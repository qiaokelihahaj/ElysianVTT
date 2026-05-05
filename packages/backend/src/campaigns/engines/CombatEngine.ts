// packages/backend/src/campaigns/engines/CombatEngine.ts
import { EventEmitter } from 'events';
import { 
    IEngineInstance, Tick, ClientIntent, Entity, EntityId, 
    TickEvent, ActionExecutionEvent, MovementStepEvent, StateMutationPayload, 
    ActionScheduledPayload, LogVisibility
} from '@hard-vtt/shared';
import { PriorityQueue } from '../../core/engine/PriorityQueue.js';
import { TickLoop } from '../../core/engine/TickLoop.js';
import { ClashPool } from '../../core/engine/ClashPool.js';
import type { ClashResult } from '../../core/engine/ClashPool.js';
import { generateId } from '../../utils/IdGenerator.js';
import { Dictionary } from '../../db/Dictionary.js';
import { EffectSystem } from '../../core/systems/EffectSystem.js';
import { SpatialSystem } from '../../core/systems/SpatialSystem.js';
import { RuleEvaluator } from '../../core/systems/RuleEvaluator.js';
import { Logger } from '../../utils/Logger.js';

const MOVE_INTERVAL_TICKS = 10;
const MOVE_STEP_SIZE = 1.0;
const MOVE_RECOVERY_TICKS = 5;

export class CombatEngine extends EventEmitter implements IEngineInstance {
    public engineId: string;
    public engineType: 'COMBAT' | 'EXPLORE' = 'COMBAT';
    public get currentTick(): Tick { return this.tickLoop.getCurrentTick(); }

    private eventQueue = new PriorityQueue();
    private tickLoop = new TickLoop(this.eventQueue);
    private entities = new Map<EntityId, Entity>();
    private combatEnded = false;
    
    private pendingMutations: StateMutationPayload = { tick: 0, mutations: [] };
    
    private logger: Logger;

    constructor(engineId: string) {
        super();
        this.engineId = engineId;
        this.logger = Logger.create(`Engine:Combat`);
        this.logger.info(`Engine created`, null, { sceneId: this.engineId });
    }

    private logCtx() {
        return { tick: this.tickLoop.getCurrentTick(), sceneId: this.engineId };
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

        if (intent.intentType === 'INTERACT') {
            this.handleInteractIntent(actor, intent);
            return;
        }
    }

    // ============================================================
    //  移动
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

        const ct = this.currentTick;
        const evt: ActionExecutionEvent = {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: ct + MOVE_INTERVAL_TICKS,
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

        // 广播时间轴数据
        const moveActiveTicks: number[] = [];
        let moveTick = evt.targetTick;
        for (let i = 0; i < waypoints.length; i++) {
            moveActiveTicks.push(moveTick + i * MOVE_INTERVAL_TICKS);
        }
        const moveEndTick = evt.targetTick + (waypoints.length - 1) * MOVE_INTERVAL_TICKS + 5;
        this.emit('ACTION_SCHEDULED', {
            entityId: actor.id,
            actionId: '__BUILTIN_MOVE__',
            actionName: 'Move',
            timeline: {
                start: ct,
                startupEnd: evt.targetTick,
                recoveryStart: moveActiveTicks[moveActiveTicks.length - 1] + 1,
                end: moveEndTick,
                pulseTicks: moveActiveTicks
            },
            tags: ['MOVEMENT']
        } as ActionScheduledPayload);

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

        const ct = this.currentTick;
        const startupTicks = template.timeCost.startupTicks;
        const recoveryTicks = template.timeCost.recoveryTicks;

        const evt: ActionExecutionEvent = {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: ct + startupTicks,
            status: 'PENDING',
            actorId: intent.actorId,
            targetIds: intent.payload.targetIds,
            actionTemplateId: template.id,
            phase: 'STARTUP'
        };

        this.eventQueue.push(evt);

        // 计算 channel 持续时长和脉冲节点
        // 引擎行为：第一个脉冲在 activeTick，之后每 intervalTicks 一个脉冲
        // pushRecovery 在最后一个脉冲 tick + recoveryTicks 触发
        const activeTick = ct + startupTicks;
        let endTick = activeTick + recoveryTicks;
        const pulseTicks: number[] = [activeTick];
        if (template.channelOptions) {
            const pulses = template.channelOptions.maxPulses ?? 1;
            const interval = template.channelOptions.intervalTicks;
            for (let i = 1; i < pulses; i++) {
                pulseTicks.push(activeTick + i * interval);
            }
            const lastPulseTick = activeTick + (pulses - 1) * interval;
            endTick = lastPulseTick + recoveryTicks;
        }

        actor.currentActionContext = {
            type: 'CASTING',
            actionId: evt.eventId,
            actionTemplateId: template.id,
            phase: 'STARTUP',
            resolveTick: evt.targetTick,
            pulseCount: 0
        };

        // 广播 ACTION_SCHEDULED
        this.emit('ACTION_SCHEDULED', {
            entityId: intent.actorId,
            actionId: template.id,
            actionName: template.id,
            timeline: {
                start: ct,
                startupEnd: activeTick,
                recoveryStart: pulseTicks[pulseTicks.length - 1] + 1,
                end: endTick,
                pulseTicks
            },
            tags: template.tags
        } as ActionScheduledPayload);

        this.processQueue();
    }

    private handleInteractIntent(actor: Entity, intent: ClientIntent): void {
        const targetId = intent.payload.targetIds?.[0];
        const target = targetId ? this.entities.get(targetId) : undefined;

        if (!target) {
            this.logger.warn(`交互目标不存在或未提供`, { actorId: actor.id, targetId }, this.logCtx());
            return;
        }

        this.logger.game(
            `🔎 [Interact] Tick ${this.currentTick}: ${actor.id} ↔ ${target.id}`,
            { actorId: actor.id, targetId: target.id },
            LogVisibility.PLAYER,
            this.logCtx()
        );

        this.emit('VISUAL_FX', {
            tick: this.currentTick,
            events: [{
                eventId: generateId(),
                eventType: 'UI_FLOATING_TEXT',
                sourceId: actor.id,
                targetId: target.id,
                fxTemplateId: 'interact',
                durationMs: 800,
                text: 'INTERACT'
            }]
        });
    }

    // ============================================================
    //  取消 / 打断
    // ============================================================

    public cancelCurrentAction(actor: Entity): void {
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
    //  核心队列处理 — TickLoop 驱动
    // ============================================================

    private processQueue(): void {
        while (!this.tickLoop.isEmpty()) {
            // 广播上一轮的 accumulation
            if (this.pendingMutations.mutations.length > 0) {
                this.broadcastMutations();
            }

            const step = this.tickLoop.step()!;
            this.pendingMutations.tick = step.tick;

            const events = step.events.filter(e => e.status !== 'CANCELLED');
            if (events.length === 0) continue;

            // 分离 ClashPool 候选（仅 CAST_ACTION 事件参与判定，移动事件不冲突）
            const clashCandidates = TickLoop.filterClashable(events)
                .filter(e => e.actionTemplateId !== '__BUILTIN_MOVE__');

            if (clashCandidates.length >= 2) {
                // ClashPool 批量结算
                this.resolveClash(clashCandidates);
                // 同 Tick 其他事件逐条处理
                const others = events.filter(e => !clashCandidates.includes(e as any));
                for (const e of others) {
                    this.resolveSingleEvent(e);
                }
            } else {
                for (const e of events) {
                    this.resolveSingleEvent(e);
                }
            }

            // 不在此处判定战斗结束 — 让队列排空后再判定
        }

        this.broadcastMutations();

        // 所有事件处理完毕，检查战斗是否应该结束
        this.checkAndEndCombat();
    }

    private resolveClash(clashEvents: ActionExecutionEvent[]): void {
        this.logger.game(
            `⚡ [ClashPool] Tick ${this.currentTick}: ${clashEvents.length} 个事件冲突`,
            null, LogVisibility.PLAYER, this.logCtx()
        );

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

        for (const ce of clashEvents) {
            const actor = this.entities.get(ce.actorId);
            if (!actor?.currentActionContext) continue;
            this.pushNextPhase(actor, ce);
        }

        this.checkAndEndCombat();
    }

    private resolveSingleEvent(event: TickEvent): void {
        if ((event as ActionExecutionEvent).eventType === 'ACTION_PHASE') {
            this.resolveActionEvent(event as ActionExecutionEvent);
        } else if ((event as MovementStepEvent).eventType === 'MOVEMENT_STEP') {
            this.resolveMovementStep(event as MovementStepEvent);
        }

        this.checkAndEndCombat();
    }

    // ============================================================
    //  MovementStep（兼容旧事件）
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
    //  ActionEvent 结算 + 递归分叉
    // ============================================================

    private resolveActionEvent(actEvent: ActionExecutionEvent): void {
        const actor = this.entities.get(actEvent.actorId);
        if (!actor || actor.currentActionContext?.actionId !== actEvent.eventId) return;

        if (actor.currentActionContext.type === 'MOVING') {
            this.resolveMovementPulse(actor, actEvent);
        } else {
            this.resolveActionPulse(actor, actEvent);
        }
    }

    private resolveMovementPulse(actor: Entity, actEvent: ActionExecutionEvent): void {
        const ctx = actor.currentActionContext!;

        if (actEvent.phase === 'RECOVERY' || !ctx.waypoints || (ctx.currentWaypointIndex ?? 0) >= (ctx.waypoints?.length ?? 0)) {
            actor.currentActionContext = undefined;
            this.recordMutation(actor.id, { 'currentActionContext': null });
            return;
        }

        const waypoints = ctx.waypoints;
        const index = ctx.currentWaypointIndex ?? 0;

        const wp = waypoints[index];
        actor.transform.coords.x = wp.x;
        actor.transform.coords.y = wp.y;
        actor.transform.coords.z = wp.z;

        this.recordMutation(actor.id, {
            'transform.coords.x': wp.x,
            'transform.coords.y': wp.y,
            'transform.coords.z': wp.z
        });

        ctx.pulseCount = (ctx.pulseCount ?? 0) + 1;

        const nextIndex = index + 1;
        if (nextIndex < waypoints.length) {
            ctx.currentWaypointIndex = nextIndex;
            this.pushNextPulse(actor, actEvent, MOVE_INTERVAL_TICKS);
        } else {
            this.logger.game(
                `✅ [Move] Tick ${this.currentTick}: ${actor.id} 到达目的地，进入收招`,
                null, LogVisibility.PLAYER, this.logCtx()
            );
            const recoveryEvt: ActionExecutionEvent = {
                ...actEvent,
                eventId: generateId(),
                targetTick: this.currentTick + MOVE_RECOVERY_TICKS,
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
            this.recordMutation(actor.id, { 'currentActionContext': actor.currentActionContext });
        }
    }

    private resolveActionPulse(actor: Entity, actEvent: ActionExecutionEvent): void {
        const ctx = actor.currentActionContext!;

        // === RECOVERY phase: 动作已完成，清除上下文 ===
        if (actEvent.phase === 'RECOVERY') {
            this.logger.game(
                `🛡️ [Action] Tick ${this.currentTick}: ${actor.id} 收招完成.`,
                null, LogVisibility.PLAYER, this.logCtx()
            );
            actor.currentActionContext = undefined;
            this.recordMutation(actor.id, { 'currentActionContext': null });
            return;
        }

        // === STARTUP (第一个或递归脉冲): 执行效果 + 决定后续 ===
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

        const mutations = EffectSystem.applyAction(template, actor, targets, this.logCtx(), (target) => {
            this.cancelCurrentAction(target);
        });

        const affectedIds: EntityId[] = [];
        for (const [targetId, changes] of mutations.entries()) {
            this.recordMutation(targetId, changes);
            affectedIds.push(targetId);
        }

        ctx.pulseCount = pulseNum;
        this.checkSustainAfterMutations([...affectedIds, actor.id]);

        const channel = template.channelOptions;

        if (channel && (!channel.maxPulses || pulseNum < channel.maxPulses)) {
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

            this.pushNextPulse(actor, actEvent, channel.intervalTicks);
            this.logger.game(
                `⏳ [Channel] Tick ${this.currentTick}: ${actor.id} 引导等待 (pulse ${pulseNum}/${channel.maxPulses ?? '∞'})`,
                null, LogVisibility.PLAYER, this.logCtx()
            );
        } else {
            this.pushRecovery(actor, actEvent, template);
        }
    }

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

    private checkAndEndCombat(): boolean {
        if (this.combatEnded) return true;

        const actors = Array.from(this.entities.values()).filter(entity => entity.type === 'ACTOR');
        // 至少需要 2 个 ACTOR 才能判定战斗结束（last man standing）
        // 单 ACTOR 场景（如移动测试）不应提前结束
        if (actors.length <= 1) return false;

        const livingActors = actors.filter(entity => (entity.resources.current['hp'] ?? 0) > 0);
        if (livingActors.length > 1) {
            return false;
        }

        this.combatEnded = true;
        this.emit('COMBAT_END', {
            sceneId: this.engineId,
            tick: this.currentTick,
            survivors: livingActors.map(entity => entity.id),
            casualties: actors.filter(entity => (entity.resources.current['hp'] ?? 0) <= 0).map(entity => entity.id),
            entities: this.getAllEntities()
        });

        return true;
    }
}
