// test/engine.integration.test.ts
// 集成测试：直接引用生产代码验证 CombatEngine + ClashPool 端到端可用性

import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { ClashPool } from '../packages/backend/src/core/engine/ClashPool.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';
import { generateId } from '../packages/backend/src/utils/IdGenerator.js';
import type {
  Entity,
  ActionTemplate,
  ClientIntent,
  DecisionPollPayload,
  StateMutationPayload
} from '../packages/shared/src/index.js';

// ==========================================
// Helper: 向 Dictionary 注入测试技能模板
// ==========================================
function registerTestAction(template: ActionTemplate) {
  Dictionary.registerAction(template);
}

function createEngine(sceneId: string): CombatEngine {
  const engine = new CombatEngine(sceneId);
  // 非交互集成场景明确选择 PASS；生产引擎会等待未响应的决策。
  engine.on('DECISION_POLL', (poll: DecisionPollPayload) => {
    engine.handleDecisionResponse({ windowId: poll.windowId, chosenOptionId: null }, 'integration-default');
  });
  return engine;
}
function makeEntity(id: string, hp: number = 100, poise: number = 50): Entity {
  return {
    id,
    templateId: 'unit',
    type: 'ACTOR',
    transform: { coords: { x: 0, y: 0, z: 0 }, planeId: '0', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 1, mass: 1, movementModes: [] },
    resources: { current: { hp, poise }, max: { hp, poise } },
    activeEffects: []
  };
}

function addFocus(e: Entity, fp: number = 50): Entity {
  (e.resources.current as any).focus = fp;
  (e.resources.max as any).focus = fp;
  return e;
}

function addArmor(e: Entity, dr: number): Entity {
  (e.resources.current as any).armor = dr;
  return e;
}

// ==========================================
// 集成测试框架
// ==========================================
let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
  testCount++;
  if (cond) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}

// ============================================================
// 测试 1: 直接测试 ClashPool.resolve() 核心逻辑
// ============================================================
console.log('[Test 1] ClashPool.resolve() 直接调用 - 相杀场景');
{
  registerTestAction({
    id: 'LETHAL_STRIKE',
    tags: ['ATTACK'],
    timeCost: { startupTicks: 10, recoveryTicks: 5 },
    resourceCost: {},
    range: { type: 'MELEE', distanceExpr: '1' },
    effects: [
      { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '100' } }
    ],
    priorityExpr: '10',
    diceRules: []
  } as ActionTemplate);

  const spearman = makeEntity('spearman', 30, 50);
  const thief = makeEntity('thief', 20, 30);

  const entities = new Map<string, Entity>();
  entities.set('spearman', spearman);
  entities.set('thief', thief);

  const evt1Id = generateId();
  const evt2Id = generateId();
  const targetTick = 10;

  const evt1: any = {
    eventId: evt1Id, eventType: 'ACTION_PHASE', targetTick,
    status: 'PENDING', actorId: 'spearman', targetIds: ['thief'],
    actionTemplateId: 'LETHAL_STRIKE', phase: 'STARTUP'
  };

  const evt2: any = {
    eventId: evt2Id, eventType: 'ACTION_PHASE', targetTick,
    status: 'PENDING', actorId: 'thief', targetIds: ['spearman'],
    actionTemplateId: 'LETHAL_STRIKE', phase: 'STARTUP'
  };

  (spearman as any).currentActionContext = {
    type: 'CASTING', actionId: evt1Id, actionTemplateId: 'LETHAL_STRIKE',
    phase: 'STARTUP', resolveTick: targetTick
  };
  (thief as any).currentActionContext = {
    type: 'CASTING', actionId: evt2Id, actionTemplateId: 'LETHAL_STRIKE',
    phase: 'STARTUP', resolveTick: targetTick
  };

  const template = Dictionary.getAction('LETHAL_STRIKE');
  console.log(`  [DEBUG] Template=${template?.id}, Effects=${template?.effects.length}`);

  const result = ClashPool.resolve([evt1, evt2], entities, targetTick, 2.0);

  console.log(`  [DEBUG] Result: deaths=${result.deaths.length}, mutations=${result.mutations.length}, mutualKillPairs=${result.mutualKillPairs.length}`);
  console.log(`  [DEBUG] spearman HP=${entities.get('spearman')!.resources.current.hp}, thief HP=${entities.get('thief')!.resources.current.hp}`);

  assert(result.deaths.length === 2, `两个角色都死亡 (${result.deaths.length})`);
  assert(result.mutualKillPairs.length === 1, `检测到相杀 (${result.mutualKillPairs.length})`);
  assert(entities.get('spearman')!.resources.current.hp <= 0, `spearman HP=${entities.get('spearman')!.resources.current.hp} <= 0`);
  assert(entities.get('thief')!.resources.current.hp <= 0, `thief HP=${entities.get('thief')!.resources.current.hp} <= 0`);
}

// ============================================================
// 测试 2: Dictionary 加载与查询
// ============================================================
console.log('\n[Test 2] Dictionary 模板查询');
{
  const action = Dictionary.getAction('LETHAL_STRIKE');
  assert(action !== undefined, 'LETHAL_STRIKE 模板已注册');
  assert(action?.priorityExpr === '10', 'priorityExpr 正确');
  assert(action?.sustainResources === undefined, 'sustainResources 未定义');
}

// ============================================================
// 测试 3: CombatEngine 实例创建与实体管理
// ============================================================
console.log('\n[Test 3] CombatEngine 实例创建与实体挂载');
{
  const engine = createEngine('scene-3');
  assert(engine.engineId === 'scene-3', 'engineId 正确');
  assert(engine.engineType === 'COMBAT', 'engineType 正确');

  const actor1 = makeEntity('actor1', 100, 50);
  const actor2 = makeEntity('actor2', 80, 40);

  engine.mountEntities([actor1, actor2]);
  const allEntities = engine.getAllEntities();

  assert(allEntities.length === 2, `实体挂载成功 (${allEntities.length})`);
  assert(allEntities.some(e => e.id === 'actor1'), 'actor1 已挂载');
  assert(allEntities.some(e => e.id === 'actor2'), 'actor2 已挂载');
}

// ============================================================
// 测试 4: 三角色多优先级 Clash 分组
// ============================================================
console.log('\n[Test 4] 三角色多优先级 Clash 分组');
{
  registerTestAction({
    id: 'HIGH_PRIO_STRIKE', tags: ['ATTACK'],
    timeCost: { startupTicks: 5, recoveryTicks: 3 },
    resourceCost: {}, range: { type: 'MELEE', distanceExpr: '2' },
    effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '30' } }],
    priorityExpr: '30', diceRules: []
  } as ActionTemplate);

  registerTestAction({
    id: 'LOW_PRIO_STRIKE', tags: ['ATTACK'],
    timeCost: { startupTicks: 5, recoveryTicks: 3 },
    resourceCost: {}, range: { type: 'MELEE', distanceExpr: '2' },
    effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '20' } }],
    priorityExpr: '5', diceRules: []
  } as ActionTemplate);

  const entities = new Map<string, Entity>();
  const fast = makeEntity('fast_killer', 100, 50);
  const slow1 = makeEntity('slow_1', 60, 50);
  const slow2 = makeEntity('slow_2', 60, 50);
  entities.set('fast_killer', fast);
  entities.set('slow_1', slow1);
  entities.set('slow_2', slow2);

  const tTick = 10;
  function makeEvt(id: string, actor: string, target: string, template: string) {
    (entities.get(actor) as any).currentActionContext = {
      type: 'CASTING', actionId: id, actionTemplateId: template,
      phase: 'STARTUP', resolveTick: tTick
    };
    return {
      eventId: id, eventType: 'ACTION_PHASE', targetTick: tTick,
      status: 'PENDING', actorId: actor, targetIds: [target],
      actionTemplateId: template, phase: 'STARTUP'
    } as any;
  }

  const events = [
    makeEvt('e1', 'fast_killer', 'slow_1', 'HIGH_PRIO_STRIKE'),
    makeEvt('e2', 'slow_1', 'fast_killer', 'LOW_PRIO_STRIKE'),
    makeEvt('e3', 'slow_2', 'fast_killer', 'LOW_PRIO_STRIKE'),
  ];

  const result = ClashPool.resolve(events, entities, tTick, 2.0);

  // fast_killer 高优先级先出手，slow_1 应受大量伤害
  const slow1Hp = entities.get('slow_1')!.resources.current.hp;
  const fastHp = entities.get('fast_killer')!.resources.current.hp;
  assert(slow1Hp <= 30, `slow_1 受高优先级攻击 HP=${slow1Hp}`);
  // slow 组两人各 20 伤害攻击 fast_killer
  assert(fastHp <= 60, `fast_killer 受低优先级攻击 HP=${fastHp}`);
  assert(result.mutations.length >= 2, `产生状态变更: ${result.mutations.length}`);
}

// ============================================================
// 测试 5: ClashPool 单事件无冲突
// ============================================================
console.log('\n[Test 5] ClashPool 单事件无冲突');
{
  const entities = new Map<string, Entity>();
  const a = makeEntity('solo', 100, 50);
  const b = makeEntity('target', 50, 50);
  entities.set('solo', a);
  entities.set('target', b);

  const tick = 10;
  (a as any).currentActionContext = {
    type: 'CASTING', actionId: 'e1', actionTemplateId: 'HIGH_PRIO_STRIKE',
    phase: 'STARTUP', resolveTick: tick
  };
  const evt = {
    eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: tick,
    status: 'PENDING', actorId: 'solo', targetIds: ['target'],
    actionTemplateId: 'HIGH_PRIO_STRIKE', phase: 'STARTUP'
  } as any;

  const result = ClashPool.resolve([evt], entities, tick, 2.0);
  assert(result.mutations.length > 0, '单事件产生状态变更');
  assert(result.mutualKillPairs.length === 0, '无相杀');
  const hpLeft = entities.get('target')!.resources.current.hp;
  assert(hpLeft < 50, `目标受伤害 HP=${hpLeft}`);
}

// ============================================================
// 测试 6: ClashPool 伤害下限为 0
// ============================================================
console.log('\n[Test 6] ClashPool 伤害下限为 0');
{
  registerTestAction({
    id: 'OVERKILL', tags: ['ATTACK'],
    timeCost: { startupTicks: 5, recoveryTicks: 3 },
    resourceCost: {}, range: { type: 'MELEE', distanceExpr: '2' },
    effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '999' } }],
    priorityExpr: '10', diceRules: []
  } as ActionTemplate);

  const entities = new Map<string, Entity>();
  const a = makeEntity('overkiller', 100, 50);
  const b = makeEntity('victim', 30, 50);
  entities.set('overkiller', a);
  entities.set('victim', b);

  const tick = 10;
  (a as any).currentActionContext = {
    type: 'CASTING', actionId: 'e1', actionTemplateId: 'OVERKILL',
    phase: 'STARTUP', resolveTick: tick
  };
  const evt = {
    eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: tick,
    status: 'PENDING', actorId: 'overkiller', targetIds: ['victim'],
    actionTemplateId: 'OVERKILL', phase: 'STARTUP'
  } as any;

  ClashPool.resolve([evt], entities, tick, 2.0);
  const hp = entities.get('victim')!.resources.current.hp;
  assert(hp === 0, `伤害下限为 0, HP=${hp}`);
}

// ============================================================
// 测试 7: CombatEngine MOVE 意图
// ============================================================
console.log('\n[Test 7] CombatEngine MOVE 意图');
{
  const engine = createEngine('scene-move');
  const mover = makeEntity('mover', 100, 50);
  mover.transform.coords = { x: 0, y: 0, z: 0 };
  engine.mountEntities([mover]);

  const scheduled: any[] = [];
  engine.on('ACTION_SCHEDULED', (p: any) => scheduled.push(p));

  engine.receiveIntent({
    actorId: 'mover', intentType: 'MOVE', clientTick: 0,
    payload: { targetCoords: { x: 5, y: 0, z: 0 } }
  } as any);

  assert(scheduled.length === 1, 'MOVE 调度了 ACTION_SCHEDULED');
  assert(scheduled[0].tags?.includes('MOVEMENT'), '事件含 MOVEMENT 标签');
  assert(scheduled[0].actionName === 'Move', 'actionName = Move');
  assert(mover.currentActionContext === undefined, '移动完成后上下文清除');
  assert(Math.abs(mover.transform.coords.x - 5) < 0.01, `移动到 x=5, 实际 ${mover.transform.coords.x}`);
}

// ============================================================
// 测试 8: CombatEngine CANCEL_ACTION
// ============================================================
console.log('\n[Test 8] CombatEngine CANCEL_ACTION');
{
  const engine = createEngine('scene-cancel');
  engine.setAutoProcess(false);
  const hero = makeEntity('cancel_hero', 100, 50);
  const dummy = makeEntity('cancel_dummy', 999, 50);

  // makeEntity 签名不支持动态坐标, 手动设置
  dummy.transform.coords = { x: 3, y: 0, z: 0 };
  engine.mountEntities([hero, dummy]);

  engine.receiveIntent({
    actorId: 'cancel_hero', intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'LETHAL_STRIKE', targetIds: ['cancel_dummy'] }
  } as any);

  // 在动作执行前取消
  engine.receiveIntent({
    actorId: 'cancel_hero', intentType: 'CANCEL_ACTION', clientTick: 0,
    payload: {}
  } as any);

  assert(hero.currentActionContext?.phase === 'RECOVERY', '取消动作进入收招');
  engine.processPending();
  assert(hero.currentActionContext === undefined, '取消后的收招完成');
  const hp = dummy.resources.current.hp;
  assert(hp === 999, `取消后 dummy HP 仍为 999, 实际 ${hp}`);
}

// ============================================================
// 测试 9: CombatEngine DEFEND 意图
// ============================================================
console.log('\n[Test 9] CombatEngine DEFEND 意图');
{
  registerTestAction({
    id: 'PARRY', tags: ['DEFENSE'],
    timeCost: { startupTicks: 3, recoveryTicks: 4 },
    resourceCost: { poise: '15' },
    range: { type: 'SELF', distanceExpr: '0' },
    effects: [],
    priorityExpr: '20', diceRules: []
  } as ActionTemplate);

  const engine = createEngine('scene-parry');
  const defender = makeEntity('parry_hero', 100, 50);
  engine.mountEntities([defender]);

  const scheduled: any[] = [];
  engine.on('ACTION_SCHEDULED', (p: any) => scheduled.push(p));

  engine.receiveIntent({
    actorId: 'parry_hero', intentType: 'DEFEND', clientTick: 0,
    payload: {}
  } as any);

  assert(scheduled.length >= 1, 'DEFEND 触发 ACTION_SCHEDULED');
  assert(defender.resources.current.poise < 50, `DEFEND 消耗 PP, poise=${defender.resources.current.poise}`);
}

// ============================================================
// 测试 10: CombatEngine BATCH_CAST 多角色同时行动
// ============================================================
console.log('\n[Test 10] BATCH_CAST 多角色同时行动');
{
  registerTestAction({
    id: 'BATCH_TEST_STRIKE', tags: ['ATTACK'],
    timeCost: { startupTicks: 5, recoveryTicks: 3 },
    resourceCost: {}, range: { type: 'MELEE', distanceExpr: '3' },
    effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '15' } }],
    priorityExpr: '10', diceRules: []
  } as ActionTemplate);

  const engine = createEngine('scene-batch');
  const a = makeEntity('batch_a', 50, 50);
  const b = makeEntity('batch_b', 50, 50);
  b.transform.coords = { x: 2, y: 0, z: 0 };
  engine.mountEntities([a, b]);

  const scheduled: any[] = [];
  engine.on('ACTION_SCHEDULED', (p: any) => scheduled.push(p));

  engine.receiveIntent({
    actorId: '__batch__', intentType: 'BATCH_CAST', clientTick: 0,
    payload: {
      batchIntents: [
        { actorId: 'batch_a', actionTemplateId: 'BATCH_TEST_STRIKE', targetIds: ['batch_b'] },
        { actorId: 'batch_b', actionTemplateId: 'BATCH_TEST_STRIKE', targetIds: ['batch_a'] }
      ]
    }
  } as any);

  assert(scheduled.length === 2, `BATCH_CAST 调度 2 个动作, 实际 ${scheduled.length}`);

  const ahp = a.resources.current.hp;
  const bhp = b.resources.current.hp;
  assert(ahp < 50, `batch_a 受到伤害 HP=${ahp}`);
  assert(bhp < 50, `batch_b 受到伤害 HP=${bhp}`);
}

// ============================================================
// 测试 11: STATE_MUTATED 事件广播
// ============================================================
console.log('\n[Test 11] STATE_MUTATED 事件广播');
{
  const engine = createEngine('scene-state');
  const attacker = makeEntity('state_atk', 100, 50);
  const victim = makeEntity('state_vic', 50, 50);
  victim.transform.coords = { x: 2, y: 0, z: 0 };
  engine.mountEntities([attacker, victim]);

  const mutations: any[] = [];
  engine.on('STATE_MUTATED', (p: any) => mutations.push(p));

  engine.receiveIntent({
    actorId: 'state_atk', intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'BATCH_TEST_STRIKE', targetIds: ['state_vic'] }
  } as any);

  assert(mutations.length > 0, `STATE_MUTATED 至少广播 1 次, 实际 ${mutations.length}`);

  const allChanges = mutations.flatMap((m: any) => m.mutations || []);
  const hpChanges = allChanges.filter((m: any) =>
    m.entityId === 'state_vic' && m.changes?.['resources.current.hp'] !== undefined
  );
  assert(hpChanges.length > 0, 'victim 的 HP 变更被广播');
}

// ============================================================
// 测试 12: 同一实体连续两次动作
// ============================================================
console.log('\n[Test 12] 同一实体连续两次动作');
{
  const engine = createEngine('scene-double');
  const hero = makeEntity('double_hero', 100, 50);
  const target = makeEntity('double_target', 200, 50);
  target.transform.coords = { x: 2, y: 0, z: 0 };
  engine.mountEntities([hero, target]);

  engine.on('DECISION_POLL', (poll: DecisionPollPayload) => {
    engine.handleDecisionResponse({ windowId: poll.windowId, chosenOptionId: 'DO_NOTHING' }, 'integration-test-12');
  });

  engine.receiveIntent({
    actorId: 'double_hero', intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'BATCH_TEST_STRIKE', targetIds: ['double_target'] }
  } as any);

  engine.receiveIntent({
    actorId: 'double_hero', intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'BATCH_TEST_STRIKE', targetIds: ['double_target'] }
  } as any);

  const expectedHp = 200 - 15 - 15;
  assert(target.resources.current.hp <= expectedHp,
    `两次攻击后 HP=${target.resources.current.hp} <= ${expectedHp}`);
  assert(hero.currentActionContext === undefined, '英雄上下文已清除');
}

// ============================================================
// 测试 13: unmountEntities 实体管理
// ============================================================
console.log('\n[Test 13] unmountEntities 实体卸载');
{
  const engine = createEngine('scene-unmount');
  const e1 = makeEntity('um_1', 100, 50);
  const e2 = makeEntity('um_2', 100, 50);
  const e3 = makeEntity('um_3', 100, 50);
  engine.mountEntities([e1, e2, e3]);

  assert(engine.getAllEntities().length === 3, '挂载 3 实体');

  const removed = engine.unmountEntities(['um_1', 'um_3']);
  assert(removed.length === 2, `卸载 2 实体, 实际 ${removed.length}`);
  assert(engine.getAllEntities().length === 1, '剩余 1 实体');
  assert(engine.getAllEntities()[0].id === 'um_2', '剩余 um_2');
}

// ============================================================
// 测试 14: 未挂载实体发送 intent（容错）
// ============================================================
console.log('\n[Test 14] 未挂载实体发送 intent 不崩溃');
{
  const engine = createEngine('scene-ghost');
  try {
    engine.receiveIntent({
      actorId: 'ghost', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'LETHAL_STRIKE', targetIds: ['ghost'] }
    } as any);
    assert(true, '未挂载实体 intent 不抛异常');
  } catch (e) {
    assert(false, `抛异常: ${e}`);
  }
}

// ============================================================
// 测试 15: 重复实体挂载（幂等性）
// ============================================================
console.log('\n[Test 15] 重复实体挂载');
{
  const engine = createEngine('scene-dupe');
  const hero = makeEntity('dupe_hero', 100, 50);
  engine.mountEntities([hero]);
  const count1 = engine.getAllEntities().length;
  engine.mountEntities([hero]); // 再次挂载
  const count2 = engine.getAllEntities().length;
  assert(count2 >= count1, '重复挂载不减少实体数');
}

// ============================================================
// 测试 16: CombatEngine DODGE 意图
// ============================================================
console.log('\n[Test 16] CombatEngine DODGE 意图');
{
  registerTestAction({
    id: 'DODGE', tags: ['MOBILITY', 'DEFENSE'],
    timeCost: { startupTicks: 2, recoveryTicks: 8 },
    resourceCost: { focus: '10' },
    range: { type: 'SELF', distanceExpr: '0' },
    effects: [],
    priorityExpr: '15'
  } as ActionTemplate);

  const engine = createEngine('scene-dodge');
  engine.setAutoProcess(false);
  const hero = makeEntity('dodge_hero', 100, 50);
  addFocus(hero, 50);
  hero.transform.coords = { x: 0, y: 0, z: 0 };
  engine.mountEntities([hero]);

  engine.receiveIntent({
    actorId: 'dodge_hero', intentType: 'DODGE', clientTick: 0,
    payload: { targetCoords: { x: 1.5, y: 0, z: 0 } }
  } as any);

  assert(Math.abs(hero.transform.coords.x - 1.5) < 0.01, `DODGE 移动到 x=1.5, 实际 ${hero.transform.coords.x}`);
  assert(hero.resources.current.focus === 40, `DODGE 消耗 FP, focus=${hero.resources.current.focus}`);
  assert(hero.currentActionContext?.actionTemplateId === 'DODGE', 'DODGE 上下文已设置');
  assert(hero.currentActionContext?.phase === 'ACTIVE', 'DODGE 阶段为 ACTIVE');
  engine.processPending();
  assert(hero.currentActionContext === undefined, 'DODGE 收招完成后清除上下文');
}

// ============================================================
// 测试 17: CombatEngine INTERACT 意图 + VISUAL_FX 事件
// ============================================================
console.log('\n[Test 17] CombatEngine INTERACT 意图 + VISUAL_FX');
{
  const engine = createEngine('scene-interact');
  const hero = makeEntity('interact_hero', 100, 50);
  const npc = makeEntity('interact_npc', 50, 50);
  engine.mountEntities([hero, npc]);

  const visualFx: any[] = [];
  engine.on('VISUAL_FX', (p: any) => visualFx.push(p));

  engine.receiveIntent({
    actorId: 'interact_hero', intentType: 'INTERACT', clientTick: 0,
    payload: { targetIds: ['interact_npc'] }
  } as any);

  assert(visualFx.length === 1, `VISUAL_FX 广播 1 次, 实际 ${visualFx.length}`);
  assert(visualFx[0].events?.[0]?.eventType === 'UI_FLOATING_TEXT', '事件类型为 UI_FLOATING_TEXT');
  assert(visualFx[0].events?.[0]?.sourceId === 'interact_hero', 'sourceId 正确');
  assert(visualFx[0].events?.[0]?.targetId === 'interact_npc', 'targetId 正确');
}

// ============================================================
// 测试 18: CombatEngine MICRO_EVADE 意图
// ============================================================
console.log('\n[Test 18] CombatEngine MICRO_EVADE 意图');
{
  const engine = createEngine('scene-evade');
  engine.setAutoProcess(false);
  const hero = makeEntity('evade_hero', 100, 50);
  addFocus(hero, 50);
  engine.mountEntities([hero]);

  engine.receiveIntent({
    actorId: 'evade_hero', intentType: 'MICRO_EVADE', clientTick: 0,
    payload: { evadeSubType: 'DUCK' }
  } as any);

  assert(hero.currentActionContext?.actionTemplateId === 'MICRO_EVADE_DUCK', '微闪避 DUCK 上下文');
  assert(hero.currentActionContext?.phase === 'ACTIVE', '微闪避阶段为 ACTIVE');
  assert(hero.resources.current.focus === 45, `微闪避消耗 5 FP, focus=${hero.resources.current.focus}`);
  engine.processPending();
  assert(hero.currentActionContext === undefined, '微闪避收招完成后清除上下文');
}

// ============================================================
// 测试 19: CombatEngine PRIORITY_TOGGLE 意图
// ============================================================
console.log('\n[Test 19] CombatEngine PRIORITY_TOGGLE 意图');
{
  const engine = createEngine('scene-toggle');
  const hero = makeEntity('toggle_hero', 100, 50);
  engine.mountEntities([hero]);

  engine.receiveIntent({
    actorId: 'toggle_hero', intentType: 'PRIORITY_TOGGLE', clientTick: 0,
    payload: { toggleMode: 'PASS_ALL' }
  } as any);

  const toggles = (engine as any).playerToggles;
  assert(toggles.get('toggle_hero') === 'PASS_ALL', 'PASS_ALL 模式已设置');

  engine.receiveIntent({
    actorId: 'toggle_hero', intentType: 'PRIORITY_TOGGLE', clientTick: 0,
    payload: { toggleMode: 'TARGET_ONLY' }
  } as any);
  assert(toggles.get('toggle_hero') === 'TARGET_ONLY', 'TARGET_ONLY 模式已切换');
}

// ============================================================
// 测试 20: CombatEngine HOOK_PRESET 意图
// ============================================================
console.log('\n[Test 20] CombatEngine HOOK_PRESET 意图');
{
  const engine = createEngine('scene-hook');
  const hero = makeEntity('hook_hero', 100, 50);
  engine.mountEntities([hero]);

  engine.receiveIntent({
    actorId: 'hook_hero', intentType: 'HOOK_PRESET', clientTick: 0,
    payload: {
      hookPreset: {
        id: 'hook_test_001',
        label: '测试钩子',
        enabled: true,
        trigger: { type: 'TICK_REACHED', targetTick: 50 }
      }
    }
  } as any);

  const registry = (engine as any).hookRegistry;
  const hasHook = registry?.hooks?.has?.('hook_hero') ?? false;
  assert(hasHook, 'HOOK_PRESET 注册成功');
}

// ============================================================
// 测试 21: COMBAT_END 事件广播
// ============================================================
console.log('\n[Test 21] COMBAT_END 事件广播');
{
  registerTestAction({
    id: 'KILL_STRIKE', tags: ['ATTACK'],
    timeCost: { startupTicks: 3, recoveryTicks: 2 },
    resourceCost: {}, range: { type: 'MELEE', distanceExpr: '3' },
    effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '100' } }],
    priorityExpr: '10', diceRules: []
  } as ActionTemplate);

  const engine = createEngine('scene-end');
  const hero = makeEntity('end_hero', 100, 50);
  const enemy = makeEntity('end_enemy', 1, 10);
  enemy.transform.coords = { x: 2, y: 0, z: 0 };
  engine.mountEntities([hero, enemy]);

  const combatEnds: any[] = [];
  engine.on('COMBAT_END', (p: any) => combatEnds.push(p));

  engine.receiveIntent({
    actorId: 'end_hero', intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'KILL_STRIKE', targetIds: ['end_enemy'] }
  } as any);

  assert(combatEnds.length === 1, `COMBAT_END 广播 1 次, 实际 ${combatEnds.length}`);
  assert(combatEnds[0]?.sceneId === 'scene-end', 'sceneId 正确');
  assert(combatEnds[0]?.survivors?.includes('end_hero'), '英雄在 survivors 中');
  assert(combatEnds[0]?.casualties?.includes('end_enemy'), '敌人在 casualties 中');
  assert(enemy.resources.current.hp <= 0, `敌人 HP=${enemy.resources.current.hp} <= 0`);
}

// ============================================================
// 测试 22: HEAL 效果通过 CombatEngine
// ============================================================
console.log('\n[Test 22] HEAL 效果');
{
  registerTestAction({
    id: 'TEST_HEAL', tags: ['BUFF'],
    timeCost: { startupTicks: 3, recoveryTicks: 2 },
    resourceCost: {}, range: { type: 'SELF', distanceExpr: '0' },
    effects: [{ type: 'HEAL', targetSelector: 'SELF', parameters: { resource: 'hp', amountExpr: '30' } }],
    priorityExpr: '5', diceRules: []
  } as ActionTemplate);

  const engine = createEngine('scene-heal');
  const hero = makeEntity('heal_hero', 50, 50);
  hero.resources.max.hp = 100; // 留出治愈空间
  engine.mountEntities([hero]);

  engine.receiveIntent({
    actorId: 'heal_hero', intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'TEST_HEAL' }
  } as any);

  assert(hero.resources.current.hp === 80, `治愈后 HP=80, 实际 ${hero.resources.current.hp}`);
  assert(hero.currentActionContext === undefined, '动作上下文已清除');
}

// ============================================================
// 测试 23: 伤害减免 DR 效果
// ============================================================
console.log('\n[Test 23] 伤害减免 DR');
{
  registerTestAction({
    id: 'DR_TEST_STRIKE', tags: ['ATTACK'],
    timeCost: { startupTicks: 3, recoveryTicks: 2 },
    resourceCost: {}, range: { type: 'MELEE', distanceExpr: '3' },
    effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '50' } }],
    priorityExpr: '10', diceRules: []
  } as ActionTemplate);

  const engine = createEngine('scene-dr');
  const attacker = makeEntity('dr_atk', 100, 50);
  const armored = makeEntity('dr_armored', 100, 50);
  addArmor(armored, 20); // DR 20 减免
  armored.transform.coords = { x: 2, y: 0, z: 0 };
  engine.mountEntities([attacker, armored]);

  engine.receiveIntent({
    actorId: 'dr_atk', intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'DR_TEST_STRIKE', targetIds: ['dr_armored'] }
  } as any);

  // 50 伤害 - 20 DR = 30 实际伤害, HP = 100 - 30 = 70
  assert(armored.resources.current.hp === 70, `DR 减免后 HP=70, 实际 ${armored.resources.current.hp}`);
}

// ============================================================
// 测试 24: 挥空 Whiff — 目标超出射程
// ============================================================
console.log('\n[Test 24] 挥空 Whiff — 目标超出射程');
{
  const engine = createEngine('scene-whiff');
  const attacker = makeEntity('whiff_atk', 100, 50);
  const farTarget = makeEntity('whiff_target', 50, 50);
  farTarget.transform.coords = { x: 100, y: 0, z: 0 }; // 远超射程
  engine.mountEntities([attacker, farTarget]);

  engine.receiveIntent({
    actorId: 'whiff_atk', intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'BATCH_TEST_STRIKE', targetIds: ['whiff_target'] }
  } as any);

  assert(farTarget.resources.current.hp === 50, `挥空后目标 HP 不变, 实际 ${farTarget.resources.current.hp}`);
  // 挥空后进入 RECOVERY 阶段（上下文设为 undefined 在 RECOVERY 事件处理时）
  assert(attacker.currentActionContext === undefined, '攻击者挥空后完成收招');
  assert(attacker.currentActionContext?.phase === 'RECOVERY' || attacker.currentActionContext === undefined,
    `攻击者处于收招或已清除`);
}

// ============================================================
// 测试 25: Channeling 引导施法多脉冲
// ============================================================
console.log('\n[Test 25] Channeling 引导施法多脉冲');
{
  registerTestAction({
    id: 'TEST_CHANNEL', tags: ['SPELL', 'CHANNEL'],
    timeCost: { startupTicks: 5, recoveryTicks: 3 },
    resourceCost: { focus: '10' },
    range: { type: 'MELEE', distanceExpr: '3' },
    effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '10' } }],
    priorityExpr: '10', diceRules: [],
    channelOptions: { intervalTicks: 4, maxPulses: 3 },
    sustainResources: ['focus']
  } as ActionTemplate);

  const engine = createEngine('scene-channel');
  const caster = makeEntity('channel_caster', 100, 50);
  addFocus(caster, 50);
  const target = makeEntity('channel_target', 100, 50);
  target.transform.coords = { x: 2, y: 0, z: 0 };
  engine.mountEntities([caster, target]);

  const mutations: any[] = [];
  engine.on('STATE_MUTATED', (p: any) => mutations.push(p));
  engine.on('DECISION_POLL', (poll: DecisionPollPayload) => {
    engine.handleDecisionResponse({ windowId: poll.windowId, chosenOptionId: 'DO_NOTHING' }, 'integration-test-25');
  });

  engine.receiveIntent({
    actorId: 'channel_caster', intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'TEST_CHANNEL', targetIds: ['channel_target'] }
  } as any);

  // 3 次脉冲各 10 伤害 = 30, HP = 100 - 30 = 70
  assert(target.resources.current.hp === 70, `引导后目标 HP=70, 实际 ${target.resources.current.hp}`);
  assert(caster.currentActionContext === undefined, '引导完成后上下文清除');
  assert(mutations.length > 0, `STATE_MUTATED 广播 ${mutations.length} 次`);
}

// ============================================================
// 测试 26: Sustain 资源中断 — 引导中资源耗尽
// ============================================================
console.log('\n[Test 26] Sustain 资源中断 — 引导中资源耗尽');
{
  const engine = createEngine('scene-sustain');
  const caster = makeEntity('sustain_caster', 100, 50);
  addFocus(caster, 3); // 仅够开始引导但不足以维持后续脉冲
  const target = makeEntity('sustain_target', 200, 50);
  target.transform.coords = { x: 2, y: 0, z: 0 };
  engine.mountEntities([caster, target]);

  const mutations: StateMutationPayload[] = [];
  const decisionPolls: DecisionPollPayload[] = [];
  engine.on('STATE_MUTATED', (p: StateMutationPayload) => mutations.push(p));
  engine.on('DECISION_POLL', (poll: DecisionPollPayload) => {
    decisionPolls.push(poll);
    engine.handleDecisionResponse({ windowId: poll.windowId, chosenOptionId: 'DO_NOTHING' }, 'integration-test-26');
  });

  engine.receiveIntent({
    actorId: 'sustain_caster', intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'TEST_CHANNEL', targetIds: ['sustain_target'] }
  } as any);

  // 第一次脉冲应该成功（10 伤害），后续脉冲因 focus 耗尽被中断
  assert(target.resources.current.hp === 190, `目标仅受到一次伤害 HP=${target.resources.current.hp}`);
  assert(decisionPolls.length > 0, `系统 Hook 已通过 DECISION_POLL 暴露, 实际 ${decisionPolls.length}`);
  const recoveryMutation = mutations.find((p) => p.mutations.some((m) =>
    m.entityId === 'sustain_caster' && m.changes?.currentActionContext?.phase === 'RECOVERY'));
  const clearedMutation = mutations.find((p) => p.mutations.some((m) =>
    m.entityId === 'sustain_caster' && m.changes?.currentActionContext === null));
  assert(recoveryMutation !== undefined, '活体 STARTUP 中断广播 RECOVERY');
  assert(clearedMutation !== undefined, '收招完成后广播 currentActionContext=null');
  assert(recoveryMutation !== undefined && clearedMutation !== undefined && recoveryMutation.tick < clearedMutation.tick,
    'STARTUP 的 RECOVERY 广播早于最终 null');
  const recoveryContext = recoveryMutation?.mutations.find((m) => m.entityId === 'sustain_caster')?.changes.currentActionContext;
  assert(clearedMutation !== undefined && recoveryContext?.resolveTick === clearedMutation.tick,
    'STARTUP 最终 null tick 等于预期收招完成 tick');
  assert(caster.currentActionContext === undefined, '施法者收招后上下文清除（被中断）');
  assert(engine.getPendingDecisionCount() === 0, 'Test 26 系统 Hook 已清理');
}

// ============================================================
// 生产回归：真实 CombatEngine 的 CHANNELING 中断必须经过 RECOVERY
// ============================================================
console.log('\n[Regression] 真实 CombatEngine CHANNELING 中断 → RECOVERY → null');
{
  registerTestAction({
    id: 'REAL_CHANNEL_INTERRUPT', tags: ['SPELL', 'CHANNEL'],
    timeCost: { startupTicks: 1, recoveryTicks: 3 },
    resourceCost: {}, range: { type: 'MELEE', distanceExpr: '3' },
    effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '5' } }],
    priorityExpr: '10', diceRules: [],
    channelOptions: {
      intervalTicks: 1,
      maxPulses: 3,
      pulseResourceCost: { focus: '5' }
    },
    sustainResources: ['focus']
  } as ActionTemplate);

  const engine = createEngine('scene-real-channel-interrupt');
  const caster = makeEntity('real_channel_caster', 100, 50);
  addFocus(caster, 5);
  const target = makeEntity('real_channel_target', 100, 50);
  target.transform.coords = { x: 2, y: 0, z: 0 };
  engine.mountEntities([caster, target]);

  const mutations: StateMutationPayload[] = [];
  const decisionPolls: DecisionPollPayload[] = [];
  engine.on('STATE_MUTATED', (p: StateMutationPayload) => mutations.push(p));
  engine.on('DECISION_POLL', (poll: DecisionPollPayload) => {
    decisionPolls.push(poll);
    engine.handleDecisionResponse({ windowId: poll.windowId, chosenOptionId: 'DO_NOTHING' }, 'integration-regression');
  });

  engine.receiveIntent({
    actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'REAL_CHANNEL_INTERRUPT', targetIds: [target.id] }
  } as ClientIntent);

  assert(target.resources.current.hp === 90, `CHANNELING 中断前仅完成两次脉冲 HP=${target.resources.current.hp}`);
  assert(decisionPolls.length >= 2, `每个已执行脉冲均经过系统 DECISION_POLL, 实际 ${decisionPolls.length}`);
  const recoveryMutation = mutations.find((p) => p.mutations.some((m) =>
    m.entityId === caster.id && m.changes?.currentActionContext?.phase === 'RECOVERY'));
  const clearedMutation = mutations.find((p) => p.mutations.some((m) =>
    m.entityId === caster.id && m.changes?.currentActionContext === null));
  assert(recoveryMutation !== undefined, '活体 CHANNELING 中断广播 RECOVERY');
  assert(clearedMutation !== undefined, 'CHANNELING 中断收招完成后广播 null');
  assert(recoveryMutation !== undefined && clearedMutation !== undefined && recoveryMutation.tick < clearedMutation.tick,
    'CHANNELING 的 RECOVERY 广播早于最终 null');
  const recoveryContext = recoveryMutation?.mutations.find((m) => m.entityId === caster.id)?.changes.currentActionContext;
  assert(clearedMutation !== undefined && recoveryContext?.resolveTick === clearedMutation.tick,
    'CHANNELING 最终 null tick 等于预期收招完成 tick');
  assert(caster.currentActionContext === undefined, 'CHANNELING 中断最终清除上下文');
  assert(engine.getPendingDecisionCount() === 0, 'CHANNELING 回归无遗留决策');
}

// ============================================================
// 生产回归：死亡中断不应重新激活动作或进入 RECOVERY
// ============================================================
console.log('\n[Regression] 真实 CombatEngine 死亡中断不复活动作');
{
  registerTestAction({
    id: 'REAL_SELF_LETHAL', tags: ['SPELL'],
    timeCost: { startupTicks: 1, recoveryTicks: 3 },
    resourceCost: {}, range: { type: 'SELF', distanceExpr: '0' },
    effects: [{ type: 'DAMAGE', targetSelector: 'SELF', parameters: { resource: 'hp', amountExpr: '100' } }],
    priorityExpr: '10', diceRules: [],
    sustainResources: ['focus']
  } as ActionTemplate);

  const engine = createEngine('scene-real-death-interrupt');
  const doomed = makeEntity('real_doomed_caster', 100, 50);
  addFocus(doomed, 50);
  const survivor = makeEntity('real_survivor', 100, 50);
  engine.mountEntities([doomed, survivor]);

  const mutations: StateMutationPayload[] = [];
  engine.on('STATE_MUTATED', (p: StateMutationPayload) => mutations.push(p));
  engine.on('DECISION_POLL', (poll: DecisionPollPayload) => {
    engine.handleDecisionResponse({ windowId: poll.windowId, chosenOptionId: 'DO_NOTHING' }, 'integration-death-regression');
  });

  engine.receiveIntent({
    actorId: doomed.id, intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'REAL_SELF_LETHAL' }
  } as ClientIntent);

  assert(doomed.resources.current.hp === 0, '死亡回归确实结算致死效果');
  assert(!mutations.some((p) => p.mutations.some((m) =>
    m.entityId === doomed.id && m.changes?.currentActionContext?.phase === 'RECOVERY')),
    '死亡中断不广播 RECOVERY');
  assert(mutations.some((p) => p.mutations.some((m) =>
    m.entityId === doomed.id && m.changes?.currentActionContext === null)),
    '死亡中断广播最终 null');
  assert(doomed.currentActionContext === undefined, '死亡后不保留或复活动作上下文');
}

// ============================================================
// 测试 27: 微闪避 + 攻击标签匹配导致挥空
// ============================================================
console.log('\n[Test 27] 微闪避 + 攻击标签匹配挥空');
{
  registerTestAction({
    id: 'HIGH_ATTACK', tags: ['ATTACK', 'MELEE'],
    attackTags: ['HIGH'],
    timeCost: { startupTicks: 3, recoveryTicks: 2 },
    resourceCost: {}, range: { type: 'MELEE', distanceExpr: '3' },
    effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '50' } }],
    priorityExpr: '10', diceRules: []
  } as ActionTemplate);

  const engine = createEngine('scene-micro-evade');
  engine.setAutoProcess(false);
  const attacker = makeEntity('atk_hero', 100, 50);
  const evader = makeEntity('evade_target', 100, 50);
  addFocus(evader, 50);
  evader.transform.coords = { x: 2, y: 0, z: 0 };
  engine.mountEntities([attacker, evader]);

  // 先微闪避 DUCK（克制 HIGH 标签）
  engine.receiveIntent({
    actorId: 'evade_target', intentType: 'MICRO_EVADE', clientTick: 0,
    payload: { evadeSubType: 'DUCK' }
  } as any);

  // DUCK 微闪避 startup=2, 在 startup 期间发送 HIGH 攻击
  // 攻击会在 tick 3 命中，此时微闪避仍在 ACTIVE 阶段
  engine.receiveIntent({
    actorId: 'atk_hero', intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'HIGH_ATTACK', targetIds: ['evade_target'] }
  } as any);

  engine.processPending();
  // 微闪避成功导致挥空：目标不应该受伤
  assert(evader.resources.current.hp === 100, `微闪避成功，目标 HP 不变, 实际 ${evader.resources.current.hp}`);
  assert(evader.resources.current.focus === 45, `微闪避消耗 5 FP, focus=${evader.resources.current.focus}`);
}

// ============================================================
// 测试 28: CANCEL_ACTION 空取消（动作完成后取消，容错）
// ============================================================
console.log('\n[Test 28] CANCEL_ACTION 空取消（容错）');
{
  const engine = createEngine('scene-cancel-empty');
  const hero = makeEntity('empty_cancel', 100, 50);
  engine.mountEntities([hero]);

  // 动作完成后取消（无待处理事件）
  try {
    engine.receiveIntent({
      actorId: 'empty_cancel', intentType: 'CANCEL_ACTION', clientTick: 0,
      payload: {}
    } as any);
    assert(true, '空取消不抛异常');
  } catch (e) {
    assert(false, `空取消抛异常: ${e}`);
  }
  assert(hero.currentActionContext === undefined, '空取消后上下文仍为 undefined');
}

// ============================================================
// 测试 29: 重复 COMBAT_END 不重复触发
// ============================================================
console.log('\n[Test 29] 重复 COMBAT_END 不重复触发');
{
  const engine = createEngine('scene-end-repeat');
  const hero = makeEntity('end_hero2', 100, 50);
  const enemy = makeEntity('end_enemy2', 1, 10);
  enemy.transform.coords = { x: 2, y: 0, z: 0 };
  engine.mountEntities([hero, enemy]);

  let endCount = 0;
  engine.on('COMBAT_END', () => endCount++);

  // 重复发送击杀确保只触发一次 COMBAT_END
  engine.receiveIntent({
    actorId: 'end_hero2', intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'KILL_STRIKE', targetIds: ['end_enemy2'] }
  } as any);

  engine.receiveIntent({
    actorId: 'end_hero2', intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'KILL_STRIKE', targetIds: ['end_enemy2'] }
  } as any);

  assert(endCount === 1, `COMBAT_END 仅触发 ${endCount} 次`);
}

// ============================================================
// 测试 30: 不存在的模板 ID 容错
// ============================================================
console.log('\n[Test 30] 不存在的模板 ID 不崩溃');
{
  const engine = createEngine('scene-bad-template');
  const hero = makeEntity('bad_hero', 100, 50);
  engine.mountEntities([hero]);

  try {
    engine.receiveIntent({
      actorId: 'bad_hero', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'DOES_NOT_EXIST', targetIds: ['bad_hero'] }
    } as any);
    assert(true, '不存在的模板 ID 不抛异常');
  } catch (e) {
    assert(false, `抛异常: ${e}`);
  }
}

// ============================================================
// 测试 31: BATCH_CAST 相杀触发 ENTITY_DIED 和 VISUAL_FX MUTUAL_KILL
// ============================================================
console.log('\n[Test 31] BATCH_CAST 相杀触发 ENTITY_DIED + MUTUAL_KILL');
{
  registerTestAction({
    id: 'CLASH_KILL', tags: ['ATTACK'],
    timeCost: { startupTicks: 5, recoveryTicks: 3 },
    resourceCost: {}, range: { type: 'MELEE', distanceExpr: '3' },
    effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '200' } }],
    priorityExpr: '10', diceRules: []
  } as ActionTemplate);

  const engine = createEngine('scene-clash-death');
  const a = makeEntity('clash_a', 30, 50);
  const b = makeEntity('clash_b', 30, 50);
  a.transform.coords = { x: 0, y: 0, z: 0 };
  b.transform.coords = { x: 2, y: 0, z: 0 };
  engine.mountEntities([a, b]);

  const entityDied: string[] = [];
  engine.on('ENTITY_DIED', (e: any) => entityDied.push(typeof e === 'string' ? e : e.id));
  const visualFx: any[] = [];
  engine.on('VISUAL_FX', (p: any) => visualFx.push(p));
  const combatEnds: any[] = [];
  engine.on('COMBAT_END', (p: any) => combatEnds.push(p));

  engine.receiveIntent({
    actorId: '__batch__', intentType: 'BATCH_CAST', clientTick: 0,
    payload: {
      batchIntents: [
        { actorId: 'clash_a', actionTemplateId: 'CLASH_KILL', targetIds: ['clash_b'] },
        { actorId: 'clash_b', actionTemplateId: 'CLASH_KILL', targetIds: ['clash_a'] }
      ]
    }
  } as any);

  assert(entityDied.length === 2, `ENTITY_DIED 广播 2 次, 实际 ${entityDied.length}`);
  assert(entityDied.includes('clash_a') && entityDied.includes('clash_b'), '双方死亡事件已广播');

  const mutualKillFx = visualFx.filter(v => v.events?.some((e: any) => e.eventType === 'MUTUAL_KILL'));
  assert(mutualKillFx.length >= 1, 'MUTUAL_KILL 视觉特效已广播');
  assert(combatEnds.length === 1, 'COMBAT_END 已广播');
}

// ============================================================
// 测试 32: 同步决策响应不能打断引导递归或遗留上下文
// ============================================================
console.log('\n[Test 32] 同步 DECISION_RESPONSE 后引导继续并清理上下文');
{
  registerTestAction({
    id: 'SYNC_DECISION_CHANNEL', tags: ['SPELL'],
    timeCost: { startupTicks: 1, recoveryTicks: 1 },
    resourceCost: {}, range: { type: 'MELEE', distanceExpr: '3' },
    effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '5' } }],
    priorityExpr: '10', diceRules: [],
    channelOptions: { intervalTicks: 1, maxPulses: 2 }
  } as ActionTemplate);

  const engine = createEngine('scene-sync-decision');
  const caster = makeEntity('sync_caster', 100, 50);
  const target = makeEntity('sync_target', 100, 50);
  target.transform.coords = { x: 2, y: 0, z: 0 };
  engine.mountEntities([caster, target]);
  engine.setPlayerControlledEntities([target.id]);

  let pollCount = 0;
  engine.on('DECISION_POLL', (poll: any) => {
    pollCount++;
    engine.handleDecisionResponse({ windowId: poll.windowId, chosenOptionId: 'DO_NOTHING' } as any, 'sync-test');
  });

  engine.receiveIntent({
    actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'SYNC_DECISION_CHANNEL', targetIds: [target.id] }
  } as any);

  assert(target.resources.current.hp === 90, `同步决策后两次脉冲均结算 HP=${target.resources.current.hp}`);
  assert(pollCount === 2, `两次脉冲各产生一个决策窗口, 实际 ${pollCount}`);
  assert(caster.currentActionContext === undefined, '同步决策后施法者上下文清除');
  assert(engine.getPendingDecisionCount() === 0, '同步决策后待决计数清零');
}

// ============================================================
// 总结
// ============================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`集成测试: ${passCount}/${testCount} 通过`);
if (passCount === testCount) console.log('✅ 所有集成测试通过!');
else process.exit(1);
