import assert from 'node:assert/strict';
import type { EncounterCommand, EncounterSnapshot } from '../packages/shared/src/index.js';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.js';
import { createDemoEntity, DEMO_ACTION_IDS } from '../packages/backend/src/demo/DemoContent.js';

async function scenario(cPriority: number | null, sourceEffectiveTick?: number, sourcePriority?: number): Promise<void> {
    const a = createDemoEntity('player-melee', 'a', { x: 2, y: 2, z: 0 });
    const b = createDemoEntity('monster-channeler', 'b', { x: 3, y: 2, z: 0 });
    const c = createDemoEntity('player-guide', 'c', { x: 2, y: 3, z: 0 });
    c.resources.current.agi = cPriority ?? 15;
    const coordinator = new EncounterCoordinator({ entities: [a, b, c] });
    const gm = { userId: 'chain-gm', role: 'GM' as const, socketId: 'chain-socket' };
    let sequence = 0;
    const send = (type: EncounterCommand['type'], payload: Record<string, unknown>): EncounterSnapshot => {
        const result = coordinator.handleCommand(gm, { type, payload, requestId: `chain-${++sequence}` } as EncounterCommand);
        assert.ok(result.ok, `${type}: ${result.reason ?? result.message}`);
        return result.snapshot;
    };
    try {
        coordinator.connect(gm);
        send('START', {});
        send('ACTION', { entityId: 'a', actionTemplateId: DEMO_ACTION_IDS.MELEE, targetIds: ['b'],
            ...(sourceEffectiveTick === undefined ? {} : { effectiveTick: sourceEffectiveTick }),
            ...(sourcePriority === undefined ? {} : { priority: sourcePriority }),
        });
        send('WAIT', { entityId: 'b' });
        const first = send('WAIT', { entityId: 'c' });
        const bw = first.decisions.find(window => window.reactorEntityId === 'b');
        const cw = first.decisions.find(window => window.reactorEntityId === 'c');
        assert.ok(bw && cw);
        send('GM_PAUSE', { reason: 'inspect causal reaction chain' });
        send('REACTION_SELECT', { windowId: bw.windowId, optionId: 'INTERRUPT' });
        const second = send('GM_PASS', { windowId: cw.windowId });
        const chainWindow = second.decisions.find(window => window.reactorEntityId === 'c' && window.sourceEntityId === 'b');
        assert.ok(chainWindow, 'C may pass A and then respond to B before either action resolves');
        assert.equal(chainWindow.causationId, bw.causationId, 'A -> B -> C must preserve one causal trigger chain');
        assert.equal(second.tick, 0);
        const third = cPriority === null
            ? send('GM_PASS', { windowId: chainWindow.windowId })
            : send('REACTION_SELECT', { windowId: chainWindow.windowId, optionId: 'INTERRUPT' });
        assert.equal(third.tick, 0);
        assert.equal(third.entities.find(entity => entity.id === 'a')?.currentActionContext?.phase, 'STARTUP', 'declared reactions never apply their interrupt ahead of their effective Tick');
        assert.equal(third.decisions.length, 0, 'one reaction per entity must bound the causal chain');
        send('GM_RESUME', {});
        for (let index = 0; index < 100 && coordinator.getSnapshot().tick < 2; index++) {
            await new Promise<void>(resolve => setTimeout(resolve, 5));
        }
        const result = coordinator.getSnapshot();
        assert.ok(result.tick >= 2, 'chain must finish without a decision or action-slot deadlock');
        const sourceActsFirst = sourceEffectiveTick === 0 || (sourceEffectiveTick === 1 && (sourcePriority ?? 14) > 63);
        const expectedHp = sourceActsFirst || (cPriority !== null && cPriority > b.resources.current.agi) ? 42 : 60;
        assert.equal(result.entities.find(entity => entity.id === 'b')?.resources.current.hp, expectedHp,
            'a faster priority C cancels B and preserves A; absent/lower/equal C cannot undo B interrupting A');
        console.log(`PASS: A -> B -> C with C priority ${cPriority ?? 'PASS'}, source Tick ${sourceEffectiveTick ?? 2}, source priority ${sourcePriority ?? 14}`);
    } finally {
        coordinator.close();
    }
}

async function main(): Promise<void> {
    let failures = 0;
    for (const priority of [null, 15, 13, 10]) {
        try { await scenario(priority); }
        catch (error) { failures++; console.error(`FAIL: chain priority ${priority}`, error); }
    }
    for (const [tick, priority] of [[0, 14], [1, 100], [1, 14]]) {
        try { await scenario(null, tick, priority); }
        catch (error) { failures++; console.error(`FAIL: source timing ${tick}/${priority}`, error); }
    }
    assert.equal(failures, 0, 'all causal priority outcomes must hold');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
