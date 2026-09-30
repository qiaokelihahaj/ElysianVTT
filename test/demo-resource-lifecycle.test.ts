import assert from 'node:assert/strict';
import type { ActionTemplate } from '../packages/shared/src/index.js';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';
import { createDemoEntity } from '../packages/backend/src/demo/DemoContent.js';

function template(id: string, startup: number, resource: string, amount: number): ActionTemplate {
    return { id, tags: ['ATTACK'], resourceCost: {}, priorityExpr: '10',
        timeCost: { startupTicks: startup, recoveryTicks: 10 },
        range: { type: 'MELEE', distanceExpr: '3' },
        effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource, amountExpr: String(amount) } }],
    };
}

let failures = 0;
for (const threshold of [-1, 0, 1]) {
    const engine = new CombatEngine(`resource-boundary-${threshold}`);
    engine.setAutoProcess(false);
    const a = createDemoEntity('player-melee', 'a', { x: 2, y: 2, z: 0 });
    const b = createDemoEntity('monster-bruiser', 'b', { x: 3, y: 2, z: 0 });
    a.resources.current.poise = 5;
    const attack = { ...template(`BOUNDARY_ATTACK_${threshold}`, 2, 'hp', 18), sustainResources: ['poise'] };
    const hit = template(`BOUNDARY_HIT_${threshold}`, 1, 'poise', 5 - threshold);
    Dictionary.registerActions([attack, hit]);
    engine.mountEntities([a, b]);
    try {
        engine.receiveCoordinatedIntents([
            { actorId: 'a', intentType: 'CAST_ACTION', clientTick: 0, payload: { actionTemplateId: attack.id, targetIds: ['b'] } },
            { actorId: 'b', intentType: 'CAST_ACTION', clientTick: 0, payload: { actionTemplateId: hit.id, targetIds: ['a'] } },
        ]);
        engine.processPending(1);
        const afterHit = engine.getAllEntities().find(entity => entity.id === 'a');
        assert.equal(afterHit?.resources.current.poise, threshold, 'STARTUP sustain damage must preserve the negative/zero/positive boundary');
        assert.equal(afterHit?.currentActionContext?.phase, threshold < 0 ? 'RECOVERY' : 'STARTUP');
        for (let count = 0; count < 20 && engine.hasPendingEvents(); count++) engine.processPending(1);
        assert.equal(engine.getAllEntities().find(entity => entity.id === 'b')?.resources.current.hp, threshold < 0 ? 80 : 62, 'only negative sustain may cancel the first hit');
        console.log(`PASS: production STARTUP sustain ${threshold}`);
    } catch (error) {
        failures++;
        console.error(`FAIL: STARTUP sustain ${threshold}`, error);
    } finally {
        engine.removeAllListeners();
    }
}
{
    const engine = new CombatEngine('channel-zero-boundary');
    engine.setAutoProcess(false);
    const a = createDemoEntity('player-guide', 'channeler', { x: 2, y: 2, z: 0 });
    const b = createDemoEntity('monster-bruiser', 'drainer', { x: 3, y: 2, z: 0 });
    a.resources.current.focus = 8;
    const channel: ActionTemplate = {
        ...template('BOUNDARY_CHANNEL', 2, 'hp', 8),
        resourceCost: { focus: '1' }, sustainResources: ['focus'],
        channelOptions: { intervalTicks: 2, maxPulses: 3, pulseResourceCost: { focus: '1' } },
    };
    const drain = template('BOUNDARY_DRAIN', 3, 'focus', 6);
    Dictionary.registerActions([channel, drain]);
    engine.mountEntities([a, b]);
    try {
        engine.receiveCoordinatedIntents([
            { actorId: a.id, intentType: 'CAST_ACTION', clientTick: 0, payload: { actionTemplateId: channel.id, targetIds: [b.id] } },
            { actorId: b.id, intentType: 'CAST_ACTION', clientTick: 0, payload: { actionTemplateId: drain.id, targetIds: [a.id] } },
        ]);
        engine.processPending(1);
        assert.equal(engine.currentTick, 2);
        assert.equal(engine.getAllEntities().find(entity => entity.id === b.id)?.resources.current.hp, 72, 'the first committed pulse is retained');
        engine.processPending(1);
        assert.equal(engine.currentTick, 3);
        const interrupted = engine.getAllEntities().find(entity => entity.id === a.id);
        assert.equal(interrupted?.resources.current.focus, 0);
        assert.equal(interrupted?.currentActionContext?.phase, 'RECOVERY', 'channel focus zero stops remaining pulses and enters recovery');
        for (let count = 0; count < 20 && engine.hasPendingEvents(); count++) engine.processPending(1);
        assert.equal(engine.getAllEntities().find(entity => entity.id === b.id)?.resources.current.hp, 72, 'interruption never reverts the first pulse and never applies future pulses');
        console.log('PASS: production channel focus zero cancels only future pulses');
    } catch (error) {
        failures++;
        console.error('FAIL: channel focus zero', error);
    } finally {
        engine.removeAllListeners();
    }
}
assert.equal(failures, 0, 'all production sustain and channel boundaries must hold');
