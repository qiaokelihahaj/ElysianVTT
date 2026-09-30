import assert from 'node:assert/strict';
import type { EncounterCommand, EncounterSnapshot } from '../packages/shared/src/index.js';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.js';
import { createDemoEntity, DEMO_ACTION_IDS } from '../packages/backend/src/demo/DemoContent.js';

const gm = { userId: 'boundary-gm', role: 'GM' as const, socketId: 'boundary-tab' };
let sequence = 0;
const command = (coordinator: EncounterCoordinator, type: EncounterCommand['type'], payload: Record<string, unknown>) =>
    coordinator.handleCommand(gm, { type, payload, requestId: `boundary-${++sequence}` } as EncounterCommand);
function send(coordinator: EncounterCoordinator, type: EncounterCommand['type'], payload: Record<string, unknown>): EncounterSnapshot {
    const result = command(coordinator, type, payload);
    assert.ok(result.ok, `${type}: ${result.reason ?? result.message}`);
    return result.snapshot;
}
function fixture(): EncounterCoordinator {
    const coordinator = new EncounterCoordinator({ entities: [
        createDemoEntity('player-ranged', 'a', { x: 2, y: 2, z: 0 }),
        createDemoEntity('monster-bruiser', 'b', { x: 3, y: 2, z: 0 }),
        createDemoEntity('player-guide', 'c', { x: 2, y: 3, z: 0 }),
    ] });
    coordinator.connect(gm);
    send(coordinator, 'START', {});
    send(coordinator, 'ACTION', { entityId: 'a', actionTemplateId: DEMO_ACTION_IDS.RANGED, targetIds: ['b'], effectiveTick: 1 });
    send(coordinator, 'WAIT', { entityId: 'b' });
    send(coordinator, 'WAIT', { entityId: 'c' });
    return coordinator;
}
async function until(coordinator: EncounterCoordinator, predicate: (snapshot: EncounterSnapshot) => boolean): Promise<EncounterSnapshot> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const snapshot = coordinator.getSnapshot();
        if (predicate(snapshot)) return snapshot;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`stalled at Tick ${coordinator.getSnapshot().tick}`);
}
async function main(): Promise<void> {
    const waiting = fixture();
    try {
        send(waiting, 'GM_PASS_ALL', {});
        await until(waiting, snapshot => snapshot.tick === 4);
        const early = command(waiting, 'ACTION', { entityId: 'b', actionTemplateId: DEMO_ACTION_IDS.MELEE, targetIds: ['a'] });
        assert.equal(early.ok, false, 'WAIT must reject an early main action even for GM acting through the ordinary action route');
        assert.equal(early.code, 'ALREADY_WAITING');
        const next = send(waiting, 'ACTION', { entityId: 'a', actionTemplateId: DEMO_ACTION_IDS.RECOVER, targetIds: [] });
        for (const entityId of ['b', 'c']) assert.equal(next.plan.slots.find(slot => slot.entityId === entityId)?.readyAtTick, 5, 'another actor committing at T4 cannot erase WAIT until T5');
        console.log('PASS: WAIT survives another barrier and prevents early main actions');
    } finally { waiting.close(); }

    for (const entityId of ['a', 'b']) {
        const removed = fixture();
        try {
            const snapshot = send(removed, 'GM_REMOVE', { entityId });
            assert.equal(snapshot.entities.some(entity => entity.id === entityId), false);
            assert.equal(snapshot.decisions.length, 0, 'removing the source or reactor closes the affected chain');
            await until(removed, state => state.tick > 0 || state.result !== undefined);
            console.log(`PASS: removing ${entityId} releases the decision barrier`);
        } finally { removed.close(); }
    }

    const stepped = fixture();
    try {
        send(stepped, 'GM_PAUSE', { reason: 'step acceptance' });
        send(stepped, 'GM_PASS_ALL', {});
        send(stepped, 'GM_TICK_BREAK', {});
        send(stepped, 'GM_RESUME', {});
        const paused = await until(stepped, snapshot => snapshot.paused);
        assert.equal(paused.tick, 0);
        assert.equal(paused.entities.find(entity => entity.id === 'b')?.resources.current.hp, 80);
        const hit = send(stepped, 'GM_STEP', { count: 1 });
        assert.equal(hit.tick, 1);
        assert.equal(hit.entities.find(entity => entity.id === 'b')?.resources.current.hp, 66);
        const premature = command(stepped, 'GM_END', { reason: 'must not truncate committed work' });
        assert.equal(premature.ok, false);
        assert.equal(premature.code, 'EFFECT_PENDING');
        console.log('PASS: break stops before the Tick, step commits one Tick, paused END preserves pending effects');
    } finally { stepped.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
