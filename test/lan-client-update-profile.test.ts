import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { EncounterEntity, EncounterSnapshot } from '../packages/shared/src/index.js';
import { useDemoStore } from '../packages/frontend/src/demo/store.ts';
import type { DemoSessionInfo } from '../packages/frontend/src/demo/types.ts';

function entity(index = 0): EncounterEntity {
  const id = index === 0 ? 'profile-player' : `profile-npc-${index}`;
  return {
    id,
    templateId: index === 0 ? 'profile.player' : 'profile.npc',
    type: 'ACTOR',
    transform: { coords: { x: index + 1, y: index % 10, z: 0 }, planeId: 'profile', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.45, mass: 60, movementModes: ['WALK'] },
    resources: { current: { hp: 100 }, max: { hp: 100 } },
    activeEffects: [],
    faction: index === 0 ? 'PLAYERS' : 'ENEMIES',
    displayName: index === 0 ? 'Profile Player' : `Profile NPC ${index}`,
  };
}

function snapshot(revision: number, joinRemainingMs: number, takenOverByGm = false, controlEpoch = 1, entityCount = 1, logCount = 0): EncounterSnapshot {
  return {
    encounterId: 'lan-client-update-profile',
    revision,
    tick: revision,
    status: 'ACTIVE',
    paused: false,
    entities: Array.from({ length: entityCount }, (_, index) => entity(index)),
    actions: [],
    plan: {
      windowTick: revision,
      slots: [{
        entityId: 'profile-player',
        faction: 'PLAYERS',
        controllerUserId: 'profile-user',
        connected: true,
        ready: false,
        waiting: false,
        controlEpoch,
      }],
      committed: false,
      actions: [],
      barrierVersion: revision,
    },
    decisions: [{
      windowId: 'profile-window',
      stage: 'REACTION_JOIN',
      sourceActionId: 'profile-action',
      sourceEntityId: 'profile-player',
      reactorEntityId: 'profile-player',
      causationId: 'profile-causation',
      openedTick: revision,
      joinDeadlineAt: 10_000 + revision,
      joinRemainingMs,
      version: 1,
      controlEpoch,
      availableOptions: [],
      respondedSocketIds: [],
      resolved: false,
    }],
    controls: [{
      entityId: 'profile-player',
      userId: 'profile-user',
      role: 'PL',
      controlEpoch,
      connectedSocketIds: ['profile-socket'],
      takenOverByGm,
    }],
    logs: Array.from({ length: logCount }, (_, index) => ({
      id: `profile-log-${revision}-${index}`,
      tick: revision,
      message: `Profile log ${index}`,
    })),
    serverTime: 20_000 + revision,
  };
}

function session(initialSnapshot: EncounterSnapshot): DemoSessionInfo {
  return {
    accessToken: 'profile-token',
    session: {
      sessionId: 'profile-session',
      userId: 'profile-user',
      role: 'PL',
      displayName: 'Profile Player',
      expiresAt: 100_000,
      reconnectUntil: 200_000,
      connectedSocketCount: 1,
      controlledEntityIds: ['profile-player'],
    },
    snapshot: initialSnapshot,
    joinCode: undefined,
  };
}

function percentile(values: number[], quantile: number): number {
  assert.ok(values.length > 0, 'percentile requires at least one sample');
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return Number(sorted[index].toFixed(4));
}

const workload = { entities: 40, logs: 500 };
const warmupCount = 10;
const initial = snapshot(100, 4_000);
const durationsMs: number[] = [];
let storeNotifications = 0;
let snapshotApplications = 0;
let staleSnapshotsRejected = 0;
let replayedSnapshots = 0;
let sameRevisionCountdownApplied = false;
let sameRevisionControlApplied = false;
useDemoStore.getState().clear();
useDemoStore.getState().setSession(session(initial), undefined, initial);
// Warm up the real store before subscribing and before collecting timings.
for (let index = 0; index < warmupCount; index += 1) {
  useDemoStore.getState().setSnapshot(snapshot(100, 3_999, false, 1, workload.entities, workload.logs));
}
const unsubscribe = useDemoStore.subscribe((state, previous) => {
  storeNotifications += 1;
  if (state.snapshot !== previous.snapshot) snapshotApplications += 1;
});

try {

  const replay = (next: EncounterSnapshot, measure = true): boolean => {
    replayedSnapshots += 1;
    const before = useDemoStore.getState().snapshot;
    const startedAt = performance.now();
    useDemoStore.getState().setSnapshot(next);
    const elapsedMs = performance.now() - startedAt;
    const after = useDemoStore.getState().snapshot;
    const applied = after !== before;
    if (applied) {
      if (measure) durationsMs.push(elapsedMs);
    } else {
      staleSnapshotsRejected += 1;
    }
    return applied;
  };

  const sameRevisionCountdown = snapshot(100, 3_500);
  sameRevisionCountdownApplied = replay(sameRevisionCountdown, false);
  assert.equal(sameRevisionCountdownApplied, true, 'same revision countdown snapshot is applied');
  assert.equal(useDemoStore.getState().snapshot?.decisions[0]?.joinRemainingMs, 3_500,
    'same revision countdown change reaches the real Demo store');

  const sameRevisionControl = snapshot(100, 3_500, true, 2);
  sameRevisionControlApplied = replay(sameRevisionControl, false);
  assert.equal(sameRevisionControlApplied, true, 'same revision control snapshot is applied');
  assert.equal(useDemoStore.getState().snapshot?.controls[0]?.takenOverByGm, true,
    'same revision control change reaches the real Demo store');
  assert.deepEqual(useDemoStore.getState().session?.session.controlledEntityIds, [],
    'control takeover updates the player session projection');

  const notificationsBeforeStale = storeNotifications;
  const applicationsBeforeStale = snapshotApplications;
  assert.equal(replay(snapshot(99, 9_999, false, 1)), false, 'older revision is rejected');
  assert.equal(storeNotifications, notificationsBeforeStale, 'older revision does not notify subscribers');
  assert.equal(snapshotApplications, applicationsBeforeStale, 'older revision is not counted as applied');
  assert.equal(useDemoStore.getState().snapshot?.revision, 100, 'older revision does not roll back current state');
  assert.equal(useDemoStore.getState().snapshot?.decisions[0]?.joinRemainingMs, 3_500,
    'older revision cannot overwrite the countdown');
  assert.equal(useDemoStore.getState().snapshot?.controls[0]?.takenOverByGm, true,
    'older revision cannot overwrite control ownership');

  for (let revision = 101; revision < 201; revision += 1) {
    const next = snapshot(revision, 4_000 - (revision - 101) * 10, revision % 2 === 0, revision % 2 === 0 ? 2 : 1, workload.entities, workload.logs);
    assert.equal(replay(next), true, `revision ${revision} is applied`);
  }

  assert.equal(snapshotApplications, storeNotifications, 'each accepted snapshot produced one store notification');
  assert.equal(staleSnapshotsRejected, 1, 'only the intentionally stale replay was rejected');
  assert.equal(useDemoStore.getState().snapshot?.revision, 200, 'latest replayed revision is retained');

  const report = {
    replayedSnapshots,
    warmupCount,
    measuredSnapshots: durationsMs.length,
    snapshotApplications,
    storeNotifications,
    staleSnapshotsRejected,
    durationsMs: {
      count: durationsMs.length,
      p50: percentile(durationsMs, 0.5),
      p95: percentile(durationsMs, 0.95),
      max: Number(Math.max(...durationsMs).toFixed(4)),
    },
    workload,
    behavior: {
      sameRevisionCountdownApplied,
      sameRevisionControlApplied,
      staleRevisionRejected: staleSnapshotsRejected === 1,
    },
    definition: 'durationsMs measure direct useDemoStore.setSnapshot calls; they are not React render or network timings.',
  };
  console.log(`[lan-client-update-profile] ${JSON.stringify(report)}`);
} finally {
  unsubscribe();
  useDemoStore.getState().clear();
}
