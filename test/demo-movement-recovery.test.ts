import assert from 'node:assert/strict';
import type { EncounterCommand } from '../packages/shared/src/index.js';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.js';
import { createDemoEntity, DEMO_ACTION_IDS } from '../packages/backend/src/demo/DemoContent.js';

async function main(): Promise<void> {
    const actor = createDemoEntity('player-melee', 'mover', { x: 2, y: 2, z: 0 });
    actor.resources.current.focus = 0;
    actor.resources.current.poise = 0;
    const coordinator = new EncounterCoordinator({ entities: [actor,
        createDemoEntity('monster-bruiser', 'watcher', { x: 7, y: 4, z: 0 }),
    ] });
    const gm = { userId: 'movement-gm', role: 'GM' as const, socketId: 'movement-tab' };
    let sequence = 0;
    const send = (type: EncounterCommand['type'], payload: Record<string, unknown>) => {
        const result = coordinator.handleCommand(gm, { type, payload, requestId: `movement-${++sequence}` } as EncounterCommand);
        assert.ok(result.ok, `${type}: ${result.reason ?? result.message}`);
        return result.snapshot;
    };
    try {
        coordinator.connect(gm);
        send('START', {});
        send('ACTION', { entityId: actor.id, actionTemplateId: DEMO_ACTION_IDS.MOVE, targetIds: [], targetCoords: { x: 3, y: 2, z: 0 } });
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(coordinator.getSnapshot().tick, 0);
        assert.deepEqual(coordinator.getSnapshot().entities.find(value => value.id === actor.id)?.transform.coords, actor.transform.coords);
        send('WAIT', { entityId: 'watcher' });
        for (let attempt = 0; attempt < 80; attempt++) {
            const snapshot = coordinator.getSnapshot();
            if (snapshot.entities.find(value => value.id === actor.id)?.transform.coords.x === 3) break;
            for (const slot of snapshot.plan.slots) {
                if (snapshot.decisions.length === 0 && slot.entityId === 'watcher' && !slot.ready && slot.readyAtTick === undefined && !snapshot.entities.find(entity => entity.id === slot.entityId)?.currentActionContext) send('WAIT', { entityId: slot.entityId });
            }
            if (snapshot.decisions.length) send('GM_PASS_ALL', {});
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        const moved = coordinator.getSnapshot();
        assert.equal(moved.entities.find(value => value.id === actor.id)?.transform.coords.x, 3, 'movement commits through the authoritative event queue');
        assert.ok(moved.tick > 0, 'movement cannot teleport at declaration');
        assert.equal(moved.entities.find(value => value.id === actor.id)?.resources.current.focus, 0, 'waiting and movement do not restore resources');
        for (let attempt = 0; attempt < 80; attempt++) {
            const snapshot = coordinator.getSnapshot();
            if (snapshot.plan.slots.some(slot => slot.entityId === actor.id && !slot.ready && slot.readyAtTick === undefined && !snapshot.entities.find(entity => entity.id === slot.entityId)?.currentActionContext)) break;
            for (const slot of snapshot.plan.slots) {
                if (snapshot.decisions.length === 0 && slot.entityId === 'watcher' && !slot.ready && slot.readyAtTick === undefined && !snapshot.entities.find(entity => entity.id === slot.entityId)?.currentActionContext) send('WAIT', { entityId: slot.entityId });
            }
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        const recoveryTick = coordinator.getSnapshot().tick;
        send('ACTION', { entityId: actor.id, actionTemplateId: DEMO_ACTION_IDS.RECOVER, targetIds: [] });
        for (let attempt = 0; attempt < 80; attempt++) {
            const snapshot = coordinator.getSnapshot();
            if ((snapshot.entities.find(value => value.id === actor.id)?.resources.current.focus ?? 0) > 0) break;
            for (const slot of snapshot.plan.slots) {
                if (snapshot.decisions.length === 0 && slot.entityId === 'watcher' && !slot.ready && slot.readyAtTick === undefined && !snapshot.entities.find(entity => entity.id === slot.entityId)?.currentActionContext) send('WAIT', { entityId: slot.entityId });
            }
            if (snapshot.decisions.length) send('GM_PASS_ALL', {});
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        const recovered = coordinator.getSnapshot();
        assert.ok(recovered.tick > recoveryTick);
        assert.equal(recovered.entities.find(value => value.id === actor.id)?.resources.current.focus, 3);
        assert.equal(recovered.entities.find(value => value.id === actor.id)?.resources.current.poise, 3);
        console.log('PASS: movement barrier, positive Tick movement, zero-resource recovery and no free WAIT restoration');
    } finally { coordinator.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
