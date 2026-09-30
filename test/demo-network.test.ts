import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import type { DemoSessionResponse, EncounterCommandResult } from '../packages/shared/src/index.js';
import { createDemoServer, type DemoServerHandle } from '../packages/backend/src/demo/DemoServer.js';
import { DEMO_ACTION_IDS } from '../packages/backend/src/demo/DemoContent.js';

const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'elysian-demo-network-')));
const clients: Socket[] = [];
let server: DemoServerHandle | undefined;
let requestNumber = 0;

async function main(): Promise<void> {
  server = await createDemoServer({
    dataDirectory: temporaryRoot,
    hostCredential: 'network-test-host-credential',
    joinCode: 'NETWORK',
    host: '127.0.0.1',
    port: 0,
  });
  try {
    const { url } = await server.listen();
    async function http(path: string, body?: unknown, token?: string): Promise<Response> {
      return fetch(`${url}/api/demo/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    async function login(path: 'host' | 'join', body: unknown): Promise<DemoSessionResponse['data']> {
      const response = await http(path, body);
      assert.equal(response.status, 200);
      const result = await response.json() as DemoSessionResponse;
      assert.equal(result.ok, true);
      return result.data;
    }
    async function connect(token: string): Promise<Socket> {
      const socket = io(url, { autoConnect: false, transports: ['websocket'], reconnection: false, forceNew: true, auth: { accessToken: token } });
      clients.push(socket);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Demo socket connection timed out')), 3000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
        socket.connect();
      });
      return socket;
    }
    async function command(socket: Socket, type: string, payload: Record<string, unknown>): Promise<EncounterCommandResult> {
      const requestId = `network-${++requestNumber}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No ACK for ${type}`)), 3000);
        socket.emit('DEMO_COMMAND', { requestId, type, payload }, (result: EncounterCommandResult) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    }

    assert.equal((await http('session')).status, 401, 'session requires a bearer header');
    assert.equal((await http('host', { credential: 'wrong' })).status, 401, 'host credential is server checked');
    const host = await login('host', { credential: 'network-test-host-credential', displayName: 'GM' });
    const players = await Promise.all(['P1', 'P2', 'P3'].map(displayName => login('join', { joinCode: 'NETWORK', displayName, role: 'GM' })));
    assert.ok(players.every(player => player.session.role === 'PL'), 'client role fields never grant GM authority');
    assert.equal(host.joinCode, 'NETWORK', 'only the GM receives the room code');
    assert.equal('joinCode' in players[0], false, 'PL session response omits the room code');

    const gmRoster = await (await http('roster', undefined, host.accessToken)).json() as { data: { entries: Array<{ userId?: string }> } };
    assert.ok(gmRoster.data.entries.every(entry => entry.userId !== undefined), 'GM roster includes identity for assignment');
    const playerRoster = await (await http('roster', undefined, players[0].accessToken)).json() as { data: { entries: Array<{ userId?: string; controlledEntityIds: string[] }> } };
    assert.ok(playerRoster.data.entries.every(entry => entry.userId === undefined), 'PL roster hides user ids');
    assert.ok(playerRoster.data.entries.every(entry => entry.controlledEntityIds.length === 0), 'PL roster hides other players control ids');

    const gmSocket = await connect(host.accessToken);
    const playerSocket = await connect(players[0].accessToken);
    const malformed = await new Promise<EncounterCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No malformed command ACK')), 3000);
      gmSocket.emit('DEMO_COMMAND', { requestId: 'malformed', type: 'UNKNOWN', payload: {} }, (result: EncounterCommandResult) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.code, 'INVALID_COMMAND');
    const badBarrierVersion = await new Promise<EncounterCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No invalid-version ACK')), 3000);
      gmSocket.emit('DEMO_COMMAND', { requestId: 'invalid-version', type: 'START', payload: {}, expectedBarrierVersion: -1 }, (result: EncounterCommandResult) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
    assert.equal(badBarrierVersion.ok, false);
    assert.equal(badBarrierVersion.code, 'INVALID_COMMAND');

    const initial = server.coordinator.getSnapshot();
    const playerEntity = initial.entities.find(entity => entity.faction === 'PLAYERS');
    assert.ok(playerEntity, 'demo has a player entity to assign');
    const assignment = await http('assign', {
      userId: players[0].session.userId,
      entityId: playerEntity.id,
    }, host.accessToken);
    assert.equal(assignment.status, 200, 'GM can assign a player before the first start');
    const enemy = initial.entities.find(entity => entity.faction === 'ENEMIES');
    assert.ok(enemy, 'demo has an enemy to place before START');
    const adjusted = await command(gmSocket, 'GM_ADJUST_ENTITY', {
      entityId: enemy.id,
      reason: 'network opening placement',
      position: { x: 4, y: 4, z: 0 },
    });
    assert.equal(adjusted.ok, true);
    const originalSaveOpening = server.persistence.saveOpeningSnapshot.bind(server.persistence);
    server.persistence.saveOpeningSnapshot = () => ({ ok: false, code: 'PERSISTENCE_FAILED', message: 'injected opening failure' });
    const failedStartPersist = await command(gmSocket, 'START', {});
    assert.equal(failedStartPersist.ok, true, 'a persistence failure does not roll back an accepted GM command');
    const failedOpeningStatus = await (await http('persistence', undefined, host.accessToken)).json() as { data: { status: string; retryable: boolean } };
    assert.equal(failedOpeningStatus.data.status, 'failed');
    server.persistence.saveOpeningSnapshot = originalSaveOpening;
    const openingRetry = await http('persistence/retry', {}, host.accessToken);
    assert.equal(openingRetry.status, 200);
    assert.equal((await openingRetry.json() as { data: { status: string } }).data.status, 'saved');
    const started = failedStartPersist;
    assert.equal(started.ok, true);
    const opening = server.persistence.load()?.openingSnapshot;
    assert.deepEqual(opening?.entities.find(entity => entity.id === enemy.id)?.transform.coords, { x: 4, y: 4, z: 0 }, 'START checkpoints GM layout as the opening snapshot');

    const spoofedPlayerOverride = await command(playerSocket, 'ACTION', {
      entityId: playerEntity.id,
      actionTemplateId: DEMO_ACTION_IDS.RANGED,
      targetIds: [enemy.id],
      priority: 999,
      effectiveTick: 0,
    });
    assert.equal(spoofedPlayerOverride.ok, false, 'PL cannot submit a priority or effective Tick override');
    assert.equal(spoofedPlayerOverride.code, 'FORBIDDEN_OVERRIDE');

    const originalSaveSettlement = server.persistence.saveSettlement.bind(server.persistence);
    let latestRosterSettlement: string | undefined;
    gmSocket.on('DEMO_ROSTER', payload => {
      const settlement = (payload as { settlement?: { status?: string } }).settlement;
      if (settlement?.status) latestRosterSettlement = settlement.status;
    });
    (server.persistence as unknown as { saveSettlement: (...args: Parameters<DemoServerHandle['persistence']['saveSettlement']>) => { ok: boolean; code?: 'PERSISTENCE_FAILED'; message?: string } }).saveSettlement = () => ({
      ok: false,
      code: 'PERSISTENCE_FAILED',
      message: 'injected network test failure',
    });
    const ended = await command(gmSocket, 'GM_END', { reason: 'network settlement' });
    assert.equal(ended.ok, true);
    const failedPersistence = await (await http('persistence', undefined, host.accessToken)).json() as { data: { status: string; retryable: boolean } };
    assert.equal(failedPersistence.data.status, 'failed');
    assert.equal(failedPersistence.data.retryable, true);
    const restartBeforeRetry = await command(gmSocket, 'GM_RESTART', {});
    assert.equal(restartBeforeRetry.ok, false, 'GM_RESTART must not discard an unsaved settlement');
    assert.equal(restartBeforeRetry.code, 'SETTLEMENT_NOT_SAVED');
    server.persistence.saveSettlement = originalSaveSettlement;
    const retried = await http('persistence/retry', {}, host.accessToken);
    assert.equal(retried.status, 200);
    const savedPersistence = await retried.json() as { data: { status: string } };
    assert.equal(savedPersistence.data.status, 'saved');
    assert.equal(latestRosterSettlement, 'saved', 'successful settlement persistence must be broadcast to connected sockets');
    const settledRecord = server.persistence.load();
    assert.ok(settledRecord?.result, 'retry writes the settlement after a transient failure');
    assert.deepEqual(settledRecord?.openingSnapshot.entities.find(entity => entity.id === enemy.id)?.transform.coords, { x: 4, y: 4, z: 0 }, 'settlement must preserve the START opening layout');
    assert.equal(settledRecord?.latestSnapshot.status, settledRecord?.result?.status, 'latest snapshot records the terminal result');
    assert.equal(server.persistence.loadSettlementHistory().length, 1, 'settlement history keeps the completed encounter');
    const historyBeforeResync = server.persistence.loadSettlementHistory().length;
    for (let attempt = 0; attempt < 4; attempt++) {
      assert.equal((await http('session', undefined, host.accessToken)).status, 200);
      assert.equal((await http('roster', undefined, host.accessToken)).status, 200);
      const resyncSocket = await connect(host.accessToken);
      const disconnected = new Promise<void>(resolve => resyncSocket.once('disconnect', () => resolve()));
      resyncSocket.disconnect();
      await disconnected;
    }
    assert.equal(server.persistence.loadSettlementHistory().length, historyBeforeResync, 'sync/reconnect must not duplicate one settlement result');

    const correction = await command(gmSocket, 'GM_CORRECT', {
      entityId: playerEntity.id, reason: 'post-settlement audit persists without rewriting the result',
      changes: { 'resources.current.hp': 42 },
    });
    assert.equal(correction.ok, true);
    assert.equal(server.persistence.load()?.latestSnapshot.entities.find(entity => entity.id === playerEntity.id)?.resources.current.hp, 42);
    assert.ok(server.persistence.load()?.latestSnapshot.logs.some(log => log.meta?.reason === 'post-settlement audit persists without rewriting the result'));
    assert.equal(server.persistence.loadSettlementHistory().length, historyBeforeResync, 'an appended correction must not rewrite or duplicate the original result');

    const restarted = await command(gmSocket, 'GM_RESTART', {});
    assert.equal(restarted.ok, true);
    const afterRestart = server.persistence.load();
    assert.equal(afterRestart?.latestSnapshot.status, 'LOBBY');
    assert.equal(afterRestart?.result, undefined, 'restart clears the active result row');
    assert.deepEqual(afterRestart?.openingSnapshot.entities.find(entity => entity.id === enemy.id)?.transform.coords, { x: 4, y: 4, z: 0 }, 'restart retains the opening layout');
    assert.deepEqual(restarted.snapshot.entities.find(entity => entity.id === enemy.id)?.transform.coords, { x: 4, y: 4, z: 0 }, 'restart mounts the START opening layout in memory');
    assert.equal(server.persistence.loadSettlementHistory().length, 1, 'restart does not delete the prior settlement history');
    assert.equal((await command(gmSocket, 'START', {})).ok, true, 'the restarted lobby can start again');
    const replayAction = await command(playerSocket, 'ACTION', {
      entityId: playerEntity.id,
      actionTemplateId: DEMO_ACTION_IDS.RANGED,
      targetIds: [enemy.id],
    });
    assert.equal(replayAction.ok, true, 'the original player socket can submit a new action after restart');
    const secondEnded = await command(gmSocket, 'GM_END', { reason: 'network second run' });
    assert.equal(secondEnded.ok, true, 'the restarted encounter can produce a second settlement');
    assert.equal(server.persistence.loadSettlementHistory().length, 2, 'a distinct restart run keeps a distinct settlement history row');
    console.log('demo-network: auth, malformed commands, visibility, settlement retry and restart persistence passed');
  } finally {
    for (const client of clients) client.disconnect();
    await server.close();
  }
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
