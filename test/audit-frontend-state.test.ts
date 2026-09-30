import assert from 'node:assert/strict';
import type { ActionScheduledPayload, DecisionPollPayload, EncounterEntity, EncounterSnapshot } from '@hard-vtt/shared';
import { useGameStore } from '../packages/frontend/src/store/gameStore.ts';
import { useDemoStore } from '../packages/frontend/src/demo/store.ts';
import type { DemoSessionInfo } from '../packages/frontend/src/demo/types.ts';

const entity: EncounterEntity = {
  id: 'audit-player', templateId: 'audit.actor', type: 'ACTOR',
  transform: { coords: { x: 0, y: 0, z: 0 }, facing: 0, planeId: 'audit-map' },
  physics: { scaleClass: 1, collisionRadius: 0.4, mass: 50, movementModes: ['WALK'] },
  resources: { current: { hp: 10 }, max: { hp: 10 } }, activeEffects: [],
};
const action: ActionScheduledPayload = {
  entityId: entity.id, actionId: 'audit-action', actionName: '测试行动',
  timeline: { start: 0, startupEnd: 2, recoveryStart: 3, end: 5, pulseTicks: [2] },
};
const decision: DecisionPollPayload = {
  windowId: 'audit-window-1', actorId: entity.id, windowType: 'REACTION', countdownMs: 1000,
  availableOptions: [], tick: 2,
};
function snapshot(revision: number, encounterId = 'audit-encounter'): EncounterSnapshot {
  return {
    encounterId, revision, tick: revision, status: 'ACTIVE', paused: false,
    entities: [entity], actions: [], decisions: [], logs: [],
    controls: [{ entityId: entity.id, userId: 'audit-user', role: 'PL', controlEpoch: 1, connectedSocketIds: [] }],
    plan: { windowTick: revision, slots: [], actions: [], committed: false, barrierVersion: revision },
  };
}
function session(accessToken = 'audit-token'): DemoSessionInfo {
  return {
    accessToken, snapshot: snapshot(1), session: {
      sessionId: accessToken, userId: 'audit-user', role: 'PL', displayName: '测试玩家',
      expiresAt: 10000, reconnectUntil: 20000, connectedSocketCount: 0, controlledEntityIds: [entity.id],
    },
  };
}

const originalGameState = useGameStore.getState();
const originalDemoState = useDemoStore.getState();
try {
  const game = useGameStore.getState();
  game.setInitialScene([entity], 0);
  game.scheduleAction(action);
  game.setMovementTarget(entity.id, { x: 1, y: 0, z: 0 });
  game.setUiMode('SELECT_MOVE_TARGET');
  game.setActiveWindow(decision);
  game.setCountdownEnd(12345);
  game.triggerReaction();
  game.setInitialScene([entity], 0);
  assert.deepEqual(useGameStore.getState().scheduledActions, [], '完整同步省略动作时不保留旧时间轴');
  assert.deepEqual(useGameStore.getState().movementTargets, {}, '完整同步清空旧移动预测');
  assert.equal(useGameStore.getState().uiState.mode, 'IDLE', '完整同步取消旧目标选择');
  assert.equal(useGameStore.getState().tactical.activeWindow, null, '完整同步清空旧决策窗口');

  game.setActiveWindow(decision);
  game.setCountdownEnd(12345);
  game.triggerReaction();
  game.setActiveWindow({ ...decision });
  assert.equal(useGameStore.getState().tactical.reactionTriggered, true, '同一窗口重发保留接战状态');
  game.setActiveWindow({ ...decision, windowId: 'audit-window-2' });
  assert.equal(useGameStore.getState().tactical.reactionTriggered, false, '新窗口不能继承上一窗口的接战状态');
  assert.equal(useGameStore.getState().tactical.countdownEnd, null, '新窗口不能继承旧截止时间');

  game.scheduleAction(action);
  game.setMovementTarget(entity.id, { x: 1, y: 0, z: 0 });
  game.setSelectedEntityId(entity.id);
  game.setUiMode('SELECT_ACTION_TARGET');
  game.removeEntity(entity.id);
  assert.deepEqual(useGameStore.getState().movementTargets, {}, '移除实体清空移动预测');
  assert.deepEqual(useGameStore.getState().scheduledActions, [], '移除实体清空其时间轴');
  assert.equal(useGameStore.getState().uiState.mode, 'IDLE', '移除施放者取消目标选择');
  assert.equal(useGameStore.getState().tactical.activeWindow, null, '移除反应者清空其决策窗口');

  const demo = useDemoStore.getState();
  demo.clear();
  demo.setSession(session());
  demo.setSnapshot(snapshot(5));
  demo.setRoom({ encounterId: 'audit-encounter', entries: [], snapshot: snapshot(1) });
  assert.equal(useDemoStore.getState().room?.snapshot.revision, 5, '迟到 HTTP/命令快照不能回滚房间状态');
  assert.equal(useDemoStore.getState().snapshot?.revision, 5);
  demo.setRoom({ encounterId: 'audit-encounter', entries: [], snapshot: snapshot(6) });
  assert.equal(useDemoStore.getState().snapshot?.revision, 6, '房间的新权威快照同步到游戏状态');
  demo.setSnapshot({ ...snapshot(7), controls: [] });
  demo.setSession(session(), { encounterId: 'audit-encounter', entries: [], snapshot: snapshot(1) });
  assert.deepEqual(useDemoStore.getState().session?.session.controlledEntityIds, [], '迟到同会话刷新不能恢复已撤销的控制权');
  demo.setSelectedCell({ x: 4, y: 2 });
  demo.addPendingRequest('old-request');
  demo.setCatalog({ entries: [], map: { id: 'old', name: '旧地图', width: 1, height: 1, tiles: [], spawnPoints: {} } });
  demo.setSession(session('new-token'));
  assert.equal(useDemoStore.getState().snapshot, null, '切换会话清空旧遭遇');
  assert.equal(useDemoStore.getState().catalog, null, '切换会话清空旧角色目录');
  assert.deepEqual(useDemoStore.getState().pendingRequests, [], '切换会话清空旧命令');
  assert.equal(useDemoStore.getState().selectedCell, null, '切换会话清空旧 GM 目标格');
} finally {
  useGameStore.setState(originalGameState, true);
  useDemoStore.setState(originalDemoState, true);
}
console.log('PASS: frontend full sync, entity removal, decision identity and session state isolation.');
