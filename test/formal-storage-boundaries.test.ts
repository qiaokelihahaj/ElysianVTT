import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DemoPersistence } from '../packages/backend/src/demo/DemoPersistence.js';
import type {
  DemoPersistenceOptions,
  DemoPersistenceWriteResult,
  PersistedDemoEncounter,
} from '../packages/backend/src/demo/DemoPersistence.js';
import { SqliteEncounterRepository } from '../packages/backend/src/persistence/SqliteEncounterRepository.js';
import type {
  EncounterRepository,
  EncounterWriteResult,
  PersistedEncounter,
} from '../packages/backend/src/persistence/EncounterRepository.js';
import { DemoSessionService } from '../packages/backend/src/demo/DemoSessionService.js';
import type {
  DemoCreatedSession,
  DemoSessionLookup,
  DemoSessionRecord,
  DemoSessionServiceCredentials,
  DemoSessionServiceOptions,
} from '../packages/backend/src/demo/DemoSessionService.js';
import { LanSessionService } from '../packages/backend/src/sessions/LanSessionService.js';
import type {
  LanCreatedSession,
  LanSessionLookup,
  LanSessionRecord,
  LanSessionServiceCredentials,
  LanSessionServiceOptions,
} from '../packages/backend/src/sessions/LanSessionService.js';

assert.equal(DemoSessionService, LanSessionService, 'legacy session export must alias the formal service');
assert.equal(DemoPersistence, SqliteEncounterRepository, 'legacy persistence export must alias the formal repository');

const legacyOptions: DemoSessionServiceOptions = { hostCredential: 'host', joinCode: 'ROOM' };
const formalOptions: LanSessionServiceOptions = legacyOptions;
const credentials: DemoSessionServiceCredentials | LanSessionServiceCredentials = { hostCredential: 'host', joinCode: 'ROOM' };
const legacyWriteResult: DemoPersistenceWriteResult = { ok: true };
const formalWriteResult: EncounterWriteResult = legacyWriteResult;
const legacyRecord = undefined as DemoSessionRecord | undefined;
const formalRecord: LanSessionRecord | undefined = legacyRecord;
const legacyLookup = undefined as DemoSessionLookup | undefined;
const formalLookup: LanSessionLookup | undefined = legacyLookup;
const legacyCreated = undefined as DemoCreatedSession | undefined;
const formalCreated: LanCreatedSession | undefined = legacyCreated;
const legacyEncounter = undefined as PersistedDemoEncounter | undefined;
const formalEncounter: PersistedEncounter | undefined = legacyEncounter;
void credentials;
void formalOptions;
void formalWriteResult;
void formalRecord;
void formalLookup;
void formalCreated;
void formalEncounter;

const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'elysian-formal-storage-')));
let repository: EncounterRepository | undefined;
try {
  repository = new SqliteEncounterRepository({ dataDirectory: temporaryRoot } satisfies DemoPersistenceOptions);
  assert.equal(repository.databasePath, resolve(temporaryRoot, 'demo.db'));
  assert.equal(typeof repository.saveOpeningSnapshot, 'function');
  assert.equal(typeof repository.saveCheckpoint, 'function');
  assert.equal(typeof repository.saveSettlement, 'function');
  assert.equal(typeof repository.load, 'function');
  assert.equal(typeof repository.loadSettlementHistory, 'function');
  assert.equal(typeof repository.loadOpeningSnapshot, 'function');
  assert.equal(typeof repository.loadLatestSnapshot, 'function');
  assert.equal(typeof repository.close, 'function');
} finally {
  repository?.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('formal-storage-boundaries: all export and interface checks passed');
