import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import type {
  ActionTemplate,
  DemoCatalogResponse,
  DemoSessionResponse,
  EncounterCommand,
  EncounterCommandResult,
  EncounterEntity,
  EncounterRulePack,
  EncounterSnapshot,
} from '../packages/shared/src/index.js';
import { createEncounterServer, type EncounterServerHandle } from '../packages/backend/src/network/EncounterServer.js';
import { SqliteEncounterRepository } from '../packages/backend/src/persistence/SqliteEncounterRepository.js';
import { EncounterCoordinator } from '../packages/backend/src/encounters/EncounterCoordinator.js';

const ENCOUNTER_ID = 'formal-composition';

function makeTemplate(
  templateId: string,
  faction: 'PLAYERS' | 'ENEMIES',
  displayName: string,
  x: number,
): Omit<EncounterEntity, 'id'> {
  return {
    templateId,
    type: 'ACTOR',
    transform: { coords: { x, y: 0, z: 0 }, planeId: 'formal-arena', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.5, mass: 10, movementModes: ['WALK'] },
    resources: { current: { hp: 10 }, max: { hp: 10 } },
    activeEffects: [],
    faction,
    displayName,
    encounterTemplateId: templateId,
    visibility: 'PUBLIC',
  };
}

function makeEntity(
  id: string,
  templateId: string,
  faction: 'PLAYERS' | 'ENEMIES',
  displayName: string,
  x: number,
): EncounterEntity {
  return { id, ...makeTemplate(templateId, faction, displayName, x) };
}

function makeContent(): { content: EncounterRulePack; entities: EncounterEntity[] } {
  const entities = [
    makeEntity('formal-hero', 'formal-hero-template', 'PLAYERS', 'Formal Hero', 0),
    makeEntity('formal-target', 'formal-target-template', 'ENEMIES', 'Formal Target', 2),
  ];
  const strike: ActionTemplate = {
    id: 'FORMAL_STRIKE',
    tags: ['MELEE'],
    timeCost: { startupTicks: 1, recoveryTicks: 1 },
    resourceCost: {},
    range: { type: 'ENTITY', distanceExpr: '3' },
    effects: [{
      type: 'DAMAGE',
      targetSelector: 'PRIMARY',
      parameters: { resource: 'hp', amountExpr: '1' },
    }],
  };
  return {
    content: {
      id: 'formal-composition-rules',
      name: 'Formal Composition Rules',
      actionTemplates: [strike],
      actorTemplates: {
        'formal-hero-template': makeTemplate('formal-hero-template', 'PLAYERS', 'Formal Hero', 0),
        'formal-target-template': makeTemplate('formal-target-template', 'ENEMIES', 'Formal Target', 2),
      },
      map: {
        id: 'formal-map',
        name: 'Formal Map',
        tiles: [],
        spawnPoints: {
          hero: { x: 0, y: 0, z: 0 },
          target: { x: 2, y: 0, z: 0 },
        },
        width: 4,
        height: 4,
      },
      reactionJoinMs: 100,
      reactionSelectMs: 100,
      priorityTolerance: 0,
    },
    entities,
  };
}

async function request(baseUrl: string, path: string, body?: unknown, accessToken?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/demo/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function login(
  baseUrl: string,
  path: 'host' | 'join',
  body: unknown,
): Promise<DemoSessionResponse['data']> {
  const response = await request(baseUrl, path, body);
  assert.equal(response.status, 200, `${path} login must succeed`);
  const result = await response.json() as DemoSessionResponse;
  assert.equal(result.ok, true);
  return result.data;
}

async function sessionSnapshot(baseUrl: string, accessToken: string): Promise<EncounterSnapshot> {
  const response = await request(baseUrl, 'session', undefined, accessToken);
  assert.equal(response.status, 200, 'authenticated session refresh must succeed');
  const result = await response.json() as DemoSessionResponse;
  assert.equal(result.ok, true);
  return result.data.snapshot;
}

interface SnapshotEnvelope {
  snapshot: EncounterSnapshot;
}

async function connect(baseUrl: string, accessToken: string): Promise<{ socket: Socket; snapshot: EncounterSnapshot }> {
  const socket = io(baseUrl, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: { accessToken },
  });
  return new Promise((resolve, reject) => {
    let connected = false;
    let initial: EncounterSnapshot | undefined;
    const timer = setTimeout(() => finish(new Error('Socket connection timed out')), 3000);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
      socket.off('DEMO_SNAPSHOT', onSnapshot);
    };
    const finish = (error?: Error): void => {
      cleanup();
      if (error) {
        socket.disconnect();
        reject(error);
      } else if (initial) {
        resolve({ socket, snapshot: initial });
      } else {
        socket.disconnect();
        reject(new Error('Socket connected without an initial snapshot'));
      }
    };
    const maybeFinish = (): void => {
      if (connected && initial) finish();
    };
    const onConnect = (): void => {
      connected = true;
      maybeFinish();
    };
    const onError = (error: Error): void => finish(error);
    const onSnapshot = (payload: SnapshotEnvelope): void => {
      if (payload && typeof payload === 'object' && payload.snapshot) initial = payload.snapshot;
      maybeFinish();
    };
    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
    socket.once('DEMO_SNAPSHOT', onSnapshot);
    socket.connect();
  });
}

function sendCommand(socket: Socket, command: EncounterCommand): Promise<EncounterCommandResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ACK for ${command.type}`)), 3000);
    socket.emit('DEMO_COMMAND', command, (result: EncounterCommandResult) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function entityIds(snapshot: EncounterSnapshot): string[] {
  return snapshot.entities.map(entity => entity.id).sort();
}

function assertCatalog(result: DemoCatalogResponse): void {
  assert.equal(result.ok, true);
  assert.equal(result.data.map.id, 'formal-map');
  const hero = result.data.entries.find(entry => entry.templateId === 'formal-hero-template');
  assert.ok(hero, 'injected actor template must be present in the GM catalog');
  assert.equal(hero.label, 'Formal Hero');
  assert.equal(hero.entityTemplate?.templateId, 'formal-hero-template');
  assert.ok(hero.actions.some(action => action.id === 'FORMAL_STRIKE'), 'injected action must be present in the catalog');
  const target = result.data.entries.find(entry => entry.templateId === 'formal-target-template');
  assert.ok(target, 'injected enemy template must be present in the GM catalog');
}

async function main(): Promise<void> {
  const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'elysian-formal-encounter-')));
  const clients: Socket[] = [];
  const { content, entities } = makeContent();
  const hostCredential = `formal-host-${randomUUID()}`;
  const joinCode = `FORMAL-${randomUUID().replaceAll('-', '').slice(0, 12)}`.toUpperCase();
  let repository: SqliteEncounterRepository | undefined;
  let server: EncounterServerHandle | undefined;
  let reopenedRepository: SqliteEncounterRepository | undefined;
  let reopenedServer: EncounterServerHandle | undefined;

  try {
    repository = new SqliteEncounterRepository({ dataDirectory: temporaryRoot });
    assert.equal(basename(repository.databasePath), 'demo.db');
    const saveOpening = repository.saveOpeningSnapshot.bind(repository);
    repository.saveOpeningSnapshot = () => ({ ok: false, code: 'PERSISTENCE_FAILED' });
    let failedCoordinatorClosed = false;
    try {
      await assert.rejects(createEncounterServer({
        content, entities, persistence: repository,
        coordinatorFactory: options => {
          const coordinator = new EncounterCoordinator(options);
          const close = coordinator.close.bind(coordinator);
          coordinator.close = () => { failedCoordinatorClosed = true; close(); };
          return coordinator;
        },
      }), /DEMO_PERSISTENCE_FAILED/);
      assert.equal(failedCoordinatorClosed, true, 'failed construction must close coordinator timers');
    } finally {
      repository.saveOpeningSnapshot = saveOpening;
    }
    server = await createEncounterServer({
      content,
      entities,
      persistence: repository,
      encounterId: ENCOUNTER_ID,
      host: '127.0.0.1',
      port: 0,
      hostCredential,
      joinCode,
    });
    const { url } = await server.listen();

    assert.equal((await request(url, 'session')).status, 401, 'session requires a bearer token');
    assert.equal((await request(url, 'catalog')).status, 401, 'catalog requires a bearer token');
    const invalidHost = await request(url, 'host', { credential: `wrong-${randomUUID()}` });
    assert.equal(invalidHost.status, 401, 'invalid host credentials must be rejected');
    const invalidJoin = await request(url, 'join', { joinCode: `WRONG-${randomUUID()}` });
    assert.equal(invalidJoin.status, 403, 'invalid join code must be rejected');

    const gm = await login(url, 'host', { credential: hostCredential, displayName: 'Formal GM' });
    assert.equal(gm.session.role, 'GM');
    assert.equal(gm.joinCode, joinCode);
    assert.deepEqual(entityIds(gm.snapshot), ['formal-hero', 'formal-target']);

    const player = await login(url, 'join', { joinCode, displayName: 'Formal Player' });
    assert.equal(player.session.role, 'PL');
    assert.equal(player.joinCode, undefined);

    const catalogResponse = await request(url, 'catalog', undefined, gm.accessToken);
    assert.equal(catalogResponse.status, 200);
    assertCatalog(await catalogResponse.json() as DemoCatalogResponse);

    const playerCatalogResponse = await request(url, 'catalog', undefined, player.accessToken);
    assert.equal(playerCatalogResponse.status, 200);
    const playerCatalog = await playerCatalogResponse.json() as DemoCatalogResponse;
    assert.equal(playerCatalog.ok, true);
    assert.equal(playerCatalog.data.entries.some(entry => entry.templateId === 'formal-target-template'), false, 'player catalog must filter enemy templates');

    const gmConnection = await connect(url, gm.accessToken);
    clients.push(gmConnection.socket);
    const playerConnection = await connect(url, player.accessToken);
    clients.push(playerConnection.socket);
    assert.deepEqual(entityIds(gmConnection.snapshot), ['formal-hero', 'formal-target']);

    const forbidden = await sendCommand(playerConnection.socket, {
      requestId: 'formal-player-gm-command',
      type: 'GM_PAUSE',
      payload: { reason: 'player must be rejected' },
    });
    assert.equal(forbidden.ok, false, 'a player must not execute a GM command');
    if (!forbidden.ok) assert.equal(forbidden.code, 'FORBIDDEN');

    const started = await sendCommand(gmConnection.socket, {
      requestId: 'formal-gm-start',
      type: 'START',
      payload: { entityId: 'formal-hero' },
    });
    assert.equal(started.ok, true, 'the injected encounter must accept a GM start command');
    assert.equal(started.snapshot.encounterId, ENCOUNTER_ID);
    assert.deepEqual(entityIds(started.snapshot), ['formal-hero', 'formal-target']);
    const persisted = repository.load(ENCOUNTER_ID);
    assert.ok(persisted, 'the explicit START save point must be durable');
    assert.deepEqual(entityIds(persisted.latestSnapshot), ['formal-hero', 'formal-target']);

    await server.close();
    server = undefined;
    repository = undefined;

    reopenedRepository = new SqliteEncounterRepository({ dataDirectory: temporaryRoot });
    reopenedServer = await createEncounterServer({
      content,
      // Deliberately leave the fallback empty: successful restoration must
      // come from the persisted opening snapshot rather than this argument.
      entities: [],
      persistence: reopenedRepository,
      encounterId: ENCOUNTER_ID,
      host: '127.0.0.1',
      port: 0,
      hostCredential,
      joinCode,
    });
    const reopened = await reopenedServer.listen();
    const reopenedGm = await login(reopened.url, 'host', { credential: hostCredential, displayName: 'Reopened GM' });
    assert.deepEqual(entityIds(reopenedGm.snapshot), ['formal-hero', 'formal-target'], 'reopened server must restore persisted entities');
    const reopenedCatalog = await request(reopened.url, 'catalog', undefined, reopenedGm.accessToken);
    assert.equal(reopenedCatalog.status, 200);
    assertCatalog(await reopenedCatalog.json() as DemoCatalogResponse);
    assert.deepEqual(entityIds(await sessionSnapshot(reopened.url, reopenedGm.accessToken)), ['formal-hero', 'formal-target']);
  } finally {
    for (const client of clients) client.disconnect();
    if (server) await server.close();
    else if (repository) repository.close();
    if (reopenedServer) await reopenedServer.close();
    else if (reopenedRepository) reopenedRepository.close();
    assert.equal(dirname(temporaryRoot), realpathSync(tmpdir()));
    assert.ok(basename(temporaryRoot).startsWith('elysian-formal-encounter-'));
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().then(() => {
  console.log('encounter-server-modules: formal non-Demo composition passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
