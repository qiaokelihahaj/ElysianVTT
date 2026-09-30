import assert from 'node:assert/strict';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.js';
import { createDemoEntity } from '../packages/backend/src/demo/DemoContent.js';
import { validateGmCorrection } from '../packages/backend/src/demo/GmCorrectionValidation.js';

const entity = createDemoEntity('player-melee', 'correction-player');
const gm = { userId: 'gm', socketId: 'correction-socket', role: 'GM' as const };
const coordinator = new EncounterCoordinator({ entities: [entity, createDemoEntity('monster-bruiser', 'enemy')] });
let request = 0;
try {
    for (const changes of [
        { 'resources.current.hp': 20, '__proto__.polluted': 1 },
        { 'resources.current.hp': 20, 'resources.current.focus': NaN },
        { 'resources.current.hp': 20, 'currentActionContext.phase': 'IDLE' },
        { 'resources.current.hp': 20, 'resources.max.hp': -1 },
        { 'resources.current.hp': 20, 'resources.current.unknown': 1 },
        {},
    ]) {
        const result = coordinator.handleCommand(gm, {
            type: 'GM_CORRECT', requestId: `invalid-${++request}`,
            payload: { entityId: entity.id, reason: 'atomic validation regression', changes },
        });
        assert.equal(result.ok, false, 'an invalid correction must be rejected');
        assert.equal(result.snapshot.entities.find(value => value.id === entity.id)?.resources.current.hp, 100, 'earlier valid fields must not be partially applied');
    }
    assert.equal(validateGmCorrection(entity, []).ok, false);
    const applied = coordinator.handleCommand(gm, {
        type: 'GM_CORRECT', requestId: 'valid-correction', payload: {
            entityId: entity.id, reason: 'GM confirmed resource correction',
            changes: { 'resources.current.hp': 60, 'resources.current.poise': -1, 'transform.facing': 90 },
        },
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.snapshot.entities.find(value => value.id === entity.id)?.resources.current.hp, 60);
    assert.equal(applied.snapshot.entities.find(value => value.id === entity.id)?.resources.current.poise, -1);
    const audit = applied.snapshot.logs.find(log => log.message === 'GM 修正：GM confirmed resource correction');
    assert.ok(audit, 'GM can inspect the append-only correction through the regular snapshot');
    assert.deepEqual(audit.meta?.before, { 'resources.current.hp': 100, 'resources.current.poise': 20, 'transform.facing': 0 });
    assert.deepEqual(audit.meta?.after, { 'resources.current.hp': 60, 'resources.current.poise': -1, 'transform.facing': 90 });
    assert.equal(audit.meta?.gmUserId, gm.userId);
    const repeated = coordinator.handleCommand(gm, {
        type: 'GM_CORRECT', requestId: 'valid-correction', payload: {
            entityId: entity.id, reason: 'duplicate packet', changes: { 'resources.current.hp': 1 },
        },
    });
    assert.equal(repeated.snapshot.entities.find(value => value.id === entity.id)?.resources.current.hp, 60);
    console.log('demo-gm-correction: atomic validation, restricted fields, negative sustain and duplicate requests passed');
} finally {
    coordinator.close();
}
