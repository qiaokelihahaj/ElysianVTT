import assert from 'node:assert/strict';
import type { ActionTemplate, ActionTimeline, ClientIntent, Entity, ExploreEntity, MapData, MovementResult, StateMutationPayload } from '../packages/shared/src/index.js';
import { PriorityQueue } from '../packages/backend/src/core/engine/PriorityQueue.js';
import { TickLoop } from '../packages/backend/src/core/engine/TickLoop.js';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { ExploreEngine } from '../packages/backend/src/campaigns/engines/ExploreEngine.js';
import { HookRegistry } from '../packages/backend/src/campaigns/engines/HookRegistry.js';
import { Scene, SceneState } from '../packages/backend/src/campaigns/Scene.js';
import { FogOfWar } from '../packages/backend/src/core/systems/FogOfWar.js';
import { RuleEvaluator } from '../packages/backend/src/core/systems/RuleEvaluator.js';
import { EffectSystem } from '../packages/backend/src/core/systems/EffectSystem.js';
import { SpatialSystem } from '../packages/backend/src/core/systems/SpatialSystem.js';
import { Projectile } from '../packages/backend/src/core/entities/Projectile.js';
import { InMemoryActionCatalog } from '../packages/backend/src/rules/ActionCatalog.js';
import { VectorMath } from '../packages/backend/src/utils/VectorMath.js';
import { MapLoader } from '../packages/backend/src/core/systems/MapLoader.js';
import { ZoneTriggerSystem } from '../packages/backend/src/core/systems/ZoneTrigger.js';

function entity(id = 'actor'): Entity {
    return {
        id, templateId: 'audit-unit', type: 'ACTOR',
        transform: { coords: { x: 0, y: 0, z: 0 }, planeId: 'audit', facing: 0 },
        physics: { scaleClass: 1, collisionRadius: 0.5, mass: 1, movementModes: [] },
        resources: { current: { hp: 100, focus: 30 }, max: { hp: 100, focus: 30 } }, activeEffects: [],
    };
}

function template(id: string): ActionTemplate {
    return { id, tags: [], timeCost: { startupTicks: 0, recoveryTicks: 3 },
        resourceCost: {}, range: { type: 'SELF', distanceExpr: '0' }, effects: [] };
}

function intent(actorId: string, intentType: ClientIntent['intentType'], payload: ClientIntent['payload'] = {}): ClientIntent {
    return { actorId, intentType, clientTick: 0, payload };
}

let failures = 0;
async function check(label: string, run: () => void | Promise<void>): Promise<void> {
    try { await run(); console.log(`PASS ${label}`); }
    catch (error) { failures++; console.error(`FAIL ${label}`, error); }
}

async function main(): Promise<void> {
    await check('late events are consumed without rewinding or empty infinite steps', () => {
        const queue = new PriorityQueue();
        const loop = new TickLoop(queue);
        queue.push({ eventId: 'first', targetTick: 10, status: 'PENDING' });
        loop.step();
        queue.push({ eventId: 'late', targetTick: 4, status: 'PENDING' });
        const step = loop.step();
        assert.equal(step?.tick, 10);
        assert.deepEqual(step?.events.map(event => event.eventId), ['late']);
        assert.equal(queue.size, 0);
    });

    await check('queue snapshots preserve tombstones but cannot empty the live heap', () => {
        const queue = new PriorityQueue();
        queue.push({ eventId: 'event', targetTick: 1, status: 'PENDING' });
        const snapshot = queue.getAllEvents();
        snapshot[0].status = 'CANCELLED';
        assert.equal(queue.peek()?.status, 'CANCELLED');
        assert.equal(Reflect.set(snapshot, 'length', 0), true);
        assert.equal(queue.size, 1);
    });

    for (const type of ['DODGE', 'MICRO_EVADE'] as const) {
        await check(`${type} reaches its recovery boundary and releases the actor`, () => {
            const actor = entity();
            const engine = new CombatEngine(`audit-${type}`, new InMemoryActionCatalog([template('DODGE')]));
            engine.mountEntities([actor]);
            engine.receiveIntent(intent(actor.id, type, type === 'DODGE'
                ? { targetCoords: { x: 1, y: 0, z: 0 } } : { evadeSubType: 'DUCK' }));
            assert.equal(actor.currentActionContext, undefined);
            assert.equal(engine.hasPendingEvents(), false);
            assert.ok(engine.currentTick > 0);
        });
    }

    await check('stance changes execute without a rule template and drain eagerly', () => {
        const actor = entity();
        const engine = new CombatEngine('audit-stance', new InMemoryActionCatalog());
        engine.mountEntities([actor]);
        engine.receiveIntent(intent(actor.id, 'CHANGE_STANCE', { stance: 'ADS' }));
        assert.equal(actor.currentStance, 'ADS');
        assert.equal(actor.currentActionContext, undefined);
        assert.equal(engine.hasPendingEvents(), false);
    });

    await check('cancelling startup enters recovery and prevents the pending hit', () => {
        const actor = entity();
        const target = entity('target');
        const attack = template('cancel-test');
        attack.timeCost = { startupTicks: 5, recoveryTicks: 3 };
        attack.range = { type: 'MELEE', distanceExpr: '2' };
        attack.effects = [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { amountExpr: '10', resource: 'hp' } }];
        const engine = new CombatEngine('audit-cancel', new InMemoryActionCatalog([attack]));
        engine.setAutoProcess(false);
        engine.setPlayerControlledEntities([]);
        engine.mountEntities([actor, target]);
        engine.receiveIntent(intent(actor.id, 'CAST_ACTION', { actionTemplateId: attack.id, targetIds: [target.id] }));
        engine.receiveIntent(intent(actor.id, 'CANCEL_ACTION'));
        assert.equal(actor.currentActionContext?.phase, 'RECOVERY');
        engine.processPending();
        assert.equal(target.resources.current.hp, 100);
        assert.equal(actor.currentActionContext, undefined);
    });

    await check('combat rotation waits its turning ticks and cannot replace a busy action', () => {
        const actor = entity();
        const engine = new CombatEngine('audit-turn', new InMemoryActionCatalog());
        engine.setAutoProcess(false);
        engine.mountEntities([actor]);
        engine.receiveIntent(intent(actor.id, 'ROTATE', { rotationDelta: 120 }));
        assert.equal(actor.transform.facing, 0);
        assert.equal(actor.currentActionContext?.resolveTick, 3);
        const actionId = actor.currentActionContext?.actionId;
        engine.receiveIntent(intent(actor.id, 'ROTATE', { rotationDelta: -60 }));
        assert.equal(actor.currentActionContext?.actionId, actionId);
        engine.processPending();
        assert.equal(actor.transform.facing, 120);
        assert.equal(engine.currentTick, 3);
        assert.equal(actor.currentActionContext, undefined);
        engine.setAutoProcess(true);
        engine.receiveIntent(intent(actor.id, 'ROTATE', { rotationDelta: -240 }));
        assert.equal(actor.transform.facing, 240);
        assert.equal(engine.currentTick, 6, 'equivalent rotation uses the shortest angle');
    });

    await check('a built-in turn settles alongside an ordinary action at the same tick', () => {
        const actor = entity();
        const other = entity('other');
        const action = template('other-action');
        action.timeCost.startupTicks = 2;
        const engine = new CombatEngine('audit-turn-clash', new InMemoryActionCatalog([action]));
        engine.setAutoProcess(false);
        engine.setPlayerControlledEntities([]);
        engine.mountEntities([actor, other]);
        engine.receiveIntent(intent(actor.id, 'ROTATE', { rotationDelta: 90 }));
        engine.receiveIntent(intent(other.id, 'CAST_ACTION', { actionTemplateId: action.id }));
        engine.processPending();
        assert.equal(actor.transform.facing, 90);
        assert.equal(actor.currentActionContext, undefined);
        assert.equal(other.currentActionContext, undefined);
    });

    await check('ACTIVE cannot be undone by a cancellation intent', () => {
        const actor = entity();
        const action = template('active-cancel');
        action.activeWindowTicks = 3;
        const engine = new CombatEngine('audit-active-cancel', new InMemoryActionCatalog([action]));
        engine.setAutoProcess(false);
        engine.mountEntities([actor]);
        engine.receiveIntent(intent(actor.id, 'CAST_ACTION', { actionTemplateId: action.id }));
        engine.processPending(1);
        assert.equal(actor.currentActionContext?.phase, 'ACTIVE');
        const actionId = actor.currentActionContext?.actionId;
        engine.receiveIntent(intent(actor.id, 'CANCEL_ACTION'));
        assert.equal(actor.currentActionContext?.phase, 'ACTIVE');
        assert.equal(actor.currentActionContext?.actionId, actionId);
        engine.processPending();
        assert.equal(actor.currentActionContext, undefined);
    });

    await check('unmounting clears actor actions, timelines, and hooks before remount', () => {
        const actor = entity();
        const action = template('transfer-action');
        action.timeCost.startupTicks = 5;
        const engine = new CombatEngine('audit-unmount', new InMemoryActionCatalog([action]));
        engine.setAutoProcess(false);
        engine.mountEntities([actor]);
        engine.receiveIntent(intent(actor.id, 'HOOK_PRESET', { hookPreset: {
            id: 'scene-local', entityId: actor.id, label: 'scene local', enabled: true,
            trigger: { type: 'TICK_REACHED', targetTick: 10 },
        } }));
        engine.receiveIntent(intent(actor.id, 'CAST_ACTION', { actionTemplateId: action.id }));
        assert.equal(engine.getScheduledActions().length, 1);
        const [removed] = engine.unmountEntities([actor.id]);
        assert.equal(removed.currentActionContext, undefined);
        assert.equal(engine.getScheduledActions().length, 0);
        assert.equal(engine.hasPendingActionEvents(), false);
        engine.mountEntities([removed]);
        engine.scheduleWakeTick(20);
        engine.processPending();
        assert.equal(engine.getPendingDecisionCount(), 0, 'scene-local hooks cannot survive a transfer');
    });

    await check('movement timeline patches retain template timing, terrain cost, and sprint count', () => {
        const actor = entity();
        const movement = template('custom-move');
        movement.timeCost = { startupTicks: 6, recoveryTicks: 2 };
        const engine = new CombatEngine('audit-move-timeline', new InMemoryActionCatalog([movement]));
        engine.setAutoProcess(false);
        engine.mountEntities([actor]);
        engine.setBattlefield({ id: 'terrain', name: 'terrain', width: 4, height: 1, spawnPoints: {}, tiles: [
            { hex: { q: 0, r: 0 }, terrain: 'GROUND' },
            { hex: { q: 1, r: 0 }, terrain: 'GROUND' },
            { hex: { q: 2, r: -1 }, terrain: 'GROUND', movementCost: 2 },
            { hex: { q: 3, r: -1 }, terrain: 'GROUND' },
        ] });
        let timeline: ActionTimeline | undefined;
        engine.on('STATE_MUTATED', (payload: StateMutationPayload) => {
            const patch = payload.actionPatches?.find(patch => patch.entityId === actor.id);
            if (patch) timeline = patch.timeline;
        });
        engine.receiveIntent(intent(actor.id, 'MOVE', { actionTemplateId: movement.id,
            targetCoords: { x: 3, y: 0, z: 0 } }));
        engine.processPending(1);
        assert.equal(engine.getNextEventTick(), 16);
        assert.deepEqual(timeline?.pulseTicks, [6, 16, 21]);
        assert.equal(timeline?.end, 24);
        assert.equal(timeline!.end - timeline!.recoveryStart, 2);
        engine.processPending();
        assert.equal(engine.currentTick, 24);
        assert.equal(actor.currentActionContext, undefined);
    });

    await check('cancelling movement spends its recovery interval instead of moving', () => {
        const actor = entity();
        const engine = new CombatEngine('audit-cancel-move', new InMemoryActionCatalog());
        engine.setAutoProcess(false);
        engine.mountEntities([actor]);
        engine.receiveIntent(intent(actor.id, 'MOVE', { targetCoords: { x: 2, y: 0, z: 0 } }));
        engine.receiveIntent(intent(actor.id, 'CANCEL_ACTION'));
        assert.equal(actor.currentActionContext?.phase, 'RECOVERY');
        engine.processPending();
        assert.deepEqual(actor.transform.coords, { x: 0, y: 0, z: 0 });
        assert.equal(actor.currentActionContext, undefined);
    });

    await check('paused scenes can accept a returning player and resume', async () => {
        const scene = new Scene('audit-paused-scene', { autoEvict: false });
        await scene.activate(new CombatEngine('audit-scene-engine', new InMemoryActionCatalog()));
        scene.pause();
        scene.onPlayerJoin('socket-a');
        assert.equal(scene.currentState, SceneState.ACTIVE);
        assert.equal(scene.playerCount, 1);
        await scene.destroy();
    });

    await check('same-id hook edits replace the original enabled preset', () => {
        const registry = new HookRegistry();
        const actor = entity();
        const preset = { id: 'same', entityId: actor.id, label: 'hook', enabled: true,
            trigger: { type: 'TICK_REACHED' as const, targetTick: 5 } };
        registry.register(actor.id, preset, 'MANUAL', 0);
        registry.register(actor.id, { ...preset, enabled: false }, 'MANUAL', 1);
        assert.equal(registry.getAll().length, 1);
        assert.deepEqual(registry.evaluate(5, new Map([[actor.id, actor]])), []);
    });

    await check('movement hooks compare axial targets with offset entity positions', () => {
        const registry = new HookRegistry();
        const actor = entity();
        actor.transform.coords = { x: 8, y: 7, z: 0 }; // axial 8,3
        registry.register(actor.id, { id: 'hex', entityId: actor.id, label: 'hex', enabled: true,
            trigger: { type: 'ENTITY_MOVES_TO', targetHex: { q: 8, r: 3 } } }, 'MANUAL', 0);
        assert.equal(registry.evaluate(0, new Map([[actor.id, actor]])).length, 1);
    });

    await check('expired hooks cannot fire at the next jumped tick', () => {
        const registry = new HookRegistry();
        const actor = entity();
        registry.register(actor.id, { id: 'expired', entityId: actor.id, label: 'expired', enabled: true,
            trigger: { type: 'TICK_REACHED', targetTick: 10 } }, 'MANUAL', 0, 5);
        assert.equal(registry.findEarliestTargetTickInRange(0, 20), null);
        assert.deepEqual(registry.evaluate(10, new Map([[actor.id, actor]])), []);
    });

    await check('fog reports first discovery for initialized map cells', () => {
        const fog = new FogOfWar();
        const map: MapData = { id: 'audit', name: 'audit', width: 1, height: 1, spawnPoints: {},
            tiles: [{ hex: { q: 0, r: 0 }, terrain: 'GROUND' }] };
        fog.initializeMap(map, 0);
        assert.deepEqual(fog.updateFog(entity(), new Set([{ q: 0, r: 0 }]), 1).exploredHexes, [{ q: 0, r: 0 }]);
    });

    await check('one viewer moving away does not obscure another viewer\'s current hex', () => {
        const fog = new FogOfWar();
        const a = entity('a');
        const b = entity('b');
        fog.updateFog(a, new Set([{ q: 0, r: 0 }]), 1);
        fog.updateFog(b, new Set([{ q: 0, r: 0 }]), 1);
        fog.updateFog(a, new Set([{ q: 1, r: 0 }]), 2);
        assert.equal(fog.getHexFogState({ q: 0, r: 0 }), 'VISIBLE');
        assert.deepEqual(new Set(fog.serialize().visibleHexes.map(hex => fog.hexKey(hex))), new Set(['0,0', '1,0']));
    });

    await check('fog ignores non-observers and removes unmounted observers', () => {
        const fog = new FogOfWar();
        const actor = entity();
        const prop: Entity = { ...entity('prop'), type: 'PROP' };
        const hidden: Partial<ExploreEntity> = entity('hidden');
        hidden.revealsFog = false;
        const updates = fog.updateFogForAll([actor, prop, hidden as Entity], null, 0,
            () => ({ q: 0, r: 0 }));
        assert.deepEqual(updates.map(update => update.entityId), [actor.id]);
        fog.updateFogForAll([], null, 1, () => ({ q: 0, r: 0 }));
        assert.equal(fog.getHexFogState({ q: 0, r: 0 }), 'EXPLORED');
        assert.deepEqual(fog.getEntityVisibleHexes(actor.id), []);
    });

    await check('fog snapshots are independent and restoring clears previous viewers', () => {
        const fog = new FogOfWar();
        fog.updateFog(entity(), new Set([{ q: 0, r: 0 }]), 1);
        const snapshot = fog.serialize();
        snapshot.cells['0,0'].state = 'UNEXPLORED';
        snapshot.visibleHexes[0].q = 20;
        assert.equal(fog.getHexFogState({ q: 0, r: 0 }), 'VISIBLE');
        assert.equal(fog.serialize().visibleHexes[0].q, 0);
        fog.deserialize({ cells: {}, visibleHexes: [] });
        assert.deepEqual(fog.getEntityVisibleHexes('actor'), []);
    });

    await check('exploration emits entered and triggered zones along the entire movement path', () => {
        const engine = new ExploreEngine('audit-zone');
        const actor = entity();
        engine.mountEntities([actor]);
        const entered: string[] = [];
        const triggered: string[] = [];
        engine.on('ZONE_ENTERED', (event: { zoneId: string }) => entered.push(event.zoneId));
        engine.on('ZONE_TRIGGERED', (event: { triggerId: string }) => triggered.push(event.triggerId));
        engine.setZoneTriggers([{ id: 'trap', center: VectorMath.hexToVector3D({ q: 1, r: 0 }), radius: 0.1,
            triggerType: 'TRAP', cooldownTicks: 3, oneShot: false, active: true }]);
        engine.receiveIntent(intent(actor.id, 'MOVE', { targetCoords: { x: 2, y: 1, z: 0 } }));
        assert.deepEqual(entered, ['trap']);
        assert.deepEqual(triggered, ['trap']);
        engine.receiveIntent(intent(actor.id, 'MOVE', { targetCoords: { x: 1, y: 0, z: 0 } }));
        assert.deepEqual(triggered, ['trap'], 'cooldown prevents immediate reentry');
    });

    await check('exploration cannot walk outside a loaded map', () => {
        const engine = new ExploreEngine('audit-map');
        engine.loadMap({ id: 'audit', name: 'audit', width: 1, height: 1, spawnPoints: {},
            tiles: [{ hex: { q: 0, r: 0 }, terrain: 'GROUND' }] });
        const actor = entity();
        engine.mountEntities([actor]);
        let result: MovementResult | undefined;
        engine.on('ENTITY_MOVED', (event: MovementResult) => { result = event; });
        engine.receiveIntent(intent(actor.id, 'MOVE', { targetCoords: { x: 1, y: 0, z: 0 } }));
        assert.equal(result?.success, false);
        assert.deepEqual(actor.transform.coords, { x: 0, y: 0, z: 0 });
    });

    await check('pathfinding selects the cheapest route when tile costs are fractional', () => {
        const map: MapData = { id: 'cheap-detour', name: 'cheap detour', width: 4, height: 2, spawnPoints: {}, tiles: [
            ...[0, 1, 2, 3].map(q => ({ hex: { q, r: 0 }, terrain: 'GROUND' as const })),
            ...[0, 1, 2].map(q => ({ hex: { q, r: 1 }, terrain: 'GROUND' as const, movementCost: 0.1 })),
        ] };
        const loader = new MapLoader(map);
        const path = loader.findPath({ q: 0, r: 0 }, { q: 3, r: 0 });
        const cost = path.slice(1).reduce((total, hex) => total + loader.getMovementCost(hex), 0);
        assert.ok(cost < 1.31, `expected cheap detour, got ${cost}`);
    });

    await check('walkable tile listing includes walkable doors', () => {
        const loader = new MapLoader({ id: 'door', name: 'door', width: 1, height: 1, spawnPoints: {},
            tiles: [{ hex: { q: 0, r: 0 }, terrain: 'DOOR' }] });
        assert.equal(loader.getWalkableTiles().length, 1);
    });

    await check('replacing a fired one-shot zone resets its lifecycle', () => {
        const zones = new ZoneTriggerSystem();
        const def = { id: 'trap', center: { x: 0, y: 0, z: 0 }, radius: 1,
            triggerType: 'TRAP' as const, cooldownTicks: 0, oneShot: true, active: true };
        zones.register(def);
        const actors = new Map([['actor', entity()]]);
        assert.equal(zones.evaluate(actors, 0).length, 1);
        assert.equal(zones.evaluate(actors, 1).length, 0);
        zones.register(def);
        assert.equal(zones.evaluate(actors, 2).length, 1);
    });

    await check('projectile advance visits its first and only waypoint before finishing', () => {
        const actor = entity();
        const projectile = new Projectile({ ...actor, sourceEntityId: 'source', speed: 1 });
        projectile.setLinearPath({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 1);
        assert.equal(projectile.isDone(), false);
        assert.deepEqual(projectile.getCurrentSegment(), { from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } });
        assert.equal(projectile.advance(), true);
        assert.deepEqual(projectile.transform.coords, { x: 1, y: 0, z: 0 });
    });

    await check('projectile advance follows all generated waypoints', () => {
        const projectile = new Projectile({ ...entity(), sourceEntityId: 'source', speed: 1 });
        projectile.setLinearPath({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, 1);
        assert.equal(projectile.advance(), false);
        assert.deepEqual(projectile.transform.coords, { x: 1, y: 0, z: 0 });
        assert.equal(projectile.advance(), false);
        assert.deepEqual(projectile.transform.coords, { x: 2, y: 0, z: 0 });
        assert.equal(projectile.advance(), true);
        assert.deepEqual(projectile.transform.coords, { x: 3, y: 0, z: 0 });
    });

    await check('linear projectile paths use the launch plane even for elevated destinations', () => {
        assert.deepEqual(SpatialSystem.planProjectilePath({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 4 }, 'LINEAR', 1),
            [{ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }]);
    });

    await check('healing respects an explicit maximum of zero', () => {
        const actor = entity();
        actor.resources.current.focus = 0;
        actor.resources.max.focus = 0;
        const heal = template('heal');
        heal.effects = [{ type: 'HEAL', targetSelector: 'SELF', parameters: { resource: 'focus', amountExpr: '5' } }];
        EffectSystem.applyAction(heal, actor, []);
        assert.equal(actor.resources.current.focus, 0);
    });

    await check('rule expressions never return non-finite totals', () => {
        assert.equal(RuleEvaluator.evaluate('2 + 3', {}).total, 5);
        for (const expression of ['1 / 0', '0 / 0', 'sqrt(-1)']) {
            assert.equal(RuleEvaluator.evaluate(expression, {}).total, 0, expression);
        }
    });

    if (failures) throw new Error(`${failures} engine audit regression checks failed`);
    console.log('audit-engine-runtime: passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
