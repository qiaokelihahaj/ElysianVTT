import type { EncounterResult, EncounterSnapshot } from '@hard-vtt/shared';

export interface PersistedEncounter {
  encounterId: string;
  openingSnapshot: EncounterSnapshot;
  latestSnapshot: EncounterSnapshot;
  result?: EncounterResult;
  status: string;
  updatedAt: number;
}

export interface EncounterWriteResult {
  ok: boolean;
  code?: 'PERSISTENCE_FAILED';
  message?: string;
}

/**
 * Business-facing persistence boundary for an encounter.
 *
 * Implementations persist only explicit encounter save points. The combat
 * loop remains in memory between those save points, so a server can inject a
 * different storage implementation without coupling itself to SQLite.
 */
export interface EncounterRepository {
  readonly databasePath: string;
  lastLoadError?: string;

  saveOpeningSnapshot(snapshot: EncounterSnapshot): EncounterWriteResult;
  saveCheckpoint(snapshot: EncounterSnapshot): EncounterWriteResult;
  saveSettlement(snapshot: EncounterSnapshot, result: EncounterResult, runId?: string): EncounterWriteResult;
  load(encounterId?: string): PersistedEncounter | undefined;
  loadSettlementHistory(encounterId?: string): Array<{
    snapshot: EncounterSnapshot;
    result: EncounterResult;
    updatedAt: number;
  }>;
  loadOpeningSnapshot(encounterId?: string): EncounterSnapshot | undefined;
  loadLatestSnapshot(encounterId?: string): EncounterSnapshot | undefined;
  close(): void;
}
