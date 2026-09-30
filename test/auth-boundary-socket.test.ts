/** Real SocketServer boundary tests. Run ONLY through auth-isolated.runner.ts.
 * Exit 1: failed security expectations; exit 2: setup/transport/cleanup failure.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import type { Server as IOServer } from 'socket.io';
import { createApp } from '../packages/backend/src/app.js';
import { SocketServer } from '../packages/backend/src/network/SocketServer.js';
import type { CampaignManager } from '../packages/backend/src/campaigns/CampaignManager.js';
import { prisma } from '../packages/backend/src/db/prisma.js';

type Packet = { event: string; data: unknown };
type Login = { accessToken: string; sessionId: string };
let passed = 0;
let failed = 0;
let environmentErrors = 0;

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object') throw new Error('Malformed response');
    return value as Record<string, unknown>;
}

function check(condition: boolean, label: string): void {
    try { assert.ok(condition, label); passed++; console.log(`[PASS] ${label}`); }
    catch { failed++; console.error(`[SECURITY_FAIL] ${label}`); }
}

// Silence is an environment/inconclusive result, never a security pass.
function response(socket: Socket, events: string[], send: () => void): Promise<Packet> {
    return new Promise((resolve, reject) => {
        const listeners = events.map(event => {
            const listener = (data: unknown) => { cleanup(); resolve({ event, data }); };
            socket.on(event, listener);
            return { event, listener };
        });
        const timer = setTimeout(() => {
            cleanup(); reject(new Error(`No response within 2500ms: ${events.join('/')}`));
        }, 2500);
        function cleanup() {
            clearTimeout(timer);
            for (const { event, listener } of listeners) socket.off(event, listener);
        }
        send();
    });
}

async function post(base: string, route: string, body: unknown) {
    const res = await fetch(`${base}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(2500),
    });
    const data = record(await res.json());
    if (res.status !== 200 || data.ok !== true) throw new Error(`HTTP fixture failed: ${route} status=${res.status}`);
    return data;
}

async function fixture(label: string, run: (f: {
    a: Socket; b: Socket; base: string; scene: string; forbidden: string;
    actor: string; hidden: string; login: Login;
    join: (s: Socket, scene?: string, actor?: string) => Promise<Packet>;
}) => Promise<void>) {
    const id = `socket_${randomUUID()}`;
    const scene = `${id}_scene`, forbidden = `${id}_forbidden`;
    const actor = `${id}_actor`, hidden = `${id}_hidden`;
    const users = [`${id}_a`, `${id}_b`];
    const sessions: Login[] = [];
    const clients: Socket[] = [];
    const http = createServer(createApp());
    const server = new SocketServer(http);
    // Private access ONLY for teardown: close IO and destroy scenes/idle timers.
    const cleanupOnly = server as unknown as { io: IOServer; campaignManager: CampaignManager };
    let base = '';
    try {
        for (const [index, entityId] of [actor, hidden].entries()) {
            await prisma.characterSheet.create({ data: {
                id: entityId, name: entityId, type: 'ACTOR', currentSceneId: scene,
                resourcesJson: JSON.stringify({ current: { hp: 100 }, max: { hp: 100 } }),
                transformJson: JSON.stringify({ coords: { x: index * 10, y: 0, z: 0 }, planeId: scene, facing: 0 }),
                physicsJson: JSON.stringify({ scaleClass: 1, collisionRadius: 0.5, mass: 50, movementModes: ['WALK'] }),
            } });
        }
        for (const user of users) {
            await prisma.permissionGrant.create({ data: {
                id: `${user}_entity`, grantedByUserId: 'fixture', grantedToUserId: user,
                capability: 'control_entity', scopeType: 'entity', scopeId: actor, sceneId: scene,
            } });
            await prisma.permissionGrant.create({ data: {
                id: `${user}_scene`, grantedByUserId: 'fixture', grantedToUserId: user,
                capability: 'join_scene', scopeType: 'scene', scopeId: scene, sceneId: scene,
            } });
        }
        await new Promise<void>((resolve, reject) => {
            http.once('error', reject); http.listen(0, '127.0.0.1', resolve);
        });
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback port');
        base = `http://127.0.0.1:${address.port}`;
        for (let i = 0; i < 2; i++) {
            const client = io(base, { autoConnect: false, reconnection: false, forceNew: true,
                transports: ['websocket'], extraHeaders: { Origin: 'http://localhost:5173' } });
            clients.push(client);
            const connected = await response(client, ['connect', 'connect_error'], () => client.connect());
            if (connected.event !== 'connect') throw new Error('Socket connection failed');
        }
        const join = (s: Socket, targetScene = scene, targetActor = actor) =>
            response(s, ['SCENE_SYNC', 'ERROR'], () => s.emit('JOIN_SCENE', { sceneId: targetScene, actorId: targetActor }));
        if (label === 'unauthenticated') {
            const denied = await join(clients[0]);
            check(denied.event === 'ERROR' && record(denied.data).code === 'UNAUTHENTICATED', 'Unauthenticated JOIN explicitly rejected');
        }
        for (const [i, userId] of users.entries()) {
            const payload = record((await post(base, '/auth/login', { userId, role: 'PL' })).data);
            if (typeof payload.accessToken !== 'string' || typeof payload.sessionId !== 'string') throw new Error('Invalid login fixture');
            const login = { accessToken: payload.accessToken, sessionId: payload.sessionId };
            sessions.push(login);
            const authenticated = await response(clients[i], ['AUTH_SUCCESS', 'AUTH_FAILED'], () =>
                clients[i].emit('AUTHENTICATE', { token: login.accessToken }));
            if (authenticated.event !== 'AUTH_SUCCESS') throw new Error('Authentication fixture failed');
            const snapshot = record(record(authenticated.data).permissionSnapshot);
            const controlled = snapshot.controllableEntities;
            if (!Array.isArray(controlled) || !controlled.includes(actor) || controlled.includes(hidden)) throw new Error('Grant fixture mismatch');
        }
        // Second socket is a real working control in every case.
        if ((await join(clients[1])).event !== 'SCENE_SYNC') throw new Error('Valid JOIN control failed');
        const control = await response(clients[1], ['SCENE_SYNC', 'ERROR'], () => clients[1].emit('RESYNC'));
        if (control.event !== 'SCENE_SYNC' || !hasEntity(control, actor)) throw new Error('Valid RESYNC control failed');
        console.log(`[CONTROL] ${label}: two HTTP logins/AUTH_SUCCESS; valid socket JOIN/RESYNC contains granted actor`);
        await run({ a: clients[0], b: clients[1], base, scene, forbidden, actor, hidden, login: sessions[0], join });
    } catch (error) {
        environmentErrors++;
        console.error(`AUTH_TEST_ENVIRONMENT_ERROR: ${label}: ${error instanceof Error ? error.message : 'unknown failure'}`);
    } finally {
        try {
            // IO close runs disconnect handlers before scenes are destroyed.
            await new Promise<void>(resolve => cleanupOnly.io.close(() => resolve()));
            for (const client of clients) { client.disconnect(); client.removeAllListeners(); }
            await cleanupOnly.campaignManager.destroyScene(scene);
            await cleanupOnly.campaignManager.destroyScene(forbidden);
            for (const session of sessions) {
                // HTTP listener has closed; revoke via public service only for cleanup.
                const { AuthenticationService } = await import('../packages/backend/src/auth/AuthenticationService.js');
                AuthenticationService.revoke(session.sessionId);
            }
            await prisma.permissionSnapshot.deleteMany({ where: { userId: { in: users } } });
            await prisma.permissionGrant.deleteMany({ where: { grantedToUserId: { in: users } } });
            await prisma.characterSheet.deleteMany({ where: { id: { in: [actor, hidden] } } });
            if (http.listening) await new Promise<void>(resolve => http.close(() => resolve()));
        } catch {
            environmentErrors++; console.error(`AUTH_TEST_ENVIRONMENT_ERROR: ${label}: cleanup failed`);
        }
    }
}

function hasEntity(packet: Packet, id: string): boolean {
    const entities = record(packet.data).entities;
    if (!Array.isArray(entities)) throw new Error('Missing entities in SCENE_SYNC');
    return entities.some(entity => record(entity).id === id);
}

function denied(packet: Packet): boolean {
    if (packet.event !== 'ERROR') return false;
    const code = record(packet.data).code;
    if (code === 'JOIN_FAILED') throw new Error('JOIN failed due to engine/fixture error');
    return ['UNAUTHORIZED', 'NOT_IN_SCENE', 'UNAUTHENTICATED', 'SESSION_REVOKED', 'INVALID_TOKEN'].includes(String(code));
}

async function main() {
    if (!process.env.ELYSIAN_AUTH_TEST_DB?.includes('elysian-auth-test-')) throw new Error('Isolated runner environment required');
    try {
        await fixture('unauthenticated', async () => {});
        await fixture('foreign actor', async f => {
            const result = await f.join(f.a, f.scene, f.hidden);
            console.log(`[EVIDENCE] foreign actor JOIN returned ${result.event}`);
            check(denied(result), 'PL cannot select an actor absent from its real grant snapshot');
        });
        await fixture('foreign scene', async f => {
            const result = await f.join(f.a, f.forbidden, f.actor);
            console.log(`[EVIDENCE] ungranted scene JOIN returned ${result.event}`);
            check(denied(result), 'PL cannot JOIN a scene without any scene grant');
        });
        await fixture('revoked session', async f => {
            if ((await f.join(f.a)).event !== 'SCENE_SYNC') throw new Error('First client valid JOIN failed');
            const before = await response(f.a, ['SCENE_SYNC', 'ERROR'], () => f.a.emit('RESYNC'));
            if (before.event !== 'SCENE_SYNC' || !hasEntity(before, f.actor)) throw new Error('Pre-revocation RESYNC failed');
            check(true, 'Both sessions RESYNC successfully before revocation');
            // Observe immediate revocation before starting HTTP logout, not afterwards.
            let stopped: Packet | undefined;
            const onRevoked = (data: unknown) => { stopped = { event: 'SESSION_REVOKED', data }; };
            const onDisconnected = (data: unknown) => { stopped = { event: 'disconnect', data }; };
            f.a.on('SESSION_REVOKED', onRevoked);
            f.a.on('disconnect', onDisconnected);
            try {
            await post(f.base, '/auth/logout', { sessionId: f.login.sessionId });
            const verification = await fetch(`${f.base}/permissions/me?token=${encodeURIComponent(f.login.accessToken)}`, { signal: AbortSignal.timeout(2500) });
            if (verification.status !== 401) throw new Error('HTTP logout did not invalidate token: cannot test revoked state');
            console.log('[CONTROL] HTTP logout completed; revoked token now returns HTTP 401');
            const after = stopped ?? await response(f.a, ['SCENE_SYNC', 'ERROR', 'SESSION_REVOKED', 'disconnect'], () => f.a.emit('RESYNC'));
            console.log(`[EVIDENCE] revoked RESYNC returned ${after.event}; sensitive actor=${after.event === 'SCENE_SYNC' && hasEntity(after, f.actor)}`);
            check(after.event === 'SESSION_REVOKED' || after.event === 'disconnect' || denied(after), 'Revoked socket cannot RESYNC scene data');
            const other = await response(f.b, ['SCENE_SYNC', 'ERROR'], () => f.b.emit('RESYNC'));
            if (other.event !== 'SCENE_SYNC') throw new Error('Other client RESYNC control failed');
            check(hasEntity(other, f.actor), 'Other valid session still RESYNCs after first session logout');
            } finally {
                f.a.off('SESSION_REVOKED', onRevoked);
                f.a.off('disconnect', onDisconnected);
            }
        });
    } finally { await prisma.$disconnect(); }
    console.log(`[socket-summary] passed=${passed} securityFailures=${failed} environmentErrors=${environmentErrors}`);
    process.exitCode = environmentErrors ? 2 : failed ? 1 : 0;
}

main().catch(() => { console.error('AUTH_TEST_ENVIRONMENT_ERROR: top-level setup/cleanup failure'); process.exitCode = 2; });
