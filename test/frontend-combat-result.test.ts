import assert from 'node:assert/strict';
import { useGameStore } from '../packages/frontend/src/store/gameStore.ts';
import type { Entity } from '../packages/shared/src/index.js';

const actor: Entity = { id: 'hero', templateId: 'hero', type: 'ACTOR',
    transform: { coords: { x: 1, y: 0, z: 0 }, planeId: 'test', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 1, mass: 1, movementModes: [] },
    resources: { current: { hp: 50 }, max: { hp: 50 } }, activeEffects: [] };
const original = useGameStore.getState();
try {
    original.setInitialScene([actor], 12);
    original.setUiMode('SELECT_MOVE_TARGET');
    original.setMovementTarget(actor.id, { x: 2, y: 0, z: 0 });
    original.setActiveWindow({ windowId: 'window', actorId: actor.id, windowType: 'REACTION', tick: 12,
        sourceAction: { actorId: 'enemy', actionName: 'strike', startupRemainingTicks: 0 }, countdownMs: 3000, availableOptions: [] });
    original.triggerReaction();
    original.finishCombat({ sceneId: 'test', tick: 10, survivors: [actor.id], casualties: [], entities: [actor] });
    const state = useGameStore.getState();
    assert.equal(state.tick, 12, '结算快照不能使最新 Tick 倒退');
    assert.equal(state.combatResult?.sceneId, 'test');
    assert.equal(state.tactical.activeWindow, null);
    assert.equal(state.tactical.reactionTriggered, false);
    assert.equal(state.tactical.frozenTick, null);
    assert.equal(state.uiState.mode, 'IDLE');
    assert.deepEqual(state.movementTargets, {});
    assert.deepEqual(state.scheduledActions, []);
    original.setInitialScene([actor], 0);
    assert.equal(useGameStore.getState().combatResult, null);
    console.log('frontend combat result: real store cleanup passed');
} finally {
    useGameStore.setState(original, true);
}
