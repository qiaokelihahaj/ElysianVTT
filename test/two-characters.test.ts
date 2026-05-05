// 双角色 Tick 系统测试：验证时间轴渲染数据的正确性
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';
import type { Entity, ActionTemplate, ClientIntent, ActionScheduledPayload } from '../packages/shared/src/index.js';

function makeActor(id: string, name: string, x = 0, y = 0, hp = 100): Entity {
  return {
    id, templateId: name, type: 'ACTOR',
    transform: { coords: { x, y, z: 0 }, planeId: 'scene-1', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.5, mass: 70, movementModes: ['WALK'] },
    resources: { current: { hp, poise: 50, focus: 20 }, max: { hp, poise: 50, focus: 20 } },
    activeEffects: []
  };
}

function registerAction(template: ActionTemplate) {
  const dict = Dictionary as any;
  if (!dict.actions) dict.actions = new Map<string, ActionTemplate>();
  dict.actions.set(template.id, template);
}

let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
  testCount++;
  if (cond) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}

// 注册测试技能
registerAction({
  id: '快速斩', tags: ['MELEE', 'PHYSICAL'],
  timeCost: { startupTicks: 5, recoveryTicks: 3 },
  resourceCost: { poise: '0' },
  range: { type: 'MELEE', distanceExpr: '2' },
  effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '15' } }],
  priorityExpr: '10'
});

registerAction({
  id: '火球术', tags: ['SPELL', 'RANGED'],
  timeCost: { startupTicks: 8, recoveryTicks: 6 },
  resourceCost: { focus: '10' },
  range: { type: 'RANGED', distanceExpr: '8' },
  effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '25' } }],
  priorityExpr: '5',
  sustainResources: ['focus']
});

registerAction({
  id: '连刺', tags: ['MELEE', 'CHANNEL'],
  timeCost: { startupTicks: 4, recoveryTicks: 4 },
  resourceCost: { poise: '5' },
  range: { type: 'MELEE', distanceExpr: '2' },
  effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '8' } }],
  priorityExpr: '8',
  channelOptions: { intervalTicks: 3, maxPulses: 3 }
});

function runTests() {
  console.log('=== 双角色 Tick 系统测试 ===\n');

  // ------------------------------------------------------------------
  // Test 1: 两个角色各自发射非 channel 动作
  // ------------------------------------------------------------------
  {
    console.log('[Test 1] 战士快速斩 + 法师火球术 — 验证 Timeline 数据');
    const engine = new CombatEngine('test-2p-1');
    const warrior = makeActor('warrior', '战士');
    const mage = makeActor('mage', '法师', 3, 0);
    engine.mountEntities([warrior, mage]);

    const scheduledActions: ActionScheduledPayload[] = [];
    engine.on('ACTION_SCHEDULED', (payload: ActionScheduledPayload) => {
      scheduledActions.push(payload);
    });

    // 战士对法师使用快速斩
    engine.receiveIntent({
      intentType: 'CAST_ACTION', actorId: 'warrior', clientTick: 0,
      payload: { actionTemplateId: '快速斩', targetIds: ['mage'] }
    } as ClientIntent);

    // 法师对战士使用火球术
    engine.receiveIntent({
      intentType: 'CAST_ACTION', actorId: 'mage', clientTick: 0,
      payload: { actionTemplateId: '火球术', targetIds: ['warrior'] }
    } as ClientIntent);

    // 验证：有 2 个 ACTION_SCHEDULED
    assert(scheduledActions.length === 2, `发射了 ${scheduledActions.length} 个 ACTION_SCHEDULED (期望 2)`);

    const warAction = scheduledActions.find(a => a.entityId === 'warrior');
    const mageAction = scheduledActions.find(a => a.entityId === 'mage');
    assert(!!warAction, '战士有 Timeline 数据');
    assert(!!mageAction, '法师有 Timeline 数据');

    if (warAction) {
      const t = warAction.timeline;
      assert(t.start === 0, `战士 start=0 (实际 ${t.start})`);
      assert(t.startupEnd === 5, `战士 startupEnd=5 (实际 ${t.startupEnd})`);
      assert(t.pulseTicks?.length === 1, `战士 pulseTicks 长度=1 (实际 ${t.pulseTicks?.length})`);
      assert(t.pulseTicks![0] === 5, `战士 pulseTicks[0]=5 (实际 ${t.pulseTicks![0]})`);
      assert(t.end === 8, `战士 end=8 (实际 ${t.end})`);  // activeTick(5) + recoveryTicks(3) = 8
      assert(t.recoveryStart === 6, `战士 recoveryStart=6 (实际 ${t.recoveryStart})`);  // lastPulse(5) + 1
      // 恢复条宽度 = end - recoveryStart = 8 - 6 = 2 = recoveryTicks(3) - 1 ✓
      assert(t.end - t.recoveryStart === 2, `战士恢复条宽度=2 (期望 ${t.recoveryStart}→${t.end})`);
    }

    if (mageAction) {
      // receiveIntent 同步执行 processQueue，战士动作(0-8)完成后法师才开始
      // 所以 mage start = 战士执行完的 tick(8)
      const t = mageAction.timeline;
      assert(t.start === 8, `法师 start=8 (实际 ${t.start})`);
      assert(t.startupEnd === 16, `法师 startupEnd=16 (实际 ${t.startupEnd})`);  // 8+8
      assert(t.pulseTicks![0] === 16, `法师 pulseTicks[0]=16 (实际 ${t.pulseTicks![0]})`);
      assert(t.end === 22, `法师 end=22 (实际 ${t.end})`);  // 16+6
      assert(t.recoveryStart === 17, `法师 recoveryStart=17 (实际 ${t.recoveryStart})`);
      assert(t.end - t.recoveryStart === 5, `法师恢复条宽度=5 (期望 ${t.recoveryStart}→${t.end})`);
    }
  }

  // ------------------------------------------------------------------
  // Test 2: Channel 动作验证 (连刺)
  // ------------------------------------------------------------------
  {
    console.log('\n[Test 2] Channel 动作 — 验证 pulseTicks 和 endTick');
    const engine = new CombatEngine('test-2p-2');
    const warrior = makeActor('warrior', '战士');
    const dummy = makeActor('dummy', '木桩', 2, 0, 999);
    engine.mountEntities([warrior, dummy]);

    const scheduledActions: ActionScheduledPayload[] = [];
    engine.on('ACTION_SCHEDULED', (payload: ActionScheduledPayload) => {
      scheduledActions.push(payload);
    });

    engine.receiveIntent({
      intentType: 'CAST_ACTION', actorId: 'warrior', clientTick: 0,
      payload: { actionTemplateId: '连刺', targetIds: ['dummy'] }
    } as ClientIntent);

    assert(scheduledActions.length === 1, '发射了 1 个 ACTION_SCHEDULED');
    const action = scheduledActions[0];
    const t = action.timeline;

    // 连刺: startupTicks=4, intervalTicks=3, maxPulses=3, recoveryTicks=4
    assert(t.startupEnd === 4, `startupEnd=4 (实际 ${t.startupEnd})`);
    // pulseTicks 使用 intervalTicks(3): [4, 7, 10]
    assert(t.pulseTicks?.length === 3, `pulseTicks 长度=3 (实际 ${t.pulseTicks?.length})`);
    assert(t.pulseTicks![0] === 4, `pulseTicks[0]=4 (实际 ${t.pulseTicks![0]})`);
    assert(t.pulseTicks![1] === 7, `pulseTicks[1]=7 (实际 ${t.pulseTicks![1]})`);
    assert(t.pulseTicks![2] === 10, `pulseTicks[2]=10 (实际 ${t.pulseTicks![2]})`);
    // recoveryStart = lastPulse + 1 = 10 + 1 = 11
    assert(t.recoveryStart === 11, `recoveryStart=11 (实际 ${t.recoveryStart})`);
    // endTick = lastPulseTick + recoveryTicks = 10 + 4 = 14
    assert(t.end === 14, `end=14 (实际 ${t.end})`);
    // 恢复条宽度 = 14 - 11 = 3 = recoveryTicks(4) - 1 ✓
    assert(t.end - t.recoveryStart === 3, `恢复条宽度=3`);
  }

  // ------------------------------------------------------------------
  // Test 3: 移动 + 动作混合双角色时间轴
  // ------------------------------------------------------------------
  {
    console.log('\n[Test 3] 双角色混合 — 战士移动 + 法师火球术');
    const engine = new CombatEngine('test-2p-3');
    const warrior = makeActor('warrior', '战士');
    const mage = makeActor('mage', '法师', 5, 0);
    engine.mountEntities([warrior, mage]);

    const scheduledActions: ActionScheduledPayload[] = [];
    engine.on('ACTION_SCHEDULED', (payload: ActionScheduledPayload) => {
      scheduledActions.push(payload);
    });

    // 战士移动到 (3,0)
    engine.receiveIntent({
      intentType: 'MOVE', actorId: 'warrior', clientTick: 0,
      payload: { targetCoords: { x: 3, y: 0, z: 0 } }
    } as ClientIntent);

    // 法师火球术
    engine.receiveIntent({
      intentType: 'CAST_ACTION', actorId: 'mage', clientTick: 0,
      payload: { actionTemplateId: '火球术', targetIds: ['warrior'] }
    } as ClientIntent);

    assert(scheduledActions.length === 2, `发射了 ${scheduledActions.length} 个 ACTION_SCHEDULED`);

    const moveAction = scheduledActions.find(a => a.entityId === 'warrior');
    const castAction = scheduledActions.find(a => a.entityId === 'mage');

    assert(!!moveAction, '战士移动有时间轴');
    assert(moveAction!.tags?.includes('MOVEMENT'), '移动带有 MOVEMENT 标签');
    assert(moveAction!.actionName === 'Move', '移动 actionName=Move');

    // 验证战士移动完成
    const e = engine as any;
    assert(warrior.transform.coords.x === 3, `战士到达 x=3 (实际 ${warrior.transform.coords.x})`);
    assert(warrior.currentActionContext === undefined, '战士上下文已清除');

    // 验证法师火球完成
    assert(!!castAction, '法师有时间轴');
    assert(mage.currentActionContext === undefined, '法师上下文已清除');

    // 两个角色的 timeline 数据都应该是有效的
    for (const a of scheduledActions) {
      const t = a.timeline;
      assert(t.end > t.start, `${a.entityId} timeline end(${t.end}) > start(${t.start})`);
      assert(t.startupEnd >= t.start, `${a.entityId} startupEnd(${t.startupEnd}) >= start(${t.start})`);
      assert(t.recoveryStart >= t.startupEnd, `${a.entityId} recoveryStart(${t.recoveryStart}) >= startupEnd(${t.startupEnd})`);
      assert(t.end >= t.recoveryStart, `${a.entityId} end(${t.end}) >= recoveryStart(${t.recoveryStart})`);
    }
  }

  // ------------------------------------------------------------------
  // Test 4: 时间轴重叠场景 — 两个角色在同一时间窗口内行动
  // ------------------------------------------------------------------
  {
    console.log('\n[Test 4] 两个角色顺序使用快速斩 — 验证 sequential 时间轴');
    const engine = new CombatEngine('test-2p-4');
    const a = makeActor('hero_a', '勇者A');
    const b = makeActor('hero_b', '勇者B', 2, 0);
    engine.mountEntities([a, b]);

    const scheduledActions: ActionScheduledPayload[] = [];
    engine.on('ACTION_SCHEDULED', (payload: ActionScheduledPayload) => {
      scheduledActions.push(payload);
    });

    engine.receiveIntent({
      intentType: 'CAST_ACTION', actorId: 'hero_a', clientTick: 0,
      payload: { actionTemplateId: '快速斩', targetIds: ['hero_b'] }
    } as ClientIntent);

    // receiveIntent 同步执行 processQueue，hero_a 完成(0-8)后 hero_b 才开始
    engine.receiveIntent({
      intentType: 'CAST_ACTION', actorId: 'hero_b', clientTick: 0,
      payload: { actionTemplateId: '快速斩', targetIds: ['hero_a'] }
    } as ClientIntent);

    assert(scheduledActions.length === 2, `2 个 ACTION_SCHEDULED`);

    const ta = scheduledActions.find(a => a.entityId === 'hero_a')!.timeline;
    const tb = scheduledActions.find(a => a.entityId === 'hero_b')!.timeline;

    // hero_a 从 tick 0 开始
    assert(ta.start === 0, `hero_a start=0 (实际 ${ta.start})`);
    assert(ta.startupEnd === 5, `hero_a startupEnd=5 (实际 ${ta.startupEnd})`);
    assert(ta.end === 8, `hero_a end=8 (实际 ${ta.end})`);
    assert(ta.recoveryStart === 6, `hero_a recoveryStart=6 (实际 ${ta.recoveryStart})`);

    // hero_b 从 hero_a 结束后开始 (tick 8)
    assert(tb.start === 8, `hero_b start=8 (实际 ${tb.start})`);
    assert(tb.startupEnd === 13, `hero_b startupEnd=13 (实际 ${tb.startupEnd})`);
    assert(tb.end === 16, `hero_b end=16 (实际 ${tb.end})`);
    assert(tb.recoveryStart === 14, `hero_b recoveryStart=14 (实际 ${tb.recoveryStart})`);
  }

  // ------------------------------------------------------------------
  // Test 5: TickMeter 需要的核心数据完整性检查
  // ------------------------------------------------------------------
  {
    console.log('\n[Test 5] 前端 TickMeter 数据完整性检查');
    const engine = new CombatEngine('test-2p-5');
    const actors = [
      makeActor('p1', '玩家1'),
      makeActor('p2', '玩家2', 4, 0),
    ];
    engine.mountEntities(actors);

    const scheduledActions: ActionScheduledPayload[] = [];
    engine.on('ACTION_SCHEDULED', (payload: ActionScheduledPayload) => {
      scheduledActions.push(payload);
    });

    // 混合行动
    engine.receiveIntent({
      intentType: 'MOVE', actorId: 'p1', clientTick: 0,
      payload: { targetCoords: { x: 2, y: 0, z: 0 } }
    } as ClientIntent);

    engine.receiveIntent({
      intentType: 'CAST_ACTION', actorId: 'p2', clientTick: 0,
      payload: { actionTemplateId: '火球术', targetIds: ['p1'] }
    } as ClientIntent);

    // TickMeter 需要的数据字段：
    for (const action of scheduledActions) {
      const t = action.timeline;
      // entityId — 确定 lane
      assert(!!action.entityId, 'entityId 存在');
      // actionName — 标签显示
      assert(!!action.actionName, 'actionName 存在');
      // timeline.start — 全局起始 tick
      assert(typeof t.start === 'number', 'timeline.start 是数字');
      // timeline.startupEnd — STARTUP 段终点
      assert(t.startupEnd >= t.start, `startupEnd(${t.startupEnd}) >= start(${t.start})`);
      // timeline.pulseTicks — ACTIVE 脉冲标记
      assert(Array.isArray(t.pulseTicks), 'pulseTicks 是数组');
      assert(t.pulseTicks!.length >= 1, 'pulseTicks 至少有 1 个元素');
      // timeline.recoveryStart — RECOVERY 段起点
      assert(t.recoveryStart > t.startupEnd, `recoveryStart(${t.recoveryStart}) > startupEnd(${t.startupEnd})`);
      // timeline.end — 动作结束
      assert(t.end > t.recoveryStart, `end(${t.end}) > recoveryStart(${t.recoveryStart})`);
      // 恢复条宽度 = end - recoveryStart (应为 recoveryTicks-1, 至少 >=0)
      const recoveryWidth = t.end - t.recoveryStart;
      assert(recoveryWidth >= 0, `${action.entityId} 恢复条宽度=${recoveryWidth} (${t.recoveryStart}→${t.end})`);

      console.log(`  ${action.entityId}(${action.actionName}): start=${t.start} startupEnd=${t.startupEnd} pulses=[${t.pulseTicks}] recoveryStart=${t.recoveryStart} end=${t.end} 恢复宽=${recoveryWidth}`);
    }

    assert(scheduledActions.length === 2, '2 个 action');
  }

  // ------------------------------------------------------------------
  // Test 6: Batch 批量施法 — 两个角色时间轴重叠
  // ------------------------------------------------------------------
  {
    console.log('\n[Test 6] Batch Cast — 两个角色同时施法，时间轴重叠');
    const engine = new CombatEngine('test-2p-6');
    const a = makeActor('hero_a', '勇者A');
    const b = makeActor('hero_b', '勇者B', 2, 0);
    engine.mountEntities([a, b]);

    const scheduledActions: ActionScheduledPayload[] = [];
    engine.on('ACTION_SCHEDULED', (payload: ActionScheduledPayload) => {
      scheduledActions.push(payload);
    });

    // 使用 BATCH_CAST — 两个角色应在相同起始 Tick 开始
    engine.receiveIntent({
      actorId: '__batch__',
      intentType: 'BATCH_CAST',
      clientTick: 0,
      payload: {
        batchIntents: [
          { actorId: 'hero_a', actionTemplateId: '快速斩', targetIds: ['hero_b'] },
          { actorId: 'hero_b', actionTemplateId: '快速斩', targetIds: ['hero_a'] }
        ]
      }
    } as ClientIntent);

    assert(scheduledActions.length === 2, `2 个 ACTION_SCHEDULED (实际 ${scheduledActions.length})`);

    const ta = scheduledActions.find(a => a.entityId === 'hero_a')!.timeline;
    const tb = scheduledActions.find(a => a.entityId === 'hero_b')!.timeline;

    // 关键验证：两个角色的 start 相同（重叠）
    assert(ta.start === tb.start, `双方 start 重叠 (${ta.start} === ${tb.start})`);
    assert(ta.start === 0, `hero_a start=0 (实际 ${ta.start})`);
    assert(ta.startupEnd === 5, `hero_a startupEnd=5 (实际 ${ta.startupEnd})`);
    assert(ta.end === 8, `hero_a end=8 (实际 ${ta.end})`);

    assert(tb.start === 0, `hero_b start=0 (实际 ${tb.start})`);
    assert(tb.startupEnd === 5, `hero_b startupEnd=5 (实际 ${tb.startupEnd})`);
    assert(tb.end === 8, `hero_b end=8 (实际 ${tb.end})`);

    assert(ta.startupEnd === tb.startupEnd, '双方 startupEnd 重叠');
    assert(ta.end === tb.end, '双方 end 重叠');
  }

  console.log(`\n========================================`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  console.log(`========================================`);
}

runTests();
