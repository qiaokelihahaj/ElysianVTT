import assert from 'node:assert/strict';
import type { ActionTemplate, AttackTag, Entity, SpatialActionConfig } from '../packages/shared/src/index.js';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { InMemoryActionCatalog } from '../packages/backend/src/rules/ActionCatalog.js';

function actor(id: string, x: number): Entity {
    return { id, templateId: id, type: 'ACTOR',
        transform: { coords: { x, y: 0, z: 0 }, planeId: 'micro-evasion', facing: 0 },
        physics: { scaleClass: 1, collisionRadius: 0.1, mass: 1, movementModes: ['WALK'] },
        resources: { current: { hp: 100, focus: 5 }, max: { hp: 100, focus: 5 } }, activeEffects: [] };
}

function fight(evade: NonNullable<SpatialActionConfig['evade']>, tag: AttackTag | undefined,
    area = false, impactTick = 2): number {
    const defense: ActionTemplate = { id: `DYNAMIC_${evade}`, tags: ['DEFENSE'], spatial: { evade }, targetKind: 'none',
        timeCost: { startupTicks: 1, recoveryTicks: 2 }, activeWindowTicks: 3,
        resourceCost: { focus: '1' }, range: { type: 'SELF', distanceExpr: '0' }, effects: [] };
    const attack: ActionTemplate = { id: 'TAGGED_ATTACK', tags: ['ATTACK'], attackTags: tag ? [tag] : undefined,
        timeCost: { startupTicks: impactTick, recoveryTicks: 1 }, resourceCost: {},
        range: { type: 'RANGED', distanceExpr: '5' }, effects: [{ type: 'DAMAGE',
            targetSelector: area ? 'ALL_IN_AOE' : 'PRIMARY', parameters: {
                resource: 'hp', amountExpr: '20', ...(area ? { aoeShape: 'CONICAL', aoeRadius: 5, aoeAngle: 90 } : {}),
            } }] };
    const attacker = actor('attacker', 0);
    const defender = actor('defender', 2);
    const engine = new CombatEngine('dynamic-micro-evasion', new InMemoryActionCatalog([defense, attack]));
    engine.setAutoProcess(false);
    engine.setPlayerControlledEntities([]);
    engine.mountEntities([attacker, defender]);
    try {
        engine.receiveCoordinatedIntents([
            { actorId: defender.id, intentType: 'CAST_ACTION', clientTick: 0, payload: { actionTemplateId: defense.id } },
            { actorId: attacker.id, intentType: 'CAST_ACTION', clientTick: 0,
                payload: { actionTemplateId: attack.id, targetIds: area ? [] : [defender.id] } },
        ]);
        engine.processPending(1);
        assert.equal(engine.currentTick, 1);
        assert.equal(defender.currentActionContext?.phase, 'ACTIVE');
        assert.equal(defender.resources.current.focus, 4, 'the configured defense pays once');
        engine.processPending();
        assert.equal(defender.currentActionContext, undefined, 'micro-evasion retains and completes recovery');
        return defender.resources.current.hp;
    } finally { engine.reset(); engine.removeAllListeners(); }
}

const match = { DUCK: 'HIGH', HOP: 'LOW', SLIP: 'LINEAR' } as const;
for (const evade of ['DUCK', 'HOP', 'SLIP'] as const) {
    assert.equal(fight(evade, match[evade]), 100, `${evade} evades its matching tag inside ACTIVE`);
    assert.equal(fight(evade, match[evade] === 'HIGH' ? 'LOW' : 'HIGH'), 80, `${evade} cannot evade the wrong tag`);
}
assert.equal(fight('HOP', 'LOW', true), 100, 'tagged LOW cone can be hopped inside ACTIVE');
assert.equal(fight('HOP', undefined, true), 80, 'untagged AOE ignores micro-evasion');
assert.equal(fight('DUCK', 'HIGH', false, 4), 80, 'the exclusive ACTIVE end boundary grants no evasion');
console.log('spatial-micro-evasion-production: 9 dynamic defense tag/window scenarios passed');
