// packages/backend/src/campaigns/engines/CombatEngine.ts
import { EventEmitter } from 'events';
import { 
    IEngineInstance, Tick, ClientIntent, Entity, EntityId, 
    TickEvent, ActionExecutionEvent, MovementStepEvent, StateMutationPayload, LogVisibility
} from '@hard-vtt/shared';
import { PriorityQueue } from '../../core/engine/PriorityQueue.js';
import { generateId } from '../../utils/IdGenerator.js';
import { Dictionary } from '../../db/Dictionary.js';
import { EffectSystem } from '../../core/systems/EffectSystem.js';
import { SpatialSystem } from '../../core/systems/SpatialSystem.js';
import { Logger } from '../../utils/Logger.js';

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

    /**
     * 处理移动意图：离散航点切分，压入最小堆
     */
    private handleMoveIntent(actor: Entity, targetCoords: { x: number; y: number; z: number }): void {
        // 如果当前正在移动，取消旧的移动事件
        this.cancelCurrentAction(actor);

        const moveEvents = SpatialSystem.planMovement(actor, targetCoords, this.currentTick);
        
        if (moveEvents.length === 0) {
            this.logger.warn(`${actor.id} 已在目标位置`, null, this.logCtx());
            return;
        }

        this.logger.game(
            `🏃 [Move] Tick ${this.currentTick}: ${actor.id} 开始移动到 (${targetCoords.x.toFixed(1)}, ${targetCoords.y.toFixed(1)})，共 ${moveEvents.length} 步`,
            null, LogVisibility.PLAYER, this.logCtx()
        );

        // 压入所有移动事件
        for (const evt of moveEvents) {
            this.eventQueue.push(evt);
        }

        // 记录移动上下文（用于后续打断时批量取消）
        const lastEvent = moveEvents[moveEvents.length - 1];
        actor.currentActionContext = {
            type: 'MOVING',
            actionId: moveEvents[0].eventId,
            phase: 'STARTUP',
            resolveTick: lastEvent.targetTick,
            eventIds: moveEvents.map(e => e.eventId)
        };

        this.processQueue();
    }

    /**
     * 处理技能意图
     */
    private handleActionIntent(actor: Entity, intent: ClientIntent): void {
        const template = Dictionary.getAction(intent.payload.actionTemplateId!);
        if (!template) {
            this.logger.warn(`技能 ${intent.payload.actionTemplateId} 不存在`);
            return;
        }

        // 如果当前正在移动，取消移动事件
        if (actor.currentActionContext?.type === 'MOVING') {
            this.cancelCurrentAction(actor);
            this.logger.game(
                `🛑 [Interrupt] Tick ${this.currentTick}: ${actor.id} 的移动被新动作打断`,
                null, LogVisibility.PLAYER, this.logCtx()
            );
        }

        if (actor.currentActionContext?.type === 'CASTING') {
            this.logger.debug(`${actor.id}'s action interrupted by new action`, null, this.logCtx());
            this.cancelCurrentAction(actor);
        }

        const startupEvent: ActionExecutionEvent = {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: this.currentTick + template.timeCost.startupTicks,
            status: 'PENDING',
            actorId: intent.actorId,
            targetIds: intent.payload.targetIds,
            actionTemplateId: template.id,
            phase: 'STARTUP'
        };

        actor.currentActionContext = {
            type: 'CASTING',
            actionId: startupEvent.eventId,
            phase: 'STARTUP',
            resolveTick: startupEvent.targetTick
        };

        this.eventQueue.push(startupEvent);
        this.processQueue();
    }

    /**
     * 取消实体当前正在执行的动作或移动
     * 将相关事件标记为 CANCELLED（Tombstone 删除）
     */
    public cancelCurrentAction(actor: Entity): void {
        const ctx = actor.currentActionContext;
        if (!ctx) return;

        // 取消队列中属于该上下文的所有事件
        for (const event of (this.eventQueue as any).heap) {
            if (event.status !== 'PENDING') continue;

            if (ctx.type === 'MOVING' && ctx.eventIds?.includes(event.eventId)) {
                event.status = 'CANCELLED';
            } else if (ctx.type === 'CASTING' && event.eventId === ctx.actionId) {
                event.status = 'CANCELLED';
            }
            // 也取消 RECOVERY 事件（来自同一 actionId 但 eventId 不同）
            if (event.eventType === 'ACTION_PHASE') {
                const actEvt = event as ActionExecutionEvent;
                if (actEvt.actorId === actor.id && event.status === 'PENDING') {
                    event.status = 'CANCELLED';
                }
            }
        }

        actor.currentActionContext = undefined;
        this.logger.debug(`${actor.id} 的当前动作已取消`, null, this.logCtx());
    }

    /**
     * 核心系统：处理事件队列（时间跃迁）
     */
    private processQueue(): void {
        while (this.eventQueue.size > 0) {
            const nextEvent = this.eventQueue.peek()!;
            
            if (nextEvent.targetTick > this.currentTick && this.pendingMutations.mutations.length > 0) {
                this.broadcastMutations();
            }

            const event = this.eventQueue.pop()!;

            // Tombstone: 丢弃被取消的事件
            if (event.status === 'CANCELLED') {
                continue;
            }

            // 时间跃迁
            if (event.targetTick > this.currentTick) {
                this.currentTick = event.targetTick;
                this.pendingMutations.tick = this.currentTick;
            }
            
            this.resolveEvent(event);
        }

        this.broadcastMutations();
    }

    private resolveEvent(event: TickEvent): void {
        if ((event as ActionExecutionEvent).eventType === 'ACTION_PHASE') {
            this.resolveActionEvent(event as ActionExecutionEvent);
        } else if ((event as MovementStepEvent).eventType === 'MOVEMENT_STEP') {
            this.resolveMovementStep(event as MovementStepEvent);
        }
    }

    /**
     * 结算移动步进事件
     */
    private resolveMovementStep(moveEvt: MovementStepEvent): void {
        const actor = this.entities.get(moveEvt.actorId);
        if (!actor) return;

        // 更新实体坐标
        actor.transform.coords.x = moveEvt.currentCoords.x;
        actor.transform.coords.y = moveEvt.currentCoords.y;
        actor.transform.coords.z = moveEvt.currentCoords.z;

        // 记录差分
        this.recordMutation(actor.id, {
            'transform.coords.x': moveEvt.currentCoords.x,
            'transform.coords.y': moveEvt.currentCoords.y,
            'transform.coords.z': moveEvt.currentCoords.z
        });

        // 派发视觉事件
        this.emit('VISUAL_FX', {
            tick: this.currentTick,
            events: [{
                eventId: generateId(),
                eventType: 'UI_FLOATING_TEXT',
                sourceId: actor.id,
                targetId: actor.id,
                fxTemplateId: 'info',
                text: 'Step!',
                durationMs: 500
            }]
        });

        // 如果是最后一步，解除移动状态
        if (moveEvt.isLastStep) {
            this.logger.game(
                `✅ [Move] Tick ${this.currentTick}: ${actor.id} 到达目标 (${moveEvt.targetCoords.x.toFixed(1)}, ${moveEvt.targetCoords.y.toFixed(1)})`,
                null, LogVisibility.PLAYER, this.logCtx()
            );
            actor.currentActionContext = undefined;
            this.recordMutation(actor.id, { 'currentActionContext': null });
        }
    }

    /**
     * 结算技能事件
     */
    private resolveActionEvent(actEvent: ActionExecutionEvent): void {
        const actor = this.entities.get(actEvent.actorId);
        if (!actor || actor.currentActionContext?.actionId !== actEvent.eventId) return;

        const template = Dictionary.getAction(actEvent.actionTemplateId);
        if (!template) return;

        const targets = (actEvent.targetIds || []).map(id => this.entities.get(id)).filter(e => e) as Entity[];

        if (actEvent.phase === 'STARTUP') {
            this.logger.game(
                `⚔️ [Action] Tick ${this.currentTick}: ${actor.id} 执行了 ${template.id}!`,
                null, LogVisibility.PLAYER, this.logCtx()
            );
            
            const mutations = EffectSystem.applyAction(template, actor, targets, this.logCtx(), (target) => {
                // INTERRUPT 回调：取消目标的当前动作
                this.cancelCurrentAction(target);
            });
            
            for (const [targetId, changes] of mutations.entries()) {
                this.recordMutation(targetId, changes);
            }

            const recoveryEvent: ActionExecutionEvent = {
                ...actEvent,
                eventId: generateId(),
                targetTick: this.currentTick + template.timeCost.recoveryTicks,
                phase: 'RECOVERY'
            };
            actor.currentActionContext = {
                type: 'CASTING',
                actionId: recoveryEvent.eventId,
                phase: 'RECOVERY',
                resolveTick: recoveryEvent.targetTick
            };
            this.eventQueue.push(recoveryEvent);
        } 
        else if (actEvent.phase === 'RECOVERY') {
            this.logger.game(
                `🛡️ [Action] Tick ${this.currentTick}: ${actor.id} 收招完成.`,
                null, LogVisibility.PLAYER, this.logCtx()
            );
            actor.currentActionContext = undefined;
            this.recordMutation(actor.id, { 'currentActionContext': null });
        }
    }

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
