import type {
    Entity, EntityId, Vector3D, Tick, ActionExecutionEvent, ActionTemplate,
    ProjectileAdvanceEvent, VisualEventPayload
} from '@hard-vtt/shared';
import { LogVisibility } from '@hard-vtt/shared';
import { Projectile } from '../../core/entities/Projectile.js';
import { ProjectileSystem } from '../../core/systems/ProjectileSystem.js';
import { CoverService } from '../../core/systems/CoverService.js';
import { generateId } from '../../utils/IdGenerator.js';
import { VectorMath } from '../../utils/VectorMath.js';
import type { Logger } from '../../utils/Logger.js';
import type { ActionCatalog } from '../../rules/ActionCatalog.js';

interface ProjectileRuntimeContext {
    entities: Map<EntityId, Entity>;
    currentTick: () => Tick;
    schedule: (event: ProjectileAdvanceEvent) => void;
    recordMutation: (entityId: EntityId, changes: Record<string, unknown>) => void;
    emitVisual: (payload: VisualEventPayload) => void;
    logger: Logger;
    logContext: () => { tick: Tick; sceneId: string; entities: Map<EntityId, Entity> };
    getActionCatalog: () => ActionCatalog;
    onInterrupt?: (target: Entity) => void;
}

/**
 * 每个 CombatEngine 独立持有的弹道生命周期。
 * 只调度边界事件，不推进 Tick；伤害差分仍交由主引擎统一广播。
 */
export class CombatProjectileRuntime {
    private projectiles = new Map<EntityId, Projectile>();
    private obstacles: Vector3D[] = [];

    constructor(private readonly context: ProjectileRuntimeContext) {}

    public setObstacles(obstacles: Vector3D[]): void {
        this.obstacles = obstacles;
    }

    public reset(): void {
        for (const projectileId of this.projectiles.keys()) this.context.entities.delete(projectileId);
        this.projectiles.clear();
    }

    /**
     * 发射投射物：创建 Projectile 实体并预计算边界事件
     * 发射阶段只创建实体，外部效果在命中或到达落点时结算。
     */
    public launch(actor: Entity, actEvent: ActionExecutionEvent, template: ActionTemplate): void {
        const config = template.launchProjectile;
        if (!config) return;
        const projectileId = generateId();

        // 空格投掷保留意图中的落点，然后才使用目标实体或朝向。
        let targetCoords: Vector3D;
        const primaryTargetId = actEvent.targetIds?.[0];
        const primaryTarget = primaryTargetId ? this.context.entities.get(primaryTargetId) : undefined;

        if (actEvent.targetCoords) {
            targetCoords = { ...actEvent.targetCoords };
        } else if (primaryTarget) {
            targetCoords = { ...primaryTarget.transform.coords };
        } else if (actor.currentActionContext?.waypoints?.length) {
            // 如果有移动路径，向路径终点发射
            const lastWp = actor.currentActionContext.waypoints[actor.currentActionContext.waypoints.length - 1];
            targetCoords = { ...lastWp };
        } else {
            // 默认向 facing 方向发射 5 个单位
            const facingRad = (actor.transform.facing ?? 0) * (Math.PI / 180);
            targetCoords = {
                x: actor.transform.coords.x + Math.cos(facingRad) * 5,
                y: actor.transform.coords.y + Math.sin(facingRad) * 5,
                z: actor.transform.coords.z ?? 0
            };
        }
        const launchHeight = config.trajectoryType === 'LINEAR' ? (config.launchHeight ?? 0) : 0;
        const launchCoords = { ...actor.transform.coords, z: actor.transform.coords.z + launchHeight };
        targetCoords.z += launchHeight;
        const stance = actor.currentStance ?? 'NONE';
        const deviation = CoverService.getShotDeviation(stance);
        targetCoords.x += deviation.x;
        targetCoords.y += deviation.y;
        targetCoords.z += deviation.z;

        // 创建弹道实体
        const projectile = new Projectile({
            id: projectileId,
            templateId: `proj_${template.id}_${projectileId}`,
            sourceEntityId: actor.id,
            sourceActionTemplateId: template.id,
            transform: {
                coords: launchCoords,
                planeId: actor.transform.planeId,
                facing: VectorMath.directionAngleFromOffset(launchCoords.x, launchCoords.y, targetCoords.x, targetCoords.y),
            },
            physics: {
                scaleClass: 0,
                collisionRadius: 0.3,
                mass: 0.1,
                movementModes: ['PROJECTILE']
            },
            resources: { current: {}, max: {} },
            trajectoryType: config.trajectoryType,
            speed: config.speed,
            maxHeight: config.maxHeight,
            minRange: config.minRange,
            collisionDieSize: config.collisionDieSize ?? 20,
            dieThreshold: Math.max(1, (config.dieThreshold ?? 10) - CoverService.getAccuracyModifier(stance)),
            targetEntityId: primaryTargetId,
            targetCoords: { ...targetCoords }
        });

        // 预计算并调度弹道边界事件
        const events = ProjectileSystem.scheduleProjectile(
            projectile,
            launchCoords,
            targetCoords,
            this.context.currentTick(),
            config.ticksPerStep ?? 1
        );
        if (events.length === 0) {
            this.context.emitVisual({ tick: this.context.currentTick(), events: [{
                eventId: generateId(), eventType: 'FX_SPAWN', sourceId: actor.id,
                targetCoords: { ...targetCoords }, fxTemplateId: 'projectile-whiff', durationMs: 300,
                text: '💨 射程盲区，投射未发出',
            }] });
            return;
        }

        // 压入事件队列
        for (const evt of events) {
            this.context.schedule(evt);
        }

        // 注册弹道实体
        this.projectiles.set(projectileId, projectile);
        this.context.entities.set(projectileId, projectile);

        this.context.logger.game(
            `🎯 [Launch] Tick ${this.context.currentTick()}: ${actor.id} 发射投射物 ${projectileId}` +
            ` (${config.trajectoryType}, ${events.length} 步) 目标→ (${targetCoords.x.toFixed(1)},${targetCoords.y.toFixed(1)})`,
            { actorId: actor.id, projectileId, trajectoryType: config.trajectoryType, steps: events.length },
            LogVisibility.PLAYER, this.context.logContext()
        );

        // 广播投射物创建
        this.context.emitVisual({
            tick: this.context.currentTick(),
            events: [{
                eventId: generateId(),
                eventType: 'FX_SPAWN',
                sourceId: actor.id,
                targetId: projectileId,
                targetCoords: { ...projectile.transform.coords },
                fxTemplateId: 'projectile-default',
                durationMs: 500,
                text: `🎯 发射 ${template.id}`
            }]
        });
    }

    /**
     * 处理 PROEJCTILE_ADVANCE 边界事件
     * 推进弹道并检查碰撞
     */
    public resolveAdvance(evt: ProjectileAdvanceEvent): void {
        const projectile = this.projectiles.get(evt.projectileId);
        if (!projectile) {
            // 已命中的弹道仍有预排航段；清理后按墓碑语义跳过即可。
            return;
        }

        const result = ProjectileSystem.resolveAdvance(
            projectile,
            evt,
            this.context.entities,
            this.obstacles,
            this.context.getActionCatalog(),
            this.context.onInterrupt,
        );

        // 记录伤害变更
        for (const [targetId, changes] of result.damageMutations) {
            this.context.recordMutation(targetId, changes);
        }
        this.context.recordMutation(projectile.id, { 'transform.coords': { ...projectile.transform.coords } });

        // 广播视觉事件
        const isExplosion = this.context.getActionCatalog().getAction(projectile.sourceActionTemplateId)
            ?.effects.some(effect => effect.targetSelector === 'ALL_IN_AOE') ?? false;
        for (const ve of result.visualEvents) {
            const isImpact = result.arrived && (ve.eventType === 'COLLISION' || ve.eventType === 'FX_SPAWN');
            this.context.emitVisual({
                tick: this.context.currentTick(),
                events: [{
                    eventId: generateId(),
                    eventType: ve.eventType as VisualEventPayload['events'][number]['eventType'],
                    sourceId: ve.sourceId,
                    targetId: ve.targetId,
                    targetCoords: ve.targetCoords,
                    fxTemplateId: isImpact && isExplosion ? 'explosion' : ve.eventType === 'COLLISION' ? 'collision' : 'projectile_trail',
                    durationMs: isImpact && isExplosion ? 600 : 200,
                    text: isImpact && isExplosion ? '💥 爆炸!' : ve.eventType === 'COLLISION' ? '💥 碰撞!' : undefined
                }]
            });
        }

        // 弹道结束：清理
        if (result.arrived) {
            this.cleanupProjectile(projectile);
        }
    }

    /**
     * 清理已完成的弹道实体
     */
    private cleanupProjectile(projectile: Projectile): void {
        this.projectiles.delete(projectile.id);
        this.context.entities.delete(projectile.id);

        this.context.logger.game(
            `🏁 [Projectile] ${projectile.id} 生命周期结束` +
            (projectile.collisionResult?.targetId ? `, 命中 ${projectile.collisionResult.targetId}` : ''),
            { projectileId: projectile.id, collisionResult: projectile.collisionResult },
            LogVisibility.PLAYER, this.context.logContext()
        );
    }

}
