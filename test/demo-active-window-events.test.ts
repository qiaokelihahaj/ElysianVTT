import assert from 'node:assert/strict';
import type {
    ActionTemplate,
    ClientIntent,
    Entity,
    EncounterCommand,
    EncounterPrincipal,
    StateMutationPayload,
    VisualEventPayload,
} from '../packages/shared/src/index.js';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';
import { createDemoEntity, installDemoContent } from '../packages/backend/src/demo/DemoContent.js';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.js';

const RANGE = 3;
const DAMAGE = 10;

function activeDamageTemplate(
    id: string,
    priority = 10,
    overrides: Partial<ActionTemplate> = {},
): ActionTemplate {
    return {
        id,
        tags: ['ATTACK'],
        resourceCost: {},
        timeCost: { startupTicks: 2, recoveryTicks: 2 },
        range: { type: 'MELEE', distanceExpr: String(RANGE) },
        priorityExpr: String(priority),
        activeWindowTicks: 3,
        effects: [{
            type: 'DAMAGE',
            targetSelector: 'PRIMARY',
            parameters: { resource: 'hp', amountExpr: String(DAMAGE) },
        }],
        ...overrides,
    };
}

function cast(actorId: string, actionTemplateId: string, targetIds: string[], effectiveTick?: number): ClientIntent {
    return {
        actorId,
        intentType: 'CAST_ACTION',
        clientTick: 0,
        payload: {
            actionTemplateId,
            targetIds,
            ...(effectiveTick === undefined ? {} : { effectiveTick }),
        },
    };
}

function entity(id: string, x: number, y = 0, hp = 100): Entity {
    const value = createDemoEntity('player-melee', id, { x, y, z: 0 });
    value.resources.current.hp = hp;
    return value;
}

function engine(id: string, entities: Entity[]): CombatEngine {
    const value = new CombatEngine(id);
    value.setAutoProcess(false);
    // Keep these tests focused on ACTIVE windows; reaction decisions belong to
    // the dedicated reaction suites and would pause the event queue here.
    value.setPlayerControlledEntities([]);
    value.mountEntities(entities);
    return value;
}

let commandNumber = 0;

function submit(
    coordinator: EncounterCoordinator,
    principal: EncounterPrincipal,
    type: EncounterCommand['type'],
    payload: Record<string, unknown>,
): ReturnType<EncounterCoordinator['handleCommand']> {
    return coordinator.handleCommand(principal, {
        requestId: `demo-active-window-${++commandNumber}`,
        type,
        payload,
    } as EncounterCommand);
}

function check(name: string, run: () => void): void {
    try {
        run();
        console.log(`PASS ${name}`);
    } catch (error) {
        failures++;
        console.error(`FAIL ${name}`, error);
    }
}

let failures = 0;

check('late target entry is notified once per ACTIVE window and never after close', () => {
    const template = activeDamageTemplate('DEMO_ACTIVE_WINDOW_LATE_ENTRY');
    Dictionary.registerAction(template);
    const source = entity('late-source', 0);
    const target = entity('late-target', 4);
    const combat = engine('demo-active-window-late-entry', [source, target]);
    try {
        combat.receiveIntent(cast(source.id, template.id, [target.id]));
        combat.processPending(1);

        assert.equal(combat.currentTick, 2, 'normal startup reaches the first ACTIVE Tick');
        assert.equal(target.resources.current.hp, 100, 'the initially out-of-range target is not hit at window open');
        assert.deepEqual(
            [source.currentActionContext?.activeWindowStart, source.currentActionContext?.activeWindowEnd],
            [2, 5],
        );

        // Multiple notifications before the wake are coalesced into one
        // same-Tick range check.
        target.transform.coords.x = 2;
        combat.notifyPositionChanged(target.id);
        combat.notifyPositionChanged(target.id);
        combat.processPending(1);
        assert.equal(combat.currentTick, 2, 'a position wake does not invent a new Tick');
        assert.equal(target.resources.current.hp, 90, 'entering range applies the first hit');

        // Leaving and re-entering the same window must not consume a second
        // hit opportunity for the same declared target.
        target.transform.coords.x = 4;
        combat.notifyPositionChanged(target.id);
        combat.processPending(1);
        target.transform.coords.x = 2;
        combat.notifyPositionChanged(target.id);
        combat.processPending(1);
        assert.equal(target.resources.current.hp, 90, 'out-and-back movement cannot repeat one strike');

        // The half-open [2,5) window is closed before this entry.
        combat.processPending(1);
        assert.equal(combat.currentTick, 5);
        target.transform.coords.x = 4;
        combat.notifyPositionChanged(target.id);
        combat.processPending(1);
        target.transform.coords.x = 2;
        combat.notifyPositionChanged(target.id);
        combat.processPending(1);
        assert.equal(target.resources.current.hp, 90, 'entering after the ACTIVE window has no effect');
    } finally {
        combat.removeAllListeners();
        Dictionary.unregisterAction(template.id);
    }
});

check('moving the source into range triggers the same active strike', () => {
    const template = activeDamageTemplate('DEMO_ACTIVE_WINDOW_SOURCE_ENTRY');
    Dictionary.registerAction(template);
    const source = entity('source-entry', 4);
    const target = entity('source-entry-target', 0);
    const combat = engine('demo-active-window-source-entry', [source, target]);
    try {
        combat.receiveIntent(cast(source.id, template.id, [target.id]));
        combat.processPending(1);
        assert.equal(target.resources.current.hp, 100, 'source starts outside the target range');

        source.transform.coords.x = 2;
        combat.notifyPositionChanged(source.id);
        combat.processPending(1);
        assert.equal(combat.currentTick, 2);
        assert.equal(target.resources.current.hp, 90, 'moving the source into range rechecks its unhit target');
    } finally {
        combat.removeAllListeners();
        Dictionary.unregisterAction(template.id);
    }
});

check('range admission uses the exact 3/3.01 boundary', () => {
    const template = activeDamageTemplate('DEMO_ACTIVE_WINDOW_RANGE_BOUNDARY');
    Dictionary.registerAction(template);
    try {
        for (const [distance, expectedHp] of [[3, 90], [3.01, 100]] as const) {
            const source = entity(`boundary-source-${distance}`, 0);
            const target = entity(`boundary-target-${distance}`, distance);
            const combat = engine(`demo-active-window-range-${distance}`, [source, target]);
            try {
                combat.receiveIntent(cast(source.id, template.id, [target.id]));
                combat.processPending(1);
                assert.equal(
                    target.resources.current.hp,
                    expectedHp,
                    `distance ${distance} must be evaluated against the 3-tile range without tolerance`,
                );
            } finally {
                combat.removeAllListeners();
            }
        }
    } finally {
        Dictionary.unregisterAction(template.id);
    }
});

check('strike sequence schedules windows at 3 and 6 and hits once per strike', () => {
    const template = activeDamageTemplate('DEMO_ACTIVE_WINDOW_SEQUENCE', 10, {
        strikeSequence: { count: 2, startupTicks: 1, activeWindowTicks: 2 },
        activeWindowTicks: undefined,
    });
    Dictionary.registerAction(template);
    const source = entity('sequence-source', 0);
    const target = entity('sequence-target', 4);
    const combat = engine('demo-active-window-sequence', [source, target]);
    try {
        combat.receiveIntent(cast(source.id, template.id, [target.id]));
        const scheduled = combat.getScheduledActions().find(action => action.entityId === source.id);
        assert.deepEqual(scheduled?.timeline.pulseTicks, [3, 6], 'timeline exposes the large plus small startup schedule');
        assert.deepEqual(
            scheduled?.timeline.activeWindows?.map(window => [window.start, window.end]),
            [[3, 5], [6, 8]],
        );

        combat.processPending(1);
        assert.equal(combat.currentTick, 3);
        assert.equal(target.resources.current.hp, 100, 'first strike starts with the target outside range');
        target.transform.coords.x = 2;
        combat.notifyPositionChanged(target.id);
        combat.processPending(1);
        assert.equal(target.resources.current.hp, 90, 'first strike hits when the target enters');

        // Repeated out-and-back notifications during the first window do not
        // apply that strike twice.
        target.transform.coords.x = 4;
        combat.notifyPositionChanged(target.id);
        combat.processPending(1);
        target.transform.coords.x = 2;
        combat.notifyPositionChanged(target.id);
        combat.processPending(1);
        assert.equal(target.resources.current.hp, 90);

        combat.processPending(1);
        assert.equal(combat.currentTick, 5, 'first window closes before the next small startup');
        assert.equal(source.currentActionContext?.phase, 'STARTUP');
        combat.processPending(1);
        assert.equal(combat.currentTick, 6, 'the second strike starts one small startup after the first window');
        assert.equal(target.resources.current.hp, 80, 'the second strike has exactly one hit opportunity');
        assert.deepEqual(source.currentActionContext?.pulseTickHistory, [3, 6]);
    } finally {
        combat.removeAllListeners();
        Dictionary.unregisterAction(template.id);
    }
});

check('SELF recovery is committed once and excluded from new-target rechecks', () => {
    const template = activeDamageTemplate('DEMO_ACTIVE_WINDOW_SELF_RECOVERY', 10, {
        effects: [
            {
                type: 'HEAL',
                targetSelector: 'SELF',
                parameters: { resource: 'hp', amountExpr: '10' },
            },
            {
                type: 'DAMAGE',
                targetSelector: 'PRIMARY',
                parameters: { resource: 'hp', amountExpr: String(DAMAGE) },
            },
        ],
    });
    Dictionary.registerAction(template);
    const source = entity('self-source', 0, 0, 50);
    const target = entity('self-target', 4);
    const combat = engine('demo-active-window-self-recovery', [source, target]);
    try {
        combat.receiveIntent(cast(source.id, template.id, [target.id]));
        combat.processPending(1);
        assert.equal(source.resources.current.hp, 60, 'SELF recovery applies at the original ACTIVE entry');
        assert.equal(target.resources.current.hp, 100, 'the primary target starts outside range');

        target.transform.coords.x = 2;
        combat.notifyPositionChanged(target.id);
        combat.processPending(1);
        assert.equal(target.resources.current.hp, 90, 'a newly entering target receives the primary damage');
        assert.equal(source.resources.current.hp, 60, 'SELF recovery is not repeated for the entering target');
    } finally {
        combat.removeAllListeners();
        Dictionary.unregisterAction(template.id);
    }
});

check('same-Tick position trigger and new attack honor high and low priority groups', () => {
    const positionTemplate = activeDamageTemplate('DEMO_ACTIVE_WINDOW_PRIORITY_SOURCE', 10);
    const highTemplate = activeDamageTemplate('DEMO_ACTIVE_WINDOW_PRIORITY_HIGH', 20);
    const lowTemplate = activeDamageTemplate('DEMO_ACTIVE_WINDOW_PRIORITY_LOW', 5);
    Dictionary.registerActions([positionTemplate, highTemplate, lowTemplate]);
    try {
        for (const [label, newTemplate, expectedOrder] of [
            ['high', highTemplate, ['priority-new-target', 'priority-position-target']],
            ['low', lowTemplate, ['priority-position-target', 'priority-new-target']],
        ] as const) {
            const source = entity('priority-source', 0);
            const positionTarget = entity('priority-position-target', 4);
            const newSource = entity('priority-new-source', 0, 1);
            const newTarget = entity('priority-new-target', 0, 2);
            const combat = engine(`demo-active-window-priority-${label}`, [source, positionTarget, newSource, newTarget]);
            const stateEvents: StateMutationPayload[] = [];
            combat.on('STATE_MUTATED', (payload: StateMutationPayload) => stateEvents.push(structuredClone(payload)));
            try {
                combat.receiveIntent(cast(source.id, positionTemplate.id, [positionTarget.id]));
                combat.processPending(1);
                stateEvents.length = 0;

                positionTarget.transform.coords.x = 2;
                combat.notifyPositionChanged(positionTarget.id);
                combat.receiveIntent(cast(newSource.id, newTemplate.id, [newTarget.id], combat.currentTick));
                combat.processPending(1);

                assert.equal(positionTarget.resources.current.hp, 90, `${label} priority still commits the position-triggered hit`);
                assert.equal(newTarget.resources.current.hp, 90, `${label} priority commits the new attack in the same Tick`);
                const sameTickMutations = stateEvents
                    .filter(payload => payload.tick === combat.currentTick)
                    .flatMap(payload => payload.mutations);
                const actualOrder = sameTickMutations
                    .map(mutation => mutation.entityId)
                    .filter(entityId => expectedOrder.includes(entityId as (typeof expectedOrder)[number]));
                assert.deepEqual(actualOrder, expectedOrder, `${label} priority group commits before the lower group`);
            } finally {
                combat.removeAllListeners();
            }
        }
    } finally {
        Dictionary.unregisterAction(positionTemplate.id);
        Dictionary.unregisterAction(highTemplate.id);
        Dictionary.unregisterAction(lowTemplate.id);
    }
});

check('same-priority same-Tick attacks resolve as a mutual kill', () => {
    const template = activeDamageTemplate('DEMO_ACTIVE_WINDOW_MUTUAL_KILL', 10);
    Dictionary.registerAction(template);
    const first = entity('mutual-first', 0, 0, 10);
    const second = entity('mutual-second', 1, 0, 10);
    const combat = engine('demo-active-window-mutual-kill', [first, second]);
    const visualEvents: VisualEventPayload[] = [];
    combat.on('VISUAL_FX', (payload: VisualEventPayload) => visualEvents.push(structuredClone(payload)));
    try {
        combat.receiveCoordinatedIntents([
            cast(first.id, template.id, [second.id]),
            cast(second.id, template.id, [first.id]),
        ]);
        combat.processPending(1);

        assert.equal(combat.currentTick, 2);
        assert.equal(first.resources.current.hp, 0, 'same-priority first attack still lands');
        assert.equal(second.resources.current.hp, 0, 'same-priority second attack still lands');
        assert.ok(
            visualEvents.some(payload => payload.events.some(event => event.eventType === 'MUTUAL_KILL' && event.fxTemplateId === 'mutual_kill')),
            'the clash emits a mutual-kill visual event',
        );
    } finally {
        combat.removeAllListeners();
        Dictionary.unregisterAction(template.id);
    }
});

check('GM-paused position changes wait for a single step before resolving', () => {
    const template = activeDamageTemplate('DEMO_ACTIVE_WINDOW_GM_PAUSE_POSITION');
    Dictionary.registerAction(template);
    const content = installDemoContent();
    content.actionTemplates = [...content.actionTemplates, template];
    const source = createDemoEntity('player-melee', 'paused-position-source', { x: 0, y: 0, z: 0 });
    const target = createDemoEntity('monster-bruiser', 'paused-position-target', { x: 4, y: 0, z: 0 });
    target.resources.max.hp = 100;
    target.resources.current.hp = 100;
    const coordinator = new EncounterCoordinator({
        encounterId: 'demo-active-window-gm-pause-position',
        content,
        entities: [source, target],
    });
    // Suppress reaction decision windows so the coordinator test only covers
    // the GM pause/barrier and the position wake marker.
    coordinator.engine.setPlayerControlledEntities([]);
    const gm: EncounterPrincipal = {
        userId: 'gm-active-window',
        role: 'GM',
        socketId: 'gm-active-window-socket',
    };
    coordinator.connect(gm);
    try {
        assert.equal(submit(coordinator, gm, 'START', {}).ok, true);
        assert.equal(
            submit(coordinator, gm, 'ACTION', {
                entityId: source.id,
                actionTemplateId: template.id,
                targetIds: [target.id],
            }).ok,
            true,
        );
        // The target is also an eligible actor, so fill its barrier slot with
        // WAIT before pausing. The action remains queued at Tick 0.
        assert.equal(submit(coordinator, gm, 'WAIT', { entityId: target.id }).ok, true);
        const paused = submit(coordinator, gm, 'GM_PAUSE', { reason: '位置调整前暂停' });
        assert.equal(paused.ok, true);
        assert.equal(paused.snapshot.paused, true);
        assert.equal(paused.snapshot.tick, 0);
        assert.equal(target.resources.current.hp, 100, 'pausing before the pump leaves the queued target untouched');

        // Advance only the queued startup boundary. The source is ACTIVE, but
        // the target is still at x=4 and therefore remains unharmed.
        const active = submit(coordinator, gm, 'GM_STEP', { count: 1 });
        assert.equal(active.ok, true);
        assert.equal(active.snapshot.paused, true);
        assert.equal(active.snapshot.tick, 2);
        assert.equal(source.currentActionContext?.phase, 'ACTIVE');
        assert.equal(target.resources.current.hp, 100);

        // A GM correction while paused updates the authoritative position and
        // queues a same-Tick wake, but it cannot settle the effect inline.
        const adjusted = submit(coordinator, gm, 'GM_ADJUST_ENTITY', {
            entityId: target.id,
            reason: '将目标移入前摇生效范围',
            position: { x: 2, y: 0, z: 0 },
        });
        assert.equal(adjusted.ok, true);
        assert.equal(adjusted.snapshot.paused, true);
        assert.equal(adjusted.snapshot.tick, 2);
        assert.equal(target.resources.current.hp, 100, 'paused GM movement does not resolve inline');

        const resolved = submit(coordinator, gm, 'GM_STEP', { count: 1 });
        assert.equal(resolved.ok, true);
        assert.equal(resolved.snapshot.paused, true, 'single-step preserves the GM pause');
        assert.equal(resolved.snapshot.tick, 2, 'the same-Tick position wake does not invent a Tick');
        assert.equal(target.resources.current.hp, 90, 'the queued position wake resolves after the step');
    } finally {
        coordinator.close();
        Dictionary.unregisterAction(template.id);
    }
});

assert.equal(failures, 0, `${failures} active-window event regressions failed`);
console.log('demo-active-window-events: event-driven range entry, exact boundary, GM pause, strike sequencing, SELF exclusion and Tick priority passed');
