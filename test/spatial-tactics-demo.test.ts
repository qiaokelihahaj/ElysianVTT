import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import type { DemoCatalogResponse, DemoSessionResponse, EncounterCommandResult, EncounterSnapshot } from '../packages/shared/src/index.js';
import { createDemoServer, type DemoServerHandle } from '../packages/backend/src/demo/DemoServer.js';
import { TACTIC_ACTION_IDS, createSpatialTacticsContent, createSpatialTacticsRoster } from '../packages/backend/src/demo/SpatialTacticsContent.js';
import { filterEncounterSnapshot } from '../packages/backend/src/network/EncounterServer.js';

async function main(): Promise<void> {
    const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'elysian-spatial-demo-')));
    const sockets: Socket[] = [];
    let server: DemoServerHandle | undefined;
    let sequence = 0;
    const originalRandom = Math.random;
    try {
        const content = createSpatialTacticsContent();
        const copy = createSpatialTacticsContent();
        content.actionTemplates[0].label = 'mutated';
        assert.notEqual(copy.actionTemplates[0].label, 'mutated', 'scenario content is instance isolated');
        assert.equal(createSpatialTacticsRoster().filter(entity => entity.type === 'ACTOR').length, 6);
        assert.equal(copy.scenario?.objectives.length, 5, 'tactics form a single ordered encounter');
        for (const objective of copy.scenario?.objectives ?? []) for (const id of objective.actionIds) {
            assert.ok(copy.actionTemplates.some(template => template.id === id), `guide action ${id} exists`);
        }
        server = await createDemoServer({ scenario: 'tactics', dataDirectory: temporaryRoot, host: '127.0.0.1', port: 0 });
        const { url } = await server.listen();
        const http = (path: string, token?: string, body?: unknown) => fetch(`${url}/api/demo/${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const login = async (path: string, body: unknown) => {
            const response = await http(path, undefined, body);
            assert.equal(response.status, 200);
            return (await response.json() as DemoSessionResponse).data;
        };
        const gm = await login('host', { credential: server.credentials.hostCredential, displayName: 'Tactics GM' });
        const player = await login('join', { joinCode: server.credentials.joinCode, displayName: 'Tactics PL' });
        const connect = async (token: string): Promise<Socket> => {
            const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false, autoConnect: false, auth: { accessToken: token } });
            sockets.push(socket);
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Socket timeout')), 3000);
                socket.once('connect', () => { clearTimeout(timer); resolve(); });
                socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
                socket.connect();
            });
            return socket;
        };
        const gmSocket = await connect(gm.accessToken);
        const plSocket = await connect(player.accessToken);
        const secondPlSocket = await connect(player.accessToken);
        const command = async (socket: Socket, type: string, payload: Record<string, unknown>, requestId = `tactics-${++sequence}`): Promise<EncounterCommandResult> =>
            new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`Missing ${type} ACK`)), 3000);
                socket.emit('DEMO_COMMAND', { requestId, type, payload }, (result: EncounterCommandResult) => { clearTimeout(timer); resolve(result); });
            });
        const assigned = await http('assign', gm.accessToken, { userId: player.session.userId, entityId: 'tactics-ranger' });
        assert.equal(assigned.status, 200);
        const plSession = server.sessionService.getSessions().find(session => session.userId === player.session.userId);
        assert.ok(plSession);
        const visibilityFixture = structuredClone(server.coordinator.getSnapshot());
        const hiddenSource = visibilityFixture.entities.find(entity => entity.id === 'tactics-sniper');
        assert.ok(hiddenSource);
        hiddenSource.visibility = 'GM';
        const projectileBase = {
            id: 'hidden-flight', templateId: 'proj-secret-action', type: 'PROJECTILE' as const,
            transform: structuredClone(hiddenSource.transform), physics: structuredClone(hiddenSource.physics),
            resources: { current: {}, max: {} }, activeEffects: [],
        };
        const hiddenFlight = { ...projectileBase, sourceEntityId: hiddenSource.id };
        const runtimeFlight = { ...projectileBase, id: 'visible-flight', sourceEntityId: 'tactics-ranger',
            targetEntityId: hiddenSource.id, targetCoords: { x: 99, y: 99, z: 0 }, waypoints: [{ x: 99, y: 99, z: 0 }],
        };
        visibilityFixture.entities.push(hiddenFlight, runtimeFlight);
        const filtered = filterEncounterSnapshot(visibilityFixture, plSession);
        assert.equal(filtered.entities.some(entity => entity.id === 'hidden-flight'), false, 'hidden source projectile stays hidden');
        const visibleFlight = filtered.entities.find(entity => entity.id === 'visible-flight');
        assert.ok(visibleFlight);
        for (const key of ['sourceEntityId', 'targetEntityId', 'targetCoords', 'waypoints', 'sourceActionTemplateId']) {
            assert.equal(key in visibleFlight, false, `runtime projectile ${key} never reaches PL`);
        }
        const catalog = await (await http('catalog', player.accessToken)).json() as DemoCatalogResponse;
        assert.equal(catalog.data.scenario?.id, 'spatial-tactics');
        assert.equal(catalog.data.map.width, 14);
        assert.ok(catalog.data.entries.flatMap(entry => entry.actions).some(action => action.id === TACTIC_ACTION_IDS.LOB && action.targetKind === 'cell'));
        assert.equal((await http('action-preview', undefined, { entityId: 'tactics-ranger', actionTemplateId: TACTIC_ACTION_IDS.LOB })).status, 401);
        assert.equal((await command(plSocket, 'START', {})).ok, false);
        assert.equal((await command(gmSocket, 'START', {})).ok, true);
        assert.equal((await command(plSocket, 'ACTION', { entityId: 'tactics-vanguard', actionTemplateId: TACTIC_ACTION_IDS.GUARD })).ok, false, 'spatial actions require ownership');
        assert.equal((await command(plSocket, 'ACTION', { entityId: 'tactics-ranger', actionTemplateId: TACTIC_ACTION_IDS.MOVE, targetCoords: { x: 6, y: 2, z: 0 } })).ok, false, 'occupied cover destinations are rejected');
        assert.equal((await command(plSocket, 'ACTION', { entityId: 'tactics-ranger', actionTemplateId: TACTIC_ACTION_IDS.ZONE, targetCoords: { x: 13, y: 8, z: 0 } })).ok, false, 'cell range is authoritative');
        assert.equal((await command(plSocket, 'ACTION', { entityId: 'tactics-ranger', actionTemplateId: TACTIC_ACTION_IDS.SPEAR, targetIds: ['tactics-sentinel'] })).ok, false, 'weapon requirement is authoritative');
        assert.equal((await command(plSocket, 'ACTION', { entityId: 'tactics-ranger', actionTemplateId: TACTIC_ACTION_IDS.ADS, priority: 999 })).ok, false);
        const requestId = 'tactics-idempotent-stance';
        const stance = await command(plSocket, 'ACTION', { entityId: 'tactics-ranger', actionTemplateId: TACTIC_ACTION_IDS.ADS }, requestId);
        assert.equal(stance.ok, true);
        const repeated = await command(secondPlSocket, 'ACTION', { entityId: 'tactics-ranger', actionTemplateId: TACTIC_ACTION_IDS.ADS }, requestId);
        assert.equal(repeated.ok, true, 'same user second socket can retry the same request');
        assert.equal(repeated.snapshot.actions.filter(action => action.actorId === 'tactics-ranger').length, 1);
        assert.equal(stance.snapshot.entities.find(entity => entity.id === 'tactics-ranger')?.currentStance, 'NONE', 'declaration does not instantly change stance');
        assert.equal((await command(gmSocket, 'ACTION', { entityId: 'tactics-vanguard', actionTemplateId: TACTIC_ACTION_IDS.GUARD })).ok, true);
        assert.equal((await command(gmSocket, 'ACTION', { entityId: 'tactics-engineer', actionTemplateId: TACTIC_ACTION_IDS.TURN_RIGHT })).ok, true);
        for (const entityId of ['tactics-sentinel', 'tactics-sniper', 'tactics-bombardier']) {
            assert.equal((await command(gmSocket, 'WAIT', { entityId })).ok, true);
        }
        // Supply later declaration barriers through the real socket interface while
        // other actors are still completing slower actions.
        const deadline = Date.now() + 5000;
        let snapshot: EncounterSnapshot = server.coordinator.getSnapshot();
        while (snapshot.entities.find(entity => entity.id === 'tactics-ranger')?.currentStance !== 'ADS' && Date.now() < deadline) {
            if (snapshot.decisions.length) await command(gmSocket, 'GM_PASS_ALL', {});
            for (const slot of snapshot.plan.slots.filter(slot => !slot.ready && !slot.waiting)) {
                const entity = snapshot.entities.find(entity => entity.id === slot.entityId);
                if (entity?.type !== 'ACTOR' || entity.currentActionContext || (entity.resources.current.hp ?? 0) <= 0) continue;
                await command(gmSocket, 'WAIT', { entityId: slot.entityId });
            }
            await new Promise(resolve => setTimeout(resolve, 10));
            snapshot = server.coordinator.getSnapshot();
        }
        assert.equal(snapshot.entities.find(entity => entity.id === 'tactics-ranger')?.currentStance, 'ADS');
        assert.ok(snapshot.entities.find(entity => entity.id === 'tactics-vanguard')?.formationContext?.interceptConfig);
        assert.equal(snapshot.entities.find(entity => entity.id === 'tactics-engineer')?.transform.facing, 60);
        assert.ok(snapshot.tick >= 5, 'real event time passed');
        assert.equal((await command(gmSocket, 'GM_END', { reason: 'spatial network acceptance' })).ok, true);
        const stored = server.persistence.load();
        assert.ok(stored?.result);
        assert.equal(stored?.openingSnapshot.entities.filter(entity => entity.type === 'PROP').length, 4);
        assert.equal((await command(gmSocket, 'GM_RESTART', {})).ok, true);
        assert.equal(server.coordinator.getSnapshot().tick, 0);
        assert.equal((await command(gmSocket, 'START', {})).ok, true);
        // Fight to a rules-derived ending using catalog actions, with all
        // declaration/reaction barriers served through authenticated sockets.
        Math.random = () => 0.95;
        const battleDeadline = Date.now() + 15000;
        while (!server.coordinator.getSnapshot().result && Date.now() < battleDeadline) {
            if (server.coordinator.getSnapshot().decisions.some(decision => !decision.resolved)) {
                assert.equal((await command(gmSocket, 'GM_PASS_ALL', {})).ok, true);
            }
            for (const entityId of server.coordinator.getSnapshot().plan.slots.map(slot => slot.entityId)) {
                const current = server.coordinator.getSnapshot();
                if (current.result) break;
                const entity = current.entities.find(candidate => candidate.id === entityId);
                const slot = current.plan.slots.find(candidate => candidate.entityId === entityId);
                if (entity?.type !== 'ACTOR' || (entity.resources.current.hp ?? 0) <= 0 || entity.currentActionContext
                    || slot?.ready || (slot?.readyAtTick !== undefined && slot.readyAtTick > current.tick)
                    || current.decisions.some(decision => !decision.resolved)) continue;
                const enemy = current.entities.find(candidate => candidate.type === 'ACTOR'
                    && candidate.faction === 'ENEMIES' && (candidate.resources.current.hp ?? 0) > 0);
                if (!enemy) break; // Let committed projectiles/recovery drain without new declarations.
                const result = entity.faction === 'PLAYERS' && enemy
                    ? await command(gmSocket, 'ACTION', (entity.resources.current.focus ?? 0) >= 2
                        ? { entityId, actionTemplateId: TACTIC_ACTION_IDS.LOB, targetCoords: enemy.transform.coords }
                        : { entityId, actionTemplateId: 'DEMO_RECOVER_FOCUS' })
                    : await command(gmSocket, 'WAIT', { entityId });
                assert.equal(result.ok, true, result.reason);
            }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        const finished = server.coordinator.getSnapshot();
        assert.equal(finished.status, 'VICTORY', 'the complete scenario reaches victory through real damage');
        assert.equal(finished.result?.endedBy, 'RULES');
        assert.equal(finished.result?.winningFaction, 'PLAYERS');
        assert.equal(finished.entities.some(entity => entity.type === 'PROJECTILE'), false, 'in-flight effects drain before settlement');
        assert.equal(server.persistence.load()?.result?.endedBy, 'RULES', 'natural victory persists');
        assert.equal((await command(gmSocket, 'GM_RESTART', {})).ok, true);
        assert.equal(server.coordinator.getSnapshot().status, 'LOBBY');
        assert.ok(server.coordinator.getSnapshot().entities.filter(entity => entity.type === 'ACTOR')
            .every(entity => entity.resources.current.hp === entity.resources.max.hp), 'replay restores the complete opening roster');
        plSocket.disconnect();
        secondPlSocket.disconnect();
        console.log('spatial-tactics-demo: scenario, real HTTP/three sockets, admission, duplicate requests, timed tactics, real victory and replay passed');
    } finally {
        Math.random = originalRandom;
        for (const socket of sockets) socket.disconnect();
        await server?.close();
        rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
