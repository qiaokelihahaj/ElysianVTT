import assert from 'node:assert/strict';
import type { EncounterCommand } from '../packages/shared/src/index.js';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.js';
import { createDemoEntity, DEMO_ACTION_IDS } from '../packages/backend/src/demo/DemoContent.js';

async function main(): Promise<void> {
    const enemy = createDemoEntity('monster-bruiser', 'final-enemy', { x: 3, y: 2, z: 0 });
    enemy.resources.current.hp = 1;
    const coordinator = new EncounterCoordinator({ entities: [
        createDemoEntity('player-ranged', 'attacker', { x: 2, y: 2, z: 0 }),
        createDemoEntity('player-guide', 'waiting-ally', { x: 2, y: 3, z: 0 }), enemy,
    ] });
    const gm = { userId: 'settlement-gm', role: 'GM' as const, socketId: 'settlement-gm-tab' };
    let sequence = 0;
    const send = (type: EncounterCommand['type'], payload: Record<string, unknown>) => {
        const result = coordinator.handleCommand(gm, { type, payload, requestId: `drain-${++sequence}` } as EncounterCommand);
        assert.ok(result.ok, `${type}: ${result.reason ?? result.message}`);
        return result;
    };
    const savedTicks: number[] = [];
    coordinator.on('SETTLED', () => savedTicks.push(coordinator.getSnapshot().tick));
    try {
        coordinator.connect(gm);
        send('START', {});
        send('ACTION', { entityId: 'attacker', actionTemplateId: DEMO_ACTION_IDS.RANGED, targetIds: [enemy.id] });
        send('WAIT', { entityId: 'waiting-ally' });
        send('WAIT', { entityId: enemy.id });
        send('GM_PASS_ALL', {});
        // The hit is T3, the bystander's WAIT expires T5, and the attacker's
        // Recovery ends T6. A terminal candidate must drain the already paid
        // action without asking the bystander for another main action.
        for (let attempt = 0; attempt < 100 && !coordinator.getSnapshot().result; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        const snapshot = coordinator.getSnapshot();
        assert.equal(snapshot.result?.status, 'VICTORY', `settlement stalled at Tick ${snapshot.tick}`);
        assert.equal(snapshot.result?.resolvedTick, 6, 'save after the committed recovery boundary, never at the first death callback');
        assert.deepEqual(savedTicks, [6], 'persist exactly one stable final result');
        assert.equal(snapshot.entities.find(entity => entity.id === 'attacker')?.currentActionContext, undefined);
        console.log('PASS: terminal candidate drains committed work across an expiring WAIT and saves once');
    } finally { coordinator.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
