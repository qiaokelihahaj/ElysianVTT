import assert from 'node:assert/strict';
import type {
  ActionTemplate,
  EncounterCommand,
  EncounterEntity,
  EncounterRulePack,
} from '../packages/shared/src/index.js';
import { EncounterCoordinator } from '../packages/backend/src/encounters/EncounterCoordinator.js';

function actorTemplate(
  templateId: string,
  faction: 'PLAYERS' | 'ENEMIES',
  displayName: string,
): Omit<EncounterEntity, 'id'> {
  return {
    templateId,
    encounterTemplateId: templateId,
    displayName,
    visibility: 'PUBLIC',
    type: 'ACTOR',
    transform: { coords: { x: 0, y: 0, z: 0 }, planeId: 'formal-test-plane', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.45, mass: 10, movementModes: ['WALK'] },
    resources: { current: { hp: 10, focus: 1 }, max: { hp: 10, focus: 1 } },
    activeEffects: [],
    tags: [faction],
    faction,
  };
}

const movement: ActionTemplate = {
  id: 'FORMAL_MOVE',
  tags: ['MOVEMENT'],
  timeCost: { startupTicks: 1, recoveryTicks: 1 },
  resourceCost: {},
  range: { type: 'MOVEMENT', distanceExpr: '10' },
  effects: [],
};

const content: EncounterRulePack = {
  id: 'formal-content-injection',
  name: 'Formal content injection',
  actionTemplates: [movement],
  actorTemplates: {
    hero: actorTemplate('hero', 'PLAYERS', 'Hero'),
    enemy: actorTemplate('enemy', 'ENEMIES', 'Enemy'),
  },
  map: {
    id: 'formal-test-map',
    name: 'Formal test map',
    tiles: [],
    spawnPoints: { hero: { x: 0, y: 0, z: 0 }, enemy: { x: 1, y: 0, z: 0 } },
    width: 4,
    height: 4,
  },
  reactionJoinMs: 100,
  reactionSelectMs: 100,
  priorityTolerance: 0,
};

function command(
  type: EncounterCommand['type'],
  requestId: string,
  payload: Record<string, unknown>,
): EncounterCommand {
  return { type, requestId, payload } as EncounterCommand;
}

async function main(): Promise<void> {
  const hero: EncounterEntity = { id: 'formal-hero', ...actorTemplate('hero', 'PLAYERS', 'Hero') };
  const coordinator = new EncounterCoordinator({ content, entities: [hero] });
  const gm = { userId: 'formal-gm', role: 'GM' as const, socketId: 'formal-gm-socket' };
  try {
    assert.equal('createDemo' in coordinator, false, 'formal coordinator must not expose Demo factory');
    const inherited = coordinator.handleCommand(gm, command('GM_SPAWN', 'spawn-inherited', {
      templateId: 'toString',
    }));
    assert.equal(inherited.ok, false);
    if (!inherited.ok) assert.equal(inherited.code, 'UNKNOWN_TEMPLATE');

    const spawned = coordinator.handleCommand(gm, command('GM_SPAWN', 'spawn-custom', {
      templateId: 'enemy',
      entityId: 'formal-enemy',
      position: { x: 2, y: 0, z: 0 },
    }));
    assert.equal(spawned.ok, true, 'spawn must use the injected actor template');
    assert.deepEqual(
      spawned.snapshot.entities.find(entity => entity.id === 'formal-enemy')?.resources.current,
      { hp: 10, focus: 1 },
    );

    const started = coordinator.handleCommand(gm, command('START', 'start', {}));
    assert.equal(started.ok, true);
    const moved = coordinator.handleCommand(gm, command('ACTION', 'move', {
      entityId: 'formal-hero',
      actionTemplateId: 'FORMAL_MOVE',
      targetIds: [],
      targetCoords: { x: 1, y: 0, z: 0 },
    }));
    assert.equal(moved.ok, true, 'a MOVEMENT template from content must be accepted');
    const waited = coordinator.handleCommand(gm, command('WAIT', 'wait', { entityId: 'formal-enemy' }));
    assert.equal(waited.ok, true);

    for (let attempt = 0; attempt < 80; attempt += 1) {
      const snapshot = coordinator.getSnapshot();
      if (snapshot.entities.find(entity => entity.id === 'formal-hero')?.transform.coords.x === 1) break;
      const enemy = snapshot.entities.find(entity => entity.id === 'formal-enemy');
      const enemySlot = snapshot.plan.slots.find(slot => slot.entityId === 'formal-enemy');
      if (enemy && enemySlot && !enemySlot.ready && enemySlot.readyAtTick === undefined && !enemy.currentActionContext) {
        const nextWait = coordinator.handleCommand(gm, command('WAIT', `wait-${attempt}`, { entityId: enemy.id }));
        assert.equal(nextWait.ok, true);
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(
      coordinator.getSnapshot().entities.find(entity => entity.id === 'formal-hero')?.transform.coords.x,
      1,
      'MOVEMENT intent must be selected from the injected template tags',
    );
  } finally {
    coordinator.close();
  }
}

main().then(() => {
  console.log('encounter-content-injection: formal content, spawn and movement passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
