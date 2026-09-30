import assert from 'node:assert/strict';
import type { ActionTemplate, Entity, StateMutationPayload } from '../packages/shared/src/index.js';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';
import { InMemoryActionCatalog } from '../packages/backend/src/rules/ActionCatalog.js';

const id = 'PIPELINE_SHARED_ACTION';
const engines: CombatEngine[] = [];
const originalRandom = Math.random;
const priorGlobal = Dictionary.getAction(id);

function actor(name: string, x: number): Entity {
  return {
    id: name, templateId: name, type: 'ACTOR',
    transform: { coords: { x, y: 0, z: 0 }, planeId: 'pipeline', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.1, mass: 10, movementModes: ['WALK'] },
    resources: { current: { hp: 100, poise: 100 }, max: { hp: 100, poise: 100 } },
    activeEffects: [],
  };
}

function template(damage: number, extra: Partial<ActionTemplate> = {}): ActionTemplate {
  return {
    id, tags: [], resourceCost: {}, priorityExpr: '10',
    timeCost: { startupTicks: 1, recoveryTicks: 2 },
    range: { type: 'RANGED', distanceExpr: '10' },
    effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: {
      resource: 'hp', amountExpr: String(damage), amount: damage,
    } }],
    ...extra,
  };
}

function setup(name: string, action: ActionTemplate) {
  const engine = new CombatEngine(name, undefined, new InMemoryActionCatalog([action]));
  engines.push(engine);
  engine.setAutoProcess(false);
  engine.setPlayerControlledEntities([]);
  const a = actor(`${name}-a`, 0);
  const b = actor(`${name}-b`, 3);
  engine.mountEntities([a, b]);
  const states: StateMutationPayload[] = [];
  engine.on('STATE_MUTATED', (state: StateMutationPayload) => states.push(structuredClone(state)));
  const cast = (source = a, target = b) => engine.receiveIntent({
    actorId: source.id, intentType: 'CAST_ACTION', clientTick: engine.currentTick,
    payload: { actionTemplateId: id, targetIds: [target.id] },
  });
  return { engine, a, b, states, cast };
}

function drain(engine: CombatEngine): void {
  for (let step = 0; step < 100 && engine.hasPendingEvents(); step++) engine.processPending(1);
  assert.equal(engine.hasPendingEvents(), false, 'isolated engine must finish its event queue');
}

try {
  Math.random = () => 0.5;
  // Any accidental fallback to the global dictionary becomes an observable lethal hit.
  Dictionary.registerAction(template(999));
  const clashA = setup('clash-a', template(7));
  const clashB = setup('clash-b', template(13));
  for (const game of [clashA, clashB]) { game.cast(); game.cast(game.b, game.a); }
  for (const game of [clashA, clashB]) {
    assert.throws(() => game.engine.bindActionCatalog(new InMemoryActionCatalog([template(999)])),
      /combat work is active/, 'queued actions must not change rule catalogs mid-flight');
  }
  for (const game of [clashB, clashA]) drain(game.engine);
  assert.deepEqual([clashA.a.resources.current.hp, clashA.b.resources.current.hp], [93, 93]);
  assert.deepEqual([clashB.a.resources.current.hp, clashB.b.resources.current.hp], [87, 87]);

  const launchProjectile: NonNullable<ActionTemplate['launchProjectile']> = {
    trajectoryType: 'LINEAR', speed: 1, ticksPerStep: 1, dieThreshold: 1,
  };
  const shotA = setup('shot-a', template(7, { launchProjectile }));
  const shotB = setup('shot-b', template(13, { launchProjectile }));
  for (const game of [shotA, shotB]) game.cast();
  for (const game of [shotA, shotB]) {
    game.engine.processPending(1);
    assert.equal(game.b.resources.current.hp, 100, 'launching does not apply collision effects early');
  }
  for (const game of [shotB, shotA]) drain(game.engine);
  // Impact resolves exactly once through each engine's own catalog.
  assert.equal(shotA.b.resources.current.hp, 93);
  assert.equal(shotB.b.resources.current.hp, 87);
  assert.equal(shotA.engine.getAllEntities().some(entity => entity.type === 'PROJECTILE'), false);
  assert.equal(shotB.engine.getAllEntities().some(entity => entity.type === 'PROJECTILE'), false);

  const channelA = setup('channel-a', template(3, { channelOptions: { maxPulses: 3, intervalTicks: 2 } }));
  const channelB = setup('channel-b', template(5, { channelOptions: { maxPulses: 2, intervalTicks: 4 } }));
  for (const game of [channelA, channelB]) game.cast();
  for (const game of [channelB, channelA]) drain(game.engine);
  assert.equal(channelA.b.resources.current.hp, 91);
  assert.equal(channelB.b.resources.current.hp, 90);
  for (const game of [channelA, channelB]) {
    assert.ok(game.states.some(state => (state.actionPatches?.length ?? 0) > 0), 'channel timeline updates must execute');
    assert.equal(game.a.currentActionContext, undefined, 'recovery must complete using the instance rules');
  }
  console.log('combat-rule-pipeline-isolation: clash, projectile and channel paths passed');
} finally {
  for (const engine of engines) { engine.reset(); engine.removeAllListeners(); }
  Math.random = originalRandom;
  Dictionary.unregisterAction(id);
  if (priorGlobal) Dictionary.registerAction(priorGlobal);
}
