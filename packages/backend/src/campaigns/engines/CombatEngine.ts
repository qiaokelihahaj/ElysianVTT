// packages/backend/src/campaigns/engines/CombatEngine.ts
import { EventEmitter } from 'events';
import { 
    IEngineInstance, Tick, ClientIntent, Entity, EntityId, 
    TickEvent, ActionExecutionEvent, MovementStepEvent, StateMutationPayload, LogVisibility
} from '@hard-vtt/shared';
import { PriorityQueue } from '../../core/engine/PriorityQueue.js';
import { ClashPool } from '../../core/engine/ClashPool.js';
import type { ClashResult } from '../../core/engine/ClashPool.js';
import { generateId } from '../../utils/IdGenerator.js';
import { Dictionary } from '../../db/Dictionary.js';
import { EffectSystem } from '../../core/systems/EffectSystem.js';
import { SpatialSystem } from '../../core/systems/SpatialSystem.js';
import { RuleEvaluator } from '../../core/systems/RuleEvaluator.js';
import { Logger } from '../../utils/Logger.js';

const MOVE_INTERVAL_TICKS = 10;  // 每步间隔
const MOVE_STEP_SIZE = 1.0;       // 步长

export class CombatEngine extends EventEmitter implements IEngineInstance {
    public engineId: string;
    public engineType: 'COMBAT' | 'EXPLORE' = 'COMBAT';
    public currentTick: Tick = 0;

    private eventQueue = new PriorityQueue();
    private entities = new Map<EntityId, Entity>();
    
    private pendingMutations: StateMutationPayload = { tick: 0, mutations: [] };
    
    private logger: Logger;

    constructor(engineId: string) {
        super();
        this.engineId = engineId;
        this.logger = Logger.create(`Engine:Combat`);
        this.logger.info(`Engine created`, null, { sceneId: this.engineId });
    }

    private logCtx() {
        return { tick: this.currentTick, sceneId: this.engineId };
    }

    public getAllEntities(): Entity[] {
        return Array.from(this.entities.values());
    }

    public mountEntities(entities: Entity[]): void {
        for (const entity of entities) {
            this.entities.set(entity.id, entity);
        }
    }

    public unmountEntities(entityIds: EntityId[]): Entity[] {
        const removed: Entity[] = [];
        for (const id of entityIds) {
            const ent = this.entities.get(id);
            if (ent) {
                removed.push(ent);
                this.entities.delete(id);
            }
        }
        return removed;
    }

    public receiveIntent(intent: ClientIntent): void {
        const actor = this.entities.get(intent.actorId);
        if (!actor) return;

        if (intent.intentType === 'MOVE' && intent.payload.targetCoords) {
            this.handleMoveIntent(actor, intent.payload.targetCoords);
            return;
        }

        if (intent.intentType === 'CAST_ACTION' && intent.payload.actionTemplateId) {
            this.handleActionIntent(actor, intent);
            return;
        }
    }

    // ============================================================
    //  移动：递归 Channel 模式
    // ============================================================

    private handleMoveIntent(actor: Entity, targetCoords: { x: number; y: number; z: number }): void {
        this.cancelCurrentAction(actor);

        const waypoints = SpatialSystem.planWaypoints(actor, targetCoords, MOVE_STEP_SIZE);
        
        if (waypoints.length === 0) {
            this.logger.warn(`${actor.id} 已在目标位置`, null, this.logCtx());
            return;
        }

        this.logger.game(
            `🏃 [Move] Tick ${this.currentTick}: ${actor.id} → (${targetCoords.x.toFixed(1)},${targetCoords.y.toFixed(1)}) 共 ${waypoints.length} 步`,
            null, LogVisibility.PLAYER, this.logCtx()
        );

        const evt: ActionExecutionEvent = {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: this.currentTick + MOVE_INTERVAL_TICKS,
            status: 'PENDING',
            actorId: actor.id,
            actionTemplateId: '__BUILTIN_MOVE__',
            phase: 'STARTUP'
        };

        this.eventQueue.push(evt);

        actor.currentActionContext = {
            type: 'MOVING',
            actionId: evt.eventId,
            phase: 'STARTUP',
            resolveTick: evt.targetTick,
            pulseCount: 0,
            waypoints,
            currentWaypointIndex: 0
        };

        this.processQueue();
    }

    // ============================================================
    //  技能意图
    // ============================================================

    private handleActionIntent(actor: Entity, intent: ClientIntent): void {
        const template = Dictionary.getAction(intent.payload.actionTemplateId!);
        if (!template) {
            this.logger.warn(`技能 ${intent.payload.actionTemplateId} 不存在`);
            return;
        }

        this.cancelCurrentAction(actor);

        const startupTicks = template.timeCost.startupTicks;
        const evt: ActionExecutionEvent = {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: this.currentTick + startupTicks,
            status: 'PENDING',
            actorId: intent.actorId,
            targetIds: intent.payload.targetIds,
            actionTemplateId: template.id,
            phase: 'STARTUP'
        };

        this.eventQueue.push(evt);

        actor.currentActionContext = {
            type: 'CASTING',
            actionId: evt.eventId,
            actionTemplateId: template.id,
            phase: 'STARTUP',
            resolveTick: evt.targetTick,
            pulseCount: 0
        };

        this.processQueue();
    }

    // ============================================================
    //  取消 / 打断
    // ============================================================

    public cancelCurrentAction(actor: Entity): void {
        // 标记该实体所有 PENDING 事件为 CANCELLED
        for (const event of (this.eventQueue as any).heap) {
            if (event.status !== 'PENDING') continue;
            if ((event as ActionExecutionEvent).actorId === actor.id ||
                (event as MovementStepEvent).actorId === actor.id) {
                event.status = 'CANCELLED';
            }
        }
        actor.currentActionContext = undefined;
        this.logger.debug(`${actor.id} 动作/移动已取消`, null, this.logCtx());
    }

    private triggerInterrupt(entity: Entity): void {
        const ctx = entity.currentActionContext;
        if (!ctx || (ctx.phase !== 'STARTUP' && ctx.phase !== 'CHANNELING')) return;

        const template = ctx.actionTemplateId ? Dictionary.getAction(ctx.actionTemplateId) : undefined;

        this.cancelCurrentAction(entity);

        // 清零依赖资源
        if (template?.sustainResources) {
            for (const resKey of template.sustainResources) {
                if (entity.resources.current[resKey] !== undefined) {
                    entity.resources.current[resKey] = 0;
                    this.recordMutation(entity.id, { [`resources.current.${resKey}`]: 0 });
                }
            }
        }

        this.emit('VISUAL_FX', {
            tick: this.currentTick,
            events: [{
                eventId: generateId(),
                eventType: 'INTERRUPTED',
                sourceId: entity.id,
                targetId: entity.id,
                fxTemplateId: 'interrupted',
                durationMs: 1200,
                text: '💥 INTERRUPTED!'
            }]
        });

        this.logger.game(
            `💥 [Interrupt] Tick ${this.currentTick}: ${entity.id} 的 ${template?.id ?? 'action'} 被打断!`,
            { entityId: entity.id, phase: ctx.phase },
            LogVisibility.PLAYER, this.logCtx()
        );
    }

    private checkSustainAfterMutations(mutatedEntityIds: EntityId[]): void {
        for (const entityId of mutatedEntityIds) {
            const entity = this.entities.get(entityId);
            if (!entity) continue;

            const ctx = entity.currentActionContext;
            if (!ctx || (ctx.phase !== 'STARTUP' && ctx.phase !== 'CHANNELING')) continue;
            if (ctx.type !== 'CASTING' && ctx.type !== 'MOVING') continue;

            // 移动也检查 sustain（可通过后续配置控制）
            const template = ctx.actionTemplateId ? Dictionary.getAction(ctx.actionTemplateId) : undefined;
            const sustainResources = template?.sustainResources;

            const hp = entity.resources.current['hp'] ?? 999;

            let shouldInterrupt = false;

            if (sustainResources && sustainResources.length > 0) {
                for (const resKey of sustainResources) {
                    if ((entity.resources.current[resKey] ?? 999) <= 0) {
                        shouldInterrupt = true;
                        break;
                    }
                }
            }

            if (hp <= 0) shouldInterrupt = true;

            if (shouldInterrupt) {
                this.triggerInterrupt(entity);
            }
        }
    }

    // ============================================================
    //  核心队列处理
    // ============================================================

    private processQueue(): void {
        while (this.eventQueue.size > 0) {
            const nextEvent = this.eventQueue.peek()!;

            if (nextEvent.targetTick > this.currentTick && this.pendingMutations.mutations.length > 0) {
                this.broadcastMutations();
            }

            const sameTickEvents = this.collectSameTickEvents();
            
            const sameTickActiveEvents = sameTickEvents.filter(
                e => (e as any).eventType === 'ACTION_PHASE' && (e as ActionExecutionEvent).phase === 'STARTUP'
            );

            if (sameTickActiveEvents.length >= 2) {
                this.resolveClash(sameTickActiveEvents as ActionExecutionEvent[]);
            } else {
                const event = this.eventQueue.pop()!;
                if (event.status === 'CANCELLED') continue;

                if (event.targetTick > this.currentTick) {
                    this.currentTick = event.targetTick;
                    this.pendingMutations.tick = this.currentTick;
                }

                this.resolveSingleEvent(event);
            }
        }

        this.broadcastMutations();
    }

    private collectSameTickEvents(): TickEvent[] {
        const heap = (this.eventQueue as any).heap as TickEvent[];
        if (heap.length === 0) return [];
        const firstTick = heap[0].targetTick;
        const collected: TickEvent[] = [];
        for (const evt of heap) {
            if (evt.targetTick === firstTick && evt.status === 'PENDING') {
                collected.push(evt);
            }
        }
        return collected;
    }

    private resolveClash(clashEvents: ActionExecutionEvent[]): void {
        this.logger.game(
            `⚡ [ClashPool] Tick ${this.currentTick}: ${clashEvents.length} 个事件冲突`,
            null, LogVisibility.PLAYER, this.logCtx()
        );

        for (const ce of clashEvents) {
            const popped = this.eventQueue.pop()!;
            if (popped.status === 'CANCELLED') continue;
        }

        const clashTick = clashEvents[0].targetTick;
        if (clashTick > this.currentTick) {
            this.currentTick = clashTick;
            this.pendingMutations.tick = this.currentTick;
        }

        const result: ClashResult = ClashPool.resolve(
            clashEvents,
            this.entities,
            this.currentTick,
            2.0,
            (target) => this.cancelCurrentAction(target)
        );

        for (const mutation of result.mutations) {
            this.recordMutation(mutation.entityId, mutation.changes);
        }

        const allMutatedIds = [...new Set(result.mutations.map(m => m.entityId))];
        this.checkSustainAfterMutations(allMutatedIds);

        for (const death of result.deaths) {
            const entity = this.entities.get(death.entityId);
            if (!entity) continue;
            this.logger.game(
                `💀 [Death] Tick ${this.currentTick}: ${death.entityId} 被击杀` +
                (death.wasPoiseBreak ? ' (韧击破)' : ''),
                null, LogVisibility.PLAYER, this.logCtx()
            );
            this.cancelCurrentAction(entity);
            this.emit('ENTITY_DIED', entity);
        }

        for (const [idA, idB] of result.mutualKillPairs) {
            this.emit('VISUAL_FX', {
                tick: this.currentTick,
                events: [{
                    eventId: generateId(),
                    eventType: 'MUTUAL_KILL',
                    sourceId: idA,
                    targetId: idB,
                    fxTemplateId: 'mutual_kill',
                    durationMs: 1500,
                    text: '⚔️ 相杀!'
                }]
            });
        }

        // 为每个存活参与者处理后续（channel 或 recovery）
        for (const ce of clashEvents) {
            const actor = this.entities.get(ce.actorId);
            if (!actor?.currentActionContext) continue;
            this.pushNextPhase(actor, ce);
        }
    }

    private resolveSingleEvent(event: TickEvent): void {
        if ((event as ActionExecutionEvent).eventType === 'ACTION_PHASE') {
            this.resolveActionEvent(event as ActionExecutionEvent);
        } else if ((event as MovementStepEvent).eventType === 'MOVEMENT_STEP') {
            this.resolveMovementStep(event as MovementStepEvent);
        }
    }

    // ============================================================
    //  MovementStep （保留兼容旧事件，但新移动不再使用）
    // ============================================================

    private resolveMovementStep(moveEvt: MovementStepEvent): void {
        const actor = this.entities.get(moveEvt.actorId);
        if (!actor) return;

        actor.transform.coords.x = moveEvt.currentCoords.x;
        actor.transform.coords.y = moveEvt.currentCoords.y;
        actor.transform.coords.z = moveEvt.currentCoords.z;

        this.recordMutation(actor.id, {
            'transform.coords.x': moveEvt.currentCoords.x,
            'transform.coords.y': moveEvt.currentCoords.y,
            'transform.coords.z': moveEvt.currentCoords.z
        });

        if (moveEvt.isLastStep) {
            actor.currentActionContext = undefined;
            this.recordMutation(actor.id, { 'currentActionContext': null });
        }
    }

    // ============================================================
    //  核心：ActionEvent 结算 + 递归分叉
    // ============================================================

    private resolveActionEvent(actEvent: ActionExecutionEvent): void {
        const actor = this.entities.get(actEvent.actorId);
        if (!actor || actor.currentActionContext?.actionId !== actEvent.eventId) return;

        // 分发：移动 or 技能
        if (actor.currentActionContext.type === 'MOVING') {
            this.resolveMovementPulse(actor, actEvent);
        } else {
            this.resolveActionPulse(actor, actEvent);
        }
    }

    /**
     * 移动脉冲：执行一个航点
     */
    private resolveMovementPulse(actor: Entity, actEvent: ActionExecutionEvent): void {
        const ctx = actor.currentActionContext!;
        const waypoints = ctx.waypoints;
        const index = ctx.currentWaypointIndex ?? 0;

        if (!waypoints || index >= waypoints.length) {
            // 异常：直接结束
            actor.currentActionContext = undefined;
            this.recordMutation(actor.id, { 'currentActionContext': null });
            return;
        }

        const wp = waypoints[index];

        // 执行移动
        actor.transform.coords.x = wp.x;
        actor.transform.coords.y = wp.y;
        actor.transform.coords.z = wp.z;

        this.recordMutation(actor.id, {
            'transform.coords.x': wp.x,
            'transform.coords.y': wp.y,
            'transform.coords.z': wp.z
        });

        this.emit('VISUAL_FX', {
            tick: this.currentTick,
            events: [{
                eventId: generateId(),
                eventType: 'UI_FLOATING_TEXT',
                sourceId: actor.id,
                targetId: actor.id,
                fxTemplateId: 'info',
                text: 'Step!',
                durationMs: 400
            }]
        });

        ctx.pulseCount = (ctx.pulseCount ?? 0) + 1;

        // 递归决定是否继续
        const nextIndex = index + 1;
        if (nextIndex < waypoints.length) {
            // 还有航点 → 推下一脉冲
            ctx.currentWaypointIndex = nextIndex;
            this.pushNextPulse(actor, actEvent, MOVE_INTERVAL_TICKS);
        } else {
            // 到达终点 → RECOVERY
            this.logger.game(
                `✅ [Move] Tick ${this.currentTick}: ${actor.id} 到达目的地`,
                null, LogVisibility.PLAYER, this.logCtx()
            );
            actor.currentActionContext = undefined;
            this.recordMutation(actor.id, { 'currentActionContext': null });
        }
    }

    /**
     * 技能脉冲（支持单段和 Channel 多段）
     */
    private resolveActionPulse(actor: Entity, actEvent: ActionExecutionEvent): void {
        const ctx = actor.currentActionContext!;
        const template = Dictionary.getAction(actEvent.actionTemplateId);
        if (!template) return;

        const targets = (actEvent.targetIds || [])
            .map(id => this.entities.get(id))
            .filter(e => e) as Entity[];

        const pulseNum = (ctx.pulseCount ?? 0) + 1;

        this.logger.game(
            `⚔️ [Action] Tick ${this.currentTick}: ${actor.id}/${template.id} pulse#${pulseNum}`,
            null, LogVisibility.PLAYER, this.logCtx()
        );

        // 执行效果
        const mutations = EffectSystem.applyAction(template, actor, targets, this.logCtx(), (target) => {
            this.cancelCurrentAction(target);
        });

        const affectedIds: EntityId[] = [];
        for (const [targetId, changes] of mutations.entries()) {
            this.recordMutation(targetId, changes);
            affectedIds.push(targetId);
        }

        ctx.pulseCount = pulseNum;

        // 检查 sustain
        this.checkSustainAfterMutations([...affectedIds, actor.id]);

        // === 递归分叉 ===
        const channel = template.channelOptions;

        if (channel && (!channel.maxPulses || pulseNum < channel.maxPulses)) {
            // 消耗脉冲资源
            if (channel.pulseResourceCost) {
                for (const [resKey, expr] of Object.entries(channel.pulseResourceCost)) {
                    const cost = Math.abs(RuleEvaluator.evaluate(expr, { actor }).total);
                    if (cost > 0) {
                        const cur = actor.resources.current[resKey] ?? 999;
                        actor.resources.current[resKey] = Math.max(0, cur - cost);
                        this.recordMutation(actor.id, { [`resources.current.${resKey}`]: actor.resources.current[resKey] });
                    }
                }
            }

            // 推下一脉冲
            this.pushNextPulse(actor, actEvent, channel.intervalTicks);
            this.logger.game(
                `⏳ [Channel] Tick ${this.currentTick}: ${actor.id} 进入引导等待 (pulse ${pulseNum}/${channel.maxPulses ?? '∞'})`,
                null, LogVisibility.PLAYER, this.logCtx()
            );
        } else {
            // 结束 → RECOVERY
            this.pushRecovery(actor, actEvent, template);
        }
    }

    /**
     * 递归：推入下一次脉冲事件并设为 CHANNELING
     */
    private pushNextPulse(actor: Entity, prevEvent: ActionExecutionEvent, intervalTicks: number): void {
        const newEvt: ActionExecutionEvent = {
            ...prevEvent,
            eventId: generateId(),
            targetTick: this.currentTick + intervalTicks,
            status: 'PENDING',
            phase: 'STARTUP'
        };

        this.eventQueue.push(newEvt);

        actor.currentActionContext = {
            ...actor.currentActionContext!,
            actionId: newEvt.eventId,
            phase: 'CHANNELING',
            resolveTick: newEvt.targetTick
        };
    }

    /**
     * 结束当前动作：推入 RECOVERY 事件
     */
    private pushRecovery(actor: Entity, prevEvent: ActionExecutionEvent, template: { timeCost: { recoveryTicks: number } }): void {
        const recoveryEvt: ActionExecutionEvent = {
            ...prevEvent,
            eventId: generateId(),
            targetTick: this.currentTick + template.timeCost.recoveryTicks,
            status: 'PENDING',
            phase: 'RECOVERY'
        };

        this.eventQueue.push(recoveryEvt);

        actor.currentActionContext = {
            ...actor.currentActionContext!,
            actionId: recoveryEvt.eventId,
            phase: 'RECOVERY',
            resolveTick: recoveryEvt.targetTick
        };
    }

    /**
     * 后续阶段处理（用于 ClashPool 后的延续）
     */
    private pushNextPhase(actor: Entity, prevEvent: ActionExecutionEvent): void {
        const template = Dictionary.getAction(prevEvent.actionTemplateId);
        if (!template) {
            actor.currentActionContext = undefined;
            this.recordMutation(actor.id, { 'currentActionContext': null });
            return;
        }

        const channel = template.channelOptions;
        const pulseNum = (actor.currentActionContext?.pulseCount ?? 0);

        if (channel && (!channel.maxPulses || pulseNum < channel.maxPulses)) {
            this.pushNextPulse(actor, prevEvent, channel.intervalTicks);
        } else {
            this.pushRecovery(actor, prevEvent, template);
        }
    }

    // ============================================================
    //  工具方法
    // ============================================================

    private recordMutation(entityId: EntityId, changes: Record<string, any>) {
        let mutation = this.pendingMutations.mutations.find(m => m.entityId === entityId);
        if (!mutation) {
            mutation = { entityId, changes: {} };
            this.pendingMutations.mutations.push(mutation);
        }
        Object.assign(mutation.changes, changes);
    }

    private broadcastMutations() {
        if (this.pendingMutations.mutations.length > 0) {
            this.emit('STATE_MUTATED', this.pendingMutations);
            this.pendingMutations = { tick: this.currentTick, mutations: [] };
        }
    }
}
