// test/hook-timing.test.ts
// 验证 Hook 创建后不会立即触发，而是在目标 Tick 正确触发

import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';
import type { Entity, ActionTemplate, ClientIntent } from '../packages/shared/src/index.js';
import assert from 'node:assert';

function makeEntity(id: string, hp = 100, poise = 50): Entity {
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

function registerTestAction(template: ActionTemplate) {
  const dict = Dictionary as any;
  if (!dict.actions) dict.actions = new Map();
  dict.actions.set(template.id, template);
}

const SLASH_TEMPLATE: ActionTemplate = {
  id: 'test_slash',
  tags: ['MELEE', 'ATTACK'],
  timeCost: { startupTicks: 10, recoveryTicks: 5 },
  resourceCost: {},
  range: { type: 'MELEE', distanceExpr: '1' },
  effects: [
    { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '20' } }
  ],
  priorityExpr: '10'
};
registerTestAction(SLASH_TEMPLATE);

function makeHookIntent(actorId: string, label: string, targetTick: number): ClientIntent {
  return {
    actorId,
    intentType: 'HOOK_PRESET',
    clientTick: 0,
    payload: {
      hookPreset: {
        id: `hook_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        entityId: actorId,
        label,
        trigger: { type: 'TICK_REACHED', targetTick },
        enabled: true
      }
    }
  };
}

function makeCastIntent(actorId: string, actionTemplateId: string, targetIds: string[] = []): ClientIntent {
  return {
    actorId,
    intentType: 'CAST_ACTION',
    clientTick: 0,
    payload: { actionTemplateId, targetIds }
  };
}

// ============================================================
// Test 1: targetTick > currentTick → 在正确 Tick 触发
// ============================================================
{
  const engine = new CombatEngine('hook-test-1');
  let decisionCalls: Array<{ tick: number }> = [];
  engine.on('DECISION_POLL', (payload: any) => { decisionCalls.push(payload); });

  const fighter = makeEntity('fighter_1', 100);
  engine.mountEntities([fighter]);

  // 先推进到 tick >= 10
  engine.receiveIntent(makeCastIntent('fighter_1', 'test_slash', []));
  const hookCreationTick = engine.currentTick;
  assert.ok(hookCreationTick >= 10);

  // 重置计数，创建 targetTick > currentTick 的 hook
  decisionCalls = [];
  const futureTarget = hookCreationTick + 5;
  engine.receiveIntent(makeHookIntent('fighter_1', '未来触发', futureTarget));

  // 验证注册 HOOK 不导致时间跃迁
  assert.strictEqual(
    engine.currentTick, hookCreationTick,
    `Hook 注册不应改变 currentTick`
  );

  // 后续自然动作驱动引擎推进
  engine.receiveIntent(makeCastIntent('fighter_1', 'test_slash', []));

  // Hook 应在 processQueue → evaluateHooks 中触发
  assert.strictEqual(decisionCalls.length, 1, `Hook 应触发 1 次`);
  assert.ok(
    decisionCalls[0].tick >= futureTarget,
    `Hook 应在 targetTick=${futureTarget} 或之后触发，实际在 tick=${decisionCalls[0].tick}`
  );
  assert.notStrictEqual(
    decisionCalls[0].tick, hookCreationTick,
    `Hook 不应在创建时的 tick (${hookCreationTick}) 触发`
  );

  console.log(`✓ Test 1 PASS: Hook 在 tick ${decisionCalls[0].tick} 正确触发 (target=${futureTarget}, creation=${hookCreationTick})`);
}

// ============================================================
// Test 2: targetTick < currentTick（已过期的 tick）→ 不应触发
// ============================================================
{
  const engine = new CombatEngine('hook-test-2');
  let decisionCalls: Array<{ tick: number }> = [];
  engine.on('DECISION_POLL', (payload: any) => { decisionCalls.push(payload); });

  const fighter = makeEntity('fighter_2', 100);
  engine.mountEntities([fighter]);

  // 推进到 tick >= 10
  engine.receiveIntent(makeCastIntent('fighter_2', 'test_slash', []));
  const currentTick = engine.currentTick;
  assert.ok(currentTick >= 10);

  // 创建 targetTick < currentTick 的 hook（已过的 tick）
  decisionCalls = [];
  engine.receiveIntent(makeHookIntent('fighter_2', '已过触发', currentTick - 5));

  // 不应触发任何 DECISION_POLL
  assert.strictEqual(
    decisionCalls.length, 0,
    `已过 target tick 的 hook 不应触发，但触发了 ${decisionCalls.length} 次`
  );

  console.log(`✓ Test 2 PASS: 已过 target tick (${currentTick - 5}) 的 hook 未触发 (currentTick=${currentTick})`);
}

// ============================================================
// Test 3: targetTick === currentTick → 应延迟到下次 processQueue 触发
// ============================================================
{
  const engine = new CombatEngine('hook-test-3');
  let decisionCalls: Array<{ tick: number }> = [];
  engine.on('DECISION_POLL', (payload: any) => { decisionCalls.push(payload); });

  const fighter = makeEntity('fighter_3', 100);
  engine.mountEntities([fighter]);

  // 推进到 tick >= 10
  engine.receiveIntent(makeCastIntent('fighter_3', 'test_slash', []));
  const currentTick = engine.currentTick;
  assert.ok(currentTick >= 10);

  // targetTick === currentTick — 应通过正常路径在下次 processQueue 触发
  decisionCalls = [];
  const equalTarget = currentTick;
  engine.receiveIntent(makeHookIntent('fighter_3', '等同触发', equalTarget));

  // 验证注册 HOOK 不导致时间跃迁
  assert.strictEqual(
    engine.currentTick, equalTarget,
    `Hook 注册不应改变 currentTick`
  );

  // 后续自然动作驱动引擎推进
  engine.receiveIntent(makeCastIntent('fighter_3', 'test_slash', []));

  // 引擎推进到 action 的 startup tick，hook 应在 >= targetTick 时触发
  assert.strictEqual(
    decisionCalls.length, 1,
    `targetTick === currentTick (${equalTarget}) 应通过 evaluateHooks 触发`
  );
  assert.ok(
    decisionCalls[0].tick >= equalTarget,
    `Hook 触发 tick=${decisionCalls[0].tick} 应 >= targetTick=${equalTarget}`
  );

  console.log(`✓ Test 3 PASS: targetTick === currentTick (${equalTarget}) 的 hook 正确延迟触发`);
}

console.log('\n所有 hook 触发时机测试通过');
