import assert from 'node:assert/strict';
import type {
  ActionTemplate,
  EncounterCommand,
  EncounterEntity,
  EncounterPrincipal,
  EncounterRulePack,
  EncounterSnapshot,
} from '../packages/shared/src/index.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';
import { EncounterCoordinator } from '../packages/backend/src/encounters/EncounterCoordinator.js';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';

const MAIN_ACTION_ID = 'ISOLATION_SHARED_ACTION';
const TRIGGER_ACTION_ID = 'ISOLATION_TRIGGER_ACTION';
const REACTION_ACTION_ID = 'PARRY';

type Faction = 'PLAYERS' | 'ENEMIES';

interface MainActionConfig {
  resourceCost: number;
  healAmount: number;
  startupTicks: number;
  recoveryTicks: number;
}

interface ReactionConfig {
  resourceCost: number;
  buffId: string;
  startupTicks: number;
  recoveryTicks: number;
}

function actorTemplate(
  templateId: string,
  faction: Faction,
  displayName: string,
  focus: number,
  x: number,
): Omit<EncounterEntity, 'id'> {
  return {
    templateId,
    encounterTemplateId: templateId,
    displayName,
    visibility: 'PUBLIC',
    type: 'ACTOR',
    transform: { coords: { x, y: 0, z: 0 }, planeId: 'isolation-plane', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.45, mass: 10, movementModes: ['WALK'] },
    resources: { current: { hp: 1, focus }, max: { hp: 20, focus: 20 } },
    activeEffects: [],
    tags: [faction],
    faction,
  };
}

function entity(
  id: string,
  templateId: string,
  faction: Faction,
  displayName: string,
  focus: number,
  x: number,
): EncounterEntity {
  return { id, ...actorTemplate(templateId, faction, displayName, focus, x) };
}

function mainAction(config: MainActionConfig): ActionTemplate {
  return {
    id: MAIN_ACTION_ID,
    tags: [],
    timeCost: { startupTicks: config.startupTicks, recoveryTicks: config.recoveryTicks },
    resourceCost: { focus: String(config.resourceCost) },
    range: { type: 'SELF', distanceExpr: '0' },
    effects: [{
      type: 'HEAL',
      targetSelector: 'SELF',
      parameters: { resource: 'hp', amountExpr: String(config.healAmount) },
    }],
  };
}

function triggerAction(): ActionTemplate {
  return {
    id: TRIGGER_ACTION_ID,
    tags: [],
    timeCost: { startupTicks: 1, recoveryTicks: 1 },
    resourceCost: {},
    range: { type: 'NONE', distanceExpr: '0' },
    effects: [],
  };
}

function reactionAction(config: ReactionConfig): ActionTemplate {
  return {
    id: REACTION_ACTION_ID,
    tags: ['REACTION'],
    timeCost: { startupTicks: config.startupTicks, recoveryTicks: config.recoveryTicks },
    resourceCost: { focus: String(config.resourceCost) },
    range: { type: 'SELF', distanceExpr: '0' },
    effects: [{
      type: 'APPLY_BUFF',
      targetSelector: 'SELF',
      parameters: { buffId: config.buffId, durationTicks: 4, damageMultiplier: 0.5 },
    }],
  };
}

function content(
  id: string,
  actions: ActionTemplate[],
  templates: Record<string, Omit<EncounterEntity, 'id'>>,
): EncounterRulePack {
  return {
    id,
    name: `Isolation ${id}`,
    actionTemplates: actions,
    actorTemplates: templates,
    map: {
      id: `${id}-map`,
      name: `${id} map`,
      tiles: [],
      spawnPoints: {},
      width: 4,
      height: 4,
    },
    reactionJoinMs: 10_000,
    reactionSelectMs: 10_000,
    priorityTolerance: 0,
  };
}

function command(
  type: EncounterCommand['type'],
  requestId: string,
  payload: Record<string, unknown>,
): EncounterCommand {
  return { type, requestId, payload } as EncounterCommand;
}

function gm(label: string): EncounterPrincipal {
  return { userId: `isolation-gm-${label}`, role: 'GM', socketId: `isolation-socket-${label}` };
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function eventually(
  read: () => EncounterSnapshot,
  predicate: (snapshot: EncounterSnapshot) => boolean,
  description: string,
): Promise<EncounterSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = read();
    if (predicate(snapshot)) return snapshot;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function findAction(snapshot: EncounterSnapshot, actionId: string, actorId: string) {
  return snapshot.actions.find(action => action.actionTemplateId === actionId && action.actorId === actorId);
}

function findDecision(snapshot: EncounterSnapshot, reactorId: string) {
  const decision = snapshot.decisions.find(candidate => candidate.reactorEntityId === reactorId);
  assert.ok(decision, `reaction window for ${reactorId} must be open`);
  return decision;
}

function findActionTemplate(pack: EncounterRulePack, actionId: string): ActionTemplate {
  const template = pack.actionTemplates.find(candidate => candidate.id === actionId);
  assert.ok(template, `${actionId} must be present in the fixture`);
  return template;
}

async function runMainActionIsolation(): Promise<void> {
  Dictionary.clearRuntimeActions();
  const aConfig: MainActionConfig = { resourceCost: 1, healAmount: 1, startupTicks: 1, recoveryTicks: 2 };
  const bConfig: MainActionConfig = { resourceCost: 4, healAmount: 4, startupTicks: 4, recoveryTicks: 7 };
  const actionA = mainAction(aConfig);
  const actionB = mainAction(bConfig);
  const contentA = content('main-a', [actionA], {
    hero: actorTemplate('hero', 'PLAYERS', 'A Hero', 3, 0),
  });
  const contentB = content('main-b', [actionB], {
    hero: actorTemplate('hero', 'PLAYERS', 'B Hero', 6, 0),
  });
  const expectedA = structuredClone(actionA);
  const expectedB = structuredClone(actionB);
  let coordinatorA: EncounterCoordinator | undefined;
  let coordinatorB: EncounterCoordinator | undefined;
  const principalA = gm('main-a');
  const principalB = gm('main-b');

  try {
    coordinatorA = new EncounterCoordinator({
      encounterId: 'isolation-main-a',
      engine: new CombatEngine('isolation-main-a-injected'),
      content: contentA,
      entities: [entity('main-a-hero', 'hero', 'PLAYERS', 'A Hero', 3, 0)],
    });
    coordinatorB = new EncounterCoordinator({
      encounterId: 'isolation-main-b',
      content: contentB,
      entities: [entity('main-b-hero', 'hero', 'PLAYERS', 'B Hero', 6, 0)],
    });

    assert.equal(coordinatorA.handleCommand(principalA, command('START', 'main-a-start', {})).ok, true);
    assert.equal(coordinatorB.handleCommand(principalB, command('START', 'main-b-start', {})).ok, true);

    // B was constructed second. A preview must still resolve A's cheaper
    // template even though both packs intentionally use one action id.
    assert.equal(coordinatorA.previewAction(principalA, 'main-a-hero', MAIN_ACTION_ID).available, true);
    assert.equal(coordinatorB.previewAction(principalB, 'main-b-hero', MAIN_ACTION_ID).available, true);

    // The coordinator owns a snapshot of the supplied content. Mutating the
    // caller's object after construction must not change the live rule pack.
    actionA.resourceCost.focus = '99';
    actionA.effects[0].parameters.amountExpr = '99';
    actionA.timeCost.startupTicks = 99;
    actionA.timeCost.recoveryTicks = 99;
    assert.deepEqual(findActionTemplate(coordinatorA.getCatalog(), MAIN_ACTION_ID), expectedA);
    assert.deepEqual(findActionTemplate(coordinatorB.getCatalog(), MAIN_ACTION_ID), expectedB);

    // A later global registration must not replace either instance's lookup.
    Dictionary.registerAction({
      ...mainAction({ resourceCost: 9, healAmount: 9, startupTicks: 9, recoveryTicks: 11 }),
      id: MAIN_ACTION_ID,
    });
    assert.equal(coordinatorA.previewAction(principalA, 'main-a-hero', MAIN_ACTION_ID).available, true);
    assert.equal(coordinatorB.previewAction(principalB, 'main-b-hero', MAIN_ACTION_ID).available, true);

    // Raise the actors above the deliberately hostile global template cost so
    // the execution path can expose the paid resource and effect differences.
    assert.equal(coordinatorA.handleCommand(principalA, command('GM_ADJUST_ENTITY', 'main-a-budget', {
      entityId: 'main-a-hero', reason: 'isolation fixture budget', resources: { focus: 10 },
    })).ok, true);
    assert.equal(coordinatorB.handleCommand(principalB, command('GM_ADJUST_ENTITY', 'main-b-budget', {
      entityId: 'main-b-hero', reason: 'isolation fixture budget', resources: { focus: 10 },
    })).ok, true);

    const acceptedA = coordinatorA.handleCommand(principalA, command('ACTION', 'main-a-action', {
      entityId: 'main-a-hero', actionTemplateId: MAIN_ACTION_ID,
    }));
    const acceptedB = coordinatorB.handleCommand(principalB, command('ACTION', 'main-b-action', {
      entityId: 'main-b-hero', actionTemplateId: MAIN_ACTION_ID,
    }));
    assert.equal(acceptedA.ok, true);
    assert.equal(acceptedB.ok, true);
    const scheduledA = findAction(acceptedA.snapshot, MAIN_ACTION_ID, 'main-a-hero');
    const scheduledB = findAction(acceptedB.snapshot, MAIN_ACTION_ID, 'main-b-hero');
    assert.ok(scheduledA?.timeline);
    assert.ok(scheduledB?.timeline);
    assert.deepEqual(scheduledA?.paidResources, { focus: aConfig.resourceCost });
    assert.deepEqual(scheduledB?.paidResources, { focus: bConfig.resourceCost });
    assert.equal(scheduledA?.timeline?.startupEnd, aConfig.startupTicks);
    assert.equal(scheduledB?.timeline?.startupEnd, bConfig.startupTicks);

    const finalA = await eventually(
      () => coordinatorA!.getSnapshot(),
      snapshot => snapshot.entities.find(candidate => candidate.id === 'main-a-hero')?.currentActionContext === undefined
        && snapshot.entities.find(candidate => candidate.id === 'main-a-hero')?.resources.current.hp === 1 + aConfig.healAmount,
      'isolated A action effect',
    );
    const finalB = await eventually(
      () => coordinatorB!.getSnapshot(),
      snapshot => snapshot.entities.find(candidate => candidate.id === 'main-b-hero')?.currentActionContext === undefined
        && snapshot.entities.find(candidate => candidate.id === 'main-b-hero')?.resources.current.hp === 1 + bConfig.healAmount,
      'isolated B action effect',
    );
    assert.equal(finalA.entities.find(candidate => candidate.id === 'main-a-hero')?.resources.current.focus, 10 - aConfig.resourceCost);
    assert.equal(finalB.entities.find(candidate => candidate.id === 'main-b-hero')?.resources.current.focus, 10 - bConfig.resourceCost);
  } finally {
    coordinatorA?.close();
    coordinatorB?.close();
    Dictionary.clearRuntimeActions();
  }
}

async function runReactionActionIsolation(): Promise<void> {
  Dictionary.clearRuntimeActions();
  const aConfig: ReactionConfig = { resourceCost: 1, buffId: 'isolation-guard-a', startupTicks: 1, recoveryTicks: 2 };
  const bConfig: ReactionConfig = { resourceCost: 4, buffId: 'isolation-guard-b', startupTicks: 4, recoveryTicks: 7 };
  const reactionA = reactionAction(aConfig);
  const reactionB = reactionAction(bConfig);
  const contentA = content('reaction-a', [triggerAction(), reactionA], {
    source: actorTemplate('source', 'PLAYERS', 'A Source', 10, 0),
    reactor: actorTemplate('reactor', 'ENEMIES', 'A Reactor', 10, 1),
  });
  const contentB = content('reaction-b', [triggerAction(), reactionB], {
    source: actorTemplate('source', 'PLAYERS', 'B Source', 10, 0),
    reactor: actorTemplate('reactor', 'ENEMIES', 'B Reactor', 10, 1),
  });
  const expectedA = structuredClone(reactionA);
  const expectedB = structuredClone(reactionB);
  let coordinatorA: EncounterCoordinator | undefined;
  let coordinatorB: EncounterCoordinator | undefined;
  const principalA = gm('reaction-a');
  const principalB = gm('reaction-b');

  try {
    coordinatorA = new EncounterCoordinator({
      encounterId: 'isolation-reaction-a',
      content: contentA,
      entities: [
        entity('reaction-a-source', 'source', 'PLAYERS', 'A Source', 10, 0),
        entity('reaction-a-reactor', 'reactor', 'ENEMIES', 'A Reactor', 10, 1),
      ],
    });
    coordinatorB = new EncounterCoordinator({
      encounterId: 'isolation-reaction-b',
      content: contentB,
      entities: [
        entity('reaction-b-source', 'source', 'PLAYERS', 'B Source', 10, 0),
        entity('reaction-b-reactor', 'reactor', 'ENEMIES', 'B Reactor', 10, 1),
      ],
    });

    // External mutation must not alter the reaction template captured by A.
    reactionA.resourceCost.focus = '99';
    reactionA.effects[0].parameters.buffId = 'mutated-outside-coordinator';
    reactionA.timeCost.startupTicks = 99;
    assert.deepEqual(findActionTemplate(coordinatorA.getCatalog(), REACTION_ACTION_ID), expectedA);
    assert.deepEqual(findActionTemplate(coordinatorB.getCatalog(), REACTION_ACTION_ID), expectedB);

    assert.equal(coordinatorA.handleCommand(principalA, command('START', 'reaction-a-start', {})).ok, true);
    assert.equal(coordinatorB.handleCommand(principalB, command('START', 'reaction-b-start', {})).ok, true);
    assert.equal(coordinatorA.handleCommand(principalA, command('ACTION', 'reaction-a-trigger', {
      entityId: 'reaction-a-source', actionTemplateId: TRIGGER_ACTION_ID,
    })).ok, true);
    assert.equal(coordinatorB.handleCommand(principalB, command('ACTION', 'reaction-b-trigger', {
      entityId: 'reaction-b-source', actionTemplateId: TRIGGER_ACTION_ID,
    })).ok, true);
    assert.equal(coordinatorA.handleCommand(principalA, command('WAIT', 'reaction-a-wait', {
      entityId: 'reaction-a-reactor',
    })).ok, true);
    assert.equal(coordinatorB.handleCommand(principalB, command('WAIT', 'reaction-b-wait', {
      entityId: 'reaction-b-reactor',
    })).ok, true);

    const decisionA = await eventually(
      () => coordinatorA!.getSnapshot(),
      snapshot => snapshot.decisions.some(decision => decision.reactorEntityId === 'reaction-a-reactor'),
      'A reaction window',
    ).then(snapshot => findDecision(snapshot, 'reaction-a-reactor'));
    const decisionB = await eventually(
      () => coordinatorB!.getSnapshot(),
      snapshot => snapshot.decisions.some(decision => decision.reactorEntityId === 'reaction-b-reactor'),
      'B reaction window',
    ).then(snapshot => findDecision(snapshot, 'reaction-b-reactor'));
    const optionA = decisionA.availableOptions.find(option => option.id === REACTION_ACTION_ID);
    const optionB = decisionB.availableOptions.find(option => option.id === REACTION_ACTION_ID);
    assert.deepEqual(optionA?.resourceCost, { focus: aConfig.resourceCost });
    assert.deepEqual(optionB?.resourceCost, { focus: bConfig.resourceCost });
    assert.equal(optionA?.canAfford, true);
    assert.equal(optionB?.canAfford, true);

    // The reaction path must also ignore a later global replacement. This
    // template is intentionally deterministic and never samples a die.
    Dictionary.registerAction(reactionAction({
      resourceCost: 9,
      buffId: 'global-reaction-contamination',
      startupTicks: 9,
      recoveryTicks: 11,
    }));
    const selectedA = coordinatorA.handleCommand(principalA, command('REACTION_SELECT', 'reaction-a-select', {
      windowId: decisionA.windowId, optionId: REACTION_ACTION_ID,
    }));
    const selectedB = coordinatorB.handleCommand(principalB, command('REACTION_SELECT', 'reaction-b-select', {
      windowId: decisionB.windowId, optionId: REACTION_ACTION_ID,
    }));
    assert.equal(selectedA.ok, true);
    assert.equal(selectedB.ok, true);
    const reactionContextA = selectedA.snapshot.entities.find(entity => entity.id === 'reaction-a-reactor')?.currentActionContext;
    const reactionContextB = selectedB.snapshot.entities.find(entity => entity.id === 'reaction-b-reactor')?.currentActionContext;
    assert.equal(reactionContextA?.actionTemplateId, REACTION_ACTION_ID);
    assert.equal(reactionContextB?.actionTemplateId, REACTION_ACTION_ID);
    assert.equal(reactionContextA?.resolveTick, selectedA.snapshot.tick + aConfig.startupTicks);
    assert.equal(reactionContextB?.resolveTick, selectedB.snapshot.tick + bConfig.startupTicks);

    const finalA = await eventually(
      () => coordinatorA!.getSnapshot(),
      snapshot => snapshot.entities.find(entity => entity.id === 'reaction-a-reactor')?.activeEffects.some(effect => effect.templateId === aConfig.buffId) === true,
      'isolated A reaction effect',
    );
    let nextWait = 0;
    const finalB = await eventually(
      () => {
        const snapshot = coordinatorB!.getSnapshot();
        const source = snapshot.entities.find(entity => entity.id === 'reaction-b-source');
        const slot = snapshot.plan.slots.find(candidate => candidate.entityId === source?.id);
        // B's trigger finishes before its slower reaction. Submit a real WAIT
        // at the new action barrier so that the reaction can reach ACTIVE.
        if (source && slot && !source.currentActionContext && !slot.ready
          && slot.readyAtTick === undefined && snapshot.decisions.length === 0) {
          const waited = coordinatorB!.handleCommand(principalB, command('WAIT', `reaction-b-continue-${++nextWait}`, {
            entityId: source.id,
          }));
          assert.equal(waited.ok, true);
          return waited.snapshot;
        }
        return snapshot;
      },
      snapshot => snapshot.entities.find(entity => entity.id === 'reaction-b-reactor')?.activeEffects.some(effect => effect.templateId === bConfig.buffId) === true,
      'isolated B reaction effect',
    );
    assert.equal(finalA.entities.find(entity => entity.id === 'reaction-a-reactor')?.resources.current.focus, 10 - aConfig.resourceCost);
    assert.equal(finalB.entities.find(entity => entity.id === 'reaction-b-reactor')?.resources.current.focus, 10 - bConfig.resourceCost);
  } finally {
    coordinatorA?.close();
    coordinatorB?.close();
    Dictionary.clearRuntimeActions();
  }
}

async function main(): Promise<void> {
  await runMainActionIsolation();
  await runReactionActionIsolation();
  console.log('encounter-rule-isolation: two formal coordinators remain rule-isolated');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
