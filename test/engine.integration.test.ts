// test/engine.integration.test.ts
// 集成测试：直接引用生产代码验证 CombatEngine + ClashPool 端到端可用性

import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { ClashPool } from '../packages/backend/src/core/engine/ClashPool.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';
import { generateId } from '../packages/backend/src/utils/IdGenerator.js';
import type { Entity, ActionTemplate } from '../packages/shared/src/index.js';

// ==========================================
// Helper: 向 Dictionary 注入测试技能模板
// ==========================================
function registerTestAction(template: ActionTemplate) {
  const dict = Dictionary as any;
  if (!dict.actions) {
    dict.actions = new Map<string, ActionTemplate>();
  }
  dict.actions.set(template.id, template);
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

// ==========================================
// 集成测试框架
// ==========================================
let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
  testCount++;
  if (cond) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}

function runIntegrationTests() {
  console.log('=== ElysianVTT CombatEngine 集成测试 ===\n');

  // ============================================================
  // 测试 1: 直接测试 ClashPool.resolve() 核心逻辑
  // （验证生产代码的冲突结算是否工作）
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
      eventId: evt1Id,
      eventType: 'ACTION_PHASE',
      targetTick,
      status: 'PENDING',
      actorId: 'spearman',
      targetIds: ['thief'],
      actionTemplateId: 'LETHAL_STRIKE',
      phase: 'STARTUP'
    };

    const evt2: any = {
      eventId: evt2Id,
      eventType: 'ACTION_PHASE',
      targetTick,
      status: 'PENDING',
      actorId: 'thief',
      targetIds: ['spearman'],
      actionTemplateId: 'LETHAL_STRIKE',
      phase: 'STARTUP'
    };

    // 设置实体的 currentActionContext（ClashPool.decorateEvents 会检查这个）
    (spearman as any).currentActionContext = {
      type: 'CASTING',
      actionId: evt1Id,
      actionTemplateId: 'LETHAL_STRIKE',
      phase: 'STARTUP',
      resolveTick: targetTick
    };

    (thief as any).currentActionContext = {
      type: 'CASTING',
      actionId: evt2Id,
      actionTemplateId: 'LETHAL_STRIKE',
      phase: 'STARTUP',
      resolveTick: targetTick
    };

    // 验证模板是否存在
    const template = Dictionary.getAction('LETHAL_STRIKE');
    console.log(`  [DEBUG] Template=${template?.id}, Effects=${template?.effects.length}`);

    // 直接调用 ClashPool.resolve()
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
    const engine = new CombatEngine('scene-3');
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

  console.log(`\n${'='.repeat(40)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有集成测试通过!');
}

runIntegrationTests();
