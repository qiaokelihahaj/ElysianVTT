// 真实 HTTP 登录 → SocketServer 权限/路由 → 引擎 → 广播 → SQLite 结算。
// 必须通过 auth-isolated.runner.ts 运行，不使用开发数据库。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { io, type Socket } from 'socket.io-client';
import type { Server } from 'socket.io';
import { createApp } from '../packages/backend/src/app.js';
import { SocketServer } from '../packages/backend/src/network/SocketServer.js';
import type { CampaignManager } from '../packages/backend/src/campaigns/CampaignManager.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';
import { prisma } from '../packages/backend/src/db/prisma.js';
import { AuthenticationService } from '../packages/backend/src/auth/AuthenticationService.js';
import type { ActionTemplate, DecisionPollPayload, StateMutationPayload, Entity } from '../packages/shared/src/index.js';

function packet<T>(socket: Socket, event: string, send: () => void, accepts: (data: T) => boolean = () => true): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Timeout: ${event}`)); }, 5000);
        const listener = (data: T) => { if (accepts(data)) { cleanup(); resolve(data); } };
        function cleanup() { clearTimeout(timer); socket.off(event, listener); }
        socket.on(event, listener);
        send();
    });
}

async function main() {
    assert.ok(process.env.ELYSIAN_AUTH_TEST_DB?.includes('elysian-auth-test-'));
    const scene = 'authenticated-combat-loop';
    const http = createServer(createApp());
    const server = new SocketServer(http);
    // 仅访问私有成员以关闭测试资源，不绕过认证或行动路由。
    const cleanup = server as unknown as { io: Server; campaignManager: CampaignManager };
    const clients: Socket[] = [];
    const sessions: string[] = [];
    const originalGetAction = Dictionary.getAction;
    const strike: ActionTemplate = { id: 'LOOP_STRIKE', tags: ['MELEE'], resourceCost: {},
        timeCost: { startupTicks: 3, recoveryTicks: 2 }, range: { type: 'MELEE', distanceExpr: '3' },
        effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '25' } }] };
    Dictionary.getAction = id => id === strike.id ? strike : originalGetAction.call(Dictionary, id);
    try {
        for (const [index, id] of ['loop-hero', 'loop-enemy'].entries()) {
            await prisma.characterSheet.create({ data: { id, name: id, type: 'ACTOR', currentSceneId: scene,
                resourcesJson: JSON.stringify({ current: { hp: 50, poise: 50, focus: 50 }, max: { hp: 50, poise: 50, focus: 50 } }),
                transformJson: JSON.stringify({ coords: { x: index * 2, y: 0, z: 0 }, planeId: scene, facing: 0 }),
                physicsJson: JSON.stringify({ scaleClass: 1, collisionRadius: 0.5, mass: 50, movementModes: ['WALK'] })
            } });
        }
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        assert.ok(address && typeof address !== 'string');
        const base = `http://127.0.0.1:${address.port}`;
        const errors: unknown[] = [];
        for (let i = 0; i < 2; i++) {
            const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: `loop-gm-${i}`, role: 'GM' }) });
            assert.equal(response.status, 200);
            const login = await response.json() as { data: { accessToken: string; sessionId: string } };
            sessions.push(login.data.sessionId);
            const client = io(base, { autoConnect: false, reconnection: false, forceNew: true, transports: ['websocket'] });
            clients.push(client);
            client.on('ERROR', error => errors.push(error));
            await packet(client, 'connect', () => client.connect());
            await packet(client, 'AUTH_SUCCESS', () => client.emit('AUTHENTICATE', { token: login.data.accessToken }));
            const sync = await packet<{ entities: Entity[] }>(client, 'SCENE_SYNC', () =>
                client.emit('JOIN_SCENE', { sceneId: scene, actorId: 'loop-hero' }));
            assert.equal(sync.entities.length, 2);
        }
        const [gm, observer] = clients;
        let polls = 0;
        gm.on('DECISION_POLL', (poll: DecisionPollPayload) => {
            polls++;
            gm.emit('DECISION_RESPONSE', { windowId: poll.windowId, chosenOptionId: null });
        });
        const send = (intentType: 'MOVE' | 'CAST_ACTION', payload: object) => gm.emit('CLIENT_INTENT', {
            actorId: 'loop-hero', intentType, clientTick: 0, payload
        });
        await packet<StateMutationPayload>(observer, 'STATE_MUTATED', () =>
            send('MOVE', { targetCoords: { x: 1, y: 0, z: 0 } }), payload =>
            payload.mutations.some(m => m.entityId === 'loop-hero' && m.changes.currentActionContext === null));
        await packet<StateMutationPayload>(observer, 'STATE_MUTATED', () =>
            send('CAST_ACTION', { actionTemplateId: strike.id, targetIds: ['loop-enemy'] }), payload =>
            payload.mutations.some(m => m.entityId === 'loop-hero' && m.changes.currentActionContext === null));
        const after = await packet<{ entities: Entity[]; pendingDecisionCount: number }>(observer, 'SCENE_SYNC', () => observer.emit('RESYNC'));
        assert.equal(after.entities.find(e => e.id === 'loop-hero')?.transform.coords.x, 1);
        assert.equal(after.entities.find(e => e.id === 'loop-enemy')?.resources.current.hp, 25);
        assert.equal(after.pendingDecisionCount, 0);
        assert.ok(polls > 0, '通过真实客户端响应决策，不关闭系统钩子');
        const ended = await packet<{ survivors: string[]; casualties: string[] }>(observer, 'COMBAT_END', () =>
            send('CAST_ACTION', { actionTemplateId: strike.id, targetIds: ['loop-enemy'] }));
        assert.deepEqual(ended.survivors, ['loop-hero']);
        assert.deepEqual(ended.casualties, ['loop-enemy']);
        const terminalSync = await packet<{ combatResult: { casualties: string[] }; entities: Entity[] }>(observer, 'SCENE_SYNC', () => observer.emit('RESYNC'));
        assert.deepEqual(terminalSync.combatResult.casualties, ['loop-enemy']);
        assert.equal(terminalSync.entities.find(e => e.id === 'loop-enemy')?.resources.current.hp, 0);
        const enemy = await prisma.characterSheet.findUniqueOrThrow({ where: { id: 'loop-enemy' } });
        assert.equal(JSON.parse(enemy.resourcesJson).current.hp, 0, '结算已持久化');
        assert.deepEqual(errors, []);
        console.log('authenticated combat loop: login, join, move, reaction, recovery, resync, kill, settlement passed');
    } finally {
        Dictionary.getAction = originalGetAction;
        for (const client of clients) { client.disconnect(); client.removeAllListeners(); }
        await new Promise<void>(resolve => cleanup.io.close(() => resolve()));
        await cleanup.campaignManager.destroyScene(scene);
        for (const session of sessions) AuthenticationService.revoke(session);
        await prisma.$disconnect();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
