import assert from 'node:assert/strict';
import type { EncounterCommand } from '../packages/shared/src/index.js';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.js';
import { createDemoEntity, DEMO_ACTION_IDS } from '../packages/backend/src/demo/DemoContent.js';

const gm = { userId: 'reaction-gm', role: 'GM' as const, socketId: 'reaction-gm-socket' };
let sequence = 0;
let failures = 0;

for (const optionId of ['INTERRUPT', 'PARRY', 'DODGE']) {
    const coordinator = new EncounterCoordinator({ entities: [
        createDemoEntity('player-melee', 'a', { x: 2, y: 2, z: 0 }),
        createDemoEntity('monster-channeler', 'b', { x: 3, y: 2, z: 0 }),
        createDemoEntity('player-guide', 'c', { x: 2, y: 3, z: 0 }),
    ] });
    const send = (type: EncounterCommand['type'], payload: Record<string, unknown>) => {
        const result = coordinator.handleCommand(gm, { type, payload, requestId: `reaction-${++sequence}` } as EncounterCommand);
        assert.ok(result.ok, `${type}: ${result.reason ?? result.message}`);
        return result.snapshot;
    };
    try {
        coordinator.connect(gm);
        send('START', {});
        send('ACTION', { entityId: 'a', actionTemplateId: DEMO_ACTION_IDS.MELEE, targetIds: ['b'] });
        send('WAIT', { entityId: 'b' });
        const declared = send('WAIT', { entityId: 'c' });
        const bWindow = declared.decisions.find(window => window.reactorEntityId === 'b');
        const cWindow = declared.decisions.find(window => window.reactorEntityId === 'c');
        assert.ok(bWindow && cWindow, 'both waiting actors receive declaration windows');
        assert.equal(declared.tick, 0);
        send('GM_PAUSE', { reason: 'inspect response collection before any Tick commits' });
        const initialB = declared.entities.find(entity => entity.id === 'b');
        const collected = send('REACTION_SELECT', { windowId: bWindow.windowId, optionId });
        const a = collected.entities.find(entity => entity.id === 'a');
        const b = collected.entities.find(entity => entity.id === 'b');
        assert.equal(collected.tick, 0);
        assert.equal(a?.currentActionContext?.phase, 'STARTUP', 'choosing an interrupt must not interrupt before its positive effective Tick');
        assert.deepEqual(b?.activeEffects, initialB?.activeEffects, 'choosing a guard must not apply its effect before the reaction event');
        assert.deepEqual(b?.resources, initialB?.resources, 'one response must not pay costs before the whole reaction batch is collected');
        assert.equal(b?.currentActionContext, undefined, 'one response must not enter the event queue before other responses are collected');
        assert.ok(collected.decisions.some(window => window.windowId === cWindow.windowId), 'the other independent decision remains open');
        console.log(`PASS: ${optionId} response collection has no premature authoritative effect`);
    } catch (error) {
        failures++;
        console.error(`FAIL: ${optionId}`, error);
    } finally {
        coordinator.close();
    }
}
{
    const coordinator = new EncounterCoordinator({ entities: [
        createDemoEntity('player-melee', 'source-a', { x: 2, y: 2, z: 0 }),
        createDemoEntity('monster-channeler', 'reactor', { x: 3, y: 2, z: 0 }),
        createDemoEntity('player-guide', 'source-c', { x: 3, y: 3, z: 0 }),
    ] });
    const send = (type: EncounterCommand['type'], payload: Record<string, unknown>) => coordinator.handleCommand(gm,
        { type, payload, requestId: `exclusive-slot-${++sequence}` } as EncounterCommand);
    try {
        coordinator.connect(gm);
        assert.ok(send('START', {}).ok);
        assert.ok(send('ACTION', { entityId: 'source-a', actionTemplateId: DEMO_ACTION_IDS.MELEE, targetIds: ['reactor'] }).ok);
        assert.ok(send('ACTION', { entityId: 'source-c', actionTemplateId: DEMO_ACTION_IDS.MELEE, targetIds: ['reactor'] }).ok);
        const declared = send('WAIT', { entityId: 'reactor' });
        const windows = declared.snapshot.decisions.filter(window => window.reactorEntityId === 'reactor');
        assert.equal(windows.length, 2, 'two distinct sources may offer concurrent windows to one actor');
        assert.ok(send('GM_PAUSE', { reason: 'one action slot per actor' }).ok);
        assert.ok(send('REACTION_SELECT', { windowId: windows[0].windowId, optionId: 'INTERRUPT' }).ok);
        const second = send('REACTION_SELECT', { windowId: windows[1].windowId, optionId: 'INTERRUPT' });
        assert.equal(second.ok, false, 'a reserved reaction must consume the sole action slot even before the batch commits');
        console.log('PASS: concurrent windows cannot reserve two actions for one actor');
    } catch (error) {
        failures++;
        console.error('FAIL: exclusive reaction action slot', error);
    } finally {
        coordinator.close();
    }
}
assert.equal(failures, 0, 'reaction declaration must preserve real positive-Tick timing and batch collection');
