// packages/backend/src/core/systems/ProjectileSystem.ts
import type {
    Entity, EntityId, Vector3D, TrajectoryType,
    ProjectileAdvanceEvent, CollisionRoll, CollisionResult,
    ActionTemplate, Tick
} from '@hard-vtt/shared';
import { LogVisibility } from '@hard-vtt/shared';
import { VectorMath } from '../../utils/VectorMath.js';
import { Projectile } from '../entities/Projectile.js';
import { SpatialSystem } from './SpatialSystem.js';
import { EffectSystem } from './EffectSystem.js';
import { Dictionary } from '../../db/Dictionary.js';
import { Logger } from '../../utils/Logger.js';

const logger = Logger.create('System:Projectile');

export interface ProjectileSystemResult {
    projectileId: EntityId;
    arrived: boolean;
    collisionResult?: CollisionResult;
    damageMutations: Map<string, Record<string, any>>;
    visualEvents: Array<{
        eventType: string;
        sourceId: EntityId;
        targetId?: EntityId;
        targetCoords?: Vector3D;
    }>;
}

export class ProjectileSystem {
    /**
     * 预计算弹道路径并生成 PROEJCTILE_ADVANCE 边界事件
     *
     * @param projectile       弹道实体
     * @param from             发射坐标
     * @param to               目标坐标
     * @param currentTick      当前 Tick
     * @param ticksPerStep     每步 Tick 间隔
     * @returns 预计算的边界事件列表（可直接压入优先队列）
     */
    public static scheduleProjectile(
        projectile: Projectile,
        from: Vector3D,
        to: Vector3D,
        currentTick: Tick,
        ticksPerStep: number = 1
    ): ProjectileAdvanceEvent[] {
        // 根据轨迹类型计算路径
        const waypoints = SpatialSystem.planProjectilePath(
            from,
            to,
            projectile.trajectoryType,
            projectile.speed,
            {
                maxHeight: projectile.maxHeight > 0 ? projectile.maxHeight : undefined,
                minRange: projectile.minRange > 0 ? projectile.minRange : undefined
            }
        );

        projectile.waypoints = waypoints;
        projectile.currentWaypointIndex = 0;
        projectile.transform.coords = { ...from };

        // 生成边界事件
        const events: ProjectileAdvanceEvent[] = [];
        let tick = currentTick;

        for (let i = 0; i < waypoints.length; i++) {
            tick += ticksPerStep;
            const fromCoords = i === 0 ? from : waypoints[i - 1];
            const toCoords = waypoints[i];

            events.push({
                eventId: `proj_${projectile.id}_step_${i}`,
                targetTick: tick,
                status: 'PENDING',
                eventType: 'PROJECTILE_ADVANCE',
                projectileId: projectile.id,
                waypointIndex: i,
                fromCoords,
                toCoords,
                isLastStep: i === waypoints.length - 1
            });
        }

        logger.game(
            `🎯 [Projectile] ${projectile.id} 弹道预计算完成: ${waypoints.length} 步, 类型=${projectile.trajectoryType}`,
            { projectileId: projectile.id, waypoints: waypoints.length, trajectoryType: projectile.trajectoryType },
            LogVisibility.PLAYER
        );

        return events;
    }

    /**
     * 处理一个边界步进事件：推进弹道+碰撞检查
     *
     * @param projectile  弹道实体
     * @param evt         边界事件
     * @param entities    所有实体表（用于碰撞检测）
     * @param obstacles   障碍物坐标列表
     * @returns 处理结果
     */
    public static resolveAdvance(
        projectile: Projectile,
        evt: ProjectileAdvanceEvent,
        entities: Map<EntityId, Entity>,
        obstacles: Vector3D[]
    ): ProjectileSystemResult {
        const result: ProjectileSystemResult = {
            projectileId: projectile.id,
            arrived: false,
            damageMutations: new Map(),
            visualEvents: []
        };

        if (projectile.hasCollided) {
            result.arrived = true;
            return result;
        }

        // 推进到目标坐标
        projectile.transform.coords = { ...evt.toCoords };
        projectile.currentWaypointIndex = evt.waypointIndex;

        // 根据抛物线轨迹更新升弧/降弧状态
        if (projectile.trajectoryType === 'PARABOLIC' && projectile.waypoints.length > 1) {
            const midPoint = Math.floor(projectile.waypoints.length / 2);
            projectile.isAscending = evt.waypointIndex <= midPoint;
        }

        // 检查障碍物碰撞（仅直射弹道检查地面障碍）
        if (projectile.trajectoryType === 'LINEAR') {
            const obstacleHit = SpatialSystem.checkObstacle(
                evt.fromCoords,
                evt.toCoords,
                obstacles,
                0.5
            );
            if (obstacleHit) {
                logger.game(
                    `🧱 [Projectile] ${projectile.id} 击中障碍物 (${obstacleHit.x.toFixed(1)},${obstacleHit.y.toFixed(1)})`,
                    { projectileId: projectile.id, obstacle: obstacleHit },
                    LogVisibility.PLAYER
                );
                projectile.onCollision();
                result.arrived = true;
                result.visualEvents.push({
                    eventType: 'COLLISION',
                    sourceId: projectile.id,
                    targetCoords: { ...projectile.transform.coords }
                });
                return result;
            }
        }

        // 检查是否与实体碰撞（网格重叠检测）
        const collisionTarget = this.checkEntityCollision(projectile, entities);
        if (collisionTarget) {
            const entity = entities.get(collisionTarget)!;
            const collisionRoll = projectile.rollCollision(entity.physics.scaleClass, false);

            logger.game(
                `💥 [Projectile] ${projectile.id} 碰撞实体 ${collisionTarget}` +
                (collisionRoll.bodyPart ? ` (部位: ${collisionRoll.bodyPart})` : ' (未命中)'),
                { projectileId: projectile.id, targetId: collisionTarget, d20: collisionRoll.d20, threshold: collisionRoll.threshold },
                LogVisibility.PLAYER
            );

            if (collisionRoll.bodyPart) {
                // 命中！应用伤害
                const cr = projectile.onCollision(collisionTarget);
                const damageMutations = this.applyProjectileDamage(
                    projectile, entity, collisionRoll.bodyPart
                );

                for (const [id, changes] of damageMutations) {
                    result.damageMutations.set(id, changes);
                }

                result.collisionResult = cr;
                result.visualEvents.push({
                    eventType: 'COLLISION',
                    sourceId: projectile.id,
                    targetId: collisionTarget,
                    targetCoords: { ...projectile.transform.coords }
                });
            } else {
                // 未命中，继续飞行
                result.visualEvents.push({
                    eventType: 'PROJECTILE_FLY',
                    sourceId: projectile.id,
                    targetCoords: { ...projectile.transform.coords }
                });
            }

            result.arrived = projectile.hasCollided;
            return result;
        }

        // 边界事件：到达终点
        if (evt.isLastStep) {
            // 终点检测：如果有目标实体，在终点再检测一次碰撞
            if (projectile.targetEntityId) {
                const target = entities.get(projectile.targetEntityId);
                if (target) {
                    const targetHp = target.resources.current.hp ?? 0;
                    if (targetHp > 0) {
                        const dist = VectorMath.distance(
                            projectile.transform.coords,
                            target.transform.coords
                        );
                        const collisionRadius = projectile.physics.collisionRadius + (target.physics.collisionRadius ?? 1);
                        if (dist < collisionRadius) {
                            const cr = projectile.onCollision(target.id);
                            const damageMutations = this.applyProjectileDamage(projectile, target);
                            for (const [id, changes] of damageMutations) {
                                result.damageMutations.set(id, changes);
                            }
                            result.collisionResult = cr;
                            result.visualEvents.push({
                                eventType: 'COLLISION',
                                sourceId: projectile.id,
                                targetId: target.id,
                                targetCoords: { ...projectile.transform.coords }
                            });
                            result.arrived = true;
                            return result;
                        }
                    }
                }
            }

            projectile.hasCollided = true;
            result.arrived = true;
            result.visualEvents.push({
                eventType: 'FX_SPAWN',
                sourceId: projectile.id,
                targetCoords: { ...projectile.transform.coords }
            });
        }

        return result;
    }

    /**
     * 检查弹道当前位置是否与实体碰撞
     * 使用碰撞半径重叠检测
     */
    private static checkEntityCollision(
        projectile: Projectile,
        entities: Map<EntityId, Entity>
    ): EntityId | null {
        // 跳过发射者自身
        for (const [id, entity] of entities) {
            if (id === projectile.sourceEntityId) continue;
            if (entity.type !== 'ACTOR' && entity.type !== 'PROP') continue;

            const dist = VectorMath.distance(
                projectile.transform.coords,
                entity.transform.coords
            );

            const collisionRadius = projectile.physics.collisionRadius + (entity.physics.collisionRadius ?? 1.0);
            if (dist <= collisionRadius) {
                return id;
            }
        }

        return null;
    }

    /**
     * 应用弹道碰撞伤害
     * 使用来源技能的 ActionTemplate 计算伤害
     */
    private static applyProjectileDamage(
        projectile: Projectile,
        target: Entity,
        bodyPart?: string
    ): Map<string, Record<string, any>> {
        const mutations = new Map<string, Record<string, any>>();

        if (!projectile.sourceActionTemplateId) return mutations;

        const template = Dictionary.getAction(projectile.sourceActionTemplateId);
        if (!template) return mutations;

        const recordChange = (entityId: string, path: string, value: any) => {
            if (!mutations.has(entityId)) mutations.set(entityId, {});
            mutations.get(entityId)![path] = value;
        };

        // 应用技能效果（将 projectile 作为 "actor" 传递，但效果对 target 应用）
        for (const effect of template.effects) {
            if (effect.targetSelector === 'PRIMARY' || effect.targetSelector === 'ALL_IN_AOE') {
                const resKey = effect.parameters.resource;
                const expr = effect.parameters.amountExpr;

                if (!resKey || !expr) continue;

                // 简化伤害计算：使用 projectile.sourceEntityId 的拥有者作为施法者
                const { total: amount } = {
                    total: Math.floor(Math.abs(effect.parameters.amount ?? 0))
                };

                const ignoreDr = effect.parameters.ignoreDr === true;
                let effectiveAmount = amount;

                if (!ignoreDr && resKey === 'hp') {
                    const dr = target.resources.current.armor ?? target.resources.current.dr ?? 0;
                    effectiveAmount = Math.max(0, amount - dr);
                }

                const currentVal = target.resources.current[resKey] ?? 0;
                const newVal = Math.max(0, currentVal - effectiveAmount);
                target.resources.current[resKey] = newVal;

                recordChange(target.id, `resources.current.${resKey}`, newVal);

                logger.game(
                    `🎯 [Projectile Hit] ${projectile.sourceEntityId} 的投射物命中 ${target.id}` +
                    `, 伤害=${effectiveAmount}${bodyPart ? `, 部位=${bodyPart}` : ''}`,
                    { projectileId: projectile.id, targetId: target.id, damage: effectiveAmount, bodyPart },
                    LogVisibility.PLAYER
                );
            }
        }

        return mutations;
    }

    /**
     * 盲投碰撞检查（场景边界事件用）
     * 不依赖实体碰撞半径，走纯概率判定
     */
    public static blindCollisionCheck(
        projectile: Projectile,
        targetScaleClass: number,
        isBlind: boolean
    ): CollisionRoll {
        return projectile.rollCollision(targetScaleClass, isBlind);
    }
}
