import assert from 'node:assert/strict';
import type { EncounterEntity, EncounterSnapshot } from '@hard-vtt/shared';
import { makeCommand } from '../packages/frontend/src/demo/commands.ts';
import { finiteInput } from '../packages/frontend/src/demo/numbers.ts';
import { mergeRefreshedSession, type StoredDemoSession } from '../packages/frontend/src/demo/session.ts';
import { useDemoStore } from '../packages/frontend/src/demo/store.ts';
import type { DemoSessionInfo } from '../packages/frontend/src/demo/types.ts';

function entity(): EncounterEntity {
  return {
    id: 'player-melee',
    templateId: 'demo.player.melee',
    type: 'ACTOR',
    transform: { coords: { x: 1, y: 1, z: 0 }, planeId: 'elysian-demo', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.45, mass: 60, movementModes: ['WALK'] },
    resources: { current: { hp: 100 }, max: { hp: 100 } },
    activeEffects: [],
    faction: 'PLAYERS',
    displayName: '先锋',
  };
}

function snapshot(revision: number, controlEpoch = 0, takenOverByGm = false): EncounterSnapshot {
  return {
    encounterId: 'demo-test',
    revision,
    tick: revision,
    status: 'ACTIVE',
    paused: false,
    entities: [entity()],
    actions: [],
    plan: {
      windowTick: revision,
      slots: [{ entityId: 'player-melee', faction: 'PLAYERS', controllerUserId: 'player-1', connected: true, ready: false, waiting: false, controlEpoch }],
      committed: false,
      actions: [],
      barrierVersion: revision,
    },
    decisions: [],
    controls: [{ entityId: 'player-melee', userId: 'player-1', role: 'PL', controlEpoch, connectedSocketIds: ['socket-1'], takenOverByGm }],
    logs: [],
  };
}

function session(initialSnapshot: EncounterSnapshot): DemoSessionInfo {
  return {
    accessToken: 'access-token',
    session: {
      sessionId: 'session-1',
      userId: 'player-1',
      role: 'PL',
      displayName: '玩家一',
      expiresAt: Date.now() + 60_000,
      reconnectUntil: Date.now() + 120_000,
      connectedSocketCount: 1,
      controlledEntityIds: ['player-melee'],
    },
    snapshot: initialSnapshot,
    joinCode: undefined,
  };
}

const stored: StoredDemoSession = { ...session(snapshot(1)), accessToken: 'stored-token' };
const refreshed = mergeRefreshedSession({ ...session(snapshot(2)), accessToken: '' }, stored);
assert.equal(refreshed.accessToken, 'stored-token', '刷新会话沿用标签页 token');

const command = makeCommand('ACTION', { entityId: 'player-melee', actionTemplateId: 'DEMO_MELEE_STRIKE' }, {
  expectedRevision: 4,
  expectedBarrierVersion: 2,
  expectedDecisionVersion: 7,
  controlEpoch: 3,
});
assert.equal(command.expectedRevision, 4, '行动带全局版本');
assert.equal(command.expectedBarrierVersion, 2, '行动带屏障版本');
assert.equal(command.expectedDecisionVersion, 7, '命令保留决策版本');
assert.equal(command.controlEpoch, 3, '命令带控制 epoch');

assert.equal(finiteInput(''), undefined, '空数字输入不生成 0');
assert.equal(finiteInput('  '), undefined, '空白数字输入不生成 0');
assert.equal(finiteInput('12'), 12, '有效数字输入可提交');

useDemoStore.getState().clear();
useDemoStore.getState().setSession(session(snapshot(1)));
useDemoStore.getState().setSnapshot(snapshot(2));
useDemoStore.getState().setSnapshot(snapshot(1));
assert.equal(useDemoStore.getState().snapshot?.revision, 2, '迟到旧快照不会回滚');
assert.deepEqual(useDemoStore.getState().session?.session.controlledEntityIds, ['player-melee'], '当前控制权同步到玩家会话');

useDemoStore.getState().setSnapshot(snapshot(3, 1, true));
assert.deepEqual(useDemoStore.getState().session?.session.controlledEntityIds, [], 'GM 接管后旧玩家控制权从 UI 消失');

console.log('demo-frontend-regression: 10 assertions passed');
