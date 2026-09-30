// Black-box LAN entry-point acceptance. No calls into private engine state.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import type { DemoSessionResponse, EncounterCommandResult, EncounterSnapshot } from '../packages/shared/src/index.js';
import { createDemoServer } from '../packages/backend/src/demo/DemoServer.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let requestSequence = 0;

async function main(): Promise<void> {
    const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'elysian-demo-acceptance-')));
    const clients: Socket[] = [];
    const server = await createDemoServer({
        hostCredential: 'acceptance-host-credential', joinCode: 'ACCEPTANCE',
        host: '127.0.0.1', port: 0, dataDirectory: temporaryRoot,
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
            assert.ok(response.ok, `${path} must accept valid local credentials (${response.status})`);
            const result = await response.json() as DemoSessionResponse;
            assert.ok(result.ok);
            return result.data;
        }
        async function snapshot(token: string): Promise<EncounterSnapshot> {
            const response = await http('session', undefined, token);
            assert.ok(response.ok, 'authenticated session refresh must succeed');
            const result = await response.json() as { data: { snapshot: EncounterSnapshot } };
            return result.data.snapshot;
        }
        async function connect(token: string): Promise<Socket> {
            const socket = io(url, {
                autoConnect: false, transports: ['websocket'], reconnection: false, forceNew: true,
                auth: { accessToken: token },
            });
            clients.push(socket);
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 3000);
                socket.once('connect', () => { clearTimeout(timer); resolve(); });
                socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
                socket.connect();
            });
            return socket;
        }
        async function command(socket: Socket, type: string, payload: Record<string, unknown>, controlEpoch?: number, requestId?: string): Promise<EncounterCommandResult> {
            const packet = { requestId: requestId ?? `acceptance-${++requestSequence}`, type, payload, controlEpoch };
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`No ACK for ${type}`)), 3000);
                socket.emit('DEMO_COMMAND', packet, (result: EncounterCommandResult) => { clearTimeout(timer); resolve(result); });
            });
        }
        async function eventually(token: string, predicate: (value: EncounterSnapshot) => boolean): Promise<EncounterSnapshot> {
            for (let attempt = 0; attempt < 80; attempt++) {
                const current = await snapshot(token);
                if (predicate(current)) return current;
                await delay(25);
            }
            throw new Error('Expected encounter state did not arrive');
        }

        const forbiddenLegacy = await fetch(`${url}/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 'attacker', role: 'GM' }),
        });
        assert.equal(forbiddenLegacy.status, 404, 'the demo must not expose legacy self-selected GM login');
        assert.equal((await http('session')).status, 401);
        assert.ok(!(await http('host', { credential: 'incorrect', displayName: 'Intruder' })).ok);

        const host = await login('host', { credential: 'acceptance-host-credential', displayName: '主持' });
        assert.equal(host.session.role, 'GM');
        const players = [];
        for (const displayName of ['先锋玩家', '游侠玩家', '引导玩家']) {
            players.push(await login('join', { joinCode: 'ACCEPTANCE', displayName }));
        }
        for (const player of players) {
            assert.equal(player.session.role, 'PL');
            assert.deepEqual(player.session.controlledEntityIds, []);
        }
        const gm = await connect(host.accessToken);
        const playerSockets = await Promise.all(players.map(player => connect(player.accessToken)));
        const secondTab = await connect(players[0].accessToken);
        const roster = await snapshot(host.accessToken);
        const characters = roster.entities.filter(entity => entity.faction === 'PLAYERS');
        assert.equal(characters.length, 3);
        for (let index = 0; index < 3; index++) {
            const assigned = await http('assign', {
                userId: players[index].session.userId, entityId: characters[index].id,
            }, host.accessToken);
            assert.ok(assigned.ok, 'GM must assign a character through the public endpoint');
        }
        const deniedAssignment = await http('assign', {
            userId: players[0].session.userId, entityId: characters[1].id,
        }, players[0].accessToken);
        assert.equal(deniedAssignment.status, 403);

        const started = await command(gm, 'START', { entityId: characters[0].id }, undefined, 'host-only-start');
        assert.ok(started.ok, 'GM starts the encounter');
        const stolenRequestId = await command(playerSockets[0], 'START', { entityId: characters[0].id }, undefined, 'host-only-start');
        assert.equal(stolenRequestId.ok, false, 'another user cannot retrieve an accepted GM command by copying its request ID');
        const initial = await snapshot(host.accessToken);
        assert.equal(initial.tick, 0);
        const initialResources = initial.entities.map(entity => [entity.id, entity.resources]);
        const epochs = characters.map(character => initial.controls.find(control => control.entityId === character.id)?.controlEpoch);
        assert.ok(epochs.every(epoch => epoch !== undefined));

        const forbidden = await command(playerSockets[0], 'WAIT', { entityId: characters[1].id }, epochs[1]);
        assert.equal(forbidden.ok, false, 'PL cannot act as another character');
        const firstRequestId = 'same-player-two-tabs';
        const first = await command(playerSockets[0], 'WAIT', { entityId: characters[0].id }, epochs[0], firstRequestId);
        assert.ok(first.ok);
        const duplicate = await command(secondTab, 'WAIT', { entityId: characters[0].id }, epochs[0], firstRequestId);
        assert.ok(duplicate.ok, 'retry must return the same accepted result');
        assert.equal(duplicate.revision, first.revision, 'retry must not create another mutation');
        const others = await Promise.all([1, 2].map(index =>
            command(playerSockets[index], 'WAIT', { entityId: characters[index].id }, epochs[index])));
        assert.ok(others.every(result => result.ok), 'independent concurrent players must both be accepted');

        const enemies = initial.entities.filter(entity => entity.faction === 'ENEMIES');
        assert.ok(enemies.length >= 3);
        for (const enemy of enemies.slice(0, -1)) {
            assert.ok((await command(gm, 'WAIT', { entityId: enemy.id })).ok);
        }
        const beforeLastReady = await snapshot(host.accessToken);
        assert.equal(beforeLastReady.tick, initial.tick, 'one unready entity must hold the barrier');
        assert.deepEqual(beforeLastReady.entities.map(entity => [entity.id, entity.resources]), initialResources);
        assert.ok((await command(gm, 'WAIT', { entityId: enemies[enemies.length - 1].id })).ok);
        const afterWait = await eventually(host.accessToken, value => value.tick === 5);
        assert.equal(afterWait.plan.committed, false, 'new ready window opens only after advancing');
        assert.equal(afterWait.entities[0].resources.current.hp, initial.entities[0].resources.current.hp);

        assert.ok((await command(gm, 'GM_PAUSE', {})).ok);
        const epochBeforeTakeover = afterWait.controls.find(control => control.entityId === characters[0].id)?.controlEpoch;
        assert.ok((await command(gm, 'GM_TAKEOVER', { entityId: characters[0].id })).ok);
        const stale = await command(playerSockets[0], 'WAIT', { entityId: characters[0].id }, epochBeforeTakeover);
        assert.equal(stale.ok, false, 'a taken-over character must reject old player authority');
        assert.ok((await command(gm, 'GM_RELEASE', { entityId: characters[0].id })).ok);
        const staleAfterRelease = await command(secondTab, 'WAIT', { entityId: characters[0].id }, epochBeforeTakeover);
        assert.equal(staleAfterRelease.ok, false, 'releasing control must not revive old authority versions');
        const omittedEpoch = await command(secondTab, 'WAIT', { entityId: characters[0].id });
        assert.equal(omittedEpoch.ok, false, 'omitting the epoch must not bypass control-version checks');

        const hidden = enemies[0];
        assert.ok((await command(gm, 'GM_ADJUST_ENTITY', { entityId: hidden.id, visibility: 'GM', reason: '隐藏测试' })).ok);
        const playerView = await snapshot(players[0].accessToken);
        assert.equal(JSON.stringify(playerView).includes(hidden.id), false, 'filtered sync must omit hidden entity references');
        const rejected = await command(playerSockets[0], 'GM_CORRECT', { entityId: hidden.id, reason: 'attempt', changes: { hp: 1 } });
        assert.equal(rejected.ok, false);
        assert.equal(JSON.stringify(rejected).includes(hidden.id), false, 'rejected-command snapshots also require filtering');

        secondTab.disconnect();
        const remainingSession = await http('session', undefined, players[0].accessToken);
        assert.ok(remainingSession.ok, 'one remaining tab keeps the session usable');
        playerSockets[1].disconnect();
        await connect(players[1].accessToken);
        const restored = await snapshot(players[1].accessToken);
        assert.equal(restored.tick, 5);
        assert.equal(restored.paused, true);

        assert.ok((await command(gm, 'GM_END', { reason: '独立网络验收结束' })).ok);
        const ended = await eventually(host.accessToken, value => value.result !== undefined);
        assert.ok(ended.result);
        assert.equal(ended.result.status, 'ENDED', 'ending a live encounter is not mutual defeat');
        assert.ok(server.persistence.load()?.result, 'settlement must reach the standalone SQLite database');
        const restarted = await command(gm, 'GM_RESTART', {});
        assert.ok(restarted.ok, 'a settled encounter can be restarted');
        const fresh = await snapshot(host.accessToken);
        assert.equal(fresh.tick, 0, 'restart must reset the actual engine clock');
        assert.equal(fresh.status, 'LOBBY');
        assert.equal(fresh.result, undefined);
        assert.equal(fresh.actions.length, 0, 'restart must remove the old event queue');
        assert.equal(fresh.decisions.length, 0);
        console.log('demo-acceptance: GM + 3 PL + second tab, barrier, authority, privacy, reconnect and settlement passed');
    } finally {
        for (const client of clients) client.disconnect();
        await server.close();
        assert.equal(dirname(temporaryRoot), realpathSync(tmpdir()));
        assert.ok(basename(temporaryRoot).startsWith('elysian-demo-acceptance-'));
        rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
