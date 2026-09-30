import assert from 'node:assert/strict';
import type { ActionTemplate, EncounterCommand, EncounterPrincipal, EncounterSnapshot } from '../packages/shared/src/index.js';
import { filterDemoSnapshot } from '../packages/backend/src/demo/DemoServer.js';
import { DEMO_ACTION_IDS, createDemoEntity, installDemoContent } from '../packages/backend/src/demo/DemoContent.js';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.js';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';

let requestNumber = 0;

function command(
    coordinator: EncounterCoordinator,
    principal: EncounterPrincipal,
    type: EncounterCommand['type'],
    payload: Record<string, unknown>,
): ReturnType<EncounterCoordinator['handleCommand']> {
    return coordinator.handleCommand(principal, {
        requestId: `timeline-${++requestNumber}`,
        type,
        payload,
    } as EncounterCommand);
}

function actionTemplate(id: string): ActionTemplate {
    return {
        id,
        tags: ['ATTACK'],
        resourceCost: {},
        timeCost: { startupTicks: 2, recoveryTicks: 2 },
        range: { type: 'MELEE', distanceExpr: '3' },
        effects: [],
        strikeSequence: { count: 3, startupTicks: 1, activeWindowTicks: 2 },
    };
}

function readyCoordinator(template: ActionTemplate): { coordinator: EncounterCoordinator; gm: EncounterPrincipal; actorId: string } {
    const content = installDemoContent();
    Dictionary.registerAction(template);
    content.actionTemplates = [...content.actionTemplates, template];
    const actorId = 'timeline-actor';
    const coordinator = new EncounterCoordinator({
        encounterId: `timeline-${template.id}`,
        content,
        entities: [createDemoEntity('player-melee', actorId, { x: 1, y: 1, z: 0 })],
    });
    const gm: EncounterPrincipal = { userId: 'timeline-gm', role: 'GM', socketId: 'timeline-gm-socket' };
    coordinator.connect(gm);
    assert.equal(command(coordinator, gm, 'START', {}).ok, true);
    return { coordinator, gm, actorId };
}

function assertInterruptClipsFutureTimeline(): void {
    const interrupted = createDemoEntity('player-melee', 'timeline-interrupted', { x: 2, y: 2, z: 0 });
    const source = createDemoEntity('monster-bruiser', 'timeline-interrupter', { x: 3, y: 2, z: 0 });
    interrupted.resources.current.poise = 5;
    const casting: ActionTemplate = {
        ...actionTemplate('DEMO_TIMELINE_INTERRUPTED'),
        sustainResources: ['poise'],
        timeCost: { startupTicks: 2, recoveryTicks: 3 },
        activeWindowTicks: 2,
        effects: [{
            type: 'DAMAGE', targetSelector: 'PRIMARY',
            parameters: { resource: 'hp', amountExpr: '1' },
        }],
    };
    const poiseStrike: ActionTemplate = {
        ...actionTemplate('DEMO_TIMELINE_POISE_STRIKE'),
        timeCost: { startupTicks: 1, recoveryTicks: 1 },
        activeWindowTicks: undefined,
        strikeSequence: undefined,
        effects: [{
            type: 'DAMAGE', targetSelector: 'PRIMARY',
            parameters: { resource: 'poise', amountExpr: '6' },
        }],
    };
    Dictionary.registerActions([casting, poiseStrike]);

    const engine = new CombatEngine('timeline-interrupt-clipping');
    engine.setAutoProcess(false);
    engine.setPlayerControlledEntities([]);
    engine.mountEntities([interrupted, source]);
    try {
        engine.receiveCoordinatedIntents([
            {
                actorId: interrupted.id,
                intentType: 'CAST_ACTION',
                clientTick: 0,
                payload: { actionTemplateId: casting.id, targetIds: [] },
            },
            {
                actorId: source.id,
                intentType: 'CAST_ACTION',
                clientTick: 0,
                payload: { actionTemplateId: poiseStrike.id, targetIds: [interrupted.id] },
            },
        ]);
        const before = engine.getScheduledActions().find(action => action.entityId === interrupted.id);
        assert.ok(before?.timeline.phaseSegments?.some(segment => segment.phase === 'ACTIVE'),
            'the initial timeline includes the future active window');

        // The poise strike resolves at Tick 1.  The negative STARTUP resource
        // interrupts the caster before its first active window at Tick 2.
        engine.processPending(1);
        const after = engine.getScheduledActions().find(action => action.entityId === interrupted.id);
        assert.ok(after, 'an interrupted live action keeps its recovery rail until recovery resolves');
        assert.deepEqual(after?.timeline.pulseTicks, [], 'an interrupted action has no uncommitted future pulses');
        assert.deepEqual(after?.timeline.activeWindows, [], 'an interrupted action has no future active windows');
        assert.equal(after?.timeline.recoveryStart, 1, 'recovery starts at the authoritative interruption Tick');
        assert.equal(after?.timeline.end, 5, 'recovery end follows the authoritative recovery event');
        assert.deepEqual(after?.timeline.phaseSegments, [
            { phase: 'STARTUP', start: 0, end: 1 },
            { phase: 'RECOVERY', start: 1, end: 5 },
        ]);
        assert.equal(interrupted.currentActionContext?.phase, 'RECOVERY');

        engine.processPending();
        assert.equal(interrupted.currentActionContext, undefined, 'the interrupted action eventually clears its context');
        assert.equal(engine.getScheduledActions().some(action => action.entityId === interrupted.id), false,
            'the interrupted rail is removed only after recovery resolves');
    } finally {
        engine.removeAllListeners();
    }
}

function assertSameTickStartupInterruptHasNoPhantomStrike(): void {
    const low = createDemoEntity('player-melee', 'timeline-low-startup', { x: 2, y: 2, z: 0 });
    const high = createDemoEntity('monster-bruiser', 'timeline-high-interrupt', { x: 3, y: 2, z: 0 });
    const highInitialHp = high.resources.current.hp;
    const lowAction: ActionTemplate = {
        id: 'DEMO_TIMELINE_LOW_STARTUP',
        tags: ['ATTACK'],
        resourceCost: {},
        priorityExpr: '10',
        timeCost: { startupTicks: 2, recoveryTicks: 3 },
        range: { type: 'MELEE', distanceExpr: '3' },
        activeWindowTicks: 1,
        effects: [{
            type: 'DAMAGE', targetSelector: 'PRIMARY',
            parameters: { resource: 'hp', amountExpr: '25' },
        }],
    };
    const highInterrupt: ActionTemplate = {
        id: 'DEMO_TIMELINE_HIGH_INTERRUPT',
        tags: ['REACTION', 'INTERRUPT'],
        resourceCost: {},
        priorityExpr: '100',
        timeCost: { startupTicks: 2, recoveryTicks: 1 },
        range: { type: 'MELEE', distanceExpr: '3' },
        activeWindowTicks: 1,
        effects: [{ type: 'INTERRUPT', targetSelector: 'PRIMARY', parameters: {} }],
    };
    Dictionary.registerActions([lowAction, highInterrupt]);

    const engine = new CombatEngine('timeline-same-tick-interrupt');
    engine.setAutoProcess(false);
    engine.setPlayerControlledEntities([]);
    engine.mountEntities([low, high]);
    try {
        engine.receiveCoordinatedIntents([
            {
                actorId: low.id,
                intentType: 'CAST_ACTION',
                clientTick: 0,
                payload: { actionTemplateId: lowAction.id, targetIds: [high.id] },
            },
            {
                actorId: high.id,
                intentType: 'CAST_ACTION',
                clientTick: 0,
                payload: { actionTemplateId: highInterrupt.id, targetIds: [low.id] },
            },
        ]);
        const planned = engine.getScheduledActions().find(action => action.entityId === low.id);
        assert.deepEqual(planned?.timeline.pulseTicks, [2]);
        assert.deepEqual(planned?.timeline.activeWindows, [{ start: 2, end: 3, strikeIndex: 0 }]);

        // Both first events enter the same Tick.  The higher-priority
        // interrupt commits first and cancels the lower STARTUP event before
        // its ACTIVE window can be materialized.
        engine.processPending(1);
        const clipped = engine.getScheduledActions().find(action => action.entityId === low.id);
        assert.ok(clipped);
        assert.deepEqual(clipped?.timeline.pulseTicks, [], 'a same-Tick cancelled strike is not a committed pulse');
        assert.deepEqual(clipped?.timeline.activeWindows, [], 'a same-Tick cancelled strike has no phantom ACTIVE window');
        assert.equal(clipped?.timeline.recoveryStart, 2);
        assert.equal(clipped?.timeline.phaseSegments?.some(segment => segment.phase === 'ACTIVE'), false);
        assert.equal(low.currentActionContext?.phase, 'RECOVERY');
        assert.equal(high.resources.current.hp, highInitialHp, 'the cancelled lower-priority attack has no effect');
    } finally {
        engine.removeAllListeners();
    }
}

function assertChannelStopTruncatesFuturePulses(): void {
    const channeler = createDemoEntity('player-guide', 'timeline-channeler', { x: 2, y: 2, z: 0 });
    const target = createDemoEntity('monster-bruiser', 'timeline-channel-target', { x: 3, y: 2, z: 0 });
    channeler.resources.current.focus = 1;
    const channel: ActionTemplate = {
        id: 'DEMO_TIMELINE_CHANNEL_STOP',
        tags: ['ATTACK', 'CHANNEL'],
        resourceCost: {},
        sustainResources: ['focus'],
        timeCost: { startupTicks: 1, recoveryTicks: 3 },
        range: { type: 'MELEE', distanceExpr: '3' },
        activeWindowTicks: 2,
        channelOptions: { intervalTicks: 3, maxPulses: 3, pulseResourceCost: { focus: '1' } },
        effects: [{
            type: 'DAMAGE', targetSelector: 'PRIMARY',
            parameters: { resource: 'hp', amountExpr: '5' },
        }],
    };
    Dictionary.registerAction(channel);

    const engine = new CombatEngine('timeline-channel-stop');
    engine.setAutoProcess(false);
    engine.setPlayerControlledEntities([]);
    engine.mountEntities([channeler, target]);
    try {
        engine.receiveIntent({
            actorId: channeler.id,
            intentType: 'CAST_ACTION',
            clientTick: 0,
            payload: { actionTemplateId: channel.id, targetIds: [target.id] },
        });
        engine.processPending(1);

        const afterPulse = engine.getScheduledActions().find(action => action.entityId === channeler.id);
        assert.ok(afterPulse, 'the channel remains visible during its recovery');
        assert.deepEqual(afterPulse?.timeline.pulseTicks, [1], 'focus exhaustion leaves only the committed pulse');
        assert.deepEqual(afterPulse?.timeline.activeWindows, [{ start: 1, end: 3, strikeIndex: 0 }]);
        assert.equal(afterPulse?.timeline.phaseSegments?.some(segment => segment.phase === 'CHANNELING'), false,
            'focus exhaustion does not render a future channeling interval');
        assert.equal(afterPulse?.timeline.recoveryStart, 3);
        assert.equal(afterPulse?.timeline.end, 6);
        assert.equal(channeler.currentActionContext?.stopAfterActiveWindow, true);

        engine.processPending();
        assert.equal(target.resources.current.hp, 75, 'only one pulse is committed before the channel stops');
        assert.equal(channeler.currentActionContext, undefined);
    } finally {
        engine.removeAllListeners();
    }
}

function assertGmEditRefreshesTimeline(): void {
    const gm: EncounterPrincipal = { userId: 'timeline-edit-gm', role: 'GM', socketId: 'timeline-edit-gm-socket' };
    const actorId = 'timeline-edit-actor';
    const coordinator = new EncounterCoordinator({
        encounterId: 'timeline-gm-edit',
        entities: [createDemoEntity('player-ranged', actorId)],
    });
    coordinator.connect(gm);
    try {
        assert.equal(command(coordinator, gm, 'START', {}).ok, true);
        const accepted = command(coordinator, gm, 'ACTION', {
            entityId: actorId,
            actionTemplateId: DEMO_ACTION_IDS.RANGED,
            targetIds: [],
        });
        assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.reason);
        const original = accepted.snapshot.actions.find(action => action.actorId === actorId);
        assert.ok(original);
        const focusAfterFirstPayment = accepted.snapshot.entities.find(entity => entity.id === actorId)?.resources.current.focus;

        const edited = command(coordinator, gm, 'GM_EDIT_ACTION', {
            actionId: original.actionId,
            actionTemplateId: DEMO_ACTION_IDS.CHANNEL,
            targetIds: [],
            priority: 99,
        });
        assert.equal(edited.ok, true, edited.ok ? '' : edited.reason);
        const replacement = edited.snapshot.actions.filter(action => action.actionId === original.actionId);
        assert.equal(replacement.length, 1, 'editing keeps one authoritative rail for the action');
        assert.equal(replacement[0]?.actionTemplateId, DEMO_ACTION_IDS.CHANNEL);
        assert.deepEqual(replacement[0]?.timeline.pulseTicks, [2, 4, 6],
            'editing rebuilds the timeline from the replacement action rules');
        assert.equal(replacement[0]?.timeline.phaseSegments?.some(segment => segment.phase === 'CHANNELING'), true);
        assert.equal(edited.snapshot.entities.find(entity => entity.id === actorId)?.resources.current.focus,
            focusAfterFirstPayment, 'editing a committed action does not pay resources twice');
    } finally {
        coordinator.close();
    }
}

async function main(): Promise<void> {
    const sequence = actionTemplate('DEMO_TIMELINE_SEQUENCE');
    const { coordinator, gm, actorId } = readyCoordinator(sequence);
    try {
        const accepted = command(coordinator, gm, 'ACTION', {
            entityId: actorId,
            actionTemplateId: sequence.id,
            targetIds: [],
        });
        assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.reason);
        const scheduled = accepted.snapshot.actions.find(action => action.actorId === actorId);
        assert.ok(scheduled, 'committed action is present in the encounter snapshot');
        assert.deepEqual(scheduled.timeline, {
            start: 0,
            startupEnd: 3,
            recoveryStart: 11,
            end: 13,
            pulseTicks: [3, 6, 9],
            activeWindows: [
                { start: 3, end: 5, strikeIndex: 0 },
                { start: 6, end: 8, strikeIndex: 1 },
                { start: 9, end: 11, strikeIndex: 2 },
            ],
            phaseSegments: [
                { phase: 'STARTUP', start: 0, end: 2 },
                { phase: 'SMALL_STARTUP', start: 2, end: 3, strikeIndex: 0 },
                { phase: 'ACTIVE', start: 3, end: 5, strikeIndex: 0 },
                { phase: 'SMALL_STARTUP', start: 5, end: 6, strikeIndex: 1 },
                { phase: 'ACTIVE', start: 6, end: 8, strikeIndex: 1 },
                { phase: 'SMALL_STARTUP', start: 8, end: 9, strikeIndex: 2 },
                { phase: 'ACTIVE', start: 9, end: 11, strikeIndex: 2 },
                { phase: 'RECOVERY', start: 11, end: 13 },
            ],
        }, 'the plan carries the engine-owned multi-strike phase boundaries');
        assert.equal(scheduled.phase, 'STARTUP');
    } finally {
        coordinator.close();
    }

    // A completed move must leave no stale scheduled rail. This guards the
    // full-snapshot path separately from incremental action patches.
    const mover = createDemoEntity('player-melee', 'timeline-mover', { x: 1, y: 1, z: 0 });
    const engine = new CombatEngine('timeline-movement-cleanup');
    engine.setAutoProcess(false);
    engine.mountEntities([mover]);
    engine.receiveIntent({
        actorId: mover.id,
        intentType: 'MOVE',
        clientTick: 0,
        payload: { targetCoords: { x: 2, y: 1, z: 0 } },
    });
    engine.processPending(2);
    assert.equal(engine.getScheduledActions().length, 0, 'movement rail is removed after authoritative recovery');

    // Timeline metadata is safe to retain on public action shells, but a
    // hidden pending action is removed as a whole at the transport boundary.
    const hiddenPlanSnapshot: EncounterSnapshot = {
        encounterId: 'timeline-visibility', revision: 1, tick: 0, status: 'ACTIVE', paused: false,
        entities: [
            createDemoEntity('player-melee', 'visible-player', { x: 1, y: 1, z: 0 }),
            { ...createDemoEntity('monster-bruiser', 'hidden-enemy', { x: 3, y: 1, z: 0 }), visibility: 'GM' },
        ],
        actions: [{
            actionId: 'hidden-plan', actorId: 'hidden-enemy', actionTemplateId: DEMO_ACTION_IDS.MELEE,
            targetIds: ['visible-player'], phase: 'DELAY', declaredTick: 0, priority: 1,
            paidResources: {}, decisionVersion: 1, controlEpoch: 0, causationId: 'hidden-cause',
            timeline: { start: 0, startupEnd: 2, recoveryStart: 3, end: 5 },
        }],
        plan: {
            windowTick: 0,
            slots: [],
            committed: false,
            actions: [],
            barrierVersion: 0,
        },
        decisions: [], controls: [], logs: [],
    };
    const filtered = filterDemoSnapshot(hiddenPlanSnapshot, {
        sessionId: 'timeline-player-session', userId: 'timeline-player', role: 'PL', displayName: 'Player',
        createdAt: 0, expiresAt: 1, reconnectUntil: 1, revoked: false, socketIds: new Set(['socket']),
        controlledEntityIds: new Set(['visible-player']),
    });
    assert.equal(filtered.actions.some(action => action.actionId === 'hidden-plan'), false, 'hidden pending timeline is not disclosed');

    assertInterruptClipsFutureTimeline();
    assertSameTickStartupInterruptHasNoPhantomStrike();
    assertChannelStopTruncatesFuturePulses();
    assertGmEditRefreshesTimeline();

    console.log('demo-timeline-backend: authoritative phases, movement cleanup, lifecycle clipping, GM edit and hidden-plan filtering passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
