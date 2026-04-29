// packages/backend/src/campaigns/engines/CombatEngine.ts
import { EventEmitter } from 'events';
import { 
    IEngineInstance, Tick, ClientIntent, Entity, EntityId, 
    TickEvent, ActionExecutionEvent, StateMutationPayload, LogVisibility
} from '@hard-vtt/shared';
import { PriorityQueue } from '../../core/engine/PriorityQueue.js';
import { generateId } from '../../utils/IdGenerator.js';
import { Dictionary } from '../../db/Dictionary.js';
import { EffectSystem } from '../../core/systems/EffectSystem.js';
import { Logger } from '../../utils/Logger.js';

export class CombatEngine extends EventEmitter implements IEngineInstance {
    public engineId: string;
    public engineType: 'COMBAT' | 'EXPLORE' = 'COMBAT';
    public currentTick: Tick = 0;

    private eventQueue = new PriorityQueue();
    private entities = new Map<EntityId, Entity>();
    
    // 状态差分收集器 (每处理完一个 Tick 后清空并广播)
    private pendingMutations: StateMutationPayload = { tick: 0, mutations: [] };
    
    // 独立日志器
    private logger: Logger;

    constructor(engineId: string) {
        super();
        this.engineId = engineId;
        this.logger = Logger.create(`Engine:Combat`);
        this.logger.info(`Engine created`, null, { sceneId: this.engineId });
    }

    // 封装一个内部使用的带 Tick 上下文的日志器
    private logCtx() {
        return { tick: this.currentTick, sceneId: this.engineId };
    }

    public getAllEntities(): Entity[] {
        return Array.from(this.entities.values());
    }

    // 挂载实体进战斗
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

    // 接收客户端指令 (例如玩家点击释放火球术或移动)
    public receiveIntent(intent: ClientIntent): void {
        const actor = this.entities.get(intent.actorId);
        if (!actor) return;

        if (intent.intentType === 'MOVE' && intent.payload.targetCoords) {
            // MVP 移动：直接瞬间位移（前端通过 Lerp 平滑）
            const targetPos = intent.payload.targetCoords;
            this.logger.game(`🏃 [Move] Tick ${this.currentTick}: ${actor.id} 移动到 (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)})`, null, LogVisibility.PLAYER, this.logCtx());
            
            // 简单的坐标修改
            actor.transform.coords.x = targetPos.x;
            actor.transform.coords.y = targetPos.y;

            // 记录状态差分
            this.recordMutation(actor.id, {
                'transform.coords.x': targetPos.x,
                'transform.coords.y': targetPos.y
            });

            // 同时派发一个飘字特效给前端，证明服务端收到
            this.emit('VISUAL_FX', {
                tick: this.currentTick,
                events: [{
                    eventId: generateId(),
                    eventType: 'UI_FLOATING_TEXT',
                    sourceId: actor.id,
                    targetId: actor.id,
                    fxTemplateId: 'info',
                    text: 'Moving!',
                    durationMs: 1000
                }]
            });
            
            // 前进 Tick 以反映移动花费的时间 (比如1平米1tick)
            this.currentTick += 10;
            this.pendingMutations.tick = this.currentTick;
            this.broadcastMutations();
            return;
        }

        if (intent.intentType === 'CAST_ACTION' && intent.payload.actionTemplateId) {
            // 从字典查询技能模板
            const template = Dictionary.getAction(intent.payload.actionTemplateId);
            if (!template) {
                this.logger.warn(`技能 ${intent.payload.actionTemplateId} 不存在`);
                return;
            }

            const startupEvent: ActionExecutionEvent = {
                eventId: generateId(),
                eventType: 'ACTION_PHASE',
                targetTick: this.currentTick + template.timeCost.startupTicks, // 【动态获取前摇】
                status: 'PENDING',
                actorId: intent.actorId,
                targetIds: intent.payload.targetIds,
                actionTemplateId: template.id,
                phase: 'STARTUP'
            };

            if (actor.currentActionContext) {
                 this.logger.debug(`${actor.id}'s action was interrupted`, null, this.logCtx());
                 // 真实逻辑应标记旧事件为 CANCELLED
            }

            actor.currentActionContext = {
                actionId: startupEvent.eventId,
                phase: 'STARTUP',
                resolveTick: startupEvent.targetTick
            };

            this.eventQueue.push(startupEvent);
            this.processQueue();
        }
    }

    /**
     * 核心系统：处理事件队列 (无轮询，直接跃迁)
     */
    private processQueue(): void {
        // 取出堆顶事件，判定是否可以推进 (在真实联机中，可能需要等待所有玩家的输入到达一定 tick 才推进，MVP 假设直接推进)
        while (this.eventQueue.size > 0) {
            const nextEvent = this.eventQueue.peek()!;

            // 如果需要等待网络对齐，可以在此处 return
            // if (nextEvent.targetTick > this.networkSyncTick) break;
            
            // 如果下一个事件发生在未来，先把当前的差分广播出去，再跃迁时间！
            if (nextEvent.targetTick > this.currentTick && this.pendingMutations.mutations.length > 0) {
                this.broadcastMutations();
            }

            const event = this.eventQueue.pop()!;

            // --- 核心防坑：惰性删除 (Tombstone) ---
            if (event.status === 'CANCELLED') {
                continue; // 丢弃被取消的事件
            }

            // 时间跃迁
            if (event.targetTick > this.currentTick) {
                this.currentTick = event.targetTick;
                this.pendingMutations.tick = this.currentTick;
            }

            // TODO: 检测碰撞池 (Clash Pool)
            // 真实实现中，应该把同 Tick 的事件收集起来一起结算，目前 MVP 先按顺序结算
            
            this.resolveEvent(event);
        }

        // 广播本 Tick 积累的状态变更
        this.broadcastMutations();
    }

    private resolveEvent(event: TickEvent): void {
        if ((event as ActionExecutionEvent).eventType === 'ACTION_PHASE') {
            const actEvent = event as ActionExecutionEvent;
            const actor = this.entities.get(actEvent.actorId);
            if (!actor || actor.currentActionContext?.actionId !== event.eventId) return;

            // 【新增】获取模板和目标
            const template = Dictionary.getAction(actEvent.actionTemplateId);
            if (!template) return;

            const targets = (actEvent.targetIds || []).map(id => this.entities.get(id)).filter(e => e) as Entity[];

            if (actEvent.phase === 'STARTUP') {
                this.logger.game(`⚔️ [Action] Tick ${this.currentTick}: ${actor.id} 执行了 ${template.id}!`, null, LogVisibility.PLAYER, this.logCtx());
                
                // 【核心替换】交由 EffectSystem 处理，代替原来的硬编码伤害
                const mutations = EffectSystem.applyAction(template, actor, targets, this.logCtx());
                
                // 将改变写入本 Tick 的同步广播中
                for (const [targetId, changes] of mutations.entries()) {
                    this.recordMutation(targetId, changes);
                }

                const recoveryEvent: ActionExecutionEvent = {
                    ...actEvent,
                    eventId: generateId(),
                    targetTick: this.currentTick + template.timeCost.recoveryTicks, // 【动态获取收招】
                    phase: 'RECOVERY'
                };
                actor.currentActionContext = { actionId: recoveryEvent.eventId, phase: 'RECOVERY', resolveTick: recoveryEvent.targetTick };
                this.eventQueue.push(recoveryEvent);
            } 
            else if (actEvent.phase === 'RECOVERY') {
                this.logger.game(`🛡️ [Action] Tick ${this.currentTick}: ${actor.id} 收招完成.`, null, LogVisibility.PLAYER, this.logCtx());
                actor.currentActionContext = undefined;
                this.recordMutation(actor.id, { 'currentActionContext': null });
            }
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
            // 清空记录器
            this.pendingMutations = { tick: this.currentTick, mutations: [] };
        }
    }
}