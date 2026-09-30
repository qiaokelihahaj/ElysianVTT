// Independent regressions against the production ClashPool, not a copied engine.
// Run via auth-isolated.runner.ts so .js siblings cannot shadow TypeScript sources.
import assert from 'node:assert/strict';
import type { ActionExecutionEvent, ActionTemplate, Entity } from '../packages/shared/src/index.js';
import { ClashPool } from '../packages/backend/src/core/engine/ClashPool.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';

function actor(id: string): Entity {
    return {
        id, templateId: id, type: 'ACTOR',
        transform: { coords: { x: 0, y: 0, z: 0 }, facing: 0, planeId: 'clash-regression' },
        physics: { scaleClass: 1, collisionRadius: 0.4, mass: 60, movementModes: ['WALK'] },
        resources: { current: { hp: 100, poise: 10 }, max: { hp: 100, poise: 10 } },
        activeEffects: [],
    };
}

function action(id: string, amountExpr: string, resource = 'hp'): ActionTemplate {
    return {
        id, tags: [], resourceCost: {}, priorityExpr: '10',
        timeCost: { startupTicks: 2, recoveryTicks: 2 },
        range: { type: 'MELEE', distanceExpr: '3' },
        effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource, amountExpr } }],
    };
}

function event(actorId: string, target: string, actionTemplateId: string): ActionExecutionEvent {
    return {
        eventId: `event-${actorId}`, actorId, targetIds: [target], actionTemplateId,
        eventType: 'ACTION_PHASE', phase: 'STARTUP', targetTick: 2, status: 'PENDING',
    };
}

const actions: ActionTemplate[] = [
    action('SELF_HP_HALF', 'actor.hp / 2'),
    action('TARGET_HP_HALF', 'target.hp / 2'),
    action('FLAT_DAMAGE', '25'),
    action('ZERO_POISE', '10', 'poise'),
    action('LETHAL', '100'),
    { ...action('INTERRUPT_ONLY', '0'), effects: [{ type: 'INTERRUPT', targetSelector: 'PRIMARY', parameters: {} }] },
];
const byId = new Map(actions.map(template => [template.id, template]));
const originalLookup = Dictionary.getAction;
Dictionary.getAction = id => byId.get(id) ?? originalLookup.call(Dictionary, id);

let failures = 0;
function check(name: string, run: () => void): void {
    try { run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}`, error); }
}

try {
    check('same-group expressions read the common starting state in either order', () => {
        for (const reverse of [false, true]) {
            const a = actor('a');
            const b = actor('b');
            const entities = new Map([[a.id, a], [b.id, b]]);
            const events = [event('a', 'b', 'SELF_HP_HALF'), event('b', 'a', 'SELF_HP_HALF')];
            ClashPool.resolve(reverse ? events.reverse() : events, entities, 2, 0);
            assert.equal(a.resources.current.hp, 50, 'A must attack with its initial 100 HP');
            assert.equal(b.resources.current.hp, 50, 'B must attack with its initial 100 HP');
        }
    });

    check('simultaneous damage to one target adds deltas computed from the same initial HP', () => {
        const entities = new Map(['a', 'b', 'target'].map(id => [id, actor(id)]));
        ClashPool.resolve([
            event('a', 'target', 'TARGET_HP_HALF'), event('b', 'target', 'TARGET_HP_HALF'),
        ], entities, 2, 0);
        assert.equal(entities.get('target')?.resources.current.hp, 0);
    });

    check('interrupt callbacks run after group commit and receive the real entity', () => {
        const entities = new Map(['a', 'b', 'target'].map(id => [id, actor(id)]));
        const victim = entities.get('target');
        assert.ok(victim);
        const observed: Array<{ entity: Entity; hp: number }> = [];
        ClashPool.resolve([
            event('a', 'target', 'INTERRUPT_ONLY'), event('b', 'target', 'FLAT_DAMAGE'),
        ], entities, 2, 0, target => observed.push({ entity: target, hp: target.resources.current.hp }));
        assert.equal(observed.length, 1);
        assert.equal(observed[0].entity, victim);
        assert.equal(observed[0].hp, 75, 'interrupt must not escape the precomputation phase');
    });

    check('zero poise is not a death while HP remains positive', () => {
        const entities = new Map(['a', 'target'].map(id => [id, actor(id)]));
        const result = ClashPool.resolve([event('a', 'target', 'ZERO_POISE')], entities, 2, 0);
        assert.equal(entities.get('target')?.resources.current.poise, 0);
        assert.equal(result.deaths.length, 0);
    });

    check('same-priority lethal attacks both commit in either arrival order', () => {
        for (const reverse of [false, true]) {
            const entities = new Map(['a', 'b'].map(id => [id, actor(id)]));
            const events = [event('a', 'b', 'LETHAL'), event('b', 'a', 'LETHAL')];
            const result = ClashPool.resolve(reverse ? events.reverse() : events, entities, 2);
            assert.equal(entities.get('a')?.resources.current.hp, 0);
            assert.equal(entities.get('b')?.resources.current.hp, 0);
            assert.equal(result.mutualKillPairs.length, 1);
        }
    });

    check('strictly higher priority interrupts a pending lower action but not ACTIVE', () => {
        for (const phase of ['STARTUP', 'ACTIVE'] as const) {
            const a = actor('a');
            const b = actor('b');
            const strike = event('b', 'a', 'FLAT_DAMAGE');
            strike.phase = phase;
            b.currentActionContext = { type: 'CASTING', actionId: strike.eventId, phase, actionTemplateId: 'FLAT_DAMAGE', resolveTick: 2 };
            const interrupt = event('a', 'b', 'INTERRUPT_ONLY');
            interrupt.priorityOverride = 10.001;
            const result = ClashPool.resolve([strike, interrupt], new Map([['a', a], ['b', b]]), 2);
            assert.equal(a.resources.current.hp, phase === 'ACTIVE' ? 75 : 100);
            assert.equal(result.cancelledEventIds?.includes(strike.eventId), phase !== 'ACTIVE');
        }
    });
} finally {
    Dictionary.getAction = originalLookup;
}

assert.equal(failures, 0, `${failures} production ClashPool regressions failed`);
console.log('demo-clash-regression: all 6 scenarios passed');
