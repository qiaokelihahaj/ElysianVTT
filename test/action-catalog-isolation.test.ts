import assert from 'node:assert/strict';
import type { ActionTemplate, ClientIntent, Entity } from '../packages/shared/src/index.js';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { InMemoryActionCatalog } from '../packages/backend/src/rules/ActionCatalog.js';

const SHARED_ACTION_ID = 'ISOLATED_SHARED_ACTION';

function actor(id: string, hp = 100): Entity {
  return {
    id,
    templateId: id,
    type: 'ACTOR',
    transform: { coords: { x: 0, y: 0, z: 0 }, planeId: 'isolation', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.5, mass: 10, movementModes: ['WALK'] },
    resources: { current: { hp, focus: 10 }, max: { hp, focus: 10 } },
    activeEffects: [],
  };
}

function action(startupTicks: number, recoveryTicks: number, damage: number): ActionTemplate {
  return {
    id: SHARED_ACTION_ID,
    tags: ['MELEE'],
    timeCost: { startupTicks, recoveryTicks },
    resourceCost: {},
    range: { type: 'MELEE', distanceExpr: '2' },
    effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: String(damage) } }],
  };
}

function cast(actorId: string, targetId: string): ClientIntent {
  return {
    intentType: 'CAST_ACTION',
    actorId,
    clientTick: 0,
    payload: { actionTemplateId: SHARED_ACTION_ID, targetIds: [targetId] },
  };
}

const sourceTemplate = action(1, 2, 7);
const catalogA = new InMemoryActionCatalog([sourceTemplate]);
sourceTemplate.timeCost.startupTicks = 99;
sourceTemplate.effects[0]!.parameters!.amountExpr = '999';
assert.equal(catalogA.getAction(SHARED_ACTION_ID)?.timeCost.startupTicks, 1, 'registration snapshots the source template');
const returnedTemplate = catalogA.getAction(SHARED_ACTION_ID)!;
returnedTemplate.timeCost.startupTicks = 88;
assert.equal(catalogA.getAction(SHARED_ACTION_ID)?.timeCost.startupTicks, 1, 'lookup returns an isolated template snapshot');

const catalogB = new InMemoryActionCatalog([action(5, 6, 13)]);
const engineA = new CombatEngine('catalog-isolation-a', undefined, catalogA);
const engineB = new CombatEngine('catalog-isolation-b', undefined, catalogB);
const targetA = actor('target-a');
const targetB = actor('target-b');
engineA.mountEntities([actor('attacker-a'), targetA]);
engineB.mountEntities([actor('attacker-b'), targetB]);
engineA.setAutoProcess(false);
engineB.setAutoProcess(false);
engineA.setPlayerControlledEntities([]);
engineB.setPlayerControlledEntities([]);

const scheduledA: Array<{ timeline: { startupEnd: number; end: number } }> = [];
const scheduledB: Array<{ timeline: { startupEnd: number; end: number } }> = [];
engineA.on('ACTION_SCHEDULED', payload => scheduledA.push(payload as typeof scheduledA[number]));
engineB.on('ACTION_SCHEDULED', payload => scheduledB.push(payload as typeof scheduledB[number]));

try {
  engineA.receiveIntent(cast('attacker-a', 'target-a'));
  engineB.receiveIntent(cast('attacker-b', 'target-b'));

  assert.equal(scheduledA.length, 1, 'engine A schedules its catalog action');
  assert.equal(scheduledB.length, 1, 'engine B schedules its catalog action');
  assert.deepEqual(
    { startupEnd: scheduledA[0]?.timeline.startupEnd, end: scheduledA[0]?.timeline.end },
    { startupEnd: 1, end: 4 },
  );
  assert.deepEqual(
    { startupEnd: scheduledB[0]?.timeline.startupEnd, end: scheduledB[0]?.timeline.end },
    { startupEnd: 5, end: 12 },
  );

  engineA.processPending();
  engineB.processPending();
  assert.equal(targetA.resources.current.hp, 93, 'engine A resolves its own damage template');
  assert.equal(targetB.resources.current.hp, 87, 'engine B resolves its own damage template');
  console.log('action-catalog-isolation: two engines kept same-id templates isolated');
} finally {
  engineA.removeAllListeners();
  engineB.removeAllListeners();
}
