import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Server } from 'socket.io';
import type { CombatEndPayload, Entity, IEngineInstance } from '@hard-vtt/shared';
import { SettlementService } from '../packages/backend/src/campaigns/SettlementService.js';
import { StateBroadcaster } from '../packages/backend/src/network/StateBroadcaster.js';
import { VisibilityFilter } from '../packages/backend/src/network/VisibilityFilter.js';
import { PermissionService } from '../packages/backend/src/permissions/PermissionService.js';

function actor(id: string, hidden = false): Entity {
    return { id, templateId: 'actor', type: 'ACTOR',
        transform: { coords: { x: 0, y: 0, z: 0 }, planeId: 'audit', facing: 0 },
        physics: { scaleClass: 1, collisionRadius: 0.5, mass: 1, movementModes: ['WALK'] },
        resources: { current: { hp: 10 }, max: { hp: 10 } }, activeEffects: [], tags: hidden ? ['HIDDEN'] : [] };
}

async function verifyBroadcastOrder(engineType: 'COMBAT' | 'EXPLORE'): Promise<void> {
    const packets: Array<{ event: string; payload: unknown }> = [];
    const otherScenePackets: string[] = [];
    const socket = { data: { permissionSubject: PermissionService.createSubject({
        userId: 'GM', sessionId: 'order', role: 'GM', controlledEntityIds: [], visibleEntityIds: [], allowedSceneIds: ['order'],
    }) }, emit: (event: string, payload: unknown) => packets.push({ event, payload }) };
    let releaseFirstFetch!: () => void;
    const firstFetch = new Promise<void>(resolve => { releaseFirstFetch = resolve; });
    let fetchCount = 0;
    const io = {
        in: (sceneId: string) => ({ fetchSockets: async () => {
            if (sceneId !== 'order') return [{ ...socket, emit: (event: string) => otherScenePackets.push(event) }];
            if (fetchCount++ === 0) await firstFetch;
            return [socket];
        } }),
        to: () => ({ emit: socket.emit }),
    } as unknown as Server;
    const emitter = Object.assign(new EventEmitter(), { engineType, getAllEntities: () => [actor('hero')] });
    const broadcaster = new StateBroadcaster(io);
    broadcaster.wireEngine(emitter as unknown as IEngineInstance, 'order');
    const otherEmitter = Object.assign(new EventEmitter(), { engineType, getAllEntities: () => [actor('hero')] });
    broadcaster.wireEngine(otherEmitter as unknown as IEngineInstance, 'other-order');
    const expected = engineType === 'COMBAT'
        ? ['DECISION_POLL', 'DECISION_POLL', 'HOOK_SYNC', 'STATE_MUTATED', 'DECISION_ALL_RESOLVED']
        : ['ENTITY_MOVED', 'SKILL_CHECK_RESULT', 'STATE_MUTATED'];
    if (engineType === 'COMBAT') {
        for (const windowId of ['first', 'second']) emitter.emit('DECISION_POLL', {
            windowId, actorId: 'hero', availableOptions: [], tick: 1, windowType: 'REACTION', countdownMs: 100,
        });
        emitter.emit('HOOK_SYNC', { hook: { id: 'hook', entityId: 'hero' } });
        emitter.emit('STATE_MUTATED', { tick: 1, mutations: [] });
        emitter.emit('DECISION_ALL_RESOLVED', { tick: 1 });
    } else {
        emitter.emit('ENTITY_MOVED', { entityId: 'hero', coords: { x: 1, y: 0, z: 0 } });
        emitter.emit('SKILL_CHECK_RESULT', { success: true });
        emitter.emit('STATE_MUTATED', { tick: 1, mutations: [] });
    }
    otherEmitter.emit('STATE_MUTATED', { tick: 1, mutations: [] });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(otherScenePackets, ['STATE_MUTATED'], 'socket lookup in one scene does not block another scene');
    releaseFirstFetch();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(packets.map(packet => packet.event), expected,
        `${engineType} broadcasts preserve engine emission order while socket lookup is pending`);
    if (engineType === 'COMBAT') assert.deepEqual(packets.slice(0, 2).map(packet => (packet.payload as { windowId: string }).windowId), ['first', 'second']);
}

async function verifySettlementOrder(): Promise<void> {
    const packets: string[] = [];
    const socket = { data: { permissionSubject: PermissionService.createSubject({
        userId: 'GM', sessionId: 'settlement', role: 'GM', controlledEntityIds: [], visibleEntityIds: [], allowedSceneIds: ['settlement'],
    }) }, emit: (event: string) => packets.push(event) };
    const io = { in: () => ({ fetchSockets: async () => [socket] }) } as unknown as Server;
    const emitter = Object.assign(new EventEmitter(), { engineType: 'COMBAT', getAllEntities: () => [actor('hero')] });
    new StateBroadcaster(io).wireEngine(emitter as unknown as IEngineInstance, 'settlement');
    let releaseSettlement!: () => void;
    const settlement = new Promise<void>(resolve => { releaseSettlement = resolve; });
    const original = SettlementService.prototype.settleCombat;
    try {
        SettlementService.prototype.settleCombat = async () => { await settlement; };
        emitter.emit('STATE_MUTATED', { tick: 1, mutations: [] });
        const result: CombatEndPayload = { sceneId: 'settlement', tick: 1, survivors: ['hero'], casualties: [], entities: [actor('hero')] };
        emitter.emit('COMBAT_END', result);
        emitter.emit('STATE_MUTATED', { tick: 2, mutations: [] });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(packets, ['STATE_MUTATED'], 'combat result waits for settlement and retains its place in the scene queue');
        releaseSettlement();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(packets, ['STATE_MUTATED', 'COMBAT_END', 'STATE_MUTATED']);
    } finally {
        releaseSettlement();
        SettlementService.prototype.settleCombat = original;
    }
}

async function main(): Promise<void> {
    await verifyBroadcastOrder('COMBAT');
    await verifyBroadcastOrder('EXPLORE');
    await verifySettlementOrder();
    const packets = new Map<string, Array<{ event: string; payload: unknown }>>();
    const sockets = ['GM', 'PL'].map(role => {
        const id = role;
        packets.set(id, []);
        return { id, data: { authenticated: true, permissionSubject: PermissionService.createSubject({
            userId: id, sessionId: id, role: role as 'GM' | 'PL',
            controlledEntityIds: role === 'PL' ? ['hero'] : [], visibleEntityIds: [], allowedSceneIds: ['audit'],
        }) }, emit: (event: string, payload: unknown) => packets.get(id)!.push({ event, payload }) };
    });
    const io = {
        in: () => ({ fetchSockets: async () => sockets }),
        to: () => ({ emit: (event: string, payload: unknown) => sockets.forEach(socket => socket.emit(event, payload)) }),
    } as unknown as Server;
    const emitter = Object.assign(new EventEmitter(), { engineType: 'COMBAT', getAllEntities: () => entities });
    const entities = [actor('hero'), actor('enemy'), actor('hidden', true)];
    new StateBroadcaster(io).wireEngine(emitter as unknown as IEngineInstance, 'audit');
    emitter.emit('STATE_MUTATED', { tick: 0, mutations: entities.map(entity => ({ entityId: entity.id, changes: { 'resources.current.hp': 9 } })),
        actionPatches: entities.map(entity => ({ entityId: entity.id, actionId: entity.id, actionName: entity.id,
            timeline: { start: 0, startupEnd: 1, recoveryStart: 2, end: 3 } })) });
    emitter.emit('DECISION_POLL', { windowId: 'foreign', actorId: 'enemy', sourceAction: { actorId: 'hidden', actionName: 'secret', startupRemainingTicks: 1 },
        availableOptions: [], tick: 0, windowType: 'REACTION', countdownMs: 100 });
    emitter.emit('ACTION_SCHEDULED', { entityId: 'hidden', actionId: 'secret', actionName: 'secret',
        timeline: { start: 0, startupEnd: 1, recoveryStart: 2, end: 3 } });
    await new Promise<void>(resolve => setImmediate(resolve));
    const pl = packets.get('PL')!;
    const state = pl.find(packet => packet.event === 'STATE_MUTATED')?.payload as { mutations: Array<{ entityId: string }>; actionPatches: Array<{ entityId: string }> };
    assert.deepEqual(state.mutations.map(mutation => mutation.entityId), ['hero', 'enemy'], 'public opponents remain visible while hidden entities stay server-side');
    assert.deepEqual(state.actionPatches.map(patch => patch.entityId), ['hero', 'enemy']);
    assert.equal(pl.some(packet => packet.event === 'DECISION_POLL'), false, 'player receives decisions only for controlled actors');
    assert.equal(pl.some(packet => packet.event === 'ACTION_SCHEDULED'), false);
    assert.equal(packets.get('GM')!.filter(packet => packet.event === 'DECISION_POLL').length, 1);
    emitter.emit('STATE_MUTATED', { tick: 2, mutations: [] });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((packets.get('PL')!.at(-1)?.payload as { tick: number }).tick, 2, 'tick-only updates reach players');
    emitter.emit('STATE_MUTATED', { tick: 4, mutations: [{ entityId: 'hidden', changes: { 'resources.current.hp': 1 } }],
        actionPatches: [{ entityId: 'hidden', actionId: 'secret-action', actionName: 'secret',
            timeline: { start: 0, startupEnd: 1, recoveryStart: 2, end: 4 } }] });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(packets.get('PL')!.at(-1)?.payload, { tick: 4, mutations: [], actionPatches: [] },
        'hidden-only mutations still advance the player Tick without exposing entity data');
    entities[0].currentActionContext = { type: 'CASTING', actionId: 'audit-action', phase: 'ACTIVE', resolveTick: 3,
        activeTargetIds: ['hidden'], activeHitTargetIds: ['hidden'] };
    entities[0].activeEffects = [{ instanceId: 'effect', templateId: 'effect', sourceEntityId: 'hidden', remainingTicks: 1, stacks: 1 }];
    const viewer = VisibilityFilter.forScene(sockets[1].data.permissionSubject, entities);
    const visibleHero = VisibilityFilter.getVisibleEntities(entities, viewer)[0];
    assert.deepEqual(visibleHero.currentActionContext?.activeTargetIds, [], 'initial sync hides runtime target references');
    assert.equal(visibleHero.activeEffects.length, 0, 'initial sync hides unseen effect source references');
    const changes = VisibilityFilter.filterStateMutation('audit', { tick: 3, mutations: [{ entityId: 'hero',
        changes: { currentActionContext: entities[0].currentActionContext, activeEffects: entities[0].activeEffects } }] }, viewer)!;
    assert.equal(JSON.stringify(changes).includes('hidden'), false, 'incremental state hides the same nested references');
    const hiddenProjectile = Object.assign(actor('hidden-projectile'), { type: 'PROJECTILE' as const, sourceEntityId: 'hidden', targetEntityId: 'hero', trajectory: [{ x: 5, y: 0, z: 0 }] });
    const publicProjectile = Object.assign(actor('public-projectile'), { type: 'PROJECTILE' as const, sourceEntityId: 'enemy', targetEntityId: 'hero', trajectory: [{ x: 5, y: 0, z: 0 }] });
    const withProjectiles = [...entities, hiddenProjectile, publicProjectile];
    const projectileViewer = VisibilityFilter.forScene(viewer, withProjectiles);
    assert.equal(projectileViewer.visibleEntityIds.includes('hidden-projectile'), false, 'hidden shooters keep their projectiles private');
    const projectile = VisibilityFilter.getVisibleEntities(withProjectiles, projectileViewer).find(candidate => candidate.id === 'public-projectile')!;
    assert.equal('trajectory' in projectile, false, 'public projectile sync carries present geometry only');
    assert.equal('targetEntityId' in projectile, false);
    console.log('audit network broadcasts: GM/full and PL/public data filtered before delivery');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
