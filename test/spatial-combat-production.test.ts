import assert from 'node:assert/strict';
import type { ActionTemplate, Entity, EncounterEntity } from '../packages/shared/src/index.js';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { InMemoryActionCatalog } from '../packages/backend/src/rules/ActionCatalog.js';
import { hexOffsetToAxial } from '../packages/shared/src/index.js';
import { EncounterCoordinator } from '../packages/backend/src/encounters/EncounterCoordinator.js';
import { createSpatialTacticsContent, createSpatialTacticsRoster, TACTIC_ACTION_IDS } from '../packages/backend/src/demo/SpatialTacticsContent.js';

function actor(id: string, x: number, y = 0, faction = 'PLAYERS'): EncounterEntity {
    return {
        id, templateId: id, type: 'ACTOR', faction, tags: [faction],
        transform: { coords: { x, y, z: 0 }, planeId: 'spatial', facing: 0 },
        physics: { scaleClass: 1, collisionRadius: 0.1, mass: 1, movementModes: ['WALK'] },
        resources: { current: { hp: 100, poise: 100 }, max: { hp: 100, poise: 100 } }, activeEffects: [],
    };
}

function action(id: string, extra: Partial<ActionTemplate> = {}): ActionTemplate {
    return { id, tags: [], timeCost: { startupTicks: 2, recoveryTicks: 2 },
        resourceCost: {}, range: { type: 'RANGED', distanceExpr: '10' }, effects: [], ...extra };
}

function setup(templates: ActionTemplate[], entities: Entity[]) {
    const engine = new CombatEngine('spatial-production', new InMemoryActionCatalog(templates));
    engine.setAutoProcess(false);
    engine.setPlayerControlledEntities([]);
    engine.mountEntities(entities);
    return engine;
}

const random = Math.random;
Math.random = () => 0.5;
try {
    // Rule-defined state changes commit at ACTIVE and retain recovery.
    {
        const rifle = action('rifle', { spatial: { weaponOperation: { type: 'EQUIP', weaponId: 'rifle' } } });
        const stance = action('stance', { spatial: { stance: 'ADS', rotationDelta: 90 } });
        const drop = action('drop', { spatial: { weaponOperation: { type: 'DROP' } } });
        const caster = actor('caster', 0);
        const engine = setup([rifle, stance, drop], [caster]);
        engine.receiveIntent({ actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0, payload: { actionTemplateId: rifle.id } });
        assert.equal(caster.equippedWeaponId, undefined);
        engine.processPending(1);
        assert.equal(caster.equippedWeaponId, 'rifle');
        assert.ok(caster.currentActionContext, 'ACTIVE keeps recovery scheduled');
        engine.processPending();
        engine.receiveIntent({ actorId: caster.id, intentType: 'CAST_ACTION', clientTick: engine.currentTick, payload: { actionTemplateId: stance.id } });
        engine.processPending();
        assert.equal(caster.currentStance, 'ADS');
        assert.equal(caster.transform.facing, 90);
        engine.receiveIntent({ actorId: caster.id, intentType: 'CAST_ACTION', clientTick: engine.currentTick, payload: { actionTemplateId: drop.id } });
        engine.processPending();
        assert.equal(caster.equippedWeaponId, undefined);
        assert.deepEqual(caster.droppedWeaponIds, ['rifle']);
    }
    // A same-Tick clash includes undeclared AOE targets and full formation context.
    {
        const blast = action('blast', { effects: [{ type: 'DAMAGE', targetSelector: 'ALL_IN_AOE', parameters: {
            resource: 'hp', amountExpr: '20', aoeShape: 'CIRCULAR', aoeRadius: 2,
        } }] });
        const idle = action('idle');
        const caster = actor('caster', 0);
        const bystander = actor('bystander', 5, 0, 'ENEMIES');
        const ally = actor('ally', 5, 1);
        const sentinel = actor('sentinel', 9);
        const engine = setup([blast, idle], [caster, bystander, ally, sentinel]);
        engine.receiveCoordinatedIntents([
            { actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0, payload: { actionTemplateId: blast.id, targetCoords: { x: 5, y: 0, z: 0 } } },
            { actorId: sentinel.id, intentType: 'CAST_ACTION', clientTick: 0, payload: { actionTemplateId: idle.id } },
        ]);
        engine.processPending();
        assert.equal(bystander.resources.current.hp, 80);
        assert.equal(ally.resources.current.hp, 80, 'AOE includes allies');
        assert.equal(caster.resources.current.hp, 100, 'cell origin is preserved');
    }
    // Guard reductions survive precision; ADS constrains the real hit table.
    {
        const precise = action('precision', { effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: {
            resource: 'hp', amountExpr: '20', route: 'PRECISION', critRange: 20,
            hitTable: [{ part: 'TORSO', weight: 100 }, { part: 'HEAD', weight: 1 }],
        } }] });
        const caster = actor('caster', 0);
        const victim = actor('victim', 4, 0, 'ENEMIES');
        victim.currentStance = 'ADS';
        victim.coverState = { coverDefId: 'barrier', coverType: 'HALF', coverDr: 2, coverThreshold: 1, height: 1, facing: 180 };
        victim.activeEffects.push({ instanceId: 'guard', templateId: 'guard', sourceEntityId: victim.id, remainingTicks: 10, stacks: 1, metadata: { damageMultiplier: 0.5 } });
        const engine = setup([precise], [caster, victim]);
        engine.receiveIntent({ actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0, payload: { actionTemplateId: precise.id, targetIds: [victim.id] } });
        engine.processPending();
        assert.equal(victim.resources.current.hp, 92, 'guard and cover reductions survive precision');
        assert.equal(victim.bodyParts?.HEAD.currentHp, (victim.bodyParts?.HEAD.maxHp ?? 0) - 10);
        assert.equal(victim.bodyParts?.TORSO.currentHp, victim.bodyParts?.TORSO.maxHp);
    }
    // Interception chooses friendly living guardians and cooperation helps.
    {
        const strike = action('strike', { effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '12' } }] });
        const caster = actor('caster', 0, 0, 'ENEMIES');
        const victim = actor('victim', 5);
        const guardian = actor('guardian', 4);
        const helper = actor('helper', 4, 1);
        for (const entity of [guardian, helper]) entity.formationContext = { interceptConfig: { interceptRange: 2, interceptionRating: 10, interceptDamageReduction: 0.5, failurePenaltyPoise: 10, failureKnockback: 1 } };
        const engine = setup([strike], [caster, victim, guardian, helper]);
        engine.receiveIntent({ actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0, payload: { actionTemplateId: strike.id, targetIds: [victim.id] } });
        engine.processPending();
        assert.equal(victim.resources.current.hp, 94);
        assert.equal(guardian.resources.current.poise, 100);
    }
    // A finite blockade triggers once on entering, then expires through the heap.
    {
        const zone = action('zone', { spatial: { blockZone: { radius: 1, durationTicks: 100, triggerDamage: 7 } } });
        const owner = actor('owner', 0);
        const mover = actor('mover', 2, 0, 'ENEMIES');
        const engine = setup([zone], [owner, mover]);
        engine.receiveIntent({ actorId: owner.id, intentType: 'CAST_ACTION', clientTick: 0, payload: { actionTemplateId: zone.id, targetCoords: { x: 4, y: 0, z: 0 } } });
        engine.processPending(2);
        assert.equal(owner.formationContext?.blockZones?.length, 1);
        engine.receiveIntent({ actorId: mover.id, intentType: 'MOVE', clientTick: engine.currentTick, payload: { targetCoords: { x: 5, y: 0, z: 0 } } });
        engine.processPending();
        assert.equal(mover.resources.current.hp, 93);
        assert.equal(owner.formationContext?.blockZones?.length, 0);
    }
    // Minimum reach and backstab produce actual damage changes.
    {
        const strike = action('reach', { spatial: { reach: { minReach: 2 }, backstabMultiplier: 1.5 }, effects: [
            { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '20' } },
        ] });
        const caster = actor('caster', 0);
        const near = actor('near', 1, 0, 'ENEMIES');
        const rear = actor('rear', 4, 0, 'ENEMIES');
        const engine = setup([strike], [caster, near, rear]);
        engine.receiveIntent({ actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0, payload: { actionTemplateId: strike.id, targetIds: [near.id, rear.id] } });
        engine.processPending();
        assert.equal(near.resources.current.hp, 100);
        assert.equal(rear.resources.current.hp, 70);
    }
    // Terrain costs and solid cells share the real movement timetable.
    {
        const move = action('terrain-move', { tags: ['MOVEMENT'], timeCost: { startupTicks: 4, recoveryTicks: 2 }, resourceCost: { focus: '2' } });
        const caster = actor('caster', 0);
        caster.resources.current.focus = 5;
        caster.resources.max.focus = 5;
        const engine = setup([move], [caster]);
        engine.setBattlefield({ id: 'terrain', name: 'terrain', width: 5, height: 2, spawnPoints: {}, tiles: [
            { hex: hexOffsetToAxial(1, 0), terrain: 'WATER', movementCost: 3 },
            { hex: hexOffsetToAxial(2, 0), terrain: 'WALL', height: 2 },
        ] });
        engine.receiveIntent({ actorId: caster.id, intentType: 'MOVE', clientTick: 0, payload: { actionTemplateId: move.id, targetCoords: { x: 4, y: 0, z: 0 } } });
        assert.equal(engine.getScheduledActions()[0].timeline.pulseTicks?.[0], 12);
        engine.processPending();
        assert.ok(caster.transform.coords.x < 2, 'movement cannot cross a solid tile');
        assert.equal(caster.resources.current.focus, 3, 'movement pays the declared template cost once');
    }
    // Cover is inferred from nearby props and released after leaving them.
    {
        const caster = actor('caster', 0);
        const prop: Entity = { ...actor('sandbag', 1), type: 'PROP', bodyBlocking: true,
            coverState: { coverDefId: 'sandbag', coverType: 'HALF', coverDr: 4, coverThreshold: 10, height: 1, facing: 0 } };
        const engine = setup([], [caster, prop]);
        assert.equal(caster.coverState?.coverDefId, prop.id);
        engine.receiveIntent({ actorId: caster.id, intentType: 'MOVE', clientTick: 0, payload: { targetCoords: { x: 0, y: 3, z: 0 } } });
        engine.processPending();
        assert.equal(caster.coverState, undefined, 'cover cannot travel with an actor');
    }
    // All declared AOE shapes resolve real entities through the engine.
    {
        for (const shape of ['CONICAL', 'LINEAR'] as const) {
            const sweep = action(shape, { effects: [{ type: 'DAMAGE', targetSelector: 'ALL_IN_AOE', parameters: {
                resource: 'hp', amountExpr: '18', aoeShape: shape, aoeRadius: 5, aoeAngle: 90, aoeWidth: 0.5,
            } }] });
            const caster = actor('caster', 0);
            const front = actor('front', 3, 0, 'ENEMIES');
            const outside = actor('outside', 0, 3, 'ENEMIES');
            const engine = setup([sweep], [caster, front, outside]);
            engine.receiveIntent({ actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0, payload: { actionTemplateId: sweep.id } });
            engine.processPending();
            assert.equal(front.resources.current.hp, 82);
            assert.equal(outside.resources.current.hp, 100);
        }
    }
    // Public admission and previews reject walls and live occupied destinations.
    {
        const coordinator = new EncounterCoordinator({ content: createSpatialTacticsContent(), entities: createSpatialTacticsRoster() });
        const gm = { userId: 'gm', socketId: 'gm-tab', role: 'GM' as const };
        let request = 0;
        try {
            coordinator.connect(gm);
            assert.ok(coordinator.handleCommand(gm, { requestId: `admission-${++request}`, type: 'START', payload: {} }).ok);
            const send = (entityId: string, actionTemplateId: string, targetCoords?: { x: number; y: number; z: number }) =>
                coordinator.handleCommand(gm, { requestId: `admission-${++request}`, type: 'ACTION', payload: { entityId, actionTemplateId, targetCoords } });
            assert.equal(send('tactics-vanguard', TACTIC_ACTION_IDS.SHOT).code, 'WEAPON_REQUIRED');
            assert.equal(send('tactics-vanguard', TACTIC_ACTION_IDS.MOVE, { x: 6, y: 1, z: 0 }).code, 'BLOCKED_POSITION');
            assert.equal(send('tactics-ranger', TACTIC_ACTION_IDS.MOVE, { x: 6, y: 2, z: 0 }).code, 'BLOCKED_POSITION');
            assert.equal(send('tactics-vanguard', TACTIC_ACTION_IDS.MOVE, { x: 2, y: 5, z: 0 }).code, 'BLOCKED_POSITION');
            const movePreview = coordinator.previewAction(gm, 'tactics-ranger', TACTIC_ACTION_IDS.MOVE);
            assert.equal(movePreview.cells.find(cell => cell.x === 6 && cell.y === 2)?.allowed, false);
            assert.equal(movePreview.cells.find(cell => cell.x === 2 && cell.y === 5)?.allowed, true, 'the mover is not its own blocker');
            const pillar = coordinator.engine.getAllEntities().find(entity => entity.type === 'PROP' && entity.transform.coords.x === 6 && entity.transform.coords.y === 2)!;
            pillar.resources.current.hp = 0;
            assert.equal(coordinator.previewAction(gm, 'tactics-ranger', TACTIC_ACTION_IDS.MOVE).cells.find(cell => cell.x === 6 && cell.y === 2)?.allowed, true, 'destroyed props release their destination');
            assert.equal(send('tactics-engineer', TACTIC_ACTION_IDS.LOB, { x: 3, y: 6, z: 0 }).code, 'OUT_OF_RANGE');
            assert.equal(coordinator.previewAction(gm, 'tactics-engineer', TACTIC_ACTION_IDS.LOB).cells.find(cell => cell.x === 3 && cell.y === 6)?.allowed, false);
            assert.equal(send('tactics-vanguard', TACTIC_ACTION_IDS.GUARD, { x: 4, y: 4, z: 0 }).code, 'INVALID_PAYLOAD');
        } finally { coordinator.close(); }
    }
    // A blocker entering a queued route is checked against current state.
    {
        const mover = actor('mover', 0);
        const engine = setup([], [mover]);
        engine.receiveIntent({ actorId: mover.id, intentType: 'MOVE', clientTick: 0, payload: { targetCoords: { x: 4, y: 0, z: 0 } } });
        const blocker = actor('blocker', 2, 0, 'ENEMIES');
        blocker.bodyBlocking = true;
        blocker.physics.collisionRadius = 0.5;
        engine.mountEntities([blocker]);
        engine.processPending();
        assert.ok(mover.transform.coords.x < 2, 'later blockers cannot be crossed by a previously queued path');
    }
    // A launch committed in the same priority group survives caster death.
    {
        const shot = action('simultaneous-shot', { launchProjectile: { trajectoryType: 'LINEAR', speed: 1, ticksPerStep: 1, dieThreshold: 1 },
            effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '20' } }] });
        const strike = action('simultaneous-strike', { effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '20' } }] });
        const caster = actor('caster', 0);
        caster.resources.current.hp = 10;
        const enemy = actor('enemy', 4, 0, 'ENEMIES');
        const engine = setup([shot, strike], [caster, enemy]);
        engine.receiveCoordinatedIntents([
            { actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0, payload: { actionTemplateId: shot.id, targetIds: [enemy.id] } },
            { actorId: enemy.id, intentType: 'CAST_ACTION', clientTick: 0, payload: { actionTemplateId: strike.id, targetIds: [caster.id] } },
        ]);
        engine.processPending();
        assert.equal(caster.resources.current.hp, 0);
        assert.equal(enemy.resources.current.hp, 80, 'committed projectile launch is irreversible');
    }
    console.log('spatial-combat-production: production engine/admission scenarios passed');
} finally {
    Math.random = random;
}
