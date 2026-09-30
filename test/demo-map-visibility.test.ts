import assert from 'node:assert/strict';
import { filterDemoSnapshot } from '../packages/backend/src/demo/DemoServer.ts';
import type { DemoSessionRecord } from '../packages/backend/src/demo/DemoSessionService.ts';
import type { EncounterActionPlan, EncounterEntity, EncounterSnapshot } from '../packages/shared/src/index.ts';

function entity(id: string, faction: 'PLAYER' | 'PLAYERS' | 'ENEMY' | 'ENEMIES', x: number, visibility: 'PUBLIC' | 'GM' = 'PUBLIC'): EncounterEntity {
  return {
    id,
    templateId: `template.${id}`,
    type: 'ACTOR',
    transform: { coords: { x, y: 2, z: 0 }, planeId: 'demo', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: .45, mass: 60, movementModes: ['WALK'] },
    resources: { current: { hp: 100 }, max: { hp: 100 } },
    activeEffects: [],
    faction,
    visibility,
    displayName: id,
  };
}

function action(partial: Partial<EncounterActionPlan> & Pick<EncounterActionPlan, 'actionId' | 'actorId' | 'actionTemplateId' | 'phase'>): EncounterActionPlan {
  return {
    targetIds: [],
    declaredTick: 0,
    priority: 0,
    paidResources: {},
    decisionVersion: 1,
    controlEpoch: 0,
    causationId: `${partial.actionId}-cause`,
    ...partial,
  };
}

function session(): DemoSessionRecord {
  return {
    sessionId: 'session', userId: 'player', role: 'PL', displayName: 'Player', createdAt: 0,
    expiresAt: 1, reconnectUntil: 1, revoked: false, socketIds: new Set(['socket']),
    controlledEntityIds: new Set(['own']),
  };
}

const own = entity('own', 'PLAYER', 1);
const ally = entity('ally', 'PLAYERS', 2);
const enemy = entity('enemy', 'ENEMY', 6);
const hidden = entity('hidden', 'ENEMIES', 7, 'GM');
own.currentActionContext = {
  type: 'MOVING', actionId: 'private-runtime', actionTemplateId: 'DEMO_MOVE', phase: 'STARTUP', resolveTick: 10,
  waypoints: [{ x: 3, y: 2, z: 0 }, { x: 4, y: 2, z: 0 }], currentWaypointIndex: 0,
  activeTargetIds: [hidden.id], activeHitTargetIds: [hidden.id],
};

const ownPending = action({ actionId: 'own-pending', actorId: own.id, actionTemplateId: 'DEMO_MOVE', phase: 'DECLARED', targetCoords: { x: 4, y: 2, z: 0 } });
const allyPending = action({ actionId: 'ally-pending', actorId: ally.id, actionTemplateId: 'DEMO_MOVE', phase: 'DECLARED', targetCoords: { x: 3, y: 2, z: 0 } });
const enemyPending = action({ actionId: 'enemy-pending', actorId: enemy.id, actionTemplateId: 'DEMO_MELEE_STRIKE', phase: 'DELAY', relation: 'ATTACK', targetIds: [own.id] });
const visibleExecution = action({ actionId: 'enemy-visible', actorId: enemy.id, actionTemplateId: 'DEMO_MELEE_STRIKE', phase: 'STARTUP', relation: 'ATTACK', targetIds: [own.id] });
const hiddenExecution = action({ actionId: 'own-hidden-target', actorId: own.id, actionTemplateId: 'DEMO_MELEE_STRIKE', phase: 'ACTIVE', relation: 'ATTACK', targetIds: [hidden.id], targetCoords: { x: 7, y: 2, z: 0 } });
const mixedExecution = action({ actionId: 'enemy-mixed', actorId: enemy.id, actionTemplateId: 'DEMO_MELEE_STRIKE', phase: 'ACTIVE', relation: 'ATTACK', targetIds: [own.id, hidden.id] });
const recovery = action({ actionId: 'enemy-recovery', actorId: enemy.id, actionTemplateId: 'DEMO_MELEE_STRIKE', phase: 'RECOVERY', relation: 'ATTACK', targetIds: [own.id] });

const snapshot: EncounterSnapshot = {
  encounterId: 'visibility-test', revision: 10, tick: 3, status: 'ACTIVE', paused: false,
  entities: [own, ally, enemy, hidden],
  actions: [ownPending, allyPending, enemyPending, visibleExecution, hiddenExecution, mixedExecution, recovery],
  plan: {
    windowTick: 0,
    slots: [
      { entityId: own.id, faction: own.faction, controllerUserId: 'player', connected: true, ready: true, waiting: false, controlEpoch: 0 },
      { entityId: ally.id, faction: ally.faction, connected: true, ready: true, waiting: false, controlEpoch: 0 },
      { entityId: enemy.id, faction: enemy.faction, connected: true, ready: true, waiting: false, controlEpoch: 0 },
    ],
    committed: true, actions: [ownPending, allyPending, enemyPending], barrierVersion: 1,
  },
  decisions: [], controls: [
    { entityId: own.id, userId: 'player', role: 'PL', controlEpoch: 0, connectedSocketIds: ['socket'], takenOverByGm: false },
    { entityId: ally.id, role: 'PL', controlEpoch: 0, connectedSocketIds: [], takenOverByGm: false },
    { entityId: enemy.id, role: 'GM', controlEpoch: 0, connectedSocketIds: [], takenOverByGm: false },
  ],
  logs: [
    { id: 'enemy-pending-log', tick: 0, message: '敌方 已提交 DEMO_MELEE_STRIKE。', visibility: 'PLAYER', actorId: enemy.id, actionId: enemyPending.actionId, causationId: 'enemy-pending-cause' },
    { id: 'enemy-execution-log', tick: 3, message: '敌方 已提交 DEMO_MELEE_STRIKE。', visibility: 'PLAYER', actorId: enemy.id, actionId: visibleExecution.actionId, causationId: 'enemy-execution-cause' },
    { id: 'enemy-history-log', tick: 8, message: '敌方 已结算 DEMO_MELEE_STRIKE。', visibility: 'PLAYER', actorId: enemy.id, actionId: 'enemy-old-action', causationId: 'enemy-old-cause' },
  ],
};

const filtered = filterDemoSnapshot(snapshot, session());
assert.deepEqual(filtered.entities.map(item => item.id), ['own', 'ally', 'enemy'], 'GM-only entity is removed');
assert.equal(filtered.actions.some(item => item.actionId === enemyPending.actionId), false, 'foreign pre-startup plan is hidden');
assert.equal(filtered.plan.actions.some(item => item.actionId === enemyPending.actionId), false, 'foreign plan.actions entry is hidden');
assert.equal(filtered.actions.some(item => item.actionId === ownPending.actionId), true, 'own-faction plan remains visible');
assert.equal(filtered.actions.some(item => item.actionId === allyPending.actionId), true, 'same-faction alias plan remains visible');
assert.equal(filtered.plan.actions.some(item => item.actionId === allyPending.actionId), true, 'same-faction alias plan.actions entry remains visible');
assert.equal(filtered.actions.find(item => item.actionId === visibleExecution.actionId)?.targetIds[0], own.id, 'visible execution relation keeps both endpoints');
assert.equal(filtered.logs.some(log => log.id === 'enemy-pending-log'), false, 'foreign pending action log is removed with its hidden action');
const visibleExecutionLog = filtered.logs.find(log => log.id === 'enemy-execution-log');
assert.ok(visibleExecutionLog, 'visible execution log remains available');
assert.equal(visibleExecutionLog.message, '战斗日志已更新', 'foreign execution log does not disclose its action template');
assert.equal(visibleExecutionLog.actionId, undefined, 'foreign execution log loses the action reference');
const historicalLog = filtered.logs.find(log => log.id === 'enemy-history-log');
assert.ok(historicalLog, 'historical foreign action log remains after the action leaves the snapshot');
assert.equal(historicalLog.message, '战斗日志已更新', 'historical foreign action log remains sanitized');
const hiddenRelation = filtered.actions.find(item => item.actionId === hiddenExecution.actionId);
assert.ok(hiddenRelation);
assert.deepEqual(hiddenRelation.targetIds, [], 'hidden endpoint is removed instead of leaking a partial relation');
assert.equal(hiddenRelation.relation, undefined);
assert.equal(hiddenRelation.targetCoords, undefined);
assert.deepEqual(filtered.actions.find(item => item.actionId === mixedExecution.actionId)?.targetIds, [], 'multi-target relation does not keep a visible subset');
const ownContext = filtered.entities.find(item => item.id === own.id)?.currentActionContext as Record<string, unknown> | undefined;
assert.ok(ownContext, 'owned current action context is retained for lifecycle state');
assert.equal(ownContext.waypoints, undefined, 'path waypoints do not bypass action filtering');
assert.equal(ownContext.actionTemplateId, undefined, 'action template does not bypass action filtering');
assert.equal(ownContext.activeTargetIds, undefined, 'window targets cannot leak hidden entity ids');
assert.equal(ownContext.activeHitTargetIds, undefined, 'per-strike hit ledger stays server-side for players');

const gmSnapshot = filterDemoSnapshot(snapshot, { ...session(), sessionId: 'gm-session', userId: 'gm', role: 'GM', controlledEntityIds: new Set<string>() });
const gmHiddenRelation = gmSnapshot.actions.find(item => item.actionId === hiddenExecution.actionId);
assert.deepEqual(gmSnapshot.entities.find(item => item.id === own.id)?.currentActionContext?.activeHitTargetIds,
  [hidden.id], 'GM retains the full strike ledger for adjudication');
assert.ok(gmHiddenRelation, 'GM keeps the hidden execution action');
assert.deepEqual(gmHiddenRelation.targetIds, [hidden.id], 'GM keeps hidden relation endpoints');
assert.equal(gmHiddenRelation.relation, 'ATTACK', 'GM keeps the explicit relation hint');
assert.equal(gmSnapshot.logs.find(log => log.id === 'enemy-pending-log')?.message, '敌方 已提交 DEMO_MELEE_STRIKE。', 'GM keeps full action log detail');
console.log('demo-map-visibility: faction plans, visible execution endpoints, aliases, context redaction and multi-target filtering passed');
