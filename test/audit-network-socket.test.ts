import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import type { Server as IOServer } from 'socket.io';
import type { Entity } from '@hard-vtt/shared';
import { SocketServer } from '../packages/backend/src/network/SocketServer.js';
import { AuthenticationService } from '../packages/backend/src/auth/AuthenticationService.js';
import type { CampaignManager } from '../packages/backend/src/campaigns/CampaignManager.js';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { prisma } from '../packages/backend/src/db/prisma.js';

function waitEvent<T>(socket: ClientSocket, event: string, send: () => void): Promise<T> {
    return new Promise((resolve, reject) => {
        const handler = (payload: T) => { clearTimeout(timer); resolve(payload); };
        const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`Timed out: ${event}`)); }, 2000);
        socket.once(event, handler); send();
    });
}
async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.ok(predicate(), 'server connection state updated');
}
const actor: Entity = { id: 'hero', templateId: 'actor', type: 'ACTOR', activeEffects: [],
    transform: { coords: { x: 0, y: 0, z: 0 }, planeId: 'audit', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.5, mass: 1, movementModes: [] },
    resources: { current: { hp: 10 }, max: { hp: 10 } } };

async function main(): Promise<void> {
    if (!process.env.ELYSIAN_AUTH_TEST_DB) throw new Error('Use auth-isolated.runner.ts');
    const http = createServer();
    const server = new SocketServer(http);
    const internals = server as unknown as { io: IOServer; campaignManager: CampaignManager };
    const clients: ClientSocket[] = [];
    const login = AuthenticationService.login({ userId: 'audit-gm', role: 'GM' });
    try {
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        assert.ok(address && typeof address !== 'string');
        const url = `http://127.0.0.1:${address.port}`;
        const engine = await internals.campaignManager.getOrCreateEngine('audit-scene-a');
        assert.ok(engine instanceof CombatEngine);
        engine.setAutoProcess(false);
        engine.mountEntities([actor]);
        for (let i = 0; i < 2; i++) {
            const client = io(url, { transports: ['websocket'], autoConnect: false, reconnection: false, forceNew: true });
            clients.push(client);
            await waitEvent(client, 'connect', () => client.connect());
            await waitEvent(client, 'AUTH_SUCCESS', () => client.emit('AUTHENTICATE', { token: login.accessToken }));
            await waitEvent(client, 'SCENE_SYNC', () => client.emit('JOIN_SCENE', { sceneId: 'audit-scene-a', actorId: 'hero' }));
        }
        assert.equal(internals.campaignManager.getScene('audit-scene-a')!.playerCount, 2, 'two tabs controlling one actor are two scene connections');
        engine.receiveIntent({ actorId: 'hero', intentType: 'HOOK_PRESET', clientTick: 0, payload: { hookPreset: {
            id: 'audit-hook', entityId: 'hero', label: 'audit hook', enabled: true, trigger: { type: 'TICK_REACHED', targetTick: 0 },
        } } });
        const poll = engine.getActiveDecisionPolls()[0];
        assert.ok(poll);
        engine.handleDecisionEngage(poll.windowId, clients[0].id!);
        clients[0].disconnect();
        await until(() => internals.campaignManager.getScene('audit-scene-a')!.playerCount === 1);
        assert.equal(engine.getPendingDecisionCount(), 0, 'disconnect releases engaged legacy windows');
        assert.equal(internals.campaignManager.getScene('audit-scene-a')!.isIdle, false, 'another tab keeps the scene alive');
        await waitEvent(clients[1], 'SCENE_SYNC', () => clients[1].emit('JOIN_SCENE', { sceneId: 'audit-scene-b', actorId: 'hero' }));
        assert.equal(internals.campaignManager.getScene('audit-scene-a')!.playerCount, 0);
        assert.equal(internals.campaignManager.getScene('audit-scene-b')!.playerCount, 1);
        assert.equal(internals.io.sockets.adapter.rooms.get('audit-scene-a')?.has(clients[1].id!), undefined, 'changing scenes removes the old room membership');
        const error = await waitEvent<{ code: string }>(clients[1], 'ERROR', () => clients[1].emit('CLIENT_INTENT', null));
        assert.equal(error.code, 'INVALID_INTENT');
        await waitEvent(clients[1], 'PONG', () => clients[1].emit('PING', { t: 1 }));
        console.log('audit network sockets: two tabs, disconnect release, scene switch and malformed input passed');
    } finally {
        await new Promise<void>(resolve => internals.io.close(() => resolve()));
        for (const client of clients) { client.disconnect(); client.removeAllListeners(); }
        await internals.campaignManager.destroyScene('audit-scene-a');
        await internals.campaignManager.destroyScene('audit-scene-b');
        AuthenticationService.revoke(login.sessionId);
        await prisma.$disconnect();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
