// packages/backend/src/core/systems/ProjectileSystem.ts
import type {
    Entity, EntityId, Vector3D,
    ProjectileAdvanceEvent, CollisionRoll, CollisionResult,
    Tick
} from '@hard-vtt/shared';
import { LogVisibility } from '@hard-vtt/shared';
import { VectorMath } from '../../utils/VectorMath.js';
import { Projectile } from '../entities/Projectile.js';
import { SpatialSystem } from './SpatialSystem.js';
import { EffectSystem } from './EffectSystem.js';
import { DictionaryActionCatalog } from '../../db/Dictionary.js';
import type { ActionCatalog } from '../../rules/ActionCatalog.js';
import { Logger } from '../../utils/Logger.js';

const logger = Logger.create('System:Projectile');

export interface ProjectileSystemResult {
    projectileId: EntityId;
    arrived: boolean;
    collisionResult?: CollisionResult;
    damageMutations: Map<string, Record<string, unknown>>;
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
        projectile.currentWaypointIndex = -1;
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
        obstacles: Vector3D[],
        actionCatalog: ActionCatalog = new DictionaryActionCatalog(),
        onInterrupt?: (target: Entity) => void,
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

        // 所有轨迹都按当前航段高度检测障碍，抛物线只能越过低于弧线的墙。
        const obstacleHit = this.checkObstacleCollision(evt.fromCoords, evt.toCoords, obstacles);
        const entityHit = this.checkEntityCollision(projectile, evt.fromCoords, evt.toCoords, entities);
        if (obstacleHit && (!entityHit || obstacleHit.progress <= entityHit.progress)) {
            projectile.transform.coords = { ...obstacleHit.coords };
            logger.game(
                `🧱 [Projectile] ${projectile.id} 击中障碍物 (${obstacleHit.coords.x.toFixed(1)},${obstacleHit.coords.y.toFixed(1)})`,
                { projectileId: projectile.id, obstacle: obstacleHit },
                LogVisibility.PLAYER
            );
            result.collisionResult = projectile.onCollision();
            result.damageMutations = this.applyImpactEffects(projectile, undefined, entities, evt.targetTick, actionCatalog, onInterrupt);
            result.arrived = true;
            result.visualEvents.push({
                eventType: 'COLLISION',
                sourceId: projectile.id,
                targetCoords: { ...projectile.transform.coords }
            });
            return result;
        }

        // 扫掠检测航段，避免高速投射物越过小体积目标；按路径先后结算。
        if (entityHit) {
            const entity = entityHit.entity;
            const collisionTarget = entity.id;
            const collisionRoll = projectile.rollCollision(entity.physics.scaleClass, false);

            logger.game(
                `💥 [Projectile] ${projectile.id} 碰撞实体 ${collisionTarget}` +
                (collisionRoll.bodyPart ? ` (部位: ${collisionRoll.bodyPart})` : ' (未命中)'),
                { projectileId: projectile.id, targetId: collisionTarget, d20: collisionRoll.d20, threshold: collisionRoll.threshold },
                LogVisibility.PLAYER
            );

            if (collisionRoll.bodyPart) {
                projectile.transform.coords = { ...entityHit.coords };
                const cr = projectile.onCollision(collisionTarget);
                result.damageMutations = this.applyImpactEffects(projectile, entity, entities, evt.targetTick, actionCatalog, onInterrupt);

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
            if (result.arrived || !evt.isLastStep) return result;
        }

        // 边界事件：到达终点
        if (evt.isLastStep) {
            // 空格投掷也必须结算落点 AOE；PRIMARY 效果只有实体命中才生效。
            result.collisionResult = projectile.onCollision();
            result.damageMutations = this.applyImpactEffects(projectile, undefined, entities, evt.targetTick, actionCatalog, onInterrupt);
            result.arrived = true;
            result.visualEvents.push({
                eventType: 'FX_SPAWN',
                sourceId: projectile.id,
                targetCoords: { ...projectile.transform.coords }
            });
        } else if (!entityHit) {
            result.visualEvents.push({ eventType: 'PROJECTILE_FLY', sourceId: projectile.id,
                targetCoords: { ...projectile.transform.coords } });
        }

        return result;
    }

    /**
     * 检查整段弹道与实体的距离，返回最先经过的实体。
     */
    private static checkEntityCollision(
        projectile: Projectile,
        from: Vector3D,
        to: Vector3D,
        entities: Map<EntityId, Entity>
    ): { entity: Entity; coords: Vector3D; progress: number } | null {
        let first: { entity: Entity; coords: Vector3D; progress: number } | null = null;
        const delta = VectorMath.direction(from, to);
        const lengthSquared = delta.x ** 2 + delta.y ** 2;
        for (const [id, entity] of entities) {
            if (id === projectile.sourceEntityId) continue;
            if (entity.type !== 'ACTOR' && entity.type !== 'PROP') continue;
            if (entity.transform.planeId !== projectile.transform.planeId) continue;
            if ((entity.resources.current.hp ?? 1) <= 0) continue;

            const relative = VectorMath.direction(from, entity.transform.coords);
            const projection = lengthSquared > 0
                ? (relative.x * delta.x + relative.y * delta.y) / lengthSquared
                : 0;
            const progress = Math.max(0, Math.min(1, projection));
            const coords = { x: from.x + delta.x * progress, y: from.y + delta.y * progress, z: from.z + delta.z * progress };
            // 角色与墙占据地面以上的有限高度；低墙不会吞掉眼部高度的射线。
            const baseZ = entity.transform.coords.z;
            const height = entity.type === 'PROP' ? (entity.coverState?.height ?? 2) : 2;
            const verticalDistance = Math.max(baseZ - coords.z, coords.z - baseZ - height, 0);
            const dist = Math.hypot(coords.x - entity.transform.coords.x, coords.y - entity.transform.coords.y, verticalDistance);
            const collisionRadius = projectile.physics.collisionRadius + (entity.physics.collisionRadius ?? 1.0);
            if (dist <= collisionRadius && (!first || progress < first.progress)) {
                first = { entity, coords, progress };
            }
        }

        return first;
    }

    /**
     * 障碍坐标 Z 表示墙顶高度；必须用水平投影计算航段上的真实高度。
     */
    private static checkObstacleCollision(from: Vector3D, to: Vector3D, obstacles: Vector3D[]): { coords: Vector3D; progress: number } | null {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const lengthSquared = dx ** 2 + dy ** 2;
        let first: { coords: Vector3D; progress: number } | null = null;
        for (const obstacle of obstacles) {
            const progress = lengthSquared > 0
                ? ((obstacle.x - from.x) * dx + (obstacle.y - from.y) * dy) / lengthSquared
                : 0;
            if (progress < 0 || progress > 1) continue;
            const coords = { x: from.x + dx * progress, y: from.y + dy * progress, z: from.z + (to.z - from.z) * progress };
            const horizontalDistance = Math.hypot(coords.x - obstacle.x, coords.y - obstacle.y);
            if (horizontalDistance < 1 && obstacle.z >= coords.z && (!first || progress < first.progress)) {
                first = { coords, progress };
            }
        }
        return first;
    }

    /** 来源实体提供规则变量；效果、护甲、部位和 AOE 统一走正式效果系统。 */
    private static applyImpactEffects(
        projectile: Projectile,
        target: Entity | undefined,
        entities: Map<EntityId, Entity>,
        tick: Tick,
        actionCatalog: ActionCatalog = new DictionaryActionCatalog(),
        onInterrupt?: (target: Entity) => void,
    ): Map<string, Record<string, unknown>> {
        const actor = entities.get(projectile.sourceEntityId);
        const template = actionCatalog.getAction(projectile.sourceActionTemplateId);
        if (!actor || !template) return new Map();
        return EffectSystem.applyAction(
            { ...template, effects: template.effects.filter(effect => effect.targetSelector !== 'SELF') },
            actor, target ? [target] : [],
            { tick, entities, actionCatalog, originCoords: { ...projectile.transform.coords }, applySpatial: false, skipReachCheck: true },
            onInterrupt,
        );
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
