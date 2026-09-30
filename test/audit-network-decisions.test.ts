import assert from 'node:assert/strict';
import type { DecisionPollPayload, EncounterActionPlan, EncounterCommand, EncounterEntity } from '@hard-vtt/shared';
import { DecisionWindowService, type DecisionWindowServicePort } from '../packages/backend/src/encounters/DecisionWindowService.js';

const actor: EncounterEntity = {
    id: 'reactor', templateId: 'actor', type: 'ACTOR',
    transform: { coords: { x: 0, y: 0, z: 0 }, planeId: 'audit', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.5, mass: 1, movementModes: ['WALK'] },
    resources: { current: { focus: 10 }, max: { focus: 10 } }, activeEffects: [],
};
const port = {
    content: {}, engine: { handleDecisionEngage: () => {}, handleDecisionResponse: () => {},
        invalidateCoordinatedDecisionWindows: () => {}, expireDecisionWindow: () => true, releaseSocketDecisionEngagement: () => 1 },
    reactionJoinMs: 1000, reactionSelectMs: 1000, now: () => 0,
    getEntity: () => actor, getControl: () => ({ controlEpoch: 0 }), getSlot: () => undefined,
    canControl: () => true, getAction: () => ({ id: 'REACT', tags: ['REACTION'], resourceCost: { focus: '5' } }),
    getRevision: () => 0, historyValues: () => [], bumpDecisionRevision: () => {},
    addLog: () => {}, emitDecision: () => {}, armDeadlineTimer: () => {}, processAfterDecision: () => {},
} as unknown as DecisionWindowServicePort;
const service = new DecisionWindowService(port);
function open(windowId: string, causationId: string): void {
    service.open({ windowId, actorId: 'reactor', windowType: 'REACTION', countdownMs: 1000, tick: 0,
        causationId, availableOptions: [{ id: 'REACT', label: 'react', resourceCost: { focus: 5 }, canAfford: true }] } as DecisionPollPayload);
}
function choose(windowId: string): ReturnType<DecisionWindowService['select']> {
    const principal = { userId: 'player', role: 'PL' as const, socketId: 'tab-a' };
    const command = { type: 'REACTION_SELECT', requestId: windowId, payload: {} } as EncounterCommand;
    assert.equal(service.join(principal, command, { windowId }).ok, true);
    return service.select(principal, command, { windowId, optionId: 'REACT' }, false);
}
open('selected', 'cancelled-chain');
open('still-open', 'other-chain');
assert.equal(choose('selected').ok, true);
service.invalidate({ actionId: 'cancelled-action', causationId: 'cancelled-chain' } as EncounterActionPlan);
assert.equal(service.hasPendingSelections(), false, 'cancelling a source clears already-collected reactions');
open('new-selection', 'new-chain');
assert.equal(choose('new-selection').ok, true, 'cancelled reaction releases its slot and resource reservation');
service.clear();
open('ownership', 'ownership-chain');
const joinCommand = { type: 'REACTION_JOIN', requestId: 'join', payload: {} } as EncounterCommand;
assert.equal(service.join({ userId: 'player', role: 'PL', socketId: 'tab-a' }, joinCommand, { windowId: 'ownership' }).ok, true);
const foreign = service.select({ userId: 'player', role: 'PL', socketId: 'tab-b' }, joinCommand,
    { windowId: 'ownership', optionId: 'REACT' }, false);
assert.equal(foreign.ok, false, 'another tab cannot answer an engaged window');
assert.equal(service.size, 1);
const release = Reflect.get(service, 'releaseSocketDecisionEngagement');
assert.equal(typeof release, 'function');
assert.equal(Reflect.apply(release, service, ['tab-b']), 0, 'other socket disconnect keeps owner window');
const deadline = service.get('ownership')!.selectDeadlineAt;
assert.equal(Reflect.apply(release, service, ['tab-a']), 1, 'owner disconnect releases only the socket engagement');
assert.equal(Reflect.apply(release, service, ['tab-a']), 0, 'repeated disconnect is harmless');
assert.equal(service.size, 1);
assert.equal(service.get('ownership')!.selectDeadlineAt, deadline, 'reconnect keeps the original selection deadline');
assert.equal(service.select({ userId: 'player', role: 'PL', socketId: 'tab-b' }, joinCommand,
    { windowId: 'ownership', optionId: 'REACT' }, false).ok, true, 'authorized reconnect can finish the outstanding choice');
assert.equal(service.size, 0);
service.clear();
console.log('audit network decisions: invalidated selected reactions release reservations');
