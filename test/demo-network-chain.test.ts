import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import type {
  DemoSessionResponse,
  EncounterCommandResult,
  EncounterSnapshot,
} from '../packages/shared/src/index.js';
import { createDemoServer, type DemoServerHandle } from '../packages/backend/src/demo/DemoServer.js';
import { DEMO_ACTION_IDS } from '../packages/backend/src/demo/DemoContent.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface ScenarioOptions {
  actionOrder: Array<'A' | 'B' | 'C'>;
  sourceEffectiveTick?: number;
}

interface ScenarioResult {
  bHp: number | undefined;
  aHp: number | undefined;
  firstDamageTick: number | undefined;
  decisions: number;
  tick: number;
}

async function runScenario(options: ScenarioOptions): Promise<ScenarioResult> {
  const dataDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'elysian-demo-network-chain-')));
  let server: DemoServerHandle | undefined;
  const sockets: Socket[] = [];
  let sequence = 0;
  try {
    server = await createDemoServer({
      dataDirectory,
      hostCredential: 'chain-network-host',
      joinCode: 'CHAIN',
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
      const socket = io(url, {
        autoConnect: false,
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        auth: { accessToken },
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('chain socket connection timed out')), 3000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
        socket.connect();
      });
      return socket;
    }
    async function command(
      socket: Socket,
      type: string,
      payload: Record<string, unknown>,
      controlEpoch?: number,
    ): Promise<EncounterCommandResult> {
      const requestId = `chain-network-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`chain command timeout: ${type}`)), 3000);
        socket.emit('DEMO_COMMAND', {
          requestId,
          type,
          payload,
          ...(controlEpoch === undefined ? {} : { controlEpoch }),
        }, (result: EncounterCommandResult) => {
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

    const host = await login('host', { credential: 'chain-network-host', displayName: 'Chain GM' });
    const players = await Promise.all(['A', 'B', 'C'].map(displayName => login('join', { joinCode: 'CHAIN', displayName })));
    const gmSocket = await connect(host.accessToken);
    const playerSockets = await Promise.all(players.map(player => connect(player.accessToken)));
    const initial = await snapshot(host.accessToken);
    const characters = initial.entities.filter(entity => entity.faction === 'PLAYERS');
    const enemies = initial.entities.filter(entity => entity.faction === 'ENEMIES');
    assert.equal(characters.length, 3);
    assert.ok(enemies.length >= 3);
    const actorA = characters[0];
    const actorB = characters[1];
    const actorC = characters[2];
    const target = actorB;
    const hiddenEnemy = enemies[0];

    for (let index = 0; index < characters.length; index++) {
      const response = await http('assign', {
        userId: players[index].session.userId,
        entityId: characters[index].id,
      }, host.accessToken);
      assert.equal(response.status, 200);
    }
    // Make C's interrupt strictly faster than B's in the same Tick.  The
    // adjustment is a real GM command before START, so the network test still
    // exercises the production authority path.
    const adjusted = await command(gmSocket, 'GM_ADJUST_ENTITY', {
      entityId: actorC.id,
      reason: 'network causal priority fixture',
      resources: { agi: 20 },
    });
    assert.equal(adjusted.ok, true);
    const hidden = await command(gmSocket, 'GM_ADJUST_ENTITY', {
      entityId: hiddenEnemy.id,
      reason: 'network hidden log fixture',
      visibility: 'GM',
    });
    assert.equal(hidden.ok, true);
    const beforeStart = await snapshot(host.accessToken);
    const epochs = characters.map(character => beforeStart.controls.find(control => control.entityId === character.id)?.controlEpoch);
    assert.ok(epochs.every(epoch => epoch !== undefined));
    assert.equal((await command(gmSocket, 'START', {})).ok, true);
    const targetHpAtStart = target.resources.current.hp ?? 0;
    let firstDamageTick: number | undefined;
    const observeSnapshot = ({ snapshot: networkSnapshot }: { snapshot: EncounterSnapshot }): void => {
      const networkTarget = networkSnapshot.entities.find(entity => entity.id === target.id);
      if (firstDamageTick === undefined && networkTarget && (networkTarget.resources.current.hp ?? 0) < targetHpAtStart) {
        firstDamageTick = networkSnapshot.tick;
      }
    };
    gmSocket.on('DEMO_INCREMENT', observeSnapshot);
    gmSocket.on('DEMO_SNAPSHOT', observeSnapshot);

    const mainCommands: Record<'A' | 'B' | 'C', () => Promise<EncounterCommandResult>> = {
      // A late effective tick is an explicit GM override.  Keeping this
      // submission on the real GM socket exercises the production authority
      // boundary while the timely cases remain ordinary player intents.
      A: () => command(options.sourceEffectiveTick === undefined ? playerSockets[0] : gmSocket, 'ACTION', {
        entityId: actorA.id,
        actionTemplateId: DEMO_ACTION_IDS.MELEE,
        targetIds: [target.id],
        ...(options.sourceEffectiveTick === undefined ? {} : { effectiveTick: options.sourceEffectiveTick }),
      }, options.sourceEffectiveTick === undefined ? epochs[0] : undefined),
      B: () => command(playerSockets[1], 'WAIT', { entityId: actorB.id }, epochs[1]),
      C: () => command(playerSockets[2], 'WAIT', { entityId: actorC.id }, epochs[2]),
    };
    for (const actor of options.actionOrder) {
      const mainResult = await mainCommands[actor]();
      assert.equal(mainResult.ok, true, `${actor} main action accepted: ${mainResult.ok ? mainResult.message ?? '' : `${mainResult.code} ${mainResult.reason}`}`);
    }
    for (const enemy of enemies) assert.equal((await command(gmSocket, 'WAIT', { entityId: enemy.id })).ok, true);

    let opened = await snapshot(host.accessToken);
    assert.equal(opened.tick, 0, 'the real network barrier must not advance before reactions are settled');
    assert.ok(opened.decisions.length >= 2, 'A declaration must expose B and C reaction windows');
    assert.equal((await command(gmSocket, 'GM_PAUSE', { reason: 'network chain inspection' })).ok, true);

    const bWindow = opened.decisions.find(window => window.reactorEntityId === actorB.id && window.sourceEntityId === actorA.id);
    const cWindow = opened.decisions.find(window => window.reactorEntityId === actorC.id && window.sourceEntityId === actorA.id);
    assert.ok(bWindow && cWindow, 'B and C must each receive the source A reaction window');
    assert.equal((await command(playerSockets[1], 'REACTION_JOIN', { windowId: bWindow.windowId }, epochs[1])).ok, true);
    assert.equal((await command(playerSockets[1], 'REACTION_SELECT', { windowId: bWindow.windowId, optionId: DEMO_ACTION_IDS.INTERRUPT }, epochs[1])).ok, true);

    // Passing every original window except B's selected interrupt lets the
    // coordinator commit the batch.  C intentionally passes A's first window
    // so it remains eligible for the chained B window.
    opened = await snapshot(host.accessToken);
    for (const window of opened.decisions) {
      if (window.windowId === bWindow.windowId) continue;
      assert.equal((await command(gmSocket, 'GM_PASS', { windowId: window.windowId })).ok, true, `GM passes ${window.windowId}`);
    }

    let chainWindow: EncounterSnapshot['decisions'][number] | undefined;
    for (let attempt = 0; attempt < 80; attempt++) {
      opened = await snapshot(host.accessToken);
      chainWindow = opened.decisions.find(window => window.reactorEntityId === actorC.id && window.sourceEntityId === actorB.id);
      if (chainWindow) break;
      await delay(5);
    }
    assert.ok(chainWindow, 'C must receive a second window sourced by B after B interrupts A');
    assert.equal(chainWindow.causationId, bWindow.causationId, 'A -> B -> C keeps one causation chain');
    assert.equal((await command(playerSockets[2], 'REACTION_JOIN', { windowId: chainWindow.windowId }, epochs[2])).ok, true);
    assert.equal((await command(playerSockets[2], 'REACTION_SELECT', { windowId: chainWindow.windowId, optionId: DEMO_ACTION_IDS.INTERRUPT }, epochs[2])).ok, true);

    // C's response may be the last selection, but resolve any unrelated
    // windows opened by the same causal batch one by one.  GM_PASS_ALL would
    // discard C's collected selection, so it is deliberately not used here.
    for (let attempt = 0; attempt < 40; attempt++) {
      opened = await snapshot(host.accessToken);
      const remaining = opened.decisions;
      if (remaining.length === 0) break;
      for (const window of remaining) {
        assert.equal((await command(gmSocket, 'GM_PASS', { windowId: window.windowId })).ok, true, `GM resolves follow-up ${window.windowId}`);
      }
    }
    opened = await snapshot(host.accessToken);
    assert.equal(opened.decisions.length, 0, 'all causal reaction windows must resolve');
    assert.equal((await command(gmSocket, 'GM_RESUME', {})).ok, true);

    let settled = opened;
    for (let attempt = 0; attempt < 120; attempt++) {
      await delay(5);
      settled = await snapshot(host.accessToken);
      if (settled.tick >= 5 && settled.actions.length === 0) break;
    }
    const bAfter = settled.entities.find(entity => entity.id === actorB.id);
    const aAfter = settled.entities.find(entity => entity.id === actorA.id);
    const damageLog = settled.logs.find(log => log.message.includes('造成'));
    const interruptLog = settled.logs.find(log => log.message.includes('打断') && log.meta?.targetId === actorB.id);
    const recoveryLog = settled.logs.find(log => log.message.includes('收招完成'));
    assert.ok(damageLog, 'the GM snapshot includes the committed engine damage log');
    assert.equal(damageLog.actionId, DEMO_ACTION_IDS.MELEE, 'damage log keeps the action association');
    assert.equal(damageLog.meta?.targetId, target.id, 'damage log keeps its target association');
    assert.ok(interruptLog, 'the GM snapshot includes the committed interrupt log');
    assert.equal(interruptLog.meta?.targetId, actorB.id, 'interrupt log keeps its interrupted target');
    assert.ok(recoveryLog, 'the GM snapshot includes the committed recovery log');
    const playerFinal = await snapshot(players[0].accessToken);
    assert.equal(playerFinal.entities.some(entity => entity.id === hiddenEnemy.id), false, 'PL snapshots omit GM-only entities');
    assert.equal(playerFinal.logs.some(log => JSON.stringify(log).includes(hiddenEnemy.id)), false, 'PL snapshots omit hidden entity ids from logs');
    return {
      bHp: bAfter?.resources.current.hp,
      aHp: aAfter?.resources.current.hp,
      firstDamageTick,
      decisions: settled.decisions.length,
      tick: settled.tick,
    };
  } finally {
    for (const socket of sockets) socket.disconnect();
    if (server) await server.close();
    rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function main(): Promise<void> {
  const timelyForward = await runScenario({ actionOrder: ['A', 'B', 'C'] });
  const timelyReversed = await runScenario({ actionOrder: ['C', 'B', 'A'] });
  assert.deepEqual(timelyReversed, timelyForward, 'swapping network arrival order must keep the fixed-rule result identical');

  const late = await runScenario({ actionOrder: ['B', 'C', 'A'], sourceEffectiveTick: 0 });
  assert.notEqual(timelyForward.firstDamageTick, undefined);
  assert.notEqual(late.firstDamageTick, undefined);
  assert.ok((late.firstDamageTick ?? 0) < (timelyForward.firstDamageTick ?? 0), 'an already ACTIVE source must damage before the timely reaction chain');
  console.log('demo-network-chain: real HTTP/socket A→B→C timely/late chain and arrival-order determinism passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
