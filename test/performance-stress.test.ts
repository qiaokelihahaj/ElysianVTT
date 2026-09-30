// test/performance-stress.test.ts
// 性能与压力测试：PriorityQueue 大规模事件、CombatEngine 多实体、TickLoop 高频跃迁

// ==========================================
// 1. 导入生产核心模块
// ==========================================
import { PriorityQueue } from '../packages/backend/src/core/engine/PriorityQueue.js';
import { TickLoop } from '../packages/backend/src/core/engine/TickLoop.js';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';
import { ClashPool } from '../packages/backend/src/core/engine/ClashPool.js';
import type { Entity, ActionTemplate, ClientIntent, ActionExecutionEvent } from '../packages/shared/src/index.js';

// ==========================================
// 2. 辅助函数
// ==========================================
function makeActor(id: string, hp = 100, poise = 50, x = 0, y = 0): Entity {
    return {
        id, templateId: 'unit', type: 'ACTOR',
        transform: { coords: { x, y, z: 0 }, planeId: 'scene-1', facing: 0 },
        physics: { scaleClass: 1, collisionRadius: 0.5, mass: 70, movementModes: ['WALK'] },
        resources: { current: { hp, poise, focus: 50 }, max: { hp, poise, focus: 50 } },
        activeEffects: []
    };
}

function registerAction(template: ActionTemplate) {
    const dict = Dictionary as any;
    if (!dict.actions) dict.actions = new Map<string, ActionTemplate>();
    dict.actions.set(template.id, template);
}

function elapsedMs(start: bigint): number {
    return Number(process.hrtime.bigint() - start) / 1_000_000;
}

// ==========================================
// 3. 测试框架
// ==========================================
let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
    testCount++;
    if (cond) { passCount++; console.log(`  ✅ ${label}`); }
    else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}

// 注册常用测试技能
registerAction({
    id: 'TEST_STRIKE', tags: ['MELEE', 'PHYSICAL'],
    timeCost: { startupTicks: 5, recoveryTicks: 3 },
    resourceCost: { poise: '0' },
    range: { type: 'MELEE', distanceExpr: '2' },
    effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '10' } }],
    priorityExpr: '10'
} as ActionTemplate);

// ==========================================
// 4. 测试运行
// ==========================================
function runTests() {
    // ============================================================
    // Part 1: PriorityQueue 压力测试
    // ============================================================
    console.log('=== 压力测试: PriorityQueue 大规模事件 ===\n');

    console.log('[Stress 1] 10,000 事件随机顺序入队');
    {
        const q = new PriorityQueue();
        const start = process.hrtime.bigint();

        const events: Array<{ eventId: string; targetTick: number; status: string }> = [];
        for (let i = 0; i < 10000; i++) {
            const tick = Math.floor(Math.random() * 100000);
            events.push({ eventId: `e_${i}`, targetTick: tick, status: 'PENDING' });
        }

        for (const evt of events) {
            q.push(evt as any);
        }

        const pushTime = elapsedMs(start);

        // 验证有序弹出
        let prevTick = -1;
        let count = 0;
        while (q.size > 0) {
            const evt = q.pop()!;
            assert(evt.targetTick >= prevTick, `弹出顺序正确: ${evt.targetTick} >= ${prevTick}`);
            prevTick = evt.targetTick;
            count++;
        }

        const totalTime = elapsedMs(start);
        assert(count === 10000, `全部 10000 事件弹出, 实际 ${count}`);
        console.log(`  ⏱  Push: ${pushTime.toFixed(1)}ms | Total: ${totalTime.toFixed(1)}ms | ${(10000 / totalTime).toFixed(0)} ops/ms`);
    }

    console.log('\n[Stress 2] 100,000 事件混合入队/出队');
    {
        const q = new PriorityQueue();
        const start = process.hrtime.bigint();

        // 交替入队出队
        for (let round = 0; round < 1000; round++) {
            for (let i = 0; i < 50; i++) {
                q.push({ eventId: `r${round}_${i}`, targetTick: Math.floor(Math.random() * 10000), status: 'PENDING' } as any);
            }
            // 出队 25 个
            for (let i = 0; i < 25 && q.size > 0; i++) {
                q.pop();
            }
        }

        const remaining = q.size;
        const time = elapsedMs(start);
        assert(remaining > 0, `队列有剩余事件: ${remaining}`);
        console.log(`  ⏱  ${1000 * 50} push + ${1000 * 25} pop = ${time.toFixed(1)}ms`);

        // 验证剩余事件有序
        let prevTick = -1;
        while (q.size > 0) {
            const evt = q.pop()!;
            assert(evt.targetTick >= prevTick, '弹出有序');
            prevTick = evt.targetTick;
        }
    }

    console.log('\n[Stress 3] 极端 Tick 分布 — 散布在 0~1e9 范围');
    {
        const q = new PriorityQueue();
        const ticks = [0, 1, 1000000000, 500000000, 100, 999999999, 500, 1000, 1000000];

        for (const tick of ticks) {
            q.push({ eventId: `t${tick}`, targetTick: tick, status: 'PENDING' } as any);
        }

        let prevTick = -1;
        let count = 0;
        while (q.size > 0) {
            const evt = q.pop()!;
            assert(evt.targetTick >= prevTick, `广范围 Tick 排序正确: ${evt.targetTick}`);
            prevTick = evt.targetTick;
            count++;
        }
        assert(count === ticks.length, `全部 ${ticks.length} 事件弹出`);
    }

    console.log('\n[Stress 4] 空队列操作');
    {
        const q = new PriorityQueue();
        assert(q.size === 0, '空队列 size=0');
        assert(q.peek() === undefined, '空队列 peek → undefined');
        assert(q.pop() === undefined, '空队列 pop → undefined');
    }

    // ============================================================
    // Part 2: TickLoop 压力测试
    // ============================================================
    console.log('\n=== 压力测试: TickLoop 高频跃迁 ===\n');

    console.log('[TickLoop 1] 10,000 事件广范围跃迁');
    {
        const q = new PriorityQueue();
        for (let i = 0; i < 10000; i++) {
            // 每 10 个 tick 一个事件
            q.push({ eventId: `e${i}`, targetTick: i * 10, status: 'PENDING' } as any);
        }

        const loop = new TickLoop(q);
        let steps = 0;
        let lastTick = -1;
        const start = process.hrtime.bigint();

        while (!loop.isEmpty()) {
            const step = loop.step();
            assert(step !== null, 'step 非空');
            assert(step!.tick > lastTick, `Tick 递增: ${step!.tick} > ${lastTick}`);
            assert(step!.events.length === 1, `每步 1 事件: ${step!.events.length}`);
            lastTick = step!.tick;
            steps++;
        }

        const time = elapsedMs(start);
        assert(steps === 10000, `全部 10000 步完成`);
        console.log(`  ⏱  ${steps} steps in ${time.toFixed(1)}ms (${(steps / time).toFixed(0)} steps/ms)`);
    }

    console.log('\n[TickLoop 2] 大跨度时间跃迁 (0 → 1,000,000)');
    {
        const q = new PriorityQueue();
        q.push({ eventId: 'early', targetTick: 10, status: 'PENDING' } as any);
        q.push({ eventId: 'late', targetTick: 1000000, status: 'PENDING' } as any);

        const loop = new TickLoop(q);

        const s1 = loop.step()!;
        assert(s1.tick === 10, '第一步 → tick 10');

        const s2 = loop.step()!;
        assert(s2.tick === 1000000, '第二步直接跃迁到 1,000,000');
        assert(loop.isEmpty(), '队列空');
    }

    console.log('\n[TickLoop 3] CANCELLED 墓碑过滤性能');
    {
        const q = new PriorityQueue();
        for (let i = 0; i < 5000; i++) {
            q.push({ eventId: `valid_${i}`, targetTick: i * 2, status: 'PENDING' } as any);
            q.push({ eventId: `cancelled_${i}`, targetTick: i * 2, status: 'CANCELLED' } as any);
        }

        const loop = new TickLoop(q);
        let validCount = 0;
        const start = process.hrtime.bigint();

        while (!loop.isEmpty()) {
            const step = loop.step()!;
            const active = step.events.filter((e: any) => e.status !== 'CANCELLED');
            validCount += active.length;
        }

        const time = elapsedMs(start);
        assert(validCount === 5000, `5000 有效事件, ${validCount} 个被处理`);
        console.log(`  ⏱  5000 墓碑事件过滤: ${time.toFixed(1)}ms`);
    }

    // ============================================================
    // Part 3: CombatEngine 多实体压力测试
    // ============================================================
    console.log('\n=== 压力测试: CombatEngine 多实体 ===\n');

    console.log('[Combat 1] 100 实体同时施法');
    {
        const engine = new CombatEngine('stress-100');
        const entities: Entity[] = [];

        const target = makeActor('target_master', 99999, 9999, 20, 0);
        entities.push(target);

        for (let i = 0; i < 100; i++) {
            entities.push(makeActor(`hero_${i}`, 100, 50, i * 2, 2));
        }

        engine.mountEntities(entities);
        let actionCount = 0;
        engine.on('ACTION_SCHEDULED', () => { actionCount++; });

        const start = process.hrtime.bigint();

        for (let i = 0; i < 100; i++) {
            engine.receiveIntent({
                actorId: `hero_${i}`, intentType: 'CAST_ACTION', clientTick: 0,
                payload: { actionTemplateId: 'TEST_STRIKE', targetIds: ['target_master'] }
            } as ClientIntent);
        }

        const totalTime = elapsedMs(start);
        assert(actionCount === 100, `全部 100 动作已调度, 实际 ${actionCount}`);
        assert(engine.getAllEntities().length === 101, '101 实体仍在引擎中');
        console.log(`  ⏱  100 实体动作序列: ${totalTime.toFixed(1)}ms (${(100 / totalTime).toFixed(1)} actions/ms)`);

        // 验证目标受到伤害（至少被部分击中）
        const hpLeft = target.resources.current.hp;
        assert(hpLeft < 99999, `目标受到伤害: HP=${hpLeft}`);
    }

    console.log('\n[Combat 2] 50 实体 BATCH_CAST 批量施法');
    {
        const engine = new CombatEngine('stress-batch');
        const entities: Entity[] = [];
        const target = makeActor('boss', 99999, 9999, 30, 0);
        entities.push(target);

        for (let i = 0; i < 50; i++) {
            entities.push(makeActor(`batch_${i}`, 100, 50, i * 2, 2));
        }
        engine.mountEntities(entities);

        let actionCount = 0;
        engine.on('ACTION_SCHEDULED', () => { actionCount++; });

        const start = process.hrtime.bigint();

        const batchIntents = Array.from({ length: 50 }, (_, i) => ({
            actorId: `batch_${i}`, actionTemplateId: 'TEST_STRIKE', targetIds: ['boss']
        }));

        engine.receiveIntent({
            actorId: '__batch__', intentType: 'BATCH_CAST', clientTick: 0,
            payload: { batchIntents }
        } as any);

        const totalTime = elapsedMs(start);
        assert(actionCount === 50, `全部 50 BATCH 动作已调度, 实际 ${actionCount}`);
        console.log(`  ⏱  50 BATCH_CAST: ${totalTime.toFixed(1)}ms`);
    }

    console.log('\n[Combat 3] 大规模 ClashPool 冲突结算');
    {
        // 直接测试 ClashPool 处理大量事件
        const entities = new Map<string, Entity>();
        for (let i = 0; i < 50; i++) {
            entities.set(`fighter_${i}`, makeActor(`fighter_${i}`, 100, 50, i, 0));
        }

        const allEvents: ActionExecutionEvent[] = [];
        const targetTick = 100;

        for (let i = 0; i < 50; i++) {
            const actor = entities.get(`fighter_${i}`)!;
            (actor as any).currentActionContext = {
                type: 'CASTING', actionId: `evt_${i}`, actionTemplateId: 'TEST_STRIKE',
                phase: 'STARTUP', resolveTick: targetTick
            };

            allEvents.push({
                eventId: `evt_${i}`, eventType: 'ACTION_PHASE', targetTick,
                status: 'PENDING', actorId: `fighter_${i}`,
                targetIds: [`fighter_${(i + 1) % 50}`],
                actionTemplateId: 'TEST_STRIKE', phase: 'STARTUP'
            } as ActionExecutionEvent);
        }

        const start = process.hrtime.bigint();
        const result = ClashPool.resolve(allEvents, entities, targetTick, 2.0);
        const totalTime = elapsedMs(start);

        assert(result.mutations.length > 0, `有状态变更: ${result.mutations.length}`);
        console.log(`  ⏱  50 实体 ClashPool: ${totalTime.toFixed(1)}ms`);
        console.log(`  📊  ${result.deaths.length} 死亡, ${result.mutations.length} 变更`);
    }

    console.log('\n[Combat 4] 内存使用 — 批量实体挂载');
    {
        const engine = new CombatEngine('stress-mem');
        const entities: Entity[] = [];

        for (let i = 0; i < 500; i++) {
            entities.push(makeActor(`mem_hero_${i}`, 100, 50, i, 0));
        }

        const start = process.hrtime.bigint();
        engine.mountEntities(entities);
        const mountTime = elapsedMs(start);

        const all = engine.getAllEntities();
        assert(all.length === 500, `500 实体挂载成功, 实际 ${all.length}`);
        console.log(`  ⏱  500 实体挂载: ${mountTime.toFixed(1)}ms`);

        // 批量 unmount
        const unmountStart = process.hrtime.bigint();
        const halfIds = Array.from({ length: 250 }, (_, i) => `mem_hero_${i}`);
        engine.unmountEntities(halfIds);
        const unmountTime = elapsedMs(unmountStart);

        const remaining = engine.getAllEntities().length;
        assert(remaining === 250, `250 实体卸载后剩余 250, 实际 ${remaining}`);
        console.log(`  ⏱  250 实体卸载: ${unmountTime.toFixed(1)}ms`);
    }

    // ============================================================
    // Part 4: 边界与抗压测试
    // ============================================================
    console.log('\n=== 边界与抗压测试 ===\n');

    console.log('[Edge 1] PriorityQueue 同一个 Tick 大量事件');
    {
        const q = new PriorityQueue();
        for (let i = 0; i < 10000; i++) {
            q.push({ eventId: `same_${i}`, targetTick: 42, status: 'PENDING' } as any);
        }

        let count = 0;
        while (q.size > 0) {
            q.pop();
            count++;
        }
        assert(count === 10000, `全部 10000 同 Tick 事件弹出`);
    }

    console.log('\n[Edge 2] CombatEngine 空动作（无 targetIds）');
    {
        // 注册一个不需要目标的动作
        registerAction({
            id: 'SELF_BUFF', tags: ['BUFF'],
            timeCost: { startupTicks: 3, recoveryTicks: 2 },
            resourceCost: { focus: '5' },
            range: { type: 'SELF', distanceExpr: '0' },
            effects: [{ type: 'HEAL', targetSelector: 'SELF', parameters: { resource: 'hp', amountExpr: '20' } }],
            priorityExpr: '5'
        } as ActionTemplate);

        const engine = new CombatEngine('edge-self');
        const hero = makeActor('self_buff_hero', 30, 50);
        hero.resources.max.hp = 50; // makeActor 把 max 设成跟 current 一样，手动调高
        engine.mountEntities([hero]);

        let scheduled = false;
        engine.on('ACTION_SCHEDULED', () => { scheduled = true; });

        engine.receiveIntent({
            actorId: 'self_buff_hero', intentType: 'CAST_ACTION', clientTick: 0,
            payload: { actionTemplateId: 'SELF_BUFF' }
        } as ClientIntent);

        assert(scheduled, '自施法被调度');
        // HP 应该被恢复（30 + 20 = 50）
        assert(hero.resources.current.hp === 50, `自施法后 HP=50, 实际 ${hero.resources.current.hp}`);
    }

    console.log('\n[Edge 3] CombatEngine 未知 actorId');
    {
        const engine = new CombatEngine('edge-unknown');
        // 不 mount 实体，直接发送 intent
        // 不应 crash
        try {
            engine.receiveIntent({
                actorId: 'ghost', intentType: 'CAST_ACTION', clientTick: 0,
                payload: { actionTemplateId: 'TEST_STRIKE', targetIds: ['ghost'] }
            } as ClientIntent);
            assert(true, '未知 actorId 不抛异常');
        } catch (e) {
            assert(false, `未知 actorId 抛异常: ${e}`);
        }
    }

    console.log('\n[Edge 4] CombatEngine 重复战斗结束');
    {
        const engine = new CombatEngine('edge-double-end');
        const hero = makeActor('last_hero', 100, 50);
        const enemy = makeActor('last_enemy', 1, 10, 2, 0); // 1 HP
        engine.mountEntities([hero, enemy]);

        let endCount = 0;
        engine.on('COMBAT_END', () => { endCount++; });

        engine.receiveIntent({
            actorId: 'last_hero', intentType: 'CAST_ACTION', clientTick: 0,
            payload: { actionTemplateId: 'TEST_STRIKE', targetIds: ['last_enemy'] }
        } as ClientIntent);

        assert(endCount <= 1, `COMBAT_END 最多触发 1 次, 实际 ${endCount}`);
        assert(engine.getAllEntities().some(e => e.id === 'last_hero'), '英雄仍在场景中');
    }

    // ============================================================
    // 总结
    // ============================================================
    console.log(`\n${'='.repeat(50)}`);
    console.log(`压力测试: ${passCount}/${testCount} 通过`);
    if (passCount < testCount) process.exit(1);
}

runTests();
