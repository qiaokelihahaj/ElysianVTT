// test/zone-trigger.test.ts
// Phase 4.3: 区域触发系统测试 — ZoneTriggerSystem 单元测试

import { ZoneTriggerSystem } from '../packages/backend/src/core/systems/ZoneTrigger.js';
import type { Entity, EntityId, ZoneTriggerType } from '@hard-vtt/shared';

// ==========================================
// 1. 内联类型
// ==========================================
interface Vector3D { x: number; y: number; z: number; }

interface Transform {
  coords: Vector3D;
  planeId?: string;
  facing: number;
}

interface PhysicsBody {
  scaleClass: number;
  collisionRadius: number;
  mass: number;
  movementModes: string[];
}

interface ResourcePool {
  current: Record<string, number>;
  max: Record<string, number>;
}

// ==========================================
// 2. 测试框架
// ==========================================
let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
  testCount++;
  if (cond) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}
function assertEqual<T>(actual: T, expected: T, label: string) {
  testCount++;
  if (actual === expected) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label} (期望=${JSON.stringify(expected)}, 实际=${JSON.stringify(actual)})`); process.exitCode = 1; }
}

// ==========================================
// 3. 辅助函数
// ==========================================
function createEntity(id: string, x: number, y: number): Entity {
  return {
    id,
    templateId: 'test',
    type: 'ACTOR',
    transform: { coords: { x, y, z: 0 }, planeId: 'main', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.5, mass: 70, movementModes: ['walk'] },
    resources: { current: { hp: 100, focus: 20, poise: 50 }, max: { hp: 100, focus: 20, poise: 50 } },
    activeEffects: [],
  } as unknown as Entity;
}

function entityMap(...entities: Entity[]): Map<EntityId, Entity> {
  const map = new Map<EntityId, Entity>();
  for (const e of entities) map.set(e.id, e);
  return map;
}

// ==========================================
// 4. 测试入口
// ==========================================
function runTests() {
  console.log('=== ElysianVTT 区域触发系统测试 ===\n');

  // ===============================================
  // Scenario A: 触发器注册与基本查询
  // ===============================================
  console.log('[Scenario A] 触发器注册与基本查询');
  {
    const zts = new ZoneTriggerSystem();

    const trigger = zts.register({
      id: 'combat_zone_1',
      center: { x: 5, y: 5, z: 0 },
      radius: 3,
      triggerType: 'COMBAT',
      cooldownTicks: 0,
      oneShot: false,
      active: true,
      payload: { encounterId: 'goblin_patrol' },
    });

    assertEqual(trigger.id, 'combat_zone_1', '触发器 ID 正确');
    assertEqual(trigger.triggerType, 'COMBAT', '触发器类型 COMBAT');
    assertEqual(trigger.radius, 3, '触发器半径 3');
    assert(trigger.active === true, '触发器默认激活');
    assert(trigger.lastTriggeredTick === undefined, 'lastTriggeredTick 初始为 undefined');

    // 查询
    const queried = zts.get('combat_zone_1');
    assert(queried !== undefined, 'get 返回触发器');
    assertEqual(queried!.id, 'combat_zone_1', '查询 ID 正确');

    // 不存在
    const none = zts.get('nonexistent');
    assert(none === undefined, '不存在触发器返回 undefined');
  }

  // ===============================================
  // Scenario B: 区域进入检测 — 实体走入触发区域
  // ===============================================
  console.log('\n[Scenario B] 区域进入检测');
  {
    const zts = new ZoneTriggerSystem();

    zts.register({
      id: 'trap_zone',
      center: { x: 10, y: 10, z: 0 },
      radius: 2,
      triggerType: 'TRAP',
      cooldownTicks: 0,
      oneShot: false,
      active: true,
      payload: { damage: 20, skillCheck: 'REFLEX' },
    });

    const hero = createEntity('hero', 15, 10); // 距离=5 > 半径=2
    const entities = entityMap(hero);

    // 远距离 → 不触发
    const eventsFar = zts.evaluate(entities, 1);
    assertEqual(eventsFar.length, 0, '远距离不触发');

    // 走入区域
    hero.transform.coords = { x: 11, y: 10, z: 0 }; // 距离=1 < 半径=2
    const prevPositions = new Map<EntityId, Vector3D>();
    prevPositions.set('hero', { x: 15, y: 10, z: 0 });

    const eventsIn = zts.evaluate(entities, 2, prevPositions);
    assertEqual(eventsIn.length, 1, '进入区域触发 1 个事件');
    assertEqual(eventsIn[0].triggerId, 'trap_zone', '事件对应的触发器 ID');
    assertEqual(eventsIn[0].eventType, 'TRAP_TRIGGERED', '事件类型 TRAP_TRIGGERED');
    assertEqual(eventsIn[0].triggeredBy, 'hero', '触发者 hero');
    assertEqual(eventsIn[0].tick, 2, '事件 Tick=2');
    assertEqual(eventsIn[0].payload?.damage, 20, '事件携带 payload');
  }

  // ===============================================
  // Scenario C: OneShot — 单次触发后不再触发
  // ===============================================
  console.log('\n[Scenario C] OneShot 触发器');
  {
    const zts = new ZoneTriggerSystem();

    zts.register({
      id: 'one_shot_trap',
      center: { x: 0, y: 0, z: 0 },
      radius: 3,
      triggerType: 'TRAP',
      cooldownTicks: 0,
      oneShot: true,
      active: true,
      payload: { damage: 50 },
    });

    const intruder = createEntity('intruder', 2, 0);
    const entities = entityMap(intruder);

    const prevPos = new Map<EntityId, Vector3D>();
    prevPos.set('intruder', { x: 5, y: 0, z: 0 });

    // 首次触发成功
    const events1 = zts.evaluate(entities, 1, prevPos);
    assertEqual(events1.length, 1, 'OneShot 首次进入触发');
    assertEqual(events1[0].eventType, 'TRAP_TRIGGERED', '事件类型');

    // 继续停在区域内 — 不重复触发
    const prevPos2 = new Map<EntityId, Vector3D>();
    prevPos2.set('intruder', { x: 2, y: 0, z: 0 });
    const events2 = zts.evaluate(entities, 2, prevPos2);
    assertEqual(events2.length, 0, 'OneShot 不重复触发（仍在区域内）');

    // 离开后重新进入 — 也不再触发
    intruder.transform.coords = { x: 5, y: 0, z: 0 };
    const prevPos3 = new Map<EntityId, Vector3D>();
    prevPos3.set('intruder', { x: 2, y: 0, z: 0 });
    const events3 = zts.evaluate(entities, 3, prevPos3);
    assertEqual(events3.length, 0, 'OneShot 离开后重新进入也不触发');
  }

  // ===============================================
  // Scenario D: 冷却时间控制
  // ===============================================
  console.log('\n[Scenario D] 冷却时间控制');
  {
    const zts = new ZoneTriggerSystem();

    zts.register({
      id: 'cooldown_trap',
      center: { x: 0, y: 0, z: 0 },
      radius: 3,
      triggerType: 'TRAP',
      cooldownTicks: 5,
      oneShot: false,
      active: true,
      payload: { damage: 10 },
    });

    const victim = createEntity('victim', 2, 0);
    const entities = entityMap(victim);
    const prevPos = new Map<EntityId, Vector3D>();
    prevPos.set('victim', { x: 5, y: 0, z: 0 });

    // Tick 1: 首次进入，触发
    const events1 = zts.evaluate(entities, 1, prevPos);
    assertEqual(events1.length, 1, '首次进入触发');

    // Tick 2: 还在区域内，但在冷却中
    const prevPos2 = new Map<EntityId, Vector3D>();
    prevPos2.set('victim', { x: 2, y: 0, z: 0 });
    const events2 = zts.evaluate(entities, 2, prevPos2);
    assertEqual(events2.length, 0, '冷却中不触发');

    // Tick 3-5: 仍在冷却
    const events3 = zts.evaluate(entities, 3, prevPos2);
    assertEqual(events3.length, 0, 'Tick3 冷却中');
    const events4 = zts.evaluate(entities, 4, prevPos2);
    assertEqual(events4.length, 0, 'Tick4 冷却中');

    // Tick 6: 冷却结束（距上次触发 >5 Tick）
    // 先让实体离开区域再重新进入
    victim.transform.coords = { x: 5, y: 0, z: 0 };
    const prevLeft = new Map<EntityId, Vector3D>();
    prevLeft.set('victim', { x: 2, y: 0, z: 0 });
    zts.evaluate(entities, 5, prevLeft); // 无 previousPositions 差异，不触发，但用于更新状态

    // 重新进入
    victim.transform.coords = { x: 2, y: 0, z: 0 };
    const prevReEnter = new Map<EntityId, Vector3D>();
    prevReEnter.set('victim', { x: 5, y: 0, z: 0 });
    const events5 = zts.evaluate(entities, 6, prevReEnter);
    assertEqual(events5.length, 1, 'Tick6 冷却结束重新触发');
  }

  // ===============================================
  // Scenario E: 不同触发类型 — COMBAT / DIALOG / TRAP
  // ===============================================
  console.log('\n[Scenario E] 三种触发类型');
  {
    const zts = new ZoneTriggerSystem();

    zts.register({
      id: 'combat_start',
      center: { x: 0, y: 0, z: 0 },
      radius: 5,
      triggerType: 'COMBAT',
      cooldownTicks: 0,
      oneShot: true,
      active: true,
      payload: { encounterId: 'boss_fight' },
    });

    zts.register({
      id: 'dialog_npc',
      center: { x: 10, y: 0, z: 0 },
      radius: 3,
      triggerType: 'DIALOG',
      cooldownTicks: 0,
      oneShot: false,
      active: true,
      payload: { dialogId: 'merchant_greeting' },
    });

    zts.register({
      id: 'pit_trap',
      center: { x: 20, y: 0, z: 0 },
      radius: 2,
      triggerType: 'TRAP',
      cooldownTicks: 10,
      oneShot: false,
      active: true,
      payload: { damage: 30, skillCheck: 'AGILITY' },
    });

    // 验证类型查询
    const combats = zts.getByType('COMBAT');
    assertEqual(combats.length, 1, '1 个 COMBAT 触发器');
    assertEqual(combats[0].id, 'combat_start', 'COMBAT 触发器 ID');

    const dialogs = zts.getByType('DIALOG');
    assertEqual(dialogs.length, 1, '1 个 DIALOG 触发器');
    assertEqual(dialogs[0].id, 'dialog_npc', 'DIALOG 触发器 ID');

    const traps = zts.getByType('TRAP');
    assertEqual(traps.length, 1, '1 个 TRAP 触发器');
    assertEqual(traps[0].id, 'pit_trap', 'TRAP 触发器 ID');

    // 触发 COMBAT
    const hero = createEntity('hero', 3, 0);
    const entities = entityMap(hero);
    const prev = new Map<EntityId, Vector3D>();
    prev.set('hero', { x: 10, y: 0, z: 0 });

    const events = zts.evaluate(entities, 10, prev);
    assert(events.length >= 1, '进入区域触发事件');

    const combatEvent = events.find(e => e.eventType === 'COMBAT_START');
    assert(combatEvent !== undefined, '存在 COMBAT_START 事件');
    assertEqual(combatEvent!.payload?.encounterId, 'boss_fight', '携带 encounterId');
  }

  // ===============================================
  // Scenario F: 停用/重新启用触发器
  // ===============================================
  console.log('\n[Scenario F] 停用/重新启用触发器');
  {
    const zts = new ZoneTriggerSystem();

    zts.register({
      id: 'deactivatable_zone',
      center: { x: 0, y: 0, z: 0 },
      radius: 5,
      triggerType: 'COMBAT',
      cooldownTicks: 0,
      oneShot: false,
      active: true,
    });

    const agent = createEntity('agent', 3, 0);
    const entities = entityMap(agent);
    const prev = new Map<EntityId, Vector3D>();
    prev.set('agent', { x: 10, y: 0, z: 0 });

    // 激活状态：触发
    const eventsActive = zts.evaluate(entities, 1, prev);
    assertEqual(eventsActive.length, 1, '激活状态触发');

    // 停用
    zts.setActive('deactivatable_zone', false);
    const prev2 = new Map<EntityId, Vector3D>();
    prev2.set('agent', { x: 3, y: 0, z: 0 });
    const eventsDeactivated = zts.evaluate(entities, 2, prev2);
    assertEqual(eventsDeactivated.length, 0, '停用后不触发');

    // 重新启用
    zts.setActive('deactivatable_zone', true);
    const prev3 = new Map<EntityId, Vector3D>();
    prev3.set('agent', { x: 10, y: 0, z: 0 });
    agent.transform.coords = { x: 3, y: 0, z: 0 };
    const eventsReactivated = zts.evaluate(entities, 3, prev3);
    assertEqual(eventsReactivated.length, 1, '重新启用后触发');
  }

  // ===============================================
  // Scenario G: 多个实体在多个触发器区域
  // ===============================================
  console.log('\n[Scenario G] 多实体多触发器');
  {
    const zts = new ZoneTriggerSystem();

    zts.register({
      id: 'zone_a',
      center: { x: 0, y: 0, z: 0 },
      radius: 3,
      triggerType: 'COMBAT',
      cooldownTicks: 0,
      oneShot: false,
      active: true,
    });

    zts.register({
      id: 'zone_b',
      center: { x: 10, y: 0, z: 0 },
      radius: 3,
      triggerType: 'TRAP',
      cooldownTicks: 0,
      oneShot: false,
      active: true,
      payload: { damage: 15 },
    });

    const alice = createEntity('alice', 2, 0);   // 在 zone_a
    const bob = createEntity('bob', 9, 0);        // 在 zone_b 边缘
    const entities = entityMap(alice, bob);
    const prev = new Map<EntityId, Vector3D>();
    prev.set('alice', { x: 10, y: 0, z: 0 });
    prev.set('bob', { x: 15, y: 0, z: 0 });

    const events = zts.evaluate(entities, 5, prev);
    assert(events.length >= 1, '多实体触发事件');

    // alice 触发 zone_a
    const aliceEvent = events.find(e => e.triggerId === 'zone_a' && e.triggeredBy === 'alice');
    assert(aliceEvent !== undefined, 'alice 触发 zone_a');

    // bob 从远处走进 zone_b
    bob.transform.coords = { x: 10, y: 0, z: 0 };
    const prev2 = new Map<EntityId, Vector3D>();
    prev2.set('bob', { x: 15, y: 0, z: 0 });  // 上一 Tick 在 zone_b 外
    const events2 = zts.evaluate(entities, 6, prev2);
    const bobEvent = events2.find(e => e.triggerId === 'zone_b' && e.triggeredBy === 'bob');
    assert(bobEvent !== undefined, 'bob 触发 zone_b');
  }

  // ===============================================
  // Scenario H: 注销触发器
  // ===============================================
  console.log('\n[Scenario H] 注销触发器');
  {
    const zts = new ZoneTriggerSystem();

    zts.register({
      id: 'remove_me',
      center: { x: 0, y: 0, z: 0 },
      radius: 10,
      triggerType: 'COMBAT',
      cooldownTicks: 0,
      oneShot: false,
      active: true,
    });

    assert(zts.get('remove_me') !== undefined, '注册后存在');

    const removed = zts.unregister('remove_me');
    assert(removed === true, '注销成功');
    assert(zts.get('remove_me') === undefined, '注销后不存在');

    // 重复注销
    const removedAgain = zts.unregister('remove_me');
    assert(removedAgain === false, '重复注销返回 false');

    // 批量注册
    const defs = zts.registerMany([
      { id: 'batch1', center: { x: 0, y: 0, z: 0 }, radius: 1, triggerType: 'COMBAT' as ZoneTriggerType, cooldownTicks: 0, oneShot: false, active: true },
      { id: 'batch2', center: { x: 0, y: 0, z: 0 }, radius: 1, triggerType: 'DIALOG' as ZoneTriggerType, cooldownTicks: 0, oneShot: true, active: true },
    ]);
    assertEqual(defs.length, 2, '批量注册 2 个');
    assert(zts.get('batch1') !== undefined, 'batch1 存在');
    assert(zts.get('batch2') !== undefined, 'batch2 存在');
  }

  // ===============================================
  // Scenario I: 边界条件 — 空实体 / 空 Map
  // ===============================================
  console.log('\n[Scenario I] 边界条件');
  {
    const zts = new ZoneTriggerSystem();

    // 空实体列表
    const events = zts.evaluate(new Map(), 1);
    assertEqual(events.length, 0, '空实体列表不触发');

    // 触发器在区域外
    zts.register({
      id: 'far_zone',
      center: { x: 100, y: 100, z: 0 },
      radius: 1,
      triggerType: 'COMBAT',
      cooldownTicks: 0,
      oneShot: false,
      active: true,
    });

    const hero = createEntity('hero', 0, 0);
    const entities = entityMap(hero);
    const farEvents = zts.evaluate(entities, 1);
    assertEqual(farEvents.length, 0, '触发器太远不触发');

    // 没有 previousPositions 时的评估
    const heroIn = createEntity('hero2', 0, 0);
    zts.register({
      id: 'here_zone',
      center: { x: 0, y: 0, z: 0 },
      radius: 5,
      triggerType: 'COMBAT',
      cooldownTicks: 0,
      oneShot: false,
      active: true,
    });
    const entities2 = entityMap(heroIn);
    const noPrevEvents = zts.evaluate(entities2, 2);
    assertEqual(noPrevEvents.length, 1, '无 previousPositions 仍能触发（当前位置在区域内）');

    // reset
    zts.reset();
    assertEqual(zts.getAll().length, 0, 'reset 后无触发器');
  }

  // ===============================================
  // Scenario J: 触发器 ID 自动生成
  // ===============================================
  console.log('\n[Scenario J] 自动生成 ID');
  {
    const zts = new ZoneTriggerSystem();
    const auto = zts.register({
      center: { x: 0, y: 0, z: 0 },
      radius: 1,
      triggerType: 'COMBAT',
      cooldownTicks: 0,
      oneShot: false,
      active: true,
    });
    assert(auto.id !== undefined && auto.id.length > 0, '自动生成 ID 非空');
    assert(auto.id !== '', '自动生成 ID 非空串');

    const found = zts.get(auto.id);
    assert(found !== undefined, '可通过自动生成的 ID 查询');
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有区域触发测试通过!');
}

runTests();
