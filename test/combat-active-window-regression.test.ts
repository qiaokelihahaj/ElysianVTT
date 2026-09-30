import assert from 'node:assert/strict';
import type { ActionTemplate, ClientIntent, Entity } from '../packages/shared/src/index.js';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';
import { createDemoEntity } from '../packages/backend/src/demo/DemoContent.js';

function action(id: string, range: number, amount: number, options: Partial<ActionTemplate> = {}): ActionTemplate {
    return {
        id,
        tags: ['ATTACK'],
        resourceCost: {},
        timeCost: { startupTicks: 1, recoveryTicks: 2 },
        range: { type: 'MELEE', distanceExpr: String(range) },
        effects: [{
            type: 'DAMAGE',
            targetSelector: 'PRIMARY',
            parameters: { resource: 'hp', amountExpr: String(amount) },
        }],
        priorityExpr: '10',
        activeWindowTicks: 4,
        ...options,
    };
}

function cast(actorId: string, actionTemplateId: string, targetIds: string[], effectiveTick?: number): ClientIntent {
    return {
        actorId,
        intentType: 'CAST_ACTION',
        clientTick: 0,
        payload: { actionTemplateId, targetIds, effectiveTick },
    };
}

function freshEntity(id: string, x: number, y = 0): Entity {
    return createDemoEntity('player-melee', id, { x, y, z: 0 });
}

function drain(engine: CombatEngine, max = 20): void {
    for (let i = 0; i < max && engine.hasPendingEvents(); i++) engine.processPending(1);
}

let failures = 0;
function check(name: string, run: () => void): void {
    try {
        run();
        console.log(`PASS ${name}`);
    } catch (error) {
        failures++;
        console.error(`FAIL ${name}`, error);
    }
}

check('late entry is event-driven and each target is consumed once per window', () => {
    const template = action('ACTIVE_LATE_ENTRY', 2, 20);
    Dictionary.registerAction(template);
    const engine = new CombatEngine('active-late-entry');
    engine.setAutoProcess(false);
    const source = freshEntity('source', 0);
    const target = freshEntity('target', 5);
    engine.setPlayerControlledEntities([source.id]);
    engine.mountEntities([source, target]);

    engine.receiveIntent(cast(source.id, template.id, [target.id]));
    engine.processPending(1);
    assert.equal(engine.currentTick, 1);
    assert.equal(target.resources.current.hp, 100, 'out-of-range declaration must not hit at window start');
    assert.equal(source.currentActionContext?.activeWindowStart, 1);
    assert.equal(source.currentActionContext?.activeWindowEnd, 5);

    target.transform.coords.x = 1;
    engine.notifyPositionChanged(target.id);
    engine.processPending(1);
    assert.equal(engine.currentTick, 1, 'position wake must not advance Tick');
    assert.equal(target.resources.current.hp, 80, 'entering the window range applies the effect');

    target.transform.coords.x = 0;
    engine.notifyPositionChanged(target.id);
    engine.processPending(1);
    assert.equal(target.resources.current.hp, 80, 'a second position event cannot repeat the strike');

    drain(engine);
    assert.equal(source.currentActionContext, undefined, 'window end and recovery must complete');
    Dictionary.unregisterAction(template.id);
});

check('attacker movement is also an event-driven range trigger', () => {
    const template = action('ACTIVE_ATTACKER_ENTRY', 2, 15);
    Dictionary.registerAction(template);
    const engine = new CombatEngine('active-attacker-entry');
    engine.setAutoProcess(false);
    const source = freshEntity('source-attacker', 5);
    const target = freshEntity('target-attacker', 0);
    engine.setPlayerControlledEntities([source.id]);
    engine.mountEntities([source, target]);

    engine.receiveIntent(cast(source.id, template.id, [target.id]));
    engine.processPending(1);
    assert.equal(target.resources.current.hp, 100);
    source.transform.coords.x = 1;
    engine.notifyPositionChanged(source.id);
    engine.processPending(1);
    assert.equal(target.resources.current.hp, 85, 'moving the source into range rechecks all unhit targets');
    Dictionary.unregisterAction(template.id);
});

check('multi-strike uses large startup plus small startup per strike', () => {
    const template = action('ACTIVE_SEQUENCE', 2, 10, {
        timeCost: { startupTicks: 3, recoveryTicks: 2 },
        activeWindowTicks: undefined,
        strikeSequence: { count: 2, startupTicks: 2, activeWindowTicks: 1 },
    });
    Dictionary.registerAction(template);
    const engine = new CombatEngine('active-sequence');
    engine.setAutoProcess(false);
    const source = freshEntity('sequence-source', 0);
    const target = freshEntity('sequence-target', 1);
    engine.setPlayerControlledEntities([source.id]);
    engine.mountEntities([source, target]);

    engine.receiveIntent(cast(source.id, template.id, [target.id]));
    engine.processPending(1);
    assert.equal(engine.currentTick, 5, 'first strike starts at big startup + small startup');
    assert.equal(target.resources.current.hp, 90);
    engine.processPending(1);
    assert.equal(engine.currentTick, 6, 'first active window is half-open and closes at end');
    engine.processPending(1);
    assert.equal(engine.currentTick, 8, 'second strike starts after small startup');
    assert.equal(target.resources.current.hp, 80);
    engine.processPending(1);
    assert.equal(engine.currentTick, 9);
    engine.processPending(1);
    assert.equal(engine.currentTick, 11);
    assert.equal(source.currentActionContext, undefined);
    Dictionary.unregisterAction(template.id);
});

check('position trigger and a same-Tick action share one immutable clash snapshot', () => {
    const active = action('ACTIVE_SNAPSHOT', 2, 10, { activeWindowTicks: 4 });
    const sibling = action('SIBLING_SNAPSHOT', 2, 7, { activeWindowTicks: 1 });
    Dictionary.registerActions([active, sibling]);
    const engine = new CombatEngine('active-snapshot');
    engine.setAutoProcess(false);
    const source = freshEntity('snapshot-source', 0);
    const siblingSource = freshEntity('snapshot-sibling', 0);
    const target = freshEntity('snapshot-target', 5);
    // Keep the sibling action available while removing it from the automatic
    // reaction barrier.  The snapshot assertion concerns the two same-Tick
    // effects, not a third actor's decision window.
    siblingSource.resources.current.focus = 0;
    siblingSource.resources.current.poise = 0;
    engine.setPlayerControlledEntities([source.id, siblingSource.id]);
    engine.mountEntities([source, siblingSource, target]);

    engine.receiveIntent(cast(source.id, active.id, [target.id]));
    engine.processPending(1);
    assert.equal(engine.currentTick, 1);
    assert.equal(target.resources.current.hp, 100);

    // Both the wake marker and the sibling action are at Tick 1.  The
    // position-triggered event is generated only after movement/position
    // state is committed, then enters the same ClashPool batch.
    target.transform.coords.x = 1;
    engine.notifyPositionChanged(target.id);
    engine.receiveIntent(cast(siblingSource.id, sibling.id, [target.id], 1));
    engine.processPending(1);
    assert.equal(target.resources.current.hp, 83, 'both effects commit at the same immutable Tick snapshot');
    Dictionary.unregisterAction(active.id);
    Dictionary.unregisterAction(sibling.id);
});

check('an explicitly declared SELF target keeps PRIMARY semantics', () => {
    const template = action('ACTIVE_EXPLICIT_SELF_TARGET', 2, 7, {
        activeWindowTicks: 1,
        effects: [
            {
                type: 'HEAL',
                targetSelector: 'SELF',
                parameters: { resource: 'hp', amountExpr: '10' },
            },
            {
                type: 'DAMAGE',
                targetSelector: 'PRIMARY',
                parameters: { resource: 'hp', amountExpr: '7' },
            },
        ],
    });
    Dictionary.registerAction(template);
    const source = freshEntity('explicit-self-source', 0);
    source.resources.current.hp = 50;
    const engine = new CombatEngine('active-explicit-self-target');
    engine.setAutoProcess(false);
    engine.setPlayerControlledEntities([]);
    engine.mountEntities([source]);

    engine.receiveIntent(cast(source.id, template.id, [source.id]));
    engine.processPending(1);
    assert.equal(source.resources.current.hp, 53, 'SELF heal and explicitly declared PRIMARY damage both apply once');
    Dictionary.unregisterAction(template.id);
});

assert.equal(failures, 0, `${failures} active-window regressions failed`);
