// FIRE_STORM 时间线数据验证测试
// 验证种子数据中 FIRE_STORM 的 timeline 计算，用于定位 TickMeter 错位问题

import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';
import type { Entity, ActionTemplate, ClientIntent, ActionScheduledPayload } from '../packages/shared/src/index.js';

function makeActor(id: string, name: string, x = 0, y = 0, hp = 100): Entity {
  return {
    id, templateId: name, type: 'ACTOR',
    transform: { coords: { x, y, z: 0 }, planeId: 'scene-1', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.5, mass: 70, movementModes: ['WALK'] },
    resources: { current: { hp, poise: 50, focus: 100 }, max: { hp, poise: 50, focus: 100 } },
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

// 注册 FIRE_STORM（与 seed.ts 一致）
registerAction({
  id: 'FIRE_STORM', tags: ['SPELL', 'AOE', 'CHANNEL'],
  timeCost: { startupTicks: 15, recoveryTicks: 10 },
  resourceCost: { poise: '0', focus: '10' },
  range: { type: 'RANGED', distanceExpr: '8' },
  effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '10 + 2d6' } }],
  priorityExpr: 'agi + 5',
  sustainResources: ['concentration', 'poise'],
  channelOptions: { intervalTicks: 8, maxPulses: 3 }
});

// 注册快速斩用于对比
registerAction({
  id: '快速斩', tags: ['MELEE', 'PHYSICAL'],
  timeCost: { startupTicks: 5, recoveryTicks: 3 },
  resourceCost: { poise: '0' },
  range: { type: 'MELEE', distanceExpr: '2' },
  effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '15' } }],
  priorityExpr: '10'
});

function runTests() {
  console.log('=== FIRE_STORM 时间线验证 ===\n');

  // ------------------------------------------------------------------
  // Test 1: FIRE_STORM 核心 timeline 字段验证
  // ------------------------------------------------------------------
  {
    console.log('[Test 1] FIRE_STORM timeline 基础值');
    const engine = new CombatEngine('test-fs-1');
    const caster = makeActor('caster', '施法者');
    const target = makeActor('target', '目标', 5, 0, 999);
    engine.mountEntities([caster, target]);

    const actions: ActionScheduledPayload[] = [];
    engine.on('ACTION_SCHEDULED', (p: ActionScheduledPayload) => actions.push(p));

    engine.receiveIntent({
      intentType: 'CAST_ACTION', actorId: 'caster', clientTick: 0,
      payload: { actionTemplateId: 'FIRE_STORM', targetIds: ['target'] }
    } as ClientIntent);

    assert(actions.length === 1, '发射了 1 个 ACTION_SCHEDULED');

    const a = actions[0];
    const t = a.timeline;

    // 核心字段
    assert(t.start === 0, `start=0 (实际 ${t.start})`);
    assert(t.startupEnd === 15, `startupEnd=15 (实际 ${t.startupEnd})`);
    assert(t.pulseTicks?.length === 3, `pulseTicks 长度=3 (实际 ${t.pulseTicks?.length})`);
    assert(t.pulseTicks![0] === 15, `pulseTicks[0]=15 (实际 ${t.pulseTicks![0]})`);
    assert(t.pulseTicks![1] === 23, `pulseTicks[1]=23 (实际 ${t.pulseTicks![1]})`);
    assert(t.pulseTicks![2] === 31, `pulseTicks[2]=31 (实际 ${t.pulseTicks![2]})`);
    assert(t.recoveryStart === 32, `recoveryStart=32 (实际 ${t.recoveryStart})`);
    assert(t.end === 42, `end=42 (实际 ${t.end})`);

    // 完整性检查
    assert(t.startupEnd > t.start, `startupEnd(${t.startupEnd}) > start(${t.start})`);
    assert(t.end > t.recoveryStart, `end(${t.end}) > recoveryStart(${t.recoveryStart})`);
    assert(t.recoveryStart > t.startupEnd, `recoveryStart(${t.recoveryStart}) > startupEnd(${t.startupEnd})`);

    // 恢复条宽度 = end - recoveryStart = 42-32 = 10 = recoveryTicks(10)
    assert(t.end - t.recoveryStart === 10, `恢复条宽度=10 (实际 ${t.end - t.recoveryStart})`);

    console.log(`\n  📊 FIRE_STORM 时间线一览:`);
    console.log(`     start=${t.start}, startupEnd=${t.startupEnd}, pulses=[${t.pulseTicks}], recoveryStart=${t.recoveryStart}, end=${t.end}`);
    console.log(`     总长度: ${t.end - t.start} ticks`);
    console.log(`     STARTUP: ${t.startupEnd - t.start} cells [${t.start}→${t.startupEnd})`);
    console.log(`     Pulse1: tick ${t.pulseTicks![0]}`);
    console.log(`     Gap1: ${t.pulseTicks![1] - t.pulseTicks![0] - 1} cells [${t.pulseTicks![0]+1}→${t.pulseTicks![1]})`);
    console.log(`     Pulse2: tick ${t.pulseTicks![1]}`);
    console.log(`     Gap2: ${t.pulseTicks![2] - t.pulseTicks![1] - 1} cells [${t.pulseTicks![1]+1}→${t.pulseTicks![2]})`);
    console.log(`     Pulse3: tick ${t.pulseTicks![2]}`);
    console.log(`     RECOVERY: ${t.end - t.pulseTicks![2] - 1} cells [${t.pulseTicks![2]+1}→${t.end})`);
  }

  // ------------------------------------------------------------------
  // Test 2: FIRE_STORM vs 快速斩 对比
  // ------------------------------------------------------------------
  {
    console.log('\n[Test 2] FIRE_STORM vs 快速斩 时间线对比');

    const engine = new CombatEngine('test-fs-2');
    const caster = makeActor('caster', '施法者');
    const warrior = makeActor('warrior', '战士', 3, 0);
    const target = makeActor('target', '目标', 8, 0, 999);
    engine.mountEntities([caster, warrior, target]);

    const actions: ActionScheduledPayload[] = [];
    engine.on('ACTION_SCHEDULED', (p: ActionScheduledPayload) => actions.push(p));

    // BATCH_CAST 让两个角色同时开始
    engine.receiveIntent({
      actorId: '__batch__', intentType: 'BATCH_CAST', clientTick: 0,
      payload: {
        batchIntents: [
          { actorId: 'caster', actionTemplateId: 'FIRE_STORM', targetIds: ['target'] },
          { actorId: 'warrior', actionTemplateId: '快速斩', targetIds: ['target'] }
        ]
      }
    } as ClientIntent);

    assert(actions.length === 2, '发射了 2 个 ACTION_SCHEDULED');

    const fs = actions.find(a => a.entityId === 'caster')!.timeline;
    const qz = actions.find(a => a.entityId === 'warrior')!.timeline;

    // 两个动作的 start 应该相同（批量施法）
    assert(fs.start === qz.start, `start 相同 (FS=${fs.start}, QZ=${qz.start})`);

    // 对比 TickMeter 渲染数据
    console.log(`\n  📊 BATCH_CAST 时间线对比:`);
    console.log(`     快速斩: start=${qz.start} startupEnd=${qz.startupEnd} pulses=[${qz.pulseTicks}] end=${qz.end}`);
    console.log(`     FIRE_STORM: start=${fs.start} startupEnd=${fs.startupEnd} pulses=[${fs.pulseTicks}] end=${fs.end}`);
    console.log(`\n  📐 PX_PER_TICK=24px 时的渲染宽度:`);
    console.log(`     快速斩: ${(qz.end - qz.start) * 24}px`);
    console.log(`     FIRE_STORM: ${(fs.end - fs.start) * 24}px`);
    console.log(`\n  📏 各段宽度 (FIRE_STORM):`);
    console.log(`     STARTUP: ${(fs.startupEnd - fs.start) * 24}px (${fs.startupEnd - fs.start} cells)`);
    console.log(`     Pulse1: 24px`);
    console.log(`     Gap1: ${(fs.pulseTicks![1] - fs.pulseTicks![0] - 1) * 24}px (${fs.pulseTicks![1] - fs.pulseTicks![0] - 1} cells)`);
    console.log(`     Pulse2: 24px`);
    console.log(`     Gap2: ${(fs.pulseTicks![2] - fs.pulseTicks![1] - 1) * 24}px (${fs.pulseTicks![2] - fs.pulseTicks![1] - 1} cells)`);
    console.log(`     Pulse3: 24px`);
    console.log(`     RECOVERY: ${(fs.end - fs.pulseTicks![2] - 1) * 24}px (${fs.end - fs.pulseTicks![2] - 1} cells)`);
    console.log(`     总: ${(fs.end - fs.start) * 24}px (${fs.end - fs.start} cells)`);

    // 验证脉冲和恢复的邻接关系
    const gap1Start = fs.pulseTicks![0] + 1;
    const gap2Start = fs.pulseTicks![1] + 1;
    const recoveryStart = fs.pulseTicks![2] + 1;

    assert(gap1Start === 16, `Gap1 从 tick 16 开始`);
    assert(fs.pulseTicks![1] - gap1Start === 7, `Gap1 宽度 7 ticks`);
    assert(gap2Start === 24, `Gap2 从 tick 24 开始`);
    assert(fs.pulseTicks![2] - gap2Start === 7, `Gap2 宽度 7 ticks`);
    assert(recoveryStart === 32, `Recovery 从 tick 32 开始`);
    assert(fs.end - recoveryStart === 10, `Recovery 宽度 10 ticks`);
  }

  // ------------------------------------------------------------------
  // Test 3: 验证所有阶段的邻接关系（无重叠、无间隙）
  // ------------------------------------------------------------------
  {
    console.log('\n[Test 3] 时间线邻接关系验证');
    const engine = new CombatEngine('test-fs-3');
    const caster = makeActor('caster', '施法者');
    const target = makeActor('target', '目标', 5, 0, 999);
    engine.mountEntities([caster, target]);

    const actions: ActionScheduledPayload[] = [];
    engine.on('ACTION_SCHEDULED', (p: ActionScheduledPayload) => actions.push(p));

    engine.receiveIntent({
      intentType: 'CAST_ACTION', actorId: 'caster', clientTick: 0,
      payload: { actionTemplateId: 'FIRE_STORM', targetIds: ['target'] }
    } as ClientIntent);

    const t = actions[0].timeline;

    // 邻接关系验证: 每个阶段结束 = 下一个阶段开始
    assert(t.pulseTicks![0] + 1 + (t.pulseTicks![1] - t.pulseTicks![0] - 1) === t.pulseTicks![1],
      `Pulse1 + Gap1 紧接 Pulse2`);
    assert(t.pulseTicks![1] + 1 + (t.pulseTicks![2] - t.pulseTicks![1] - 1) === t.pulseTicks![2],
      `Pulse2 + Gap2 紧接 Pulse3`);
    assert(t.pulseTicks![2] + 1 === t.recoveryStart, 'Recovery 紧接 Pulse3');

    // 总长度
    const totalCells = (t.startupEnd - t.start)
      + 1 // pulse1
      + (t.pulseTicks![1] - t.pulseTicks![0] - 1) // gap1
      + 1 // pulse2
      + (t.pulseTicks![2] - t.pulseTicks![1] - 1) // gap2
      + 1 // pulse3
      + (t.end - t.pulseTicks![2] - 1); // recovery

    assert(totalCells === t.end - t.start,
      `总 cells(${totalCells}) = end-start(${t.end - t.start})`);
    assert(totalCells * 24 === (t.end - t.start) * 24,
      `总像素 ${totalCells * 24}px = ${(t.end - t.start) * 24}px`);
  }

  console.log(`\n=== 完成: ${passCount}/${testCount} 通过 ===`);
  if (passCount === testCount) {
    console.log('🎉 所有 FIRE_STORM 时间线验证通过!');
  } else {
    console.error(`❌ ${testCount - passCount} 个测试失败`);
    process.exitCode = 1;
  }
}

runTests();
