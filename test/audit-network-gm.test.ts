import assert from 'node:assert/strict';
import type { EncounterCommand, EncounterEntity } from '@hard-vtt/shared';
import { GmCommandService, type GmCommandServicePort } from '../packages/backend/src/encounters/GmCommandService.js';

const entity: EncounterEntity = { id: 'actor', templateId: 'actor', type: 'ACTOR', activeEffects: [],
    transform: { coords: { x: 0, y: 0, z: 0 }, planeId: 'audit', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.5, mass: 1, movementModes: [] },
    resources: { current: { hp: 10 }, max: { hp: 10 } } };
let terminalChecks = 0;
let positionChecks = 0;
let pumps = 0;
const port = {
    getEntity: () => entity, engine: { notifyPositionChanged: () => { positionChecks++; } },
    bumpState: () => {}, currentTick: () => 0, addLog: () => {},
    refreshTerminalState: () => { terminalChecks++; }, isActiveAndRunning: () => true,
    schedulePump: () => { pumps++; },
} as unknown as GmCommandServicePort;
const service = new GmCommandService(port);
const principal = { userId: 'gm', socketId: 'gm-tab', role: 'GM' as const };
const command = { requestId: 'audit-gm', type: 'GM_ADJUST_ENTITY', payload: {} } as EncounterCommand;
assert.equal(service.adjustEntity(principal, command, { entityId: 'actor', reason: 'correct hp', resources: { hp: 0 } }).ok, true);
assert.equal(terminalChecks, 1, 'GM HP adjustments refresh settlement just like corrections');
assert.equal(pumps, 1, 'GM resource edits wake blocked in-memory work');
assert.equal(service.correct(principal, command, { entityId: 'actor', reason: 'correct position', changes: { 'transform.coords.x': 2 } }).ok, true);
assert.equal(positionChecks, 1, 'GM coordinate corrections notify spatial active windows');
assert.equal(pumps, 2);
assert.equal(service.adjustEntity({ ...principal, role: 'PL' }, command, { entityId: 'actor', reason: 'reject', resources: { hp: 10 } }).ok, false);
assert.equal(entity.resources.current.hp, 0);
console.log('audit network GM: HP edits refresh outcomes and coordinate corrections refresh spatial state');
