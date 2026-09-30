import assert from 'node:assert/strict';
import type { EncounterCommand, EncounterEntity, EncounterPrincipal, EncounterSide, EncounterSideRelation, EncounterSnapshot, EncounterVictoryCondition } from '../packages/shared/src/index.js';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.js';
import { createDemoContent, createDemoEntity } from '../packages/backend/src/demo/DemoContent.js';

const gm = { userId: 'factions-gm', role: 'GM' as const, socketId: 'factions-gm-tab' };
const player = { userId: 'factions-player', role: 'PL' as const, socketId: 'factions-player-tab' };
let sequence = 0;
const faction = (id: string): EncounterSide => ({ kind: 'FACTION', id });
const independent = (id: string): EncounterSide => ({ kind: 'ENTITY', id });
function actor(id: string, allegiance: string | null): EncounterEntity {
    const entity = createDemoEntity('player-ranged', id, { x: 2, y: 2, z: 0 });
    entity.faction = allegiance;
    return entity;
}
function command(coordinator: EncounterCoordinator, type: EncounterCommand['type'], payload: Record<string, unknown>, principal: EncounterPrincipal = gm) {
    return coordinator.handleCommand({ type, payload, requestId: `factions-${++sequence}` } as EncounterCommand, principal);
}
function send(coordinator: EncounterCoordinator, type: EncounterCommand['type'], payload: Record<string, unknown>): EncounterSnapshot {
    const result = command(coordinator, type, payload);
    assert.equal(result.ok, true, `${type}: ${result.reason ?? result.message}`);
    return result.snapshot;
}
function kill(coordinator: EncounterCoordinator, entityId: string): EncounterSnapshot {
    return send(coordinator, 'GM_CORRECT', { entityId, reason: 'faction outcome regression', changes: { 'resources.current.hp': 0 } });
}
function fixture(entities: EncounterEntity[]): EncounterCoordinator {
    const coordinator = new EncounterCoordinator({ entities });
    coordinator.connect(gm);
    return coordinator;
}

const three = fixture([actor('a', '红方'), actor('b', '蓝方'), actor('c', '绿方')]);
try {
    send(three, 'START', {});
    assert.equal(kill(three, 'b').result, undefined, 'one defeated side cannot end a three-sided encounter');
    const ended = kill(three, 'c');
    assert.equal(ended.result?.status, 'ENDED');
    assert.deepEqual(ended.result?.winningSides, [faction('红方')]);
} finally { three.close(); }

const freeForAll = fixture([actor('a', null), actor('b', null), actor('c', null)]);
try {
    const opening = send(freeForAll, 'START', {});
    assert.ok(opening.entities.every(entity => entity.faction === null), 'explicit null overrides legacy PLAYER tags');
    assert.ok(opening.plan.slots.every(slot => slot.faction === null));
    assert.equal(kill(freeForAll, 'b').result, undefined, 'unaffiliated actors are separate sides');
    const ended = kill(freeForAll, 'c');
    assert.deepEqual(ended.result?.winningSides, [independent('a')]);
    assert.equal(ended.result?.winningFaction, undefined);
} finally { freeForAll.close(); }

const allied = fixture([actor('a', '甲'), actor('b', '乙'), actor('c', '丙')]);
try {
    send(allied, 'GM_SET_RELATION', { a: faction('甲'), b: faction('乙'), relation: 'ALLY' });
    send(allied, 'START', {});
    assert.equal(send(allied, 'GM_SET_RELATION', { a: faction('甲'), b: faction('丙'), relation: 'NEUTRAL' }).result, undefined);
    const ended = kill(allied, 'c');
    assert.deepEqual(ended.result?.winningSides, [faction('甲'), faction('乙')]);
    assert.equal(ended.result?.status, 'ENDED');
} finally { allied.close(); }

const manual = fixture([actor('a', '甲'), actor('b', '乙')]);
try {
    send(manual, 'GM_SET_VICTORY_CONDITION', { condition: 'MANUAL' });
    send(manual, 'START', {});
    assert.equal(kill(manual, 'b').result, undefined, 'manual encounters do not infer victory');
    assert.equal(send(manual, 'GM_END', {}).result?.status, 'ENDED');
} finally { manual.close(); }

const removed = fixture([actor('a', '甲'), actor('b', '乙')]);
try {
    send(removed, 'START', {});
    assert.deepEqual(send(removed, 'GM_REMOVE', { entityId: 'b' }).result?.winningSides, [faction('甲')]);
} finally { removed.close(); }

const single = fixture([actor('a', '甲'), actor('b', '甲')]);
try {
    send(single, 'START', {});
    assert.equal(kill(single, 'b').result, undefined, 'one participating side does not auto-end');
} finally { single.close(); }

const singleActor = fixture([actor('a', '甲')]);
try {
    send(singleActor, 'START', {});
    assert.equal(send(singleActor, 'GM_SET_FACTION', { entityId: 'a', faction: '乙' }).result, undefined, 'one actor changing allegiance never creates a second participating side');
    assert.equal(send(singleActor, 'GM_SET_FACTION', { entityId: 'a', faction: null }).result, undefined);
} finally { singleActor.close(); }

const peaceful = fixture([actor('a', '甲'), actor('b', '乙')]);
try {
    send(peaceful, 'GM_SET_RELATION', { a: faction('甲'), b: faction('乙'), relation: 'ALLY' });
    send(peaceful, 'START', {});
    assert.equal(kill(peaceful, 'b').result, undefined, 'an entirely allied opening is not a contested encounter');
} finally { peaceful.close(); }

const neutral = fixture([actor('a', '甲'), actor('b', '乙'), actor('c', '丙')]);
try {
    send(neutral, 'GM_SET_RELATION', { a: faction('甲'), b: faction('乙'), relation: 'NEUTRAL' });
    send(neutral, 'START', {});
    assert.equal(kill(neutral, 'c').result, undefined, 'surviving neutral sides do not share victory');
} finally { neutral.close(); }

const spawned = fixture([actor('a', '甲')]);
try {
    send(spawned, 'START', {});
    send(spawned, 'GM_SPAWN', { templateId: 'monster-bruiser', entityId: 'later-opponent', faction: '乙' });
    assert.deepEqual(send(spawned, 'GM_REMOVE', { entityId: 'later-opponent' }).result?.winningSides, [faction('甲')], 'removed post-start opponents still count as participating sides');
} finally { spawned.close(); }

const validation = fixture([actor('a', '甲'), actor('b', '乙')]);
try {
    for (const [type, payload] of [
        ['GM_SET_FACTION', { entityId: 'a', faction: '丙' }],
        ['GM_SET_RELATION', { a: faction('甲'), b: faction('乙'), relation: 'ALLY' }],
        ['GM_SET_VICTORY_CONDITION', { condition: 'MANUAL' }],
    ] as const) assert.equal(command(validation, type, payload, player).code, 'FORBIDDEN');
    for (const value of ['', ' ', ' padded ', 'x'.repeat(65), '__proto__', 5, {}, undefined]) {
        assert.equal(command(validation, 'GM_SET_FACTION', { entityId: 'a', faction: value }).code, 'INVALID_PAYLOAD');
        assert.equal(command(validation, 'GM_SPAWN', { templateId: 'monster-bruiser', faction: value }).code, 'INVALID_PAYLOAD');
    }
    for (const payload of [
        { a: faction('甲'), b: faction('missing'), relation: 'ALLY' },
        { a: faction('甲'), b: faction('甲'), relation: 'HOSTILE' },
        { a: faction('甲'), b: faction('乙'), relation: 'UNKNOWN' },
        { a: { kind: 'INVALID', id: '甲' }, b: faction('乙'), relation: 'ALLY' },
    ]) assert.equal(command(validation, 'GM_SET_RELATION', payload).ok, false);
    assert.equal(command(validation, 'GM_SET_VICTORY_CONDITION', { condition: 'AUTOWIN' }).code, 'INVALID_PAYLOAD');
    for (const payload of [null, [], 5]) {
        assert.equal(validation.handleCommand({ type: 'GM_SET_RELATION', requestId: `invalid-payload-${++sequence}`, payload } as unknown as EncounterCommand, gm).code, 'INVALID_PAYLOAD');
    }
    for (const payload of [
        { winningFaction: 'invented' },
        { winningFaction: 'NEUTRAL' },
        { winningSides: [independent('missing')] },
        { winningSides: [faction('甲'), faction('甲')] },
        { winningFaction: '甲', winningSides: [faction('甲')] },
    ]) assert.equal(command(validation, 'GM_END', payload).ok, false);
    const request: EncounterCommand = { type: 'GM_SET_RELATION', requestId: 'factions-repeat', payload: { a: faction('甲'), b: faction('乙'), relation: 'ALLY' } };
    const accepted = validation.handleCommand(request, gm);
    assert.equal(accepted.ok, true);
    assert.deepEqual(validation.handleCommand(request, gm), accepted, 'retries return the cached result without a second mutation');
    assert.equal(validation.handleCommand({ ...request, payload: { ...request.payload, relation: 'NEUTRAL' } }, gm).code, 'REQUEST_ID_REUSE');
    assert.equal(validation.getSnapshot().relations?.length, 1);
    send(validation, 'GM_SET_RELATION', { a: faction('乙'), b: faction('甲'), relation: null });
    assert.deepEqual(validation.getSnapshot().relations, [], 'reverse pair removes the symmetric override');
    assert.equal(send(validation, 'GM_SPAWN', { templateId: 'monster-bruiser', entityId: 'spawn-independent', faction: null }).entities.find(entity => entity.id === 'spawn-independent')?.faction, null);
} finally { validation.close(); }

const restart = fixture([actor('a', '甲'), actor('b', '乙')]);
try {
    restart.connect(player);
    send(restart, 'GM_ASSIGN_ENTITY', { entityId: 'a', userId: player.userId });
    send(restart, 'GM_SET_FACTION', { entityId: 'a', faction: '开局自定义阵营' });
    send(restart, 'GM_SET_RELATION', { a: faction('开局自定义阵营'), b: faction('乙'), relation: 'NEUTRAL' });
    send(restart, 'GM_SET_VICTORY_CONDITION', { condition: 'MANUAL' });
    const opening = send(restart, 'START', {});
    const control = opening.controls.find(item => item.entityId === 'a');
    send(restart, 'GM_SET_FACTION', { entityId: 'a', faction: null });
    assert.deepEqual(restart.getSnapshot().controls.find(item => item.entityId === 'a'), control, 'allegiance never changes ownership');
    send(restart, 'GM_SET_RELATION', { a: independent('a'), b: faction('乙'), relation: 'HOSTILE' });
    send(restart, 'GM_SET_VICTORY_CONDITION', { condition: 'LAST_SIDE' });
    send(restart, 'GM_END', { winningSides: [independent('a')] });
    const restored = send(restart, 'GM_RESTART', {});
    assert.equal(restored.entities.find(entity => entity.id === 'a')?.faction, '开局自定义阵营');
    assert.deepEqual(restored.relations, opening.relations);
    assert.equal(restored.victoryCondition, 'MANUAL');
    assert.equal(restored.controls.find(item => item.entityId === 'a')?.userId, player.userId);
    assert.equal(restored.controls.find(item => item.entityId === 'a')?.controlEpoch, (control?.controlEpoch ?? 0) + 1);
    const hydrated = new EncounterCoordinator({ initialSnapshot: restored });
    try {
        assert.deepEqual(hydrated.getSnapshot().relations, restored.relations);
        assert.equal(hydrated.getSnapshot().victoryCondition, restored.victoryCondition);
    } finally { hydrated.close(); }
} finally { restart.close(); }

const content = createDemoContent();
content.relations = [{ a: faction('甲'), b: faction('乙'), relation: 'ALLY' }];
content.victoryCondition = 'MANUAL';
const configured = new EncounterCoordinator({ content, entities: [actor('a', '甲'), actor('b', '乙')], relations: [], victoryCondition: 'LAST_SIDE' });
try {
    assert.deepEqual(configured.getSnapshot().relations, [], 'an explicit empty override does not restore content defaults');
    assert.equal(configured.getSnapshot().victoryCondition, 'LAST_SIDE');
} finally { configured.close(); }
for (const relations of [null, {}, [{ a: faction('甲'), b: faction('乙'), relation: 'INVALID' }]]) {
    assert.throws(() => new EncounterCoordinator({ initialSnapshot: { entities: [actor('a', '甲')], relations: relations as EncounterSideRelation[] } }), /Invalid encounter side relation/);
}
assert.throws(() => new EncounterCoordinator({ initialSnapshot: { victoryCondition: 'BAD' as EncounterVictoryCondition } }), /Invalid encounter victory condition/);

console.log('PASS: arbitrary factions, independent actors, alliances, manual victory, authorization, idempotency and restart');
