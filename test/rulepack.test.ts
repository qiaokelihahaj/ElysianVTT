// test/rulepack.test.ts
// RulePack 系统集成测试

import { RulePackLoader } from '../packages/backend/src/db/RulePackLoader.js';
import { RuleEvaluator } from '../packages/backend/src/core/systems/RuleEvaluator.js';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import type { Entity, ActionTemplate, EvaluationContext } from '../packages/shared/src/index.js';

function makeActor(id: string, hp = 100, poise = 50, focus = 20): Entity {
  return {
    id, templateId: 'test', type: 'ACTOR',
    transform: { coords: { x: 0, y: 0, z: 0 }, planeId: 'scene-1', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.5, mass: 70, movementModes: ['WALK'] },
    resources: { current: { hp, poise, focus }, max: { hp, poise, focus } },
    activeEffects: []
  };
}

let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
  testCount++;
  if (cond) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}

async function runTests() {
  console.log('=== RulePack 系统集成测试 ===\n');

  // ------------------------------------------------------------------
  // Test 1: RulePackLoader loads default 'elysian' pack correctly
  // ------------------------------------------------------------------
  {
    console.log('[Test 1] RulePackLoader loads default \'elysian\' pack');
    RulePackLoader.clearCache();
    const result = await RulePackLoader.load('elysian');

    assert(result !== null, 'load("elysian") should return non-null');
    assert(result!.id === 'elysian', `result.id === 'elysian' (got ${result!.id})`);
    assert(result!.name === 'Elysian 规则', `result.name === 'Elysian 规则' (got ${result!.name})`);
    assert(result!.attributeDefs.length === 4, `4 attribute defs (got ${result!.attributeDefs.length})`);
    assert(result!.resourceDefs.length === 3, `3 resource defs (got ${result!.resourceDefs.length})`);
    assert(result!.phaseDefs.length === 4, `4 phase defs (got ${result!.phaseDefs.length})`);
    assert(result!.defenseModel.drFormula !== undefined, 'defenseModel.drFormula is defined');
    assert(result!.defenseModel.parryFormula !== undefined, 'defenseModel.parryFormula is defined');
    assert(result!.defenseModel.dodgeFormula !== undefined, 'defenseModel.dodgeFormula is defined');
  }

  // ------------------------------------------------------------------
  // Test 2: RulePackLoader returns null for unknown pack
  // ------------------------------------------------------------------
  {
    console.log('[Test 2] RulePackLoader returns null for unknown pack');
    const result = await RulePackLoader.load('nonexistent_pack');

    assert(result === null, 'load("nonexistent_pack") should return null');
  }

  // ------------------------------------------------------------------
  // Test 3: RulePackLoader caches loaded packs
  // ------------------------------------------------------------------
  {
    console.log('[Test 3] RulePackLoader caches loaded packs');
    RulePackLoader.clearCache();

    // Load once from DB
    const first = await RulePackLoader.load('elysian');
    assert(first !== null, 'first load returns non-null');

    // Second call should use cache (no DB query)
    const second = await RulePackLoader.load('elysian');
    assert(second !== null, 'second load returns non-null');
    assert(second === first, 'second load returns same object reference (cache hit)');

    // getCached should also work
    const cached = RulePackLoader.getCached('elysian');
    assert(cached !== undefined, 'getCached("elysian") returns defined');
    assert(cached === first, 'getCached returns same reference');
    assert(RulePackLoader.getCached('nonexistent') === undefined, 'getCached("nonexistent") returns undefined');

    // Helper methods
    const resourceKeys = RulePackLoader.getResourceKeys('elysian');
    assert(resourceKeys !== null, 'getResourceKeys returns non-null');
    assert(resourceKeys!.includes('hp'), 'resource keys includes "hp"');
    assert(resourceKeys!.includes('poise'), 'resource keys includes "poise"');

    const attributeKeys = RulePackLoader.getAttributeKeys('elysian');
    assert(attributeKeys !== null, 'getAttributeKeys returns non-null');
    assert(attributeKeys!.includes('str'), 'attribute keys includes "str"');
    assert(attributeKeys!.includes('agi'), 'attribute keys includes "agi"');
  }

  // ------------------------------------------------------------------
  // Test 4: CombatEngine constructor accepts rulePackId
  // ------------------------------------------------------------------
  {
    console.log('[Test 4] CombatEngine constructor accepts rulePackId');
    const engine = new CombatEngine('test-engine-rulepack', 'elysian');

    assert(engine.engineId === 'test-engine-rulepack', 'engine id is set');
    assert(engine.engineType === 'COMBAT', 'engine type is COMBAT');

    // getRulePackDefs may be null if async load hasn't completed yet
    // We'll wait briefly for the async load
    console.log('   等待 RulePackLoader 异步加载...');
  }

  // ------------------------------------------------------------------
  // Test 5: CombatEngine.getRulePackDefs() returns loaded defs
  // ------------------------------------------------------------------
  {
    console.log('[Test 5] CombatEngine.getRulePackDefs() returns loaded defs');

    // Pre-load into cache so constructor can read from cache synchronously
    RulePackLoader.clearCache();
    await RulePackLoader.load('elysian');

    const engine = new CombatEngine('test-engine-defs', 'elysian');

    // Since the pack was cached, the constructor's async load completes immediately
    // We need a microtask wait for the Promise.then to execute
    await new Promise(resolve => setTimeout(resolve, 50));

    const defs = engine.getRulePackDefs();
    assert(defs !== null, 'getRulePackDefs() returns non-null');
    assert(defs!.id === 'elysian', `defs.id === 'elysian' (got ${defs!.id})`);
    assert(defs!.resourceDefs.length === 3, '3 resource defs');
  }

  // ------------------------------------------------------------------
  // Test 6: RuleEvaluator.evaluateWithDefs uses custom variables
  // ------------------------------------------------------------------
  {
    console.log('[Test 6] RuleEvaluator.evaluateWithDefs uses custom variables');

    const actor = makeActor('test-eval', 100, 50, 20);
    const context: EvaluationContext = { actor };

    // Evaluate with custom variable defs
    const result1 = RuleEvaluator.evaluateWithDefs('armor + 5', context, { armor: 10 });
    assert(result1.total === 15, `armor=10 => armor+5 = 15 (got ${result1.total})`);

    const result2 = RuleEvaluator.evaluateWithDefs('armor * 2', context, { armor: 7 });
    assert(result2.total === 14, `armor=7 => armor*2 = 14 (got ${result2.total})`);

    // Custom defs don't leak into subsequent evaluate calls
    const result3 = RuleEvaluator.evaluate('actor.hp', context);
    assert(result3.total === 100, `actor.hp = 100 (got ${result3.total})`);

    // evaluate (backwards compat) still works without custom defs
    const result4 = RuleEvaluator.evaluate('actor.hp + actor.poise', context);
    assert(result4.total === 150, `actor.hp + actor.poise = 150 (got ${result4.total})`);

    // Actor resources still accessible in evaluateWithDefs
    const result5 = RuleEvaluator.evaluateWithDefs('actor.hp + armor', context, { armor: 5 });
    assert(result5.total === 105, `actor.hp=100 + armor=5 => 105 (got ${result5.total})`);
  }

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log(`\n=== 完成: ${passCount}/${testCount} 通过 ===`);
  if (passCount === testCount) {
    console.log('🎉 所有测试通过!');
  } else {
    console.error(`❌ ${testCount - passCount} 个测试失败`);
    process.exitCode = 1;
  }
}

runTests().catch(e => {
  console.error('❌ 测试执行异常:', e);
  process.exitCode = 1;
});
