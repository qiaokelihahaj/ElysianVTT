// test/interrupt.test.ts
// 打断系统测试：sustainResources, 阶段铁律, triggerInterrupt, 状态变更拦截器

let idCounter = 0;
function generateId(): string { return 'i_' + (++idCounter); }

// ==========================================
// 1. 内联共享类型
// ==========================================
type EntityId = string;

interface Entity {
    id: EntityId;
    resources: { current: Record<string, number>; max: Record<string, number> };
    currentActionContext?: {
        type: 'CASTING' | 'MOVING';
        actionId: string;
        actionTemplateId?: string;
        phase: 'STARTUP' | 'ACTIVE' | 'RECOVERY';
        resolveTick: number;
        eventIds?: string[];
    };
}

interface TickEvent {
    eventId: string;
    targetTick: number;
    status: 'PENDING' | 'RESOLVED' | 'CANCELLED';
    [key: string]: any;
}

interface ActionExecutionEvent extends TickEvent {
    eventType: 'ACTION_PHASE';
    actorId: EntityId;
    targetIds?: EntityId[];
    actionTemplateId: string;
    phase: 'STARTUP' | 'ACTIVE' | 'RECOVERY';
}

interface ActionTemplate {
    id: string;
    timeCost: { startupTicks: number; recoveryTicks: number };
    effects: Array<{ type: string; targetSelector: string; parameters: Record<string, any> }>;
    sustainResources?: string[];
}

// ==========================================
// 2. Dictionary
// ==========================================
const actionDict = new Map<string, ActionTemplate>();

// ==========================================
// 3. CombatEngine 打断核心逻辑（提取为独立测试）
// ==========================================
class InterruptTestEngine {
    entities = new Map<EntityId, Entity>();
    eventQueue: TickEvent[] = [];
    currentTick = 0;
    logs: string[] = [];

    addEntity(entity: Entity) {
        this.entities.set(entity.id, { ...entity, resources: { current: { ...entity.resources.current }, max: { ...entity.resources.max } } });
    }

    getEntity(id: EntityId) {
        return this.entities.get(id);
    }

    pushEvent(event: TickEvent) {
        this.eventQueue.push(event);
    }

    cancelCurrentAction(actor: Entity): void {
        const ctx = actor.currentActionContext;
        if (!ctx) return;

        for (const event of this.eventQueue) {
            if (event.status !== 'PENDING') continue;
            if (ctx.type === 'CASTING' && event.eventId === ctx.actionId) {
                event.status = 'CANCELLED';
            }
            if (event.eventType === 'ACTION_PHASE') {
                if ((event as ActionExecutionEvent).actorId === actor.id && event.status === 'PENDING') {
                    event.status = 'CANCELLED';
                }
            }
        }

        actor.currentActionContext = undefined;
        this.logs.push(`interrupt:${actor.id}`);
    }

    triggerInterrupt(entity: Entity): void {
        const ctx = entity.currentActionContext;
        if (!ctx || ctx.phase !== 'STARTUP') return;

        const template = ctx.actionTemplateId ? actionDict.get(ctx.actionTemplateId) : undefined;

        this.cancelCurrentAction(entity);

        if (template?.sustainResources) {
            for (const resKey of template.sustainResources) {
                if (entity.resources.current[resKey] !== undefined) {
                    entity.resources.current[resKey] = 0;
                }
            }
        }
    }

    checkSustainAfterMutations(mutatedEntityIds: EntityId[]): EntityId[] {
        const interrupted: EntityId[] = [];
        for (const entityId of mutatedEntityIds) {
            const entity = this.entities.get(entityId);
            if (!entity) continue;

            const ctx = entity.currentActionContext;
            if (!ctx || ctx.type !== 'CASTING' || ctx.phase !== 'STARTUP') continue;

            const template = ctx.actionTemplateId ? actionDict.get(ctx.actionTemplateId) : undefined;
            if (!template?.sustainResources || template.sustainResources.length === 0) continue;

            const hp = entity.resources.current['hp'] ?? 999;

            let shouldInterrupt = false;
            for (const resKey of template.sustainResources) {
                if ((entity.resources.current[resKey] ?? 999) <= 0) {
                    shouldInterrupt = true;
                    break;
                }
            }
            if (hp <= 0) shouldInterrupt = true;

            if (shouldInterrupt) {
                this.triggerInterrupt(entity);
                interrupted.push(entityId);
            }
        }
        return interrupted;
    }
}

// ==========================================
// 4. 测试框架
// ==========================================
let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
    testCount++;
    if (cond) { passCount++; console.log(`  ✅ ${label}`); }
    else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}

function runTests() {
    console.log('=== ElysianVTT 打断系统测试 ===\n');

    // ---- Test 1: STARTUP 阶段 sustain 资源归零触发打断 ----
    console.log('[Test 1] STARTUP 阶段 sustain 资源归零 → 打断');
    {
        // 注册技能：依赖 poise 维持前摇
        actionDict.set('HEAVY_SWING', {
            id: 'HEAVY_SWING',
            timeCost: { startupTicks: 15, recoveryTicks: 8 },
            effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '30' } }],
            sustainResources: ['poise']
        });

        const engine = new InterruptTestEngine();
        const warrior: Entity = {
            id: 'warrior',
            resources: { current: { hp: 100, poise: 30 }, max: { hp: 100, poise: 30 } },
            currentActionContext: {
                type: 'CASTING', actionId: 'evt_1', actionTemplateId: 'HEAVY_SWING',
                phase: 'STARTUP', resolveTick: 15
            }
        };
        engine.addEntity(warrior);

        // 模拟外界攻击削韧 → poise 归零
        const w = engine.getEntity('warrior')!;
        w.resources.current.poise = 0;

        const interrupted = engine.checkSustainAfterMutations(['warrior']);
        assert(interrupted.includes('warrior'), 'poise 归零触发打断');
        assert(engine.getEntity('warrior')!.currentActionContext === undefined, '动作上下文被清除');
        assert(engine.getEntity('warrior')!.resources.current.poise === 0, 'poise 被清零');
    }

    // ---- Test 2: RECOVERY 阶段 sustain 资源归零不打断 ----
    console.log('\n[Test 2] RECOVERY 阶段 sustain 归零 → 不打断（动作已完成）');
    {
        const engine = new InterruptTestEngine();
        const warrior: Entity = {
            id: 'warrior',
            resources: { current: { hp: 100, poise: 30 }, max: { hp: 100, poise: 30 } },
            currentActionContext: {
                type: 'CASTING', actionId: 'evt_2', actionTemplateId: 'HEAVY_SWING',
                phase: 'RECOVERY', resolveTick: 30
            }
        };
        engine.addEntity(warrior);

        const w = engine.getEntity('warrior')!;
        w.resources.current.poise = 0;

        const interrupted = engine.checkSustainAfterMutations(['warrior']);
        assert(!interrupted.includes('warrior'), 'RECOVERY 阶段不触发打断');
        assert(engine.getEntity('warrior')!.currentActionContext !== undefined, '动作上下文保持不变');
    }

    // ---- Test 3: 无 sustain 资源定义不触发打断 ----
    console.log('\n[Test 3] 无 sustainResources 定义 → 不触发打断');
    {
        actionDict.set('QUICK_STAB', {
            id: 'QUICK_STAB',
            timeCost: { startupTicks: 5, recoveryTicks: 3 },
            effects: [],
            sustainResources: undefined
        });

        const engine = new InterruptTestEngine();
        const thief: Entity = {
            id: 'thief',
            resources: { current: { hp: 50, poise: 5, agi: 30 }, max: { hp: 50, poise: 5 } },
            currentActionContext: {
                type: 'CASTING', actionId: 'evt_3', actionTemplateId: 'QUICK_STAB',
                phase: 'STARTUP', resolveTick: 5
            }
        };
        engine.addEntity(thief);

        const t = engine.getEntity('thief')!;
        t.resources.current.poise = 0;

        const interrupted = engine.checkSustainAfterMutations(['thief']);
        assert(!interrupted.includes('thief'), '无 sustainResources → 不清除动作');
        assert(engine.getEntity('thief')!.currentActionContext !== undefined, '动作继续执行');
    }

    // ---- Test 4: HP 归零触发打断（STARTUP 阶段） ----
    console.log('\n[Test 4] HP 归零 → 强制打断');
    {
        const engine = new InterruptTestEngine();
        const warrior: Entity = {
            id: 'warrior',
            resources: { current: { hp: 100, poise: 30 }, max: { hp: 100, poise: 30 } },
            currentActionContext: {
                type: 'CASTING', actionId: 'evt_4', actionTemplateId: 'HEAVY_SWING',
                phase: 'STARTUP', resolveTick: 15
            }
        };
        engine.addEntity(warrior);

        const w = engine.getEntity('warrior')!;
        w.resources.current.hp = 0; // 被秒杀

        const interrupted = engine.checkSustainAfterMutations(['warrior']);
        assert(interrupted.includes('warrior'), 'HP 归零触发打断');
        assert(engine.getEntity('warrior')!.currentActionContext === undefined, '上下文清除');
    }

    // ---- Test 5: 多个 sustain 资源任意一个归零触发打断 ----
    console.log('\n[Test 5] 多个 sustain 资源（任意一个归零）');
    {
        actionDict.set('CHANNEL_SPELL', {
            id: 'CHANNEL_SPELL',
            timeCost: { startupTicks: 20, recoveryTicks: 10 },
            effects: [],
            sustainResources: ['concentration', 'poise'] // 两个资源都要维持
        });

        // 仅 poise 归零
        const engine1 = new InterruptTestEngine();
        const mage1: Entity = {
            id: 'mage',
            resources: { current: { hp: 50, concentration: 50, poise: 30 }, max: { hp: 50, concentration: 50, poise: 30 } },
            currentActionContext: {
                type: 'CASTING', actionId: 'evt_5a', actionTemplateId: 'CHANNEL_SPELL',
                phase: 'STARTUP', resolveTick: 20
            }
        };
        engine1.addEntity(mage1);
        engine1.getEntity('mage')!.resources.current.poise = 0;
        assert(engine1.checkSustainAfterMutations(['mage']).includes('mage'), 'poise 归零触发打断');

        // 仅 concentration 归零
        const engine2 = new InterruptTestEngine();
        const mage2: Entity = {
            id: 'mage',
            resources: { current: { hp: 50, concentration: 50, poise: 30 }, max: { hp: 50, concentration: 50, poise: 30 } },
            currentActionContext: {
                type: 'CASTING', actionId: 'evt_5b', actionTemplateId: 'CHANNEL_SPELL',
                phase: 'STARTUP', resolveTick: 20
            }
        };
        engine2.addEntity(mage2);
        engine2.getEntity('mage')!.resources.current.concentration = 0;
        assert(engine2.checkSustainAfterMutations(['mage']).includes('mage'), 'concentration 归零触发打断');

        // 两者都没归零
        const engine3 = new InterruptTestEngine();
        const mage3: Entity = {
            id: 'mage',
            resources: { current: { hp: 50, concentration: 50, poise: 30 }, max: { hp: 50, concentration: 50, poise: 30 } },
            currentActionContext: {
                type: 'CASTING', actionId: 'evt_5c', actionTemplateId: 'CHANNEL_SPELL',
                phase: 'STARTUP', resolveTick: 20
            }
        };
        engine3.addEntity(mage3);
        engine3.getEntity('mage')!.resources.current.hp = 40; // 受了点伤但都 >0
        assert(!engine3.checkSustainAfterMutations(['mage']).includes('mage'), '资源都 >0 不触发打断');
    }

    // ---- Test 6: 打断后事件队列 cleanup ----
    console.log('\n[Test 6] triggerInterrupt 清理事件队列');
    {
        const engine = new InterruptTestEngine();
        const warrior: Entity = {
            id: 'warrior',
            resources: { current: { hp: 100, poise: 30 }, max: { hp: 100, poise: 30 } },
            currentActionContext: {
                type: 'CASTING', actionId: 'evt_startup', actionTemplateId: 'HEAVY_SWING',
                phase: 'STARTUP', resolveTick: 15
            }
        };
        engine.addEntity(warrior);

        // 模拟队列中有前摇 + 收招事件
        engine.pushEvent({
            eventId: 'evt_startup', eventType: 'ACTION_PHASE', targetTick: 15,
            status: 'PENDING', actorId: 'warrior', actionTemplateId: 'HEAVY_SWING', phase: 'STARTUP'
        });
        engine.pushEvent({
            eventId: 'evt_recovery', eventType: 'ACTION_PHASE', targetTick: 23,
            status: 'PENDING', actorId: 'warrior', actionTemplateId: 'HEAVY_SWING', phase: 'RECOVERY'
        });

        const w = engine.getEntity('warrior')!;
        w.resources.current.poise = 0;
        engine.checkSustainAfterMutations(['warrior']);

        const cancelled = engine.eventQueue.filter(e => e.status === 'CANCELLED');
        assert(cancelled.length >= 2, '至少 2 个事件被标记 CANCELLED');
        assert(engine.eventQueue.find(e => e.eventId === 'evt_startup')?.status === 'CANCELLED', '前摇事件被取消');
        assert(engine.eventQueue.find(e => e.eventId === 'evt_recovery')?.status === 'CANCELLED', '收招事件被取消');
    }

    // ---- Test 7: 非 CASTING 类型不受打断影响 ----
    console.log('\n[Test 7] MOVING 类型不受 CASTING sustain 检查影响');
    {
        const engine = new InterruptTestEngine();
        const warrior: Entity = {
            id: 'warrior',
            resources: { current: { hp: 100, poise: 5 }, max: { hp: 100, poise: 5 } },
            currentActionContext: {
                type: 'MOVING', actionId: 'evt_move', phase: 'STARTUP',
                resolveTick: 20, eventIds: ['step_1', 'step_2']
            }
        };
        engine.addEntity(warrior);

        engine.getEntity('warrior')!.resources.current.poise = 0;
        const interrupted = engine.checkSustainAfterMutations(['warrior']);
        assert(!interrupted.includes('warrior'), 'MOVING 不受 sustain 检查');
        assert(engine.getEntity('warrior')!.currentActionContext !== undefined, '移动继续');
    }

    // ---- Test 8: 阶段铁律 - ACTIVE 帧攻击已脱手，打断不影响已结算效果 ----
    console.log('\n[Test 8] 阶段铁律：ACTIVE 帧效果已生成 → 打断不影响后续');
    {
        // 模拟：A 在 STARTUP 结算时（= ACTIVE 帧）对 B 造成伤害
        // 然后 A 的 poise 也被 B 的反击归零
        // A 的效果已经应用，A 被打断但 B 应该已经受伤
        actionDict.set('MUTUAL_ATTACK', {
            id: 'MUTUAL_ATTACK',
            timeCost: { startupTicks: 10, recoveryTicks: 5 },
            effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '25' } }],
            sustainResources: ['poise']
        });

        const engine = new InterruptTestEngine();
        const alice: Entity = {
            id: 'alice',
            resources: { current: { hp: 100, poise: 10 }, max: { hp: 100, poise: 10 } },
            currentActionContext: {
                type: 'CASTING', actionId: 'e_a', actionTemplateId: 'MUTUAL_ATTACK',
                phase: 'STARTUP', resolveTick: 10
            }
        };
        const bob: Entity = {
            id: 'bob',
            resources: { current: { hp: 50, poise: 10 }, max: { hp: 50, poise: 10 } }
        };
        engine.addEntity(alice);
        engine.addEntity(bob);

        // 模拟 ACTIVE 帧：先应用伤害到 bob，再检查 sustain
        const b = engine.getEntity('bob')!;
        b.resources.current.hp = Math.max(0, b.resources.current.hp - 25); // 先扣 bob 的血
        assert(b.resources.current.hp === 25, 'ACTIVE 帧效果已应用: bob HP=25');

        // 然后 alice 的 poise 归零（模拟被反击）
        const a = engine.getEntity('alice')!;
        a.resources.current.poise = 0;

        // alice 被打断，但 bob 的伤害已经结算完了
        const interrupted = engine.checkSustainAfterMutations(['alice', 'bob']);
        assert(interrupted.includes('alice'), 'alice 被打断');
        assert(b.resources.current.hp === 25, 'bob 的伤害不会因为 alice 被打断而撤销');
    }

    // ---- Test 9: 端点: HP 和 sustain 资源独立检查 ----
    console.log('\n[Test 9] HP=0 但 sustain 资源 >0 → 仍打断');
    {
        actionDict.set('POISE_ONLY', {
            id: 'POISE_ONLY',
            timeCost: { startupTicks: 10, recoveryTicks: 5 },
            effects: [],
            sustainResources: ['poise'] // 只依赖 poise，不检查 hp 作为 sustain
        });

        const engine = new InterruptTestEngine();
        const entity: Entity = {
            id: 'test',
            resources: { current: { hp: 0, poise: 50 }, max: { hp: 100, poise: 50 } },
            currentActionContext: {
                type: 'CASTING', actionId: 'e_9', actionTemplateId: 'POISE_ONLY',
                phase: 'STARTUP', resolveTick: 10
            }
        };
        engine.addEntity(entity);

        // poise >0 但 hp = 0（sustain 列表中只有 poise，但 hp=0 强制打断）
        const interrupted = engine.checkSustainAfterMutations(['test']);
        assert(interrupted.includes('test'), 'HP=0 触发强制打断');
    }

    // ---- Test 10: triggerInterrupt 清零所有 sustain 资源 ----
    console.log('\n[Test 10] triggerInterrupt 清零 sustainResources');
    {
        actionDict.set('TRIPLE_SUSTAIN', {
            id: 'TRIPLE_SUSTAIN',
            timeCost: { startupTicks: 10, recoveryTicks: 5 },
            effects: [],
            sustainResources: ['poise', 'concentration', 'stamina']
        });

        const engine = new InterruptTestEngine();
        const entity: Entity = {
            id: 'test',
            resources: { current: { hp: 100, poise: 30, concentration: 50, stamina: 80 }, max: { hp: 100, poise: 30, concentration: 50, stamina: 80 } },
            currentActionContext: {
                type: 'CASTING', actionId: 'e_10', actionTemplateId: 'TRIPLE_SUSTAIN',
                phase: 'STARTUP', resolveTick: 10
            }
        };
        engine.addEntity(entity);

        // 清零 concentration 触发打断
        engine.getEntity('test')!.resources.current.concentration = 0;
        engine.checkSustainAfterMutations(['test']);

        const e = engine.getEntity('test')!;
        assert(e.resources.current.poise === 0, 'poise 被清零');
        assert(e.resources.current.concentration === 0, 'concentration 被清零');
        assert(e.resources.current.stamina === 0, 'stamina 被清零');
    }

    console.log(`\n${'='.repeat(40)}`);
    console.log(`结果: ${passCount}/${testCount} 通过`);
    if (passCount === testCount) console.log('✅ 所有打断系统测试通过!');
}

runTests();
