import assert from 'node:assert/strict';
import type { Entity } from '@hard-vtt/shared';
import { useGameStore } from '../packages/frontend/src/store/gameStore.ts';

// 直接验证生产 Zustand/Immer store；复制实现会掩盖真正的状态同步回归。
function actor(id: string, hp = 100): Entity {
  return {
    id, templateId: 'hero', type: 'ACTOR',
    transform: { coords: { x: 0, y: 0, z: 0 }, planeId: 'ground', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 1, mass: 100, movementModes: ['WALK'] },
    resources: { current: { hp }, max: { hp } }, activeEffects: [],
  };
}

const initial = useGameStore.getInitialState();
const previous = useGameStore.getState();
try {
  useGameStore.setState(initial, true);
  assert.equal(initial.tick, 0);
  assert.deepEqual(initial.entities, {});
  assert.equal(initial.selectedEntityId, null);
  assert.deepEqual(initial.uiState, { mode: 'IDLE', pendingMoveCoords: null, activeActionId: null });

  const actions = useGameStore.getState();
  const warrior = actor('warrior');
  actions.setInitialScene([warrior], 42);
  assert.equal(useGameStore.getState().tick, 42);
  assert.equal(Object.keys(useGameStore.getState().entities).length, 1);
  assert.equal(useGameStore.getState().entities.warrior.resources.current.hp, 100);
  actions.setSelectedEntityId(warrior.id);
  assert.equal(useGameStore.getState().selectedEntityId, warrior.id);
  actions.setSelectedEntityId(null);
  assert.equal(useGameStore.getState().selectedEntityId, null);

  actions.addEntity(actor('goblin', 30));
  assert.equal(useGameStore.getState().entities.goblin.resources.current.hp, 30);
  actions.setSelectedEntityId('goblin');
  const beforeMutation = useGameStore.getState();
  actions.applyStateMutation({
    tick: 50,
    mutations: [{ entityId: 'goblin', changes: { 'transform.coords.x': 150, 'resources.current.hp': 15 } }],
  });
  const afterMutation = useGameStore.getState();
  assert.equal(afterMutation.tick, 50);
  assert.equal(afterMutation.entities.goblin.transform.coords.x, 150);
  assert.equal(afterMutation.entities.goblin.resources.current.hp, 15);
  assert.equal(afterMutation.selectedEntityId, 'goblin');
  assert.equal(beforeMutation.entities.goblin.resources.current.hp, 30, 'Immer 保留旧状态快照');
  assert.equal(afterMutation.entities.warrior, beforeMutation.entities.warrior, '未修改实体保留对象身份');

  actions.setUiMode('SELECT_MOVE_TARGET');
  actions.setPendingMoveCoords({ x: 200, y: 200, z: 0 });
  assert.equal(useGameStore.getState().uiState.mode, 'SELECT_MOVE_TARGET');
  assert.equal(useGameStore.getState().uiState.pendingMoveCoords?.x, 200);
  actions.setUiMode('IDLE');
  assert.equal(useGameStore.getState().uiState.pendingMoveCoords, null);
  actions.setActiveActionId('HEAVY_STRIKE');
  actions.setUiMode('SELECT_ACTION_TARGET');
  actions.resetUiState();
  assert.deepEqual(useGameStore.getState().uiState, initial.uiState);

  actions.setSelectedEntityId('goblin');
  actions.removeEntity('goblin');
  assert.equal(useGameStore.getState().entities.goblin, undefined);
  assert.equal(useGameStore.getState().selectedEntityId, null);
  actions.setInitialScene([actor('replacement')], 0);
  assert.deepEqual(Object.keys(useGameStore.getState().entities), ['replacement']);
  assert.equal(useGameStore.getState().tick, 0, '新场景可以从 Tick 0 开始');
} finally {
  useGameStore.setState(previous, true);
}
console.log('PASS: production frontend store initialization, mutation, selection and UI state.');
