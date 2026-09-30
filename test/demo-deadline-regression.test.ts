import assert from 'node:assert/strict';
import type { EncounterCommand } from '../packages/shared/src/index.js';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.js';
import { createDemoEntity, DEMO_ACTION_IDS } from '../packages/backend/src/demo/DemoContent.js';

async function main(): Promise<void> {
    let now = 1_000_000;
    let sequence = 0;
    const gm = { userId: 'deadline-gm', role: 'GM' as const, socketId: 'gm-tab' };
    const coordinator = new EncounterCoordinator({ now: () => now, entities: [
        createDemoEntity('player-melee', 'a', { x: 2, y: 2, z: 0 }),
        createDemoEntity('monster-bruiser', 'b', { x: 3, y: 2, z: 0 }),
    ] });
    const send = (type: EncounterCommand['type'], payload: Record<string, unknown>) => {
        const result = coordinator.handleCommand(gm, { type, payload, requestId: `deadline-${++sequence}` } as EncounterCommand);
        assert.ok(result.ok, `${type}: ${result.reason ?? result.message}`);
        return result.snapshot;
    };
    try {
        coordinator.connect(gm);
        send('START', {});
        send('ACTION', { entityId: 'a', actionTemplateId: DEMO_ACTION_IDS.MELEE, targetIds: ['b'] });
        const declared = send('WAIT', { entityId: 'b' });
        const window = declared.decisions[0];
        assert.ok(window);
        assert.equal(window.joinDeadlineAt - now, 10_000);
        now += 3_000;
        send('GM_PAUSE', { reason: 'deadline freeze' });
        now += 120_000;
        coordinator.advanceDeadlines();
        assert.equal(coordinator.getSnapshot().decisions.length, 1);
        const resumed = send('GM_RESUME', {});
        assert.equal(resumed.decisions[0].joinDeadlineAt - now, 7_000, 'pause must preserve join remainder');
        const joined = send('REACTION_JOIN', { windowId: window.windowId });
        assert.equal(joined.decisions[0].selectDeadlineAt! - now, 60_000);
        coordinator.disconnect(gm.socketId);
        now += 20_000;
        coordinator.connect({ ...gm, socketId: 'gm-reconnected-tab' });
        assert.equal(coordinator.getSnapshot().decisions[0].selectDeadlineAt, joined.decisions[0].selectDeadlineAt, 'reconnection must not reset the selection deadline');
        now += 40_000;
        coordinator.advanceDeadlines();
        assert.equal(coordinator.getSnapshot().decisions.length, 0, 'expired engaged window must be removed');
        for (let index = 0; index < 40 && coordinator.getSnapshot().tick === 0; index++) {
            await new Promise<void>(resolve => setTimeout(resolve, 5));
        }
        assert.ok(coordinator.getSnapshot().tick > 0, 'the engine must resume after an engaged disconnected window expires, with no orphaned decision counter');

        // A GM override is a server-authority response, not a fabricated
        // socket response.  It must be able to pass a window after a player
        // has engaged it, while the regular cross-socket auto-pass guard
        // remains covered by combat-decision-ownership.test.ts.
        let overrideNow = 2_000_000;
        let overrideSequence = 0;
        const overrideCoordinator = new EncounterCoordinator({ now: () => overrideNow, entities: [
            createDemoEntity('player-melee', 'override-a', { x: 2, y: 2, z: 0 }),
            createDemoEntity('monster-bruiser', 'override-b', { x: 3, y: 2, z: 0 }),
        ] });
        const overrideGm = { userId: 'override-gm', role: 'GM' as const, socketId: 'override-gm-tab' };
        const overridePlayer = { userId: 'override-player-user', role: 'PL' as const, socketId: 'override-player-tab' };
        const sendOverride = (
            principal: typeof overrideGm | typeof overridePlayer,
            type: EncounterCommand['type'],
            payload: Record<string, unknown>,
        ) => {
            const result = overrideCoordinator.handleCommand(principal, {
                type,
                payload,
                requestId: `deadline-override-${++overrideSequence}`,
            } as EncounterCommand);
            assert.ok(result.ok, `${type}: ${result.reason ?? result.message}`);
            return result.snapshot;
        };
        try {
            overrideCoordinator.connect(overrideGm);
            overrideCoordinator.connect(overridePlayer);
            sendOverride(overrideGm, 'GM_ASSIGN_ENTITY', { entityId: 'override-b', userId: overridePlayer.userId });
            sendOverride(overrideGm, 'START', {});
            sendOverride(overrideGm, 'ACTION', {
                entityId: 'override-a',
                actionTemplateId: DEMO_ACTION_IDS.MELEE,
                targetIds: ['override-b'],
            });
            const engagedWindow = sendOverride(overridePlayer, 'WAIT', { entityId: 'override-b' }).decisions[0];
            assert.ok(engagedWindow);
            sendOverride(overridePlayer, 'REACTION_JOIN', { windowId: engagedWindow.windowId });
            const gmPass = sendOverride(overrideGm, 'GM_PASS', { windowId: engagedWindow.windowId });
            assert.equal(gmPass.decisions.length, 0, 'GM PASS must resolve a player-engaged window');
            assert.equal(overrideCoordinator.engine.getPendingDecisionCount(), 0, 'GM PASS must release the engine decision counter');
            for (let index = 0; index < 40 && overrideCoordinator.getSnapshot().tick === 0; index++) {
                await new Promise<void>(resolve => setTimeout(resolve, 5));
            }
            assert.ok(overrideCoordinator.getSnapshot().tick > 0, 'GM PASS must resume the event queue');
        } finally {
            overrideCoordinator.close();
        }
        console.log('demo-deadline-regression: 10s/60s, pause freeze, reconnect deadline and engaged timeout resume passed');
    } finally {
        coordinator.close();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
