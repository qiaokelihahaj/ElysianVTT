import assert from 'node:assert/strict';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.js';
import { DEMO_ACTION_IDS } from '../packages/backend/src/demo/DemoContent.js';
import type { EncounterCommand, EncounterPrincipal, EncounterSnapshot } from '../packages/shared/src/index.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function command(
    coordinator: EncounterCoordinator,
    principal: EncounterPrincipal,
    requestId: string,
    type: EncounterCommand['type'],
    payload: Record<string, unknown>,
    controlEpoch?: number,
) {
    return coordinator.handleCommand(principal, {
        requestId,
        type,
        payload,
        ...(controlEpoch === undefined ? {} : { controlEpoch }),
    } as EncounterCommand);
}

async function main(): Promise<void> {
    const coordinator = EncounterCoordinator.createDemo({ encounterId: 'demo-engine-coordinator' });
    const gm: EncounterPrincipal = { userId: 'gm', role: 'GM', socketId: 'gm-socket' };
    const players = [0, 1, 2].map(index => ({
        userId: `player-${index}`,
        role: 'PL' as const,
        socketId: `player-${index}-socket`,
    }));

    try {
        coordinator.connect(gm);
        players.forEach(player => coordinator.connect(player));
        const roster = coordinator.getSnapshot();
        const characters = roster.entities.filter(entity => entity.faction === 'PLAYERS');
        assert.equal(characters.length, 3);
        characters.forEach((entity, index) => {
            const result = command(coordinator, gm, `assign-${index}`, 'GM_ASSIGN_ENTITY', {
                entityId: entity.id,
                userId: players[index].userId,
            });
            assert.equal(result.ok, true);
        });

        assert.equal(command(coordinator, gm, 'start', 'START', {}).ok, true);
        const afterAssignment = coordinator.getSnapshot();
        const epochFor = (entityId: string): number => {
            const epoch = afterAssignment.controls.find(control => control.entityId === entityId)?.controlEpoch;
            assert.notEqual(epoch, undefined);
            return epoch!;
        };

        // Let the GM controlled marksman attack the first player while every
        // other actor submits WAIT.  The barrier must commit atomically.
        const target = characters[0];
        const marksman = afterAssignment.entities.find(entity => entity.id === 'demo-monster-marksman')!;
        assert.equal(command(coordinator, players[0], 'wait-melee', 'WAIT', { entityId: target.id }, epochFor(target.id)).ok, true);
        assert.equal(command(coordinator, players[1], 'wait-ranged', 'WAIT', { entityId: characters[1].id }, epochFor(characters[1].id)).ok, true);
        assert.equal(command(coordinator, players[2], 'wait-guide', 'WAIT', { entityId: characters[2].id }, epochFor(characters[2].id)).ok, true);
        for (const entity of afterAssignment.entities.filter(candidate => candidate.faction === 'ENEMIES' && candidate.id !== marksman.id)) {
            assert.equal(command(coordinator, gm, `wait-${entity.id}`, 'WAIT', { entityId: entity.id }, epochFor(entity.id)).ok, true);
        }
        assert.equal(command(coordinator, gm, 'marksman-shot', 'ACTION', {
            entityId: marksman.id,
            actionTemplateId: DEMO_ACTION_IDS.RANGED,
            targetIds: [target.id],
        }, epochFor(marksman.id)).ok, true);

        const opened = coordinator.getSnapshot();
        assert.equal(opened.tick, 0, 'reaction declaration must not advance the Tick');
        assert.ok(opened.decisions.length > 0, 'GM controlled and player controlled actors receive reaction windows');
        assert.ok(opened.decisions.every(window => window.openedTick === 0));
        const targetWindow = opened.decisions.find(window => window.reactorEntityId === target.id);
        assert.ok(targetWindow, 'the attacked idle player must be offered a reaction');

        // The target chooses PARRY.  The remaining windows are passed by GM;
        // this also checks GM can adjudicate a window owned by another role.
        const parryJoin = command(coordinator, players[0], 'parry-join', 'REACTION_JOIN', {
            windowId: targetWindow!.windowId,
        }, epochFor(target.id));
        assert.equal(parryJoin.ok, true);
        assert.equal(command(coordinator, players[0], 'parry-select', 'REACTION_SELECT', {
            windowId: targetWindow!.windowId,
            optionId: 'PARRY',
        }, epochFor(target.id)).ok, true);
        for (const window of opened.decisions) {
            if (window.windowId === targetWindow!.windowId) continue;
            assert.equal(command(coordinator, gm, `pass-${window.windowId}`, 'GM_PASS', { windowId: window.windowId }).ok, true);
        }

        // The pump advances one heap Tick at a time.  PARRY's recovery ends
        // at Tick 4 and opens a fresh barrier before the marksman's Tick 5/6
        // recovery can be skipped.
        let current: EncounterSnapshot = coordinator.getSnapshot();
        for (let attempt = 0; attempt < 80 && current.tick < 4; attempt++) {
            await delay(5);
            current = coordinator.getSnapshot();
        }
        assert.equal(current.tick, 4);
        const targetAfterParry = current.entities.find(entity => entity.id === target.id)!;
        assert.equal(targetAfterParry.resources.current.hp, target.resources.current.hp! - 7, 'PARRY must halve the real damage');
        assert.equal(targetAfterParry.activeEffects.some(effect => effect.templateId === 'DEMO_PARRY_WINDOW'), false, 'PARRY guard is consumed by the hit');
        assert.equal(current.plan.slots.find(slot => slot.entityId === target.id)?.blockedReason, '等待该玩家提交行动');
        assert.equal(current.actions.some(action => action.actorId === marksman.id), true, 'an unfinished action remains visible with its runtime plan id');

        // No timer should continue through the barrier while a newly idle
        // actor has not submitted.  Closing also removes the deadline timer.
        const heldTick = current.tick;
        await delay(30);
        assert.equal(coordinator.getSnapshot().tick, heldTick);
    } finally {
        coordinator.dispose();
    }
    console.log('demo-engine-coordinator: declaration reactions, GM polls, parry and mixed barrier passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
