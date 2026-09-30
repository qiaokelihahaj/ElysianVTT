import assert from 'node:assert/strict';
import type { ActionTemplate, EncounterCommand, EncounterPrincipal } from '@hard-vtt/shared';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.js';
import { createDemoContent, createDemoEntity } from '../packages/backend/src/demo/DemoContent.js';

const content = createDemoContent();
const makeAction = (id: string, targetKind: ActionTemplate['targetKind']): ActionTemplate => ({
    id, targetKind, tags: [], timeCost: { startupTicks: 2, recoveryTicks: 1 }, resourceCost: {},
    range: { type: 'RANGED', distanceExpr: '2' }, effects: [],
});
content.actionTemplates.push(makeAction('AUDIT_ENTITY', 'entity'), makeAction('AUDIT_CELL', 'cell'), makeAction('AUDIT_NONE', 'none'));
const coordinator = new EncounterCoordinator({ content, entities: [
    createDemoEntity('player-melee', 'a', { x: 0, y: 0, z: 0 }),
    createDemoEntity('monster-bruiser', 'b', { x: 1, y: 0, z: 0 }),
] });
const gm: EncounterPrincipal = { userId: 'gm', role: 'GM', socketId: 'gm-tab' };
let request = 0;
function submit(type: EncounterCommand['type'], payload: Record<string, unknown>) {
    return coordinator.handleCommand(gm, { requestId: `audit-${++request}`, type, payload } as EncounterCommand);
}
try {
    coordinator.connect(gm);
    assert.equal(submit('START', {}).ok, true);
    const declared = submit('ACTION', { entityId: 'a', actionTemplateId: 'AUDIT_ENTITY', targetIds: ['b'] });
    assert.equal(declared.ok, true);
    const actionId = declared.snapshot.plan.actions[0].actionId;
    assert.equal(submit('GM_EDIT_ACTION', { actionId, actionTemplateId: 'AUDIT_CELL', targetIds: [] }).ok, false,
        'editing to a cell action requires a destination');
    assert.equal(submit('GM_EDIT_ACTION', { actionId, actionTemplateId: 'AUDIT_CELL', targetIds: [], targetCoords: { x: 8, y: 0, z: 0 } }).ok, false,
        'edited cell actions obey the same range rules as declaration');
    assert.equal(submit('GM_EDIT_ACTION', { actionId, targetIds: [] }).ok, false,
        'editing an entity action cannot remove its required target');
    const edited = submit('GM_EDIT_ACTION', { actionId, actionTemplateId: 'AUDIT_NONE', targetIds: [] });
    assert.equal(edited.ok, true, 'explicit empty targets support switching to an untargeted action');
    assert.deepEqual(edited.snapshot.plan.actions[0].targetIds, []);
    console.log('audit network plans: declaration and GM edit use consistent target validation');
} finally { coordinator.close(); }
