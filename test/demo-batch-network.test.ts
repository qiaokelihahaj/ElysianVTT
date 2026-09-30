import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import type { DemoSessionResponse, EncounterCommandResult, EncounterSnapshot } from '../packages/shared/src/index.js';
import { createDemoServer, type DemoServerHandle } from '../packages/backend/src/demo/DemoServer.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const dataDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'elysian-demo-batch-network-')));
  let server: DemoServerHandle | undefined;
  const sockets: Socket[] = [];
  let sequence = 0;
  try {
    server = await createDemoServer({
      dataDirectory,
      hostCredential: 'batch-network-host',
      joinCode: 'BATCH',
      host: '127.0.0.1',
      port: 0,
    });
    const { url } = await server.listen();
    async function http(path: string, body?: unknown, token?: string): Promise<Response> {
      return fetch(`${url}/api/demo/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
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
    async function connect(accessToken: string): Promise<Socket> {
      const socket = io(url, { autoConnect: false, transports: ['websocket'], reconnection: false, forceNew: true, auth: { accessToken } });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('batch socket connection timed out')), 3000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
        socket.connect();
      });
      return socket;
    }
    async function command(socket: Socket, type: string, payload: Record<string, unknown>, controlEpoch?: number): Promise<EncounterCommandResult> {
      const requestId = `batch-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`batch ACK timeout: ${type}`)), 3000);
        socket.emit('DEMO_COMMAND', { requestId, type, payload, controlEpoch }, (result: EncounterCommandResult) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    }
    async function snapshot(token: string): Promise<EncounterSnapshot> {
      const response = await http('session', undefined, token);
      assert.equal(response.status, 200);
      const result = await response.json() as { data: { snapshot: EncounterSnapshot } };
      return result.data.snapshot;
    }

    const host = await login('host', { credential: 'batch-network-host', displayName: 'GM' });
    const players = await Promise.all(['A', 'B', 'C'].map(displayName => login('join', { joinCode: 'BATCH', displayName })));
    const gmSocket = await connect(host.accessToken);
    const playerSockets = await Promise.all(players.map(player => connect(player.accessToken)));
    const characters = (await snapshot(host.accessToken)).entities.filter(entity => entity.faction === 'PLAYERS');
    const enemies = (await snapshot(host.accessToken)).entities.filter(entity => entity.faction === 'ENEMIES');
    assert.equal(characters.length, 3);
    assert.ok(enemies.length >= 3);
    for (let index = 0; index < characters.length; index++) {
      const assignment = await http('assign', { userId: players[index].session.userId, entityId: characters[index].id }, host.accessToken);
      assert.equal(assignment.status, 200);
    }
    const beforeStart = await snapshot(host.accessToken);
    const epochs = characters.map(character => beforeStart.controls.find(control => control.entityId === character.id)?.controlEpoch);
    assert.ok(epochs.every(epoch => epoch !== undefined));
    assert.equal((await command(gmSocket, 'START', {})).ok, true);

    // Submit B first and A second.  Both plans belong to the same barrier;
    // their declaration order must not open a reaction window for B while it
    // is still only a plan and has not entered STARTUP.
    const bAction = await command(playerSockets[1], 'ACTION', {
      entityId: characters[1].id,
      actionTemplateId: 'DEMO_RANGED_SHOT',
      targetIds: [enemies[0].id],
    }, epochs[1]);
    const aAction = await command(playerSockets[0], 'ACTION', {
      entityId: characters[0].id,
      actionTemplateId: 'DEMO_RANGED_SHOT',
      targetIds: [enemies[0].id],
    }, epochs[0]);
    assert.equal(bAction.ok, true);
    assert.equal(aAction.ok, true);
    const beforeThird = await snapshot(host.accessToken);
    assert.equal(beforeThird.tick, 0);
    assert.equal(beforeThird.decisions.length, 0, 'a pending plan cannot receive a reaction window before the barrier commits');
    assert.ok(beforeThird.plan.slots.find(slot => slot.entityId === characters[1].id)?.ready);
    assert.ok(beforeThird.plan.slots.find(slot => slot.entityId === characters[2].id)?.ready === false);

    // C waits, while GM supplies the three NPC slots.  The final submission
    // commits all five decisions together and advances to the first startup.
    assert.equal((await command(playerSockets[2], 'WAIT', { entityId: characters[2].id }, epochs[2])).ok, true);
    for (const enemy of enemies) assert.equal((await command(gmSocket, 'WAIT', { entityId: enemy.id })).ok, true);
    const finalBarrier = await snapshot(host.accessToken);
    assert.equal(finalBarrier.tick, 0);
    assert.equal(finalBarrier.decisions.some(decision => decision.reactorEntityId === characters[1].id), false, 'the later declared actor is not a reactor for its own unstarted action');

    let firstStartup: EncounterSnapshot | undefined;
    for (let attempt = 0; attempt < 80; attempt++) {
      const current = await snapshot(host.accessToken);
      if (current.tick >= 2 || current.decisions.length > 0) {
        firstStartup = current;
        break;
      }
      await delay(25);
    }
    assert.ok(firstStartup, 'the committed action batch must reach its first startup tick');
    assert.ok(firstStartup.decisions.every(decision => decision.reactorEntityId !== characters[1].id), 'a later declared actor never gets an ordinary reaction while its own action is pending/active');
    assert.ok(firstStartup.decisions.every(decision => decision.sourceEntityId === characters[0].id || decision.sourceEntityId === characters[1].id || decision.sourceEntityId === enemies[0].id || decision.sourceEntityId === enemies[1].id || decision.sourceEntityId === enemies[2].id), 'reaction sources come from the committed batch');
    console.log('demo-batch-network: declaration order, shared barrier and startup reaction eligibility passed');
  } finally {
    for (const socket of sockets) socket.disconnect();
    if (server) await server.close();
    rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
