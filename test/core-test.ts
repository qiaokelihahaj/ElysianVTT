import { EventEmitter } from 'events';
import { create, all } from 'mathjs';

// ==========================================
// 1. Mock: Shared Types (模拟 @hard-vtt/shared)
// ==========================================
type Tick = number;
type EntityId = string;
const generateId = () => Math.random().toString(36).substring(2, 9);

interface Entity {
    id: EntityId;
    resources: { current: Record<string, number>; max: Record<string, number> };
    currentActionContext?: { actionId: string; phase: string; resolveTick: number };
}

interface TickEvent {
    eventId: string;
    targetTick: Tick;
    status: 'PENDING' | 'RESOLVED' | 'CANCELLED';
    [key: string]: any;
}

// ==========================================
// 2. 核心类：优先队列 (PriorityQueue)
// ==========================================
class PriorityQueue {
    private heap: TickEvent[] = [];
    public get size(): number { return this.heap.length; }

    public push(event: TickEvent): void {
        this.heap.push(event);
        this.heap.sort((a, b) => a.targetTick - b.targetTick); // 测试环境简易实现排序，代替手写二叉堆
    }

    public pop(): TickEvent | undefined { return this.heap.shift(); }
    public peek(): TickEvent | undefined { return this.heap[0]; }
}

// ==========================================
// 3. 核心类：安全表达式解析 (RuleEvaluator)
// ==========================================
const math = create(all);
math.import({
    import: function () { throw new Error('Disabled'); },
}, { override: true });

class RuleEvaluator {
    public static evaluate(expr: string, context: { actor?: Entity; target?: Entity }): number {
        // 构建嵌套的 scope 对象供 mathjs 读取
        const scope: any = { actor: {}, target: {} };
        
        if (context.actor) {
            Object.entries(context.actor.resources.current).forEach(([k, v]) => {
                scope.actor[k] = v;
            });
        }
        if (context.target) {
            Object.entries(context.target.resources.current).forEach(([k, v]) => {
                scope.target[k] = v;
            });
        }

        // 模拟骰子 3d6
        const parsedExpr = expr.replace(/(\d+)d(\d+)/g, (match, n, m) => {
            let total = 0;
            for(let i=0; i<Number(n); i++) total += Math.floor(Math.random() * Number(m)) + 1;
            console.log(`[Dice] 掷骰 ${match} 结果: ${total}`);
            return total.toString();
        });

        return Number(math.evaluate!(parsedExpr, scope));
    }
}

// ==========================================
// 4. 核心类：Tick战斗引擎 (CombatEngine)
// ==========================================
class CombatEngine extends EventEmitter {
    public currentTick: Tick = 0;
    private eventQueue = new PriorityQueue();
    private entities = new Map<EntityId, Entity>();
    private pendingMutations: any = { tick: 0, mutations: [] };

    public mountEntities(entities: Entity[]) { entities.forEach(e => this.entities.set(e.id, e)); }
    public getEntity(id: EntityId) { return this.entities.get(id); }

    public receiveIntent(actorId: EntityId, actionId: string, targetId: EntityId) {
        console.log(`\n[Intent] 收到指令: ${actorId} 对 ${targetId} 释放 [${actionId}]`);
        const startupEvent: TickEvent = {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: this.currentTick + 10, // 假设10Tick前摇
            status: 'PENDING',
            actorId, targetId, actionId, phase: 'STARTUP'
        };
        
        const actor = this.entities.get(actorId)!;
        actor.currentActionContext = { actionId: startupEvent.eventId, phase: 'STARTUP', resolveTick: startupEvent.targetTick };
        
        this.eventQueue.push(startupEvent);
        this.processQueue();
    }

    private processQueue() {
        while (this.eventQueue.size > 0) {
            const event = this.eventQueue.pop()!;
            if (event.status === 'CANCELLED') continue;

            if (event.targetTick > this.currentTick) {
                console.log(`\n⏳ [Time Jump] 时间轴跃迁: Tick ${this.currentTick} ---> Tick ${event.targetTick}`);
                this.currentTick = event.targetTick;
                this.pendingMutations.tick = this.currentTick;
            }

            this.resolveEvent(event);
        }
        this.broadcastMutations();
    }

    private resolveEvent(event: TickEvent) {
        if (event.eventType === 'ACTION_PHASE') {
            const actor = this.entities.get(event.actorId)!;
            const target = this.entities.get(event.targetId)!;

            if (event.phase === 'STARTUP') {
                console.log(`⚔️ [Action] Tick ${this.currentTick}: ${actor.id} 的前摇结束，开始判定伤害!`);
                
                // 测试动态伤害计算
                const damageFormula = "actor.str + 2d6";
                const damage = RuleEvaluator.evaluate(damageFormula, { 
                    actor: { ...actor, resources: { current: { str: 10 }, max: {} } } as any, 
                    target 
                });
                
                target.resources.current['hp'] -= damage;
                console.log(`💥 [Effect] 造成 ${damage} 点伤害。${target.id} 剩余HP: ${target.resources.current['hp']}`);
                
                this.recordMutation(target.id, { 'resources.current.hp': target.resources.current['hp'] });

                // 推进到收招阶段
                const recoveryEvent = { ...event, eventId: generateId(), targetTick: this.currentTick + 5, phase: 'RECOVERY' };
                actor.currentActionContext = { actionId: recoveryEvent.eventId, phase: 'RECOVERY', resolveTick: recoveryEvent.targetTick };
                this.eventQueue.push(recoveryEvent);
            } 
            else if (event.phase === 'RECOVERY') {
                console.log(`🛡️ [Action] Tick ${this.currentTick}: ${actor.id} 收招完成，恢复自由态.`);
                actor.currentActionContext = undefined;
                this.recordMutation(actor.id, { 'currentActionContext': null });
            }
        }
    }

    private recordMutation(entityId: string, changes: any) {
        let mutation = this.pendingMutations.mutations.find((m: any) => m.entityId === entityId);
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

// ==========================================
// 5. 运行测试用例 (Test Runner)
// ==========================================
console.log("=== ElysianVTT 后端核心底层测试开始 ===\n");

// 1. 初始化引擎
const engine = new CombatEngine();

// 2. 监听差分广播 (模拟前端接收 WebSocket 消息)
engine.on('STATE_MUTATED', (payload: any) => {
    console.log(`📡 [Broadcast] 发送状态差分给前端 ->`, JSON.stringify(payload));
});

// 3. 构造 Mock 实体
const warrior: Entity = {
    id: "actor_warrior",
    resources: { current: { hp: 100, poise: 50 }, max: { hp: 100, poise: 50 } }
};
const goblin: Entity = {
    id: "target_goblin",
    resources: { current: { hp: 30, poise: 10 }, max: { hp: 30, poise: 10 } }
};

// 4. 将实体挂载进引擎
engine.mountEntities([warrior, goblin]);
console.log("✅ 实体挂载完成 (Warrior & Goblin)");

// 5. 模拟玩家发送攻击指令
engine.receiveIntent("actor_warrior", "HEAVY_STRIKE", "target_goblin");

// 6. 验证最终状态
console.log("\n=== 测试结果验证 ===");
console.log("Goblin 最终 HP:", engine.getEntity("target_goblin")?.resources.current.hp);
console.log("Warrior 当前动作上下文 (预期为 undefined):", engine.getEntity("actor_warrior")?.currentActionContext);