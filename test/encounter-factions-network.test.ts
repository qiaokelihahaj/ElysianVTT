import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import type { DemoCatalogResponse, DemoSessionResponse, DemoSocketIncrementPayload, DemoSocketRosterPayload, EncounterActionPlan, EncounterCommandResult, EncounterSide, EncounterSnapshot } from '../packages/shared/src/index.js';
import { createDemoServer, filterDemoSnapshot, type DemoServerHandle } from '../packages/backend/src/demo/DemoServer.js';
import { DEMO_ACTION_IDS } from '../packages/backend/src/demo/DemoContent.js';
import type { LanSessionRecord } from '../packages/backend/src/sessions/LanSessionService.js';

const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'elysian-factions-network-')));
const clients: Socket[] = [];
let server: DemoServerHandle | undefined;
let requestNumber = 0;
const options = { dataDirectory: temporaryRoot, hostCredential: 'factions-test-host', joinCode: 'FACTIONS', host: '127.0.0.1', port: 0 };
const red: EncounterSide = { kind: 'FACTION', id: '赤铜议会' };
const blue: EncounterSide = { kind: 'FACTION', id: '蓝月游团' };
const secret: EncounterSide = { kind: 'FACTION', id: '秘密势力' };

function pending(actorId: string): EncounterActionPlan {
  return { actionId: `plan-${actorId}`, actorId, actionTemplateId: DEMO_ACTION_IDS.MOVE, phase: 'DECLARED',
    targetIds: [], targetCoords: { x: 3, y: 3, z: 0 }, declaredTick: 0, priority: 0, paidResources: {},
    decisionVersion: 0, controlEpoch: 0, causationId: `cause-${actorId}` };
}

function checkPlanVisibility(snapshot: EncounterSnapshot, session: LanSessionRecord): void {
  const fixture = structuredClone(snapshot);
  const own = fixture.entities[0];
  const foreign = fixture.entities[1];
  const independent = fixture.entities[2];
  const otherOwned = fixture.entities[3];
  const hidden = fixture.entities[4];
  const sameFaction = fixture.entities[5];
  own.faction = null;
  foreign.faction = 'NEUTRAL';
  independent.faction = null;
  otherOwned.faction = red.id;
  sameFaction.faction = red.id;
  fixture.actions = fixture.entities.map(entity => pending(entity.id));
  fixture.plan.actions = fixture.actions;
  fixture.relations = [
    { a: { kind: 'ENTITY', id: own.id }, b: { kind: 'ENTITY', id: foreign.id }, relation: 'ALLY' },
    { a: red, b: { kind: 'ENTITY', id: hidden.id }, relation: 'HOSTILE' },
    { a: red, b: secret, relation: 'HOSTILE' },
  ];
  const filtered = filterDemoSnapshot(fixture, session);
  assert.deepEqual(filtered.actions.map(action => action.actorId).sort(), [own.id, otherOwned.id, sameFaction.id].sort(),
    'ownership spans factions and shares exact-faction plans, while allied independent entities stay private');
  assert.deepEqual(filtered.plan.actions.map(action => action.actorId).sort(), filtered.actions.map(action => action.actorId).sort());
  assert.equal(filtered.relations?.length, 1, 'both hidden entity endpoints and hidden-only faction endpoints are removed');
  assert.equal(JSON.stringify(filtered).includes(secret.id), false, 'secret faction identity does not escape through relations');
  fixture.result = { status: 'ENDED', survivors: [], casualties: [], resolvedTick: 0, endedBy: 'GM',
    winningFaction: secret.id, winningSides: [secret, { kind: 'ENTITY', id: hidden.id }, { kind: 'ENTITY', id: own.id }], reason: `${secret.id}获胜` };
  const result = filterDemoSnapshot(fixture, session).result;
  assert.deepEqual(result?.winningSides, [{ kind: 'ENTITY', id: own.id }]);
  assert.equal(result?.winningFaction, undefined);
  assert.equal(result?.reason, '遭遇已结算', 'settlement reason does not disclose a hidden-only faction name');
}

async function checkLobbyRestore(): Promise<void> {
  const lobbyOptions = { ...options, dataDirectory: join(temporaryRoot, 'lobby-restore') };
  let lobby = await createDemoServer(lobbyOptions);
  let socket: Socket | undefined;
  try {
    const { url } = await lobby.listen();
    const login = await fetch(`${url}/api/demo/host`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: options.hostCredential }) });
    assert.equal(login.status, 200);
    const host = (await login.json() as DemoSessionResponse).data;
    socket = io(url, { autoConnect: false, transports: ['websocket'], reconnection: false, forceNew: true, auth: { accessToken: host.accessToken } });
    const client = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('lobby restore socket timed out')), 4000);
      client.once('connect', () => { clearTimeout(timer); resolve(); });
      client.once('connect_error', error => { clearTimeout(timer); reject(error); });
      client.connect();
    });
    async function command(type: string, payload: Record<string, unknown>): Promise<EncounterCommandResult> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`lobby restore ACK timed out: ${type}`)), 4000);
        client.emit('DEMO_COMMAND', { requestId: `lobby-${++requestNumber}`, type, payload }, (result: EncounterCommandResult) => { clearTimeout(timer); resolve(result); });
      });
    }
    const [own, independent, , , , removed] = lobby.coordinator.getSnapshot().entities;
    assert.equal((await command('GM_SET_FACTION', { entityId: own.id, faction: red.id })).ok, true);
    assert.equal(lobby.persistence.load()?.openingSnapshot.entities.find(entity => entity.id === own.id)?.faction, red.id,
      'accepted lobby faction changes are persisted as opening configuration before START');
    assert.equal((await command('GM_SET_FACTION', { entityId: independent.id, faction: null })).ok, true);
    const relation = { a: red, b: { kind: 'ENTITY', id: independent.id }, relation: 'ALLY' };
    assert.equal((await command('GM_SET_RELATION', relation)).ok, true);
    assert.equal((await command('GM_SPAWN', { templateId: 'player-melee', entityId: 'lobby-independent', faction: null })).ok, true);
    assert.equal((await command('GM_REMOVE', { entityId: removed.id })).ok, true);
    const position = { x: 4, y: 4, z: 0 };
    assert.equal((await command('GM_ADJUST_ENTITY', { entityId: own.id, reason: 'lobby placement', position })).ok, true);
    const saveOpening = lobby.persistence.saveOpeningSnapshot.bind(lobby.persistence);
    lobby.persistence.saveOpeningSnapshot = () => ({ ok: false, code: 'PERSISTENCE_FAILED', message: 'injected lobby opening failure' });
    assert.equal((await command('GM_SET_VICTORY_CONDITION', { condition: 'MANUAL' })).ok, true);
    assert.notEqual(lobby.persistence.load()?.openingSnapshot.victoryCondition, 'MANUAL', 'injected failure does not silently save the new opening');
    lobby.persistence.saveOpeningSnapshot = saveOpening;
    assert.equal(lobby.retryPersistence(), true);
    assert.equal(lobby.persistence.load()?.openingSnapshot.victoryCondition, 'MANUAL', 'retry writes an opening snapshot, not only a checkpoint');
    client.disconnect();
    await lobby.close();
    lobby = await createDemoServer(lobbyOptions);
    const restored = lobby.coordinator.getSnapshot();
    assert.equal(restored.status, 'LOBBY');
    assert.equal(restored.entities.find(entity => entity.id === own.id)?.faction, red.id);
    assert.equal(restored.entities.find(entity => entity.id === independent.id)?.faction, null);
    assert.equal(restored.entities.find(entity => entity.id === 'lobby-independent')?.faction, null);
    assert.equal(restored.entities.some(entity => entity.id === removed.id), false);
    assert.deepEqual(restored.entities.find(entity => entity.id === own.id)?.transform.coords, position);
    assert.deepEqual(restored.relations, [relation]);
    assert.equal(restored.victoryCondition, 'MANUAL');
  } finally {
    socket?.disconnect();
    await lobby.close();
  }
}

async function main(): Promise<void> {
  await checkLobbyRestore();
  server = await createDemoServer(options);
  try {
    const { url } = await server.listen();
    async function http(path: string, body?: unknown, token?: string): Promise<Response> {
      return fetch(`${url}/api/demo/${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) });
    }
    async function login(path: 'host' | 'join', body: unknown): Promise<DemoSessionResponse['data']> {
      const response = await http(path, body);
      assert.equal(response.status, 200);
      return (await response.json() as DemoSessionResponse).data;
    }
    async function connect(token: string): Promise<{ socket: Socket; snapshot: EncounterSnapshot }> {
      const socket = io(url, { autoConnect: false, transports: ['websocket'], reconnection: false, forceNew: true, auth: { accessToken: token } });
      clients.push(socket);
      const snapshot = await new Promise<EncounterSnapshot>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('faction socket sync timed out')), 4000);
        socket.once('DEMO_SNAPSHOT', (payload: { snapshot: EncounterSnapshot }) => { clearTimeout(timer); resolve(payload.snapshot); });
        socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
        socket.connect();
      });
      return { socket, snapshot };
    }
    async function command(socket: Socket, type: string, payload: Record<string, unknown>, requestId = `factions-${++requestNumber}`): Promise<EncounterCommandResult> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No ACK for ${type}`)), 4000);
        socket.emit('DEMO_COMMAND', { requestId, type, payload }, (result: EncounterCommandResult) => { clearTimeout(timer); resolve(result); });
      });
    }
    function increment(socket: Socket, stage: string, predicate: (value: DemoSocketIncrementPayload) => boolean): Promise<DemoSocketIncrementPayload> {
      return new Promise((resolve, reject) => {
        let lastReceived = 'none';
        const timer = setTimeout(() => {
          socket.off('DEMO_INCREMENT', handler);
          reject(new Error(`faction increment timed out: ${stage}; last received: ${lastReceived}`));
        }, 4000);
        function handler(value: DemoSocketIncrementPayload): void {
          lastReceived = `revision ${value.increment.revision}, payload keys [${Object.keys(value.increment.payload).join(', ')}]`;
          if (!predicate(value)) return;
          clearTimeout(timer); socket.off('DEMO_INCREMENT', handler); resolve(value);
        }
        socket.on('DEMO_INCREMENT', handler);
      });
    }
    function nextEvent<T>(socket: Socket, event: string): Promise<T> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off(event, received); reject(new Error(`assignment sync timed out: ${event}`)); }, 4000);
        function received(value: T): void { clearTimeout(timer); socket.off(event, received); resolve(value); }
        socket.on(event, received);
      });
    }
    const gm = await login('host', { credential: options.hostCredential });
    const one = await login('join', { joinCode: options.joinCode, displayName: 'One' });
    const two = await login('join', { joinCode: options.joinCode, displayName: 'Two' });
    const gmSocket = (await connect(gm.accessToken)).socket;
    const oneSocket = (await connect(one.accessToken)).socket;
    const twoSocket = (await connect(two.accessToken)).socket;
    const entities = server.coordinator.getSnapshot().entities;
    const [own, foreign, independent, otherOwned, hidden] = entities;
    const emptyCatalog = await (await http('catalog', undefined, one.accessToken)).json() as DemoCatalogResponse;
    assert.equal(emptyCatalog.data.entries.length, 0, 'unassigned PL does not receive the GM template palette');
    for (const [userId, entityId] of [[one.session.userId, own.id], [one.session.userId, otherOwned.id], [two.session.userId, foreign.id]]) {
      assert.equal((await http('assign', { userId, entityId }, gm.accessToken)).status, 200);
    }
    for (const [entityId, faction] of [[own.id, red.id], [foreign.id, blue.id], [independent.id, null], [otherOwned.id, '紫杉守卫'], [hidden.id, secret.id]] as const) {
      assert.equal((await command(gmSocket, 'GM_SET_FACTION', { entityId, faction })).ok, true);
    }
    assert.equal((await command(gmSocket, 'GM_ADJUST_ENTITY', { entityId: hidden.id, reason: 'hidden faction fixture', visibility: 'GM' })).ok, true);
    const ownedCatalog = await (await http('catalog', undefined, one.accessToken)).json() as DemoCatalogResponse;
    assert.deepEqual(ownedCatalog.data.entries.map(entry => entry.templateId).sort(), ['monster-bruiser', 'player-melee']);
    assert.ok(ownedCatalog.data.entries.every(entry => entry.actions.some(action => action.id === DEMO_ACTION_IDS.MOVE)), 'custom-controlled enemy template has usable actions');
    assert.ok(ownedCatalog.data.entries.every(entry => entry.entityTemplate === undefined), 'PL catalog never sends full GM template stats');
    for (const playerSocket of [oneSocket, twoSocket]) {
      assert.equal((await command(playerSocket, 'GM_SET_FACTION', { entityId: own.id, faction: 'Spoof' })).code, 'FORBIDDEN');
      assert.equal((await command(playerSocket, 'GM_SET_RELATION', { a: red, b: blue, relation: 'ALLY' })).code, 'FORBIDDEN');
      assert.equal((await command(playerSocket, 'GM_SET_VICTORY_CONDITION', { condition: 'MANUAL' })).code, 'FORBIDDEN');
    }
    for (const faction of ['', ' padded ', 'bad\nname', '__proto__', 7, {}, 'x'.repeat(65)]) {
      assert.equal((await command(gmSocket, 'GM_SET_FACTION', { entityId: own.id, faction })).code, 'INVALID_COMMAND');
      assert.equal((await command(gmSocket, 'GM_SPAWN', { templateId: 'player-melee', faction })).code, 'INVALID_COMMAND');
    }
    for (const payload of [{ a: red, b: blue, relation: 'UNKNOWN' }, { a: red, b: { kind: 'ENTITY', id: '' }, relation: 'ALLY' }]) {
      assert.equal((await command(gmSocket, 'GM_SET_RELATION', payload)).code, 'INVALID_COMMAND');
    }
    assert.equal((await command(gmSocket, 'GM_SET_VICTORY_CONDITION', { condition: 'AUTO' })).code, 'INVALID_COMMAND');
    assert.equal((await command(gmSocket, 'GM_END', { winningSides: [{ kind: 'INVALID', id: own.id }] })).code, 'INVALID_COMMAND');
    for (const [entityId, faction] of [['spawn-independent', null], ['spawn-custom', '琥珀商队']] as const) {
      const spawned = await command(gmSocket, 'GM_SPAWN', { templateId: 'player-melee', entityId, faction });
      assert.equal(spawned.ok, true);
      assert.equal(spawned.snapshot.entities.find(entity => entity.id === entityId)?.faction, faction);
      assert.equal((await command(gmSocket, 'GM_REMOVE', { entityId })).ok, true);
    }

    const modeSync = increment(oneSocket, 'manual victory policy to player one', value => value.increment.payload.victoryCondition === 'MANUAL');
    assert.equal((await command(gmSocket, 'GM_SET_VICTORY_CONDITION', { condition: 'MANUAL' })).ok, true);
    assert.equal((await modeSync).snapshot.victoryCondition, 'MANUAL');
    const oneSync = increment(oneSocket, 'alliance to player one', value => value.increment.payload.relations?.some(pair => pair.relation === 'ALLY') === true);
    const twoSync = increment(twoSocket, 'alliance to player two', value => value.increment.payload.relations?.some(pair => pair.relation === 'ALLY') === true);
    const relationPayload = { a: red, b: blue, relation: 'ALLY' };
    const alliance = await command(gmSocket, 'GM_SET_RELATION', relationPayload, 'same-alliance-request');
    assert.equal(alliance.ok, true);
    assert.deepEqual((await oneSync).increment.payload.relations, [{ ...relationPayload }]);
    assert.deepEqual((await twoSync).snapshot.relations, [{ ...relationPayload }]);
    const revisionBeforeDuplicate = server.coordinator.getSnapshot().revision;
    assert.equal((await command(gmSocket, 'GM_SET_RELATION', relationPayload, 'same-alliance-request')).revision, alliance.revision);
    assert.equal(server.coordinator.getSnapshot().revision, revisionBeforeDuplicate, 'duplicate request does not mutate the relation twice');
    const hiddenSync = increment(oneSocket, 'hidden faction relation redaction', value => value.increment.revision > revisionBeforeDuplicate);
    assert.equal((await command(gmSocket, 'GM_SET_RELATION', { a: blue, b: secret, relation: 'HOSTILE' })).ok, true);
    assert.equal(JSON.stringify(await hiddenSync).includes(secret.id), false, 'increment and attached snapshot both hide secret faction endpoints');
    assert.equal((await command(gmSocket, 'START', {})).ok, true);
    assert.equal((await command(oneSocket, 'ACTION', { entityId: otherOwned.id, actionTemplateId: DEMO_ACTION_IDS.RANGED, targetIds: [foreign.id] })).ok, true,
      'a player retains command authority over an entity in a second faction');
    for (const userId of ['missing-player-session', gm.session.userId]) {
      const before = server.coordinator.getSnapshot();
      assert.equal((await command(gmSocket, 'GM_ASSIGN_ENTITY', { entityId: otherOwned.id, userId })).code, 'ASSIGNMENT_INVALID');
      assert.equal(server.coordinator.getSnapshot().revision, before.revision, 'an invalid assignment has no partial coordinator mutation');
      assert.equal(server.coordinator.getSnapshot().controls.find(control => control.entityId === otherOwned.id)?.userId, one.session.userId);
    }
    const oneAssignmentSnapshot = nextEvent<{ snapshot: EncounterSnapshot }>(oneSocket, 'DEMO_SNAPSHOT');
    const twoAssignmentSnapshot = nextEvent<{ snapshot: EncounterSnapshot }>(twoSocket, 'DEMO_SNAPSHOT');
    const oneAssignmentRoster = nextEvent<DemoSocketRosterPayload>(oneSocket, 'DEMO_ROSTER');
    const twoAssignmentRoster = nextEvent<DemoSocketRosterPayload>(twoSocket, 'DEMO_ROSTER');
    const oldOwnerFrames: EncounterSnapshot[] = [];
    const recordTransferFrame = (value: DemoSocketIncrementPayload): void => {
      const control = value.snapshot.controls.find(candidate => candidate.entityId === otherOwned.id);
      if (control?.userId !== one.session.userId) oldOwnerFrames.push(value.snapshot);
    };
    oneSocket.on('DEMO_INCREMENT', recordTransferFrame);
    const transfer = { entityId: otherOwned.id, userId: two.session.userId };
    assert.equal((await command(gmSocket, 'GM_ASSIGN_ENTITY', transfer, 'transfer-to-player-two')).ok, true);
    assert.equal((await oneAssignmentSnapshot).snapshot.actions.some(action => action.actorId === otherOwned.id), false, 'previous controller loses the foreign-faction pending plan');
    const newOwnerSnapshot = (await twoAssignmentSnapshot).snapshot;
    const transferredPlan = newOwnerSnapshot.actions.find(action => action.actorId === otherOwned.id);
    assert.ok(transferredPlan, 'new controller receives the pending plan');
    assert.deepEqual((await oneAssignmentRoster).entries.find(entry => entry.displayName === 'One')?.controlledEntityIds, [own.id]);
    assert.deepEqual((await twoAssignmentRoster).entries.find(entry => entry.displayName === 'Two')?.controlledEntityIds.sort(), [foreign.id, otherOwned.id].sort());
    oneSocket.off('DEMO_INCREMENT', recordTransferFrame);
    assert.ok(oldOwnerFrames.length > 0, 'assignment produces an increment before the final snapshot');
    assert.ok(oldOwnerFrames.every(snapshot => !snapshot.actions.some(action => action.actorId === otherOwned.id)),
      'every transfer increment uses the updated ownership, with no intermediate private-plan leak');
    const previousOwnerCatalog = await (await http('catalog', undefined, one.accessToken)).json() as DemoCatalogResponse;
    const newOwnerCatalog = await (await http('catalog', undefined, two.accessToken)).json() as DemoCatalogResponse;
    assert.deepEqual(previousOwnerCatalog.data.entries.map(entry => entry.templateId), ['player-melee']);
    assert.deepEqual(newOwnerCatalog.data.entries.map(entry => entry.templateId).sort(), ['monster-bruiser', 'player-ranged']);
    assert.equal((await command(oneSocket, 'ACTION', { entityId: otherOwned.id, actionTemplateId: DEMO_ACTION_IDS.RANGED, targetIds: [foreign.id] })).code, 'NOT_CONTROLLER');
    assert.equal((await command(twoSocket, 'CANCEL_ACTION', { actionId: transferredPlan.actionId })).ok, true);
    assert.equal((await command(twoSocket, 'ACTION', { entityId: otherOwned.id, actionTemplateId: DEMO_ACTION_IDS.RANGED, targetIds: [foreign.id] })).ok, true,
      'new controller can cancel and replace the transferred entity action');
    assert.equal((await command(gmSocket, 'GM_ASSIGN_ENTITY', { entityId: otherOwned.id, userId: one.session.userId })).ok, true);
    const revisionAfterReturn = server.coordinator.getSnapshot().revision;
    assert.equal((await command(gmSocket, 'GM_ASSIGN_ENTITY', transfer, 'transfer-to-player-two')).ok, true);
    assert.equal(server.coordinator.getSnapshot().revision, revisionAfterReturn, 'replaying an earlier assignment never reassigns an entity again');
    assert.ok(server.sessionService.getSessions().find(session => session.userId === one.session.userId)?.controlledEntityIds.has(otherOwned.id));
    assert.equal(server.sessionService.getSessions().find(session => session.userId === two.session.userId)?.controlledEntityIds.has(otherOwned.id), false);
    const unauthorized = await command(twoSocket, 'ACTION', { entityId: otherOwned.id, actionTemplateId: DEMO_ACTION_IDS.RANGED, targetIds: [own.id] });
    assert.equal(unauthorized.code, 'NOT_CONTROLLER', 'alliance does not transfer entity control');
    const playerSession = server.sessionService.getSessions().find(session => session.userId === one.session.userId);
    assert.ok(playerSession);
    checkPlanVisibility(server.coordinator.getSnapshot(), playerSession);
    const clearSync = increment(twoSocket, 'clear visible relations for player two', value => Array.isArray(value.increment.payload.relations) && value.increment.payload.relations.length === 0);
    assert.equal((await command(gmSocket, 'GM_SET_RELATION', { a: red, b: blue, relation: null })).ok, true);
    assert.deepEqual((await clearSync).increment.payload.relations, [], 'an explicit empty relation list clears the client state');
    twoSocket.disconnect();
    const reconnected = await connect(two.accessToken);
    assert.deepEqual(reconnected.snapshot.relations, []);
    assert.equal(reconnected.snapshot.victoryCondition, 'MANUAL');
    assert.equal(reconnected.snapshot.entities.find(entity => entity.id === foreign.id)?.faction, blue.id);
    assert.equal(reconnected.snapshot.actions.some(action => action.actorId === otherOwned.id), false, 'foreign pending plan remains hidden after reconnect');

    const winningSides: EncounterSide[] = [red, secret];
    const resultSync = increment(oneSocket, 'settlement winner redaction', value => value.increment.payload.result !== undefined);
    const ended = await command(gmSocket, 'GM_END', { winningSides, reason: 'multi-faction settlement' });
    assert.equal(ended.ok, true);
    assert.deepEqual(ended.snapshot.result?.winningSides, winningSides);
    const playerResult = await resultSync;
    assert.deepEqual(playerResult.increment.payload.result?.winningSides, [red]);
    assert.deepEqual(playerResult.snapshot.result?.winningSides, [red]);
    const stored = server.persistence.load();
    assert.deepEqual(stored?.result?.winningSides, winningSides);
    assert.equal(stored?.openingSnapshot.victoryCondition, 'MANUAL');
    assert.ok(stored?.openingSnapshot.relations?.some(pair => pair.relation === 'ALLY'));
    assert.equal(server.persistence.saveCheckpoint({ ...ended.snapshot, relations: [{ a: red, b: blue, relation: 'INVALID' }] } as unknown as EncounterSnapshot).ok, false, 'malformed persisted relation is rejected');
    assert.equal(server.persistence.saveCheckpoint({ ...ended.snapshot, victoryCondition: 'INVALID' } as unknown as EncounterSnapshot).ok, false, 'malformed persisted victory policy is rejected');
    const settlementCount = server.persistence.loadSettlementHistory().length;
    const alternateResult = { ...ended.snapshot.result!, winningSides: [red] };
    assert.equal(server.persistence.saveSettlement(ended.snapshot, alternateResult, 'winning-side-identity').ok, true);
    assert.equal(server.persistence.saveSettlement(ended.snapshot, { ...alternateResult, winningSides: [secret] }, 'winning-side-identity').ok, true);
    assert.equal(server.persistence.loadSettlementHistory().length, settlementCount + 2, 'different winners receive different settlement identities');
    for (const client of clients) client.disconnect();
    await server.close();
    server = await createDemoServer(options);
    const reopened = server.coordinator.getSnapshot();
    assert.equal(reopened.status, 'LOBBY', 'server restart preserves the existing restore-to-opening behavior');
    assert.equal(reopened.victoryCondition, 'MANUAL');
    assert.deepEqual(reopened.relations, stored?.openingSnapshot.relations, 'opening relation policy survives SQLite restore');
    console.log('encounter-factions-network: custom factions, two-player authorization, relation sync/reset, private plans, hidden sides, reconnect and SQLite restore passed');
  } finally {
    for (const client of clients) client.disconnect();
    await server?.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
