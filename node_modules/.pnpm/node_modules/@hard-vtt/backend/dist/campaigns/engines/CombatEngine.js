"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CombatEngine = void 0;
// packages/backend/src/campaigns/engines/CombatEngine.ts
const events_1 = require("events");
const PriorityQueue_js_1 = require("../../core/engine/PriorityQueue.js");
const IdGenerator_js_1 = require("../../utils/IdGenerator.js");
const Dictionary_js_1 = require("../../db/Dictionary.js");
const EffectSystem_js_1 = require("../../core/systems/EffectSystem.js");
// import { Dictionary } from '../../db/Dictionary'; // 用于读取 ActionTemplate
class CombatEngine extends events_1.EventEmitter {
    engineId;
    engineType = 'COMBAT';
    currentTick = 0;
    eventQueue = new PriorityQueue_js_1.PriorityQueue();
    entities = new Map();
    // 状态差分收集器 (每处理完一个 Tick 后清空并广播)
    pendingMutations = { tick: 0, mutations: [] };
    constructor(engineId) {
        super();
        this.engineId = engineId;
    }
    // 挂载实体进战斗
    mountEntities(entities) {
        for (const entity of entities) {
            this.entities.set(entity.id, entity);
        }
    }
    unmountEntities(entityIds) {
        const removed = [];
        for (const id of entityIds) {
            const ent = this.entities.get(id);
            if (ent) {
                removed.push(ent);
                this.entities.delete(id);
            }
        }
        return removed;
    }
    // 接收客户端指令 (例如玩家点击释放火球术)
    receiveIntent(intent) {
        const actor = this.entities.get(intent.actorId);
        if (!actor || intent.intentType !== 'CAST_ACTION' || !intent.payload.actionTemplateId)
            return;
        // 从字典查询技能模板
        const template = Dictionary_js_1.Dictionary.getAction(intent.payload.actionTemplateId);
        if (!template) {
            console.warn(`[CombatEngine] 技能 ${intent.payload.actionTemplateId} 不存在`);
            return;
        }
        const startupEvent = {
            eventId: (0, IdGenerator_js_1.generateId)(),
            eventType: 'ACTION_PHASE',
            targetTick: this.currentTick + template.timeCost.startupTicks, // 【动态获取前摇】
            status: 'PENDING',
            actorId: intent.actorId,
            targetIds: intent.payload.targetIds,
            actionTemplateId: template.id,
            phase: 'STARTUP'
        };
        if (actor.currentActionContext) {
            console.log(`[CombatEngine] ${actor.id} 的动作被打断`);
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
    /**
     * 核心系统：处理事件队列 (无轮询，直接跃迁)
     */
    processQueue() {
        // 取出堆顶事件，判定是否可以推进 (在真实联机中，可能需要等待所有玩家的输入到达一定 tick 才推进，MVP 假设直接推进)
        while (this.eventQueue.size > 0) {
            const nextEvent = this.eventQueue.peek();
            // 如果需要等待网络对齐，可以在此处 return
            // if (nextEvent.targetTick > this.networkSyncTick) break;
            // 如果下一个事件发生在未来，先把当前的差分广播出去，再跃迁时间！
            if (nextEvent.targetTick > this.currentTick && this.pendingMutations.mutations.length > 0) {
                this.broadcastMutations();
            }
            const event = this.eventQueue.pop();
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
    resolveEvent(event) {
        if (event.eventType === 'ACTION_PHASE') {
            const actEvent = event;
            const actor = this.entities.get(actEvent.actorId);
            if (!actor || actor.currentActionContext?.actionId !== event.eventId)
                return;
            // 【新增】获取模板和目标
            const template = Dictionary_js_1.Dictionary.getAction(actEvent.actionTemplateId);
            if (!template)
                return;
            const targets = (actEvent.targetIds || []).map(id => this.entities.get(id)).filter(e => e);
            if (actEvent.phase === 'STARTUP') {
                console.log(`⚔️ [Action] Tick ${this.currentTick}: ${actor.id} 执行了 ${template.id}!`);
                // 【核心替换】交由 EffectSystem 处理，代替原来的硬编码伤害
                const mutations = EffectSystem_js_1.EffectSystem.applyAction(template, actor, targets);
                // 将改变写入本 Tick 的同步广播中
                for (const [targetId, changes] of mutations.entries()) {
                    this.recordMutation(targetId, changes);
                }
                const recoveryEvent = {
                    ...actEvent,
                    eventId: (0, IdGenerator_js_1.generateId)(),
                    targetTick: this.currentTick + template.timeCost.recoveryTicks, // 【动态获取收招】
                    phase: 'RECOVERY'
                };
                actor.currentActionContext = { actionId: recoveryEvent.eventId, phase: 'RECOVERY', resolveTick: recoveryEvent.targetTick };
                this.eventQueue.push(recoveryEvent);
            }
            else if (actEvent.phase === 'RECOVERY') {
                console.log(`🛡️ [Action] Tick ${this.currentTick}: ${actor.id} 收招完成.`);
                actor.currentActionContext = undefined;
                this.recordMutation(actor.id, { 'currentActionContext': null });
            }
        }
    }
    recordMutation(entityId, changes) {
        let mutation = this.pendingMutations.mutations.find(m => m.entityId === entityId);
        if (!mutation) {
            mutation = { entityId, changes: {} };
            this.pendingMutations.mutations.push(mutation);
        }
        Object.assign(mutation.changes, changes);
    }
    broadcastMutations() {
        if (this.pendingMutations.mutations.length > 0) {
            this.emit('STATE_MUTATED', this.pendingMutations);
            // 清空记录器
            this.pendingMutations = { tick: this.currentTick, mutations: [] };
        }
    }
}
exports.CombatEngine = CombatEngine;
//# sourceMappingURL=CombatEngine.js.map