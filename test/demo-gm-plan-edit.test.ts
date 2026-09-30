import assert from 'node:assert/strict';
import type { EncounterCommand, EncounterPrincipal } from '../packages/shared/src/index.js';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.js';
import { createDemoEntity, DEMO_ACTION_IDS } from '../packages/backend/src/demo/DemoContent.js';

let requestNumber = 0;

function submit(
    coordinator: EncounterCoordinator,
    principal: EncounterPrincipal,
    type: EncounterCommand['type'],
    payload: Record<string, unknown>,
): ReturnType<EncounterCoordinator['handleCommand']> {
    return coordinator.handleCommand(principal, {
        requestId: `gm-plan-${++requestNumber}`,
        type,
        payload,
    } as EncounterCommand);
}

function startWithOneActor(coordinator: EncounterCoordinator, gm: EncounterPrincipal): void {
    assert.equal(submit(coordinator, gm, 'START', {}).ok, true);
}

function scheduleAction(
    coordinator: EncounterCoordinator,
    gm: EncounterPrincipal,
    actionTemplateId: string,
): string {
    const result = submit(coordinator, gm, 'ACTION', {
        entityId: 'demo-edit-actor',
        actionTemplateId,
        targetIds: [],
    });
    assert.equal(result.ok, true);
    const action = result.snapshot.actions.find(candidate => candidate.actorId === 'demo-edit-actor');
    assert.ok(action);
    return action.actionId;
}

function testCommittedEditKeepsPaidResources(): void {
    const gm: EncounterPrincipal = { userId: 'gm-edit', role: 'GM', socketId: 'gm-edit-socket' };
    const coordinator = new EncounterCoordinator({
        encounterId: 'demo-gm-plan-edit',
        entities: [createDemoEntity('player-ranged', 'demo-edit-actor')],
    });
    coordinator.connect(gm);
    try {
        startWithOneActor(coordinator, gm);
        const actionId = scheduleAction(coordinator, gm, DEMO_ACTION_IDS.RANGED);
        const paidFocus = coordinator.getSnapshot().entities.find(entity => entity.id === 'demo-edit-actor')?.resources.current.focus;
        assert.equal(paidFocus, 6, 'the initial queued action pays exactly once');

        const edited = submit(coordinator, gm, 'GM_EDIT_ACTION', {
            actionId,
            actionTemplateId: DEMO_ACTION_IDS.MELEE,
            priority: 9,
        });
        assert.equal(edited.ok, true, edited.reason ?? edited.message);
        const replacement = edited.snapshot.actions.find(action => action.actionId === actionId);
        assert.ok(replacement, 'the replacement keeps the coordinator action id');
        assert.equal(replacement.actionTemplateId, DEMO_ACTION_IDS.MELEE);
        assert.equal(replacement.priority, 9);
        assert.equal(edited.snapshot.entities.find(entity => entity.id === 'demo-edit-actor')?.resources.current.focus, 6);
        assert.equal(edited.snapshot.revision > 0, true);
        const editAudit = edited.snapshot.logs.find(log => log.actionId === actionId && log.meta?.operation === 'GM_EDIT_ACTION');
        assert.ok(editAudit);
        assert.equal(editAudit.meta?.reason, 'GM 编辑行动');
        assert.ok(editAudit.meta?.before && editAudit.meta?.after);
    } finally {
        coordinator.close();
    }
}

function testGmCancelCommittedAction(): void {
    const gm: EncounterPrincipal = { userId: 'gm-cancel', role: 'GM', socketId: 'gm-cancel-socket' };
    const coordinator = new EncounterCoordinator({
        encounterId: 'demo-gm-plan-cancel',
        entities: [createDemoEntity('player-ranged', 'demo-edit-actor')],
    });
    coordinator.connect(gm);
    try {
        startWithOneActor(coordinator, gm);
        const actionId = scheduleAction(coordinator, gm, DEMO_ACTION_IDS.RANGED);
        const cancelled = submit(coordinator, gm, 'GM_CANCEL_ACTION', { actionId });
        assert.equal(cancelled.ok, true, cancelled.reason ?? cancelled.message);
        assert.equal(cancelled.snapshot.actions.some(action => action.actionId === actionId), false);
        assert.equal(cancelled.snapshot.entities.find(entity => entity.id === 'demo-edit-actor')?.currentActionContext?.phase, 'RECOVERY');
        assert.equal(cancelled.snapshot.entities.find(entity => entity.id === 'demo-edit-actor')?.resources.current.focus, 6);
        const cancelAudit = cancelled.snapshot.logs.find(log => log.actionId === actionId && log.meta?.operation === 'GM_CANCEL_ACTION');
        assert.ok(cancelAudit);
        assert.equal(cancelAudit.meta?.reason, 'GM 取消行动');
        assert.ok(cancelAudit.meta?.before && cancelAudit.meta?.after);
    } finally {
        coordinator.close();
    }
}

function testPlayerCancelEntersRecovery(): void {
    const gm: EncounterPrincipal = { userId: 'gm-player-cancel', role: 'GM', socketId: 'gm-player-cancel-socket' };
    const player: EncounterPrincipal = { userId: 'player-cancel', role: 'PL', socketId: 'player-cancel-socket' };
    const coordinator = new EncounterCoordinator({
        encounterId: 'demo-player-cancel',
        entities: [createDemoEntity('player-ranged', 'demo-edit-actor')],
    });
    coordinator.connect(gm);
    coordinator.connect(player);
    try {
        const assignment = submit(coordinator, gm, 'GM_ASSIGN_ENTITY', {
            entityId: 'demo-edit-actor',
            userId: player.userId,
        });
        assert.equal(assignment.ok, true);
        assert.equal(submit(coordinator, gm, 'START', {}).ok, true);
        const action = submit(coordinator, player, 'ACTION', {
            entityId: 'demo-edit-actor',
            actionTemplateId: DEMO_ACTION_IDS.RANGED,
            targetIds: [],
        });
        assert.equal(action.ok, true);
        const actionId = action.snapshot.actions.find(candidate => candidate.actorId === 'demo-edit-actor')?.actionId;
        assert.ok(actionId);
        const cancelled = submit(coordinator, player, 'CANCEL_ACTION', { actionId });
        assert.equal(cancelled.ok, true, cancelled.reason ?? cancelled.message);
        assert.equal(cancelled.snapshot.entities.find(entity => entity.id === 'demo-edit-actor')?.currentActionContext?.phase, 'RECOVERY');
    } finally {
        coordinator.close();
    }
}

function testPausedQueuedEditRetargetsBeforeEffect(): void {
    const gm: EncounterPrincipal = { userId: 'gm-retarget', role: 'GM', socketId: 'gm-retarget-socket' };
    const coordinator = new EncounterCoordinator({
        encounterId: 'demo-paused-retarget',
        entities: [
            createDemoEntity('player-ranged', 'demo-edit-actor', { x: 1, y: 2, z: 0 }),
            createDemoEntity('monster-bruiser', 'demo-old-target', { x: 3, y: 2, z: 0 }),
            createDemoEntity('monster-marksman', 'demo-new-target', { x: 4, y: 2, z: 0 }),
        ],
    });
    coordinator.connect(gm);
    try {
        startWithOneActor(coordinator, gm);
        const attackerAction = submit(coordinator, gm, 'ACTION', {
            entityId: 'demo-edit-actor',
            actionTemplateId: DEMO_ACTION_IDS.RANGED,
            targetIds: ['demo-old-target'],
        });
        assert.equal(attackerAction.ok, true);
        const oldTargetHp = attackerAction.snapshot.entities.find(entity => entity.id === 'demo-old-target')?.resources.current.hp;
        const newTargetHp = attackerAction.snapshot.entities.find(entity => entity.id === 'demo-new-target')?.resources.current.hp;
        const actionId = attackerAction.snapshot.actions.find(action => action.actorId === 'demo-edit-actor')?.actionId;
        assert.ok(actionId);
        assert.equal(oldTargetHp, 80);
        assert.equal(newTargetHp, 55);

        // Fill the other ready slots synchronously, then pause before the
        // scheduled engine pump can advance the old startup event.
        const waitOld = submit(coordinator, gm, 'WAIT', { entityId: 'demo-old-target' });
        assert.equal(waitOld.ok, true, waitOld.reason ?? waitOld.message);
        const committed = submit(coordinator, gm, 'WAIT', { entityId: 'demo-new-target' });
        assert.equal(committed.ok, true);
        const paused = submit(coordinator, gm, 'GM_PAUSE', { reason: '编辑前冻结' });
        assert.equal(paused.ok, true);
        assert.equal(paused.snapshot.tick, 0);
        assert.equal(paused.snapshot.entities.find(entity => entity.id === 'demo-old-target')?.resources.current.hp, 80);

        const edited = submit(coordinator, gm, 'GM_EDIT_ACTION', {
            actionId,
            targetIds: ['demo-new-target'],
            effectiveTick: 4,
            priority: 99,
        });
        assert.equal(edited.ok, true, edited.reason ?? edited.message);
        assert.equal(edited.snapshot.tick, 0);
        assert.equal(edited.snapshot.entities.find(entity => entity.id === 'demo-old-target')?.resources.current.hp, 80);
        assert.equal(edited.snapshot.entities.find(entity => entity.id === 'demo-new-target')?.resources.current.hp, 55);
        assert.equal(edited.snapshot.entities.find(entity => entity.id === 'demo-edit-actor')?.resources.current.focus, 6);
        assert.equal(edited.snapshot.actions.find(action => action.actionId === actionId)?.targetIds[0], 'demo-new-target');

        // Editing an existing committed action must rebuild its reaction
        // windows.  Resolve those windows as GM before stepping the new tick.
        assert.equal(submit(coordinator, gm, 'GM_PASS_ALL', {}).ok, true);
        const oldTick = submit(coordinator, gm, 'GM_STEP', { count: 1 });
        assert.equal(oldTick.ok, true, oldTick.reason ?? oldTick.message);
        assert.equal(oldTick.snapshot.tick, 3, 'the cancelled old event remains a queue tombstone');
        assert.equal(oldTick.snapshot.entities.find(entity => entity.id === 'demo-old-target')?.resources.current.hp, 80);
        assert.equal(oldTick.snapshot.entities.find(entity => entity.id === 'demo-new-target')?.resources.current.hp, 55);

        const stepped = submit(coordinator, gm, 'GM_STEP', { count: 1 });
        assert.equal(stepped.ok, true, stepped.reason ?? stepped.message);
        assert.equal(stepped.snapshot.tick, 4);
        assert.equal(stepped.snapshot.entities.find(entity => entity.id === 'demo-old-target')?.resources.current.hp, 80);
        assert.equal(stepped.snapshot.entities.find(entity => entity.id === 'demo-new-target')?.resources.current.hp, 41);

        const activeAction = stepped.snapshot.actions.find(action => action.actionId === actionId);
        assert.ok(activeAction);
        const rejected = submit(coordinator, gm, 'GM_EDIT_ACTION', {
            actionId,
            priority: 1,
        });
        assert.equal(rejected.ok, false);
        assert.ok(rejected.code === 'ACTION_ACTIVE' || rejected.code === 'ACTION_RECOVERY');
        assert.equal(rejected.snapshot.actions.find(action => action.actionId === actionId)?.priority, activeAction.priority);
    } finally {
        coordinator.close();
    }
}

testCommittedEditKeepsPaidResources();
testGmCancelCommittedAction();
testPlayerCancelEntersRecovery();
testPausedQueuedEditRetargetsBeforeEffect();
console.log('demo-gm-plan-edit: committed edit, GM tombstone cancel, and player recovery cancel passed');
