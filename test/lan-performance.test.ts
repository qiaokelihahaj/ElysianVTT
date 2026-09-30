import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { io, type Socket } from 'socket.io-client';
import type {
  DemoSessionResponse,
  EncounterCommand,
  EncounterCommandResult,
  EncounterEntity,
  EncounterIncrement,
  EncounterSnapshot,
  EncounterRulePack,
} from '@hard-vtt/shared';
import { createDemoContent, createDemoEntity } from '../packages/backend/src/demo/DemoContent.js';
import { createEncounterServer, type EncounterServerHandle } from '../packages/backend/src/network/EncounterServer.js';
import { SqliteEncounterRepository } from '../packages/backend/src/persistence/SqliteEncounterRepository.js';

type PerfEventName = 'DEMO_SNAPSHOT' | 'DEMO_INCREMENT' | 'DEMO_ROSTER' | 'DEMO_ERROR';

const PERF_EVENTS: readonly PerfEventName[] = [
  'DEMO_SNAPSHOT',
  'DEMO_INCREMENT',
  'DEMO_ROSTER',
  'DEMO_ERROR',
];

const PLAYER_TEMPLATES = ['player-melee', 'player-ranged', 'player-guide'] as const;
const ENEMY_TEMPLATES = ['monster-bruiser', 'monster-marksman', 'monster-channeler'] as const;
const PLAYER_IDS = ['perf-player-0', 'perf-player-1', 'perf-player-2'] as const;
const ACTION_ID = 'DEMO_MELEE_STRIKE';
const SOCKET_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 15_000;
const SOCKET_DELIVERY_TIMEOUT_MS = 10_000;
const MAX_ENTITY_HP = 1_000_000;

interface ScenarioConfig {
  name: 'small' | 'expanded' | 'history';
  entityCount: number;
  warmupRounds: number;
  measuredRounds: number;
}

interface SocketMetrics {
  readonly label: string;
  readonly eventCounts: Record<PerfEventName, number>;
  readonly eventJsonBytes: Record<PerfEventName, number>;
  readonly stateEventSnapshotJsonBytes: number[];
  readonly stateEventIncrementJsonBytes: number[];
  stateReceivedCount: number;
  acceptedByRevisionGateCount: number;
  rejectedByRevisionGateCount: number;
  latestAppliedRevision?: number;
  ackCount: number;
  ackJsonBytes: number;
  ackSnapshotJsonBytes: number;
  reset(): void;
  totalEventCount(): number;
  totalEventJsonBytes(): number;
}

interface ConnectedSocket {
  socket: Socket;
  metrics: SocketMetrics;
}

interface RuntimeMeasurements {
  measuring: boolean;
  sourceIncrementTotal: number;
  tickDurationsMs: number[];
  broadcastDurationsMs: number[];
  restore(): void;
}

interface DistributionSummary {
  count: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

interface ScenarioReport {
  name: ScenarioConfig['name'];
  workload: {
    entityCount: number;
    playerCount: number;
    gmCount: number;
    warmupRounds: number;
    measuredRounds: number;
    measuredBarrierCount: number;
    measuredActionCommandCount: number;
    measuredWaitCommandCount: number;
    transport: 'socket.io websocket';
    actionFixture: {
      templateId: string;
      startupTicks: number;
      activeWindowTicks: number;
      recoveryTicks: number;
      priority: number;
      damage: number;
      random: false;
    };
  };
  result: {
    finalTick: number;
    finalRevision: number;
    finalLogCount: number;
    submittedActionCount: number;
  };
  source: {
    incrementCount: number;
    tickCount: number;
    processPendingDurationMs: DistributionSummary;
    processPendingIncludesSynchronousBroadcast: true;
    broadcastCount: number;
    broadcastDurationMs: DistributionSummary;
  };
  sockets: Array<{
    label: string;
    eventCounts: Record<PerfEventName, number>;
    eventJsonBytes: Record<PerfEventName, number>;
    totalEventCount: number;
    totalEventJsonBytes: number;
    state: {
      receivedCount: number;
      acceptedByRevisionGateCount: number;
      rejectedByRevisionGateCount: number;
      latestAppliedRevision?: number;
      snapshotJsonBytes: {
        count: number;
        total: number;
        p50: number;
        p95: number;
        max: number;
      };
      incrementJsonBytes: {
        count: number;
        total: number;
        p50: number;
        p95: number;
        max: number;
      };
    };
    commandAck: {
      count: number;
      ackJsonBytes: number;
      snapshotJsonBytes: number;
    };
  }>;
  aggregate: {
    eventCountAcrossSockets: number;
    eventJsonBytesAcrossSockets: number;
    commandAckCountAcrossSockets: number;
    commandAckJsonBytesAcrossSockets: number;
    commandAckSnapshotJsonBytesAcrossSockets: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

function summarize(values: readonly number[]): DistributionSummary {
  assert.ok(values.length > 0, 'performance sample must contain at least one value');
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return {
    count: sorted.length,
    totalMs: roundMetric(sorted.reduce((total, value) => total + value, 0)),
    p50Ms: roundMetric(percentile(0.5)),
    p95Ms: roundMetric(percentile(0.95)),
    maxMs: roundMetric(sorted[sorted.length - 1]),
  };
}

function summarizeBytes(values: readonly number[]) {
  if (values.length === 0) return { count: 0, total: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return {
    count: sorted.length,
    total: sorted.reduce((total, value) => total + value, 0),
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted[sorted.length - 1],
  };
}

function isSnapshot(value: unknown): value is EncounterSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.encounterId === 'string'
    && typeof value.revision === 'number'
    && typeof value.tick === 'number'
    && Array.isArray(value.entities)
    && Array.isArray(value.actions)
    && Array.isArray(value.decisions)
    && Array.isArray(value.controls)
    && Array.isArray(value.logs)
    && isRecord(value.plan);
}

function createSocketMetrics(label: string, socket: Socket): SocketMetrics {
  const eventCounts = Object.fromEntries(PERF_EVENTS.map(event => [event, 0])) as Record<PerfEventName, number>;
  const eventJsonBytes = Object.fromEntries(PERF_EVENTS.map(event => [event, 0])) as Record<PerfEventName, number>;
  const stateEventSnapshotJsonBytes: number[] = [];
  const stateEventIncrementJsonBytes: number[] = [];
  const metrics: SocketMetrics = {
    label,
    eventCounts,
    eventJsonBytes,
    stateEventSnapshotJsonBytes,
    stateEventIncrementJsonBytes,
    stateReceivedCount: 0,
    acceptedByRevisionGateCount: 0,
    rejectedByRevisionGateCount: 0,
    latestAppliedRevision: undefined,
    ackCount: 0,
    ackJsonBytes: 0,
    ackSnapshotJsonBytes: 0,
    reset(): void {
      for (const event of PERF_EVENTS) {
        metrics.eventCounts[event] = 0;
        metrics.eventJsonBytes[event] = 0;
      }
      metrics.stateEventSnapshotJsonBytes.length = 0;
      metrics.stateEventIncrementJsonBytes.length = 0;
      metrics.stateReceivedCount = 0;
      metrics.acceptedByRevisionGateCount = 0;
      metrics.rejectedByRevisionGateCount = 0;
      metrics.latestAppliedRevision = undefined;
      metrics.ackCount = 0;
      metrics.ackJsonBytes = 0;
      metrics.ackSnapshotJsonBytes = 0;
    },
    totalEventCount(): number {
      return PERF_EVENTS.reduce((total, event) => total + metrics.eventCounts[event], 0);
    },
    totalEventJsonBytes(): number {
      return PERF_EVENTS.reduce((total, event) => total + metrics.eventJsonBytes[event], 0);
    },
  };

  const record = (event: PerfEventName, payload: unknown): void => {
    metrics.eventCounts[event] += 1;
    metrics.eventJsonBytes[event] += jsonBytes(payload);
  };

  const applySnapshot = (snapshot: unknown): void => {
    metrics.stateReceivedCount += 1;
    if (!isSnapshot(snapshot)) {
      metrics.rejectedByRevisionGateCount += 1;
      return;
    }
    if (metrics.latestAppliedRevision !== undefined && snapshot.revision < metrics.latestAppliedRevision) {
      metrics.rejectedByRevisionGateCount += 1;
      return;
    }
    metrics.latestAppliedRevision = snapshot.revision;
    metrics.acceptedByRevisionGateCount += 1;
  };

  socket.on('DEMO_SNAPSHOT', (payload: unknown) => {
    record('DEMO_SNAPSHOT', payload);
    if (isRecord(payload)) {
      const snapshot = payload.snapshot;
      if (isSnapshot(snapshot)) metrics.stateEventSnapshotJsonBytes.push(jsonBytes(snapshot));
      applySnapshot(snapshot);
    } else {
      applySnapshot(undefined);
    }
  });
  socket.on('DEMO_INCREMENT', (payload: unknown) => {
    record('DEMO_INCREMENT', payload);
    if (isRecord(payload)) {
      const snapshot = payload.snapshot;
      const increment = payload.increment;
      if (isSnapshot(snapshot)) metrics.stateEventSnapshotJsonBytes.push(jsonBytes(snapshot));
      if (isRecord(increment)) metrics.stateEventIncrementJsonBytes.push(jsonBytes(increment));
      applySnapshot(snapshot);
    } else {
      applySnapshot(undefined);
    }
  });
  socket.on('DEMO_ROSTER', (payload: unknown) => record('DEMO_ROSTER', payload));
  socket.on('DEMO_ERROR', (payload: unknown) => record('DEMO_ERROR', payload));

  return metrics;
}

function createEntities(name: ScenarioConfig['name'], entityCount: number): EncounterEntity[] {
  assert.ok(entityCount >= PLAYER_TEMPLATES.length + 3, 'scenario must include three player entities and enemies');
  const entities: EncounterEntity[] = [];
  for (let index = 0; index < PLAYER_TEMPLATES.length; index += 1) {
    const entity = createDemoEntity(PLAYER_TEMPLATES[index], PLAYER_IDS[index], { x: index + 1, y: 2, z: 0 });
    normalizeEntityForBenchmark(entity);
    entities.push(entity);
  }
  for (let index = 0; index < entityCount - PLAYER_TEMPLATES.length; index += 1) {
    const template = ENEMY_TEMPLATES[index % ENEMY_TEMPLATES.length];
    const position = index < 3
      ? { x: index + 2, y: 2, z: 0 }
      : { x: 1 + (index % 8), y: 1 + Math.floor(index / 8), z: 0 };
    const entity = createDemoEntity(template, `perf-${name}-enemy-${index}`, position);
    normalizeEntityForBenchmark(entity);
    entities.push(entity);
  }
  return entities;
}

function normalizeEntityForBenchmark(entity: EncounterEntity): void {
  entity.resources.current.hp = MAX_ENTITY_HP;
  entity.resources.max.hp = MAX_ENTITY_HP;
  // A zero focus/poise pool keeps the measured melee barriers free of
  // reaction windows while leaving the real action, timeline and broadcast
  // path intact.  The melee action has no resource cost.
  entity.resources.current.focus = 0;
  entity.resources.max.focus = 0;
  entity.resources.current.poise = 0;
  entity.resources.max.poise = 0;
}

/**
 * Keep the measured barrier cadence deterministic without changing DemoContent.
 * The production Demo melee action has a three-Tick active window; the
 * benchmark fixture uses one active Tick so its 2 + 1 + 2 action lifetime
 * matches the coordinator's five-Tick WAIT wake marker.
 */
function createPerformanceContent(): EncounterRulePack {
  const content = createDemoContent();
  const melee = content.actionTemplates.find(template => template.id === ACTION_ID);
  assert.ok(melee, `missing benchmark action template ${ACTION_ID}`);
  melee.timeCost = { startupTicks: 2, recoveryTicks: 2 };
  melee.activeWindowTicks = 1;
  melee.priorityExpr = '10';
  const damage = melee.effects.find(effect => effect.type === 'DAMAGE');
  assert.ok(damage, `missing deterministic damage effect for ${ACTION_ID}`);
  damage.parameters.amountExpr = '18';
  return content;
}

function initialSnapshot(encounterId: string, entities: EncounterEntity[]): EncounterSnapshot {
  return {
    encounterId,
    revision: 0,
    tick: 0,
    status: 'LOBBY',
    paused: false,
    entities,
    actions: [],
    plan: { windowTick: 0, slots: [], committed: false, actions: [], barrierVersion: 0 },
    decisions: [],
    controls: [],
    logs: [],
  };
}

function installRuntimeMeasurements(server: EncounterServerHandle): RuntimeMeasurements {
  const coordinator = server.coordinator as unknown as {
    engine: {
      currentTick: number;
      processPending(maxSteps?: number): void;
    };
    on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
    off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  };
  const engine = coordinator.engine;
  const originalProcessPending = engine.processPending;
  const serverProbe = server as unknown as {
    broadcastSnapshot?: (increment?: EncounterIncrement) => void;
  };
  const originalBroadcastSnapshot = serverProbe.broadcastSnapshot;
  const measurements: RuntimeMeasurements = {
    measuring: false,
    sourceIncrementTotal: 0,
    tickDurationsMs: [],
    broadcastDurationsMs: [],
    restore(): void {
      engine.processPending = originalProcessPending;
      if (originalBroadcastSnapshot) serverProbe.broadcastSnapshot = originalBroadcastSnapshot;
      coordinator.off?.('INCREMENT', onIncrement);
    },
  };
  const onIncrement = (..._args: unknown[]): void => {
    measurements.sourceIncrementTotal += 1;
  };
  coordinator.on?.('INCREMENT', onIncrement);
  engine.processPending = (maxSteps?: number): void => {
    const startedAt = performance.now();
    try {
      originalProcessPending.call(engine, maxSteps);
    } finally {
      if (measurements.measuring) measurements.tickDurationsMs.push(performance.now() - startedAt);
    }
  };
  if (originalBroadcastSnapshot) {
    serverProbe.broadcastSnapshot = (increment?: EncounterIncrement): void => {
      const startedAt = performance.now();
      try {
        originalBroadcastSnapshot.call(server, increment);
      } finally {
        if (measurements.measuring) measurements.broadcastDurationsMs.push(performance.now() - startedAt);
      }
    };
  }
  return measurements;
}

async function requestJson<T>(url: string, path: string, body?: unknown, token?: string): Promise<{ response: Response; data: T }> {
  const response = await fetch(`${url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json() as T;
  return { response, data };
}

async function login(url: string, kind: 'host' | 'join', body: unknown): Promise<DemoSessionResponse['data']> {
  const result = await requestJson<DemoSessionResponse>(url, `/api/demo/${kind}`, body);
  assert.equal(result.response.status, 200, `${kind} HTTP status`);
  assert.equal(result.data.ok, true, `${kind} response`);
  return result.data.data;
}

async function connectSocket(url: string, accessToken: string, label: string): Promise<ConnectedSocket> {
  const socket = io(url, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: { accessToken },
  });
  const metrics = createSocketMetrics(label, socket);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} socket connection timed out`)), SOCKET_TIMEOUT_MS);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('connect_error', error => {
        clearTimeout(timer);
        reject(error);
      });
      socket.connect();
    });
  } catch (error) {
    socket.disconnect();
    throw error;
  }
  return { socket, metrics };
}

async function command(
  connected: ConnectedSocket,
  sequence: { value: number },
  type: EncounterCommand['type'],
  payload: Record<string, unknown>,
  controlEpoch?: number,
): Promise<EncounterCommandResult> {
  const requestId = `lan-perf-${connected.metrics.label}-${++sequence.value}`;
  const rawCommand = {
    requestId,
    type,
    payload,
    ...(controlEpoch === undefined ? {} : { controlEpoch }),
  } as unknown as EncounterCommand;
  return new Promise<EncounterCommandResult>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`command timed out: ${type}`)), SOCKET_TIMEOUT_MS);
    connected.socket.timeout(SOCKET_TIMEOUT_MS).emit(
      'DEMO_COMMAND',
      rawCommand,
      (error: Error | null, result: EncounterCommandResult | undefined) => {
        clearTimeout(timer);
        if (error) {
          reject(error);
          return;
        }
        if (!result) {
          reject(new Error(`missing ACK for ${type}`));
          return;
        }
        connected.metrics.ackCount += 1;
        connected.metrics.ackJsonBytes += jsonBytes(result);
        connected.metrics.ackSnapshotJsonBytes += jsonBytes(result.snapshot);
        resolve(result);
      },
    );
  });
}

async function currentSnapshot(url: string, accessToken: string): Promise<EncounterSnapshot> {
  const result = await requestJson<DemoSessionResponse>(url, '/api/demo/session', undefined, accessToken);
  assert.equal(result.response.status, 200, 'session HTTP status');
  assert.equal(result.data.ok, true, 'session response');
  return result.data.data.snapshot;
}

function isIdle(snapshot: EncounterSnapshot, minimumTick: number): boolean {
  return snapshot.tick > minimumTick
    && snapshot.actions.length === 0
    && snapshot.plan.actions.length === 0
    && snapshot.decisions.length === 0
    && snapshot.plan.slots.every((slot: EncounterSnapshot['plan']['slots'][number]) => !slot.ready && !slot.waiting && slot.readyAtTick === undefined);
}

async function waitForIdle(url: string, accessToken: string, minimumTick: number): Promise<EncounterSnapshot> {
  const deadline = performance.now() + IDLE_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const snapshot = await currentSnapshot(url, accessToken);
    if (isIdle(snapshot, minimumTick)) return snapshot;
    await new Promise<void>(resolve => setTimeout(resolve, 3));
  }
  throw new Error(`encounter did not reach idle after Tick ${minimumTick}`);
}

async function waitForRevision(sockets: readonly ConnectedSocket[], minimumRevision: number): Promise<void> {
  const deadline = performance.now() + SOCKET_DELIVERY_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (sockets.every(client => (client.metrics.latestAppliedRevision ?? -1) >= minimumRevision)) return;
    await new Promise<void>(resolve => setTimeout(resolve, 2));
  }
  const revisions = sockets.map(client => `${client.metrics.label}=${client.metrics.latestAppliedRevision ?? 'none'}`).join(', ');
  throw new Error(`Socket.IO state delivery did not catch up to revision ${minimumRevision}: ${revisions}`);
}

async function runBarrier(
  server: EncounterServerHandle,
  url: string,
  gmAccessToken: string,
  sockets: { gm: ConnectedSocket; players: ConnectedSocket[] },
  entities: EncounterEntity[],
  sequence: { value: number },
): Promise<number> {
  const before = server.coordinator.getSnapshot();
  const enemyTargets = entities.filter(entity => entity.faction === 'ENEMIES').slice(0, 3);
  assert.equal(enemyTargets.length, 3, 'barrier target fixture');
  let submittedActionCount = 0;
  for (let index = 0; index < sockets.players.length; index += 1) {
    const player = entities[index];
    const control = before.controls.find(candidate => candidate.entityId === player.id);
    assert.ok(control, `control fixture for ${player.id}`);
    const result = await command(sockets.players[index], sequence, 'ACTION', {
      entityId: player.id,
      actionTemplateId: ACTION_ID,
      targetIds: [enemyTargets[index].id],
    }, control.controlEpoch);
    assert.equal(result.ok, true, `${sockets.players[index].metrics.label} action accepted`);
    submittedActionCount += 1;
  }
  const playerIds = new Set(PLAYER_IDS);
  for (const entity of entities) {
    if (playerIds.has(entity.id as typeof PLAYER_IDS[number])) continue;
    const result = await command(sockets.gm, sequence, 'WAIT', { entityId: entity.id });
    assert.equal(result.ok, true, `GM wait accepted for ${entity.id}`);
  }
  await waitForIdle(url, gmAccessToken, before.tick);
  return submittedActionCount;
}

async function runScenario(config: ScenarioConfig): Promise<ScenarioReport> {
  const dataDirectory = realpathSync(mkdtempSync(join(tmpdir(), `elysian-lan-perf-${config.name}-`)));
  const encounterId = `lan-perf-${config.name}`;
  const entities = createEntities(config.name, config.entityCount);
  const sockets: ConnectedSocket[] = [];
  const sequence = { value: 0 };
  let server: EncounterServerHandle | undefined;
  let measurements: RuntimeMeasurements | undefined;
  let persistence: SqliteEncounterRepository | undefined;
  try {
    const hostCredential = randomBytes(16).toString('hex');
    const joinCode = randomBytes(4).toString('hex').toUpperCase();
    const content = createPerformanceContent();
    persistence = new SqliteEncounterRepository({ dataDirectory });
    try {
      server = await createEncounterServer({
        content,
        entities,
        persistence,
        initialSnapshot: initialSnapshot(encounterId, entities),
        encounterId,
        hostCredential,
        joinCode,
        host: '127.0.0.1',
        port: 0,
      });
    } catch (error) {
      persistence.close();
      persistence = undefined;
      throw error;
    }
    const listenResult = await server.listen();
    measurements = installRuntimeMeasurements(server);

    const host = await login(listenResult.url, 'host', {
      credential: hostCredential,
      displayName: 'Performance GM',
    });
    const players = await Promise.all(['P1', 'P2', 'P3'].map(displayName => login(listenResult.url, 'join', {
      joinCode,
      displayName,
    })));
    const gm = await connectSocket(listenResult.url, host.accessToken, 'GM');
    sockets.push(gm);
    const playerSockets: ConnectedSocket[] = [];
    for (let index = 0; index < players.length; index += 1) {
      const connected = await connectSocket(listenResult.url, players[index].accessToken, `P${index + 1}`);
      sockets.push(connected);
      playerSockets.push(connected);
    }

    for (let index = 0; index < playerSockets.length; index += 1) {
      const assignment = await requestJson(listenResult.url, '/api/demo/assign', {
        userId: players[index].session.userId,
        entityId: PLAYER_IDS[index],
      }, host.accessToken);
      assert.equal(assignment.response.status, 200, `assignment ${index}`);
    }

    const connected = { gm, players: playerSockets };
    const start = await command(gm, sequence, 'START', {});
    assert.equal(start.ok, true, 'GM start accepted');
    for (let warmup = 0; warmup < config.warmupRounds; warmup += 1) {
      await runBarrier(server, listenResult.url, host.accessToken, connected, entities, sequence);
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    await waitForRevision(sockets, server.coordinator.getSnapshot().revision);
    for (const client of sockets) client.metrics.reset();
    const sourceStart = measurements.sourceIncrementTotal;
    measurements.measuring = true;
    let submittedActionCount = 0;
    for (let round = 0; round < config.measuredRounds; round += 1) {
      submittedActionCount += await runBarrier(server, listenResult.url, host.accessToken, connected, entities, sequence);
    }
    const finalSnapshot = await currentSnapshot(listenResult.url, host.accessToken);
    const measuredSourceIncrementCount = measurements.sourceIncrementTotal - sourceStart;
    await waitForRevision(sockets, finalSnapshot.revision);
    measurements.measuring = false;

    assert.ok(measuredSourceIncrementCount > 0, 'measured workload must emit state increments');
    assert.ok(measurements.tickDurationsMs.length > 0, 'measured workload must process at least one Tick');
    assert.equal(measurements.broadcastDurationsMs.length, measuredSourceIncrementCount, 'one measured broadcast per source increment');
    for (const client of sockets) {
      assert.equal(client.metrics.eventCounts.DEMO_INCREMENT, measuredSourceIncrementCount, `${client.metrics.label} receives each measured increment`);
      assert.equal(client.metrics.stateReceivedCount, client.metrics.acceptedByRevisionGateCount, `${client.metrics.label} accepts each measured state event by revision`);
      assert.equal(client.metrics.rejectedByRevisionGateCount, 0, `${client.metrics.label} state revisions are ordered`);
    }

    const sourceIncrements = measuredSourceIncrementCount;
    const report: ScenarioReport = {
      name: config.name,
      workload: {
        entityCount: config.entityCount,
        playerCount: 3,
        gmCount: 1,
        warmupRounds: config.warmupRounds,
        measuredRounds: config.measuredRounds,
        measuredBarrierCount: config.measuredRounds,
        measuredActionCommandCount: config.measuredRounds * 3,
        measuredWaitCommandCount: config.measuredRounds * (config.entityCount - 3),
        transport: 'socket.io websocket',
        actionFixture: {
          templateId: ACTION_ID,
          startupTicks: 2,
          activeWindowTicks: 1,
          recoveryTicks: 2,
          priority: 10,
          damage: 18,
          random: false,
        },
      },
      result: {
        finalTick: finalSnapshot.tick,
        finalRevision: finalSnapshot.revision,
        finalLogCount: finalSnapshot.logs.length,
        submittedActionCount,
      },
      source: {
        incrementCount: sourceIncrements,
        tickCount: measurements.tickDurationsMs.length,
        processPendingDurationMs: summarize(measurements.tickDurationsMs),
        processPendingIncludesSynchronousBroadcast: true,
        broadcastCount: measurements.broadcastDurationsMs.length,
        broadcastDurationMs: summarize(measurements.broadcastDurationsMs),
      },
      sockets: sockets.map(client => ({
        label: client.metrics.label,
        eventCounts: { ...client.metrics.eventCounts },
        eventJsonBytes: { ...client.metrics.eventJsonBytes },
        totalEventCount: client.metrics.totalEventCount(),
        totalEventJsonBytes: client.metrics.totalEventJsonBytes(),
        state: {
          receivedCount: client.metrics.stateReceivedCount,
          acceptedByRevisionGateCount: client.metrics.acceptedByRevisionGateCount,
          rejectedByRevisionGateCount: client.metrics.rejectedByRevisionGateCount,
          latestAppliedRevision: client.metrics.latestAppliedRevision,
          snapshotJsonBytes: summarizeBytes(client.metrics.stateEventSnapshotJsonBytes),
          incrementJsonBytes: summarizeBytes(client.metrics.stateEventIncrementJsonBytes),
        },
        commandAck: {
          count: client.metrics.ackCount,
          ackJsonBytes: client.metrics.ackJsonBytes,
          snapshotJsonBytes: client.metrics.ackSnapshotJsonBytes,
        },
      })),
      aggregate: {
        eventCountAcrossSockets: sockets.reduce((total, client) => total + client.metrics.totalEventCount(), 0),
        eventJsonBytesAcrossSockets: sockets.reduce((total, client) => total + client.metrics.totalEventJsonBytes(), 0),
        commandAckCountAcrossSockets: sockets.reduce((total, client) => total + client.metrics.ackCount, 0),
        commandAckJsonBytesAcrossSockets: sockets.reduce((total, client) => total + client.metrics.ackJsonBytes, 0),
        commandAckSnapshotJsonBytesAcrossSockets: sockets.reduce((total, client) => total + client.metrics.ackSnapshotJsonBytes, 0),
      },
    };
    return report;
  } finally {
    if (measurements) {
      measurements.measuring = false;
      measurements.restore();
    }
    for (const client of sockets) client.socket.disconnect();
    await server?.close();
    assert.equal(dirname(dataDirectory), realpathSync(tmpdir()));
    assert.ok(basename(dataDirectory).startsWith(`elysian-lan-perf-${config.name}-`));
    rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function main(): Promise<void> {
  const scenarios: readonly ScenarioConfig[] = [
    { name: 'small', entityCount: 6, warmupRounds: 1, measuredRounds: 3 },
    { name: 'expanded', entityCount: 24, warmupRounds: 1, measuredRounds: 3 },
    { name: 'history', entityCount: 6, warmupRounds: 1, measuredRounds: 10 },
  ];
  const reports: ScenarioReport[] = [];
  for (const scenario of scenarios) reports.push(await runScenario(scenario));

  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      jsonBytes: "Buffer.byteLength(JSON.stringify(value), 'utf8')",
      jsonBytesIncludeSocketIoTransportOverhead: false,
      note: 'Event JSON includes the application payload passed to Socket.IO; framing, Engine.IO, WebSocket/TCP/TLS headers and compression are excluded. Command ACK snapshot JSON is reported separately.',
    },
    scenarios: reports,
  };
  const outputDirectory = join(process.cwd(), '.tmp');
  mkdirSync(outputDirectory, { recursive: true });
  const outputPath = join(outputDirectory, 'lan-performance.json');
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[lan-performance] wrote ${outputPath}`);
  for (const scenario of reports) {
    console.log(`[lan-performance] ${scenario.name}: entities=${scenario.workload.entityCount} rounds=${scenario.workload.measuredRounds} sourceIncrements=${scenario.source.incrementCount} processPendingSteps=${scenario.source.tickCount} processPendingMs(p50/p95/max)=${scenario.source.processPendingDurationMs.p50Ms}/${scenario.source.processPendingDurationMs.p95Ms}/${scenario.source.processPendingDurationMs.maxMs} eventJsonBytes=${scenario.aggregate.eventJsonBytesAcrossSockets} ackSnapshotJsonBytes=${scenario.aggregate.commandAckSnapshotJsonBytesAcrossSockets}`);
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
