import { mkdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EncounterResult, EncounterSnapshot } from '@hard-vtt/shared';
import { isEncounterFaction, isEncounterRelation, isEncounterSide, isEncounterVictoryCondition } from '@hard-vtt/shared';
import type { EncounterRepository, EncounterWriteResult, PersistedEncounter } from './EncounterRepository.js';

export type { EncounterWriteResult, PersistedEncounter } from './EncounterRepository.js';

export interface SqliteEncounterRepositoryOptions {
  dataDirectory?: string;
  /** Optional explicit path for tests; it must remain outside the Prisma DB. */
  databasePath?: string;
  databaseFileName?: string;
}

const DEFAULT_DATABASE_FILE = 'demo.db';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validVector(value: unknown): boolean {
  return isRecord(value) && finite(value.x) && finite(value.y) && finite(value.z);
}

function isPersistedEntity(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.templateId !== 'string' || !['ACTOR', 'PROP', 'PROJECTILE'].includes(String(value.type))) return false;
  if (value.faction !== undefined && value.faction !== null && !isEncounterFaction(value.faction)) return false;
  if (!isRecord(value.transform) || !validVector(value.transform.coords) || typeof value.transform.planeId !== 'string' || !finite(value.transform.facing)) return false;
  if (!isRecord(value.physics) || !finite(value.physics.scaleClass) || !finite(value.physics.collisionRadius) || !finite(value.physics.mass) || !Array.isArray(value.physics.movementModes) || !value.physics.movementModes.every(item => typeof item === 'string')) return false;
  if (!isRecord(value.resources) || !isRecord(value.resources.current) || !isRecord(value.resources.max)) return false;
  if (!Object.values(value.resources.current).every(finite) || !Object.values(value.resources.max).every(finite)) return false;
  if (!Array.isArray(value.activeEffects)) return false;
  return value.activeEffects.every(effect => isRecord(effect) && typeof effect.instanceId === 'string' && typeof effect.templateId === 'string' && typeof effect.sourceEntityId === 'string' && finite(effect.remainingTicks) && finite(effect.stacks));
}

function isPersistedAction(value: unknown): boolean {
  return isRecord(value)
    && typeof value.actionId === 'string'
    && typeof value.actorId === 'string'
    && typeof value.actionTemplateId === 'string'
    && Array.isArray(value.targetIds)
    && value.targetIds.every(item => typeof item === 'string')
    && typeof value.phase === 'string'
    && finite(value.declaredTick)
    && (value.effectiveTick === undefined || finite(value.effectiveTick))
    && finite(value.priority)
    && isRecord(value.paidResources)
    && Object.values(value.paidResources).every(finite)
    && finite(value.decisionVersion)
    && finite(value.controlEpoch)
    && typeof value.causationId === 'string'
    && (value.relation === undefined || ['ATTACK', 'HEAL', 'SUPPORT'].includes(String(value.relation)))
    && (value.selfTarget === undefined || typeof value.selfTarget === 'boolean')
    && (value.arrivalTick === undefined || finite(value.arrivalTick));
}

function isPersistedSlot(value: unknown): boolean {
  return isRecord(value) && typeof value.entityId === 'string' && (value.faction === undefined || value.faction === null || isEncounterFaction(value.faction)) && typeof value.connected === 'boolean' && typeof value.ready === 'boolean' && typeof value.waiting === 'boolean' && (value.readyAtTick === undefined || finite(value.readyAtTick)) && finite(value.controlEpoch);
}

function isPersistedPlan(value: unknown): boolean {
  return isRecord(value) && finite(value.windowTick) && Array.isArray(value.slots) && value.slots.every(isPersistedSlot) && typeof value.committed === 'boolean' && Array.isArray(value.actions) && value.actions.every(isPersistedAction) && finite(value.barrierVersion);
}

function isPersistedDecision(value: unknown): boolean {
  return isRecord(value) && typeof value.windowId === 'string' && ['REACTION_JOIN', 'REACTION_SELECT', 'GM_REVIEW'].includes(String(value.stage)) && typeof value.sourceActionId === 'string' && typeof value.sourceEntityId === 'string' && typeof value.reactorEntityId === 'string' && typeof value.causationId === 'string' && finite(value.openedTick) && finite(value.joinDeadlineAt) && finite(value.joinRemainingMs) && Array.isArray(value.availableOptions) && Array.isArray(value.respondedSocketIds) && value.respondedSocketIds.every(item => typeof item === 'string') && typeof value.resolved === 'boolean';
}

function isPersistedControl(value: unknown): boolean {
  return isRecord(value) && typeof value.entityId === 'string' && ['GM', 'PL', 'OB'].includes(String(value.role)) && finite(value.controlEpoch) && Array.isArray(value.connectedSocketIds) && value.connectedSocketIds.every(item => typeof item === 'string') && typeof value.takenOverByGm === 'boolean' && (value.userId === undefined || typeof value.userId === 'string');
}

function isPersistedLog(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && finite(value.tick) && typeof value.message === 'string' && (value.actorId === undefined || typeof value.actorId === 'string') && (value.actionId === undefined || typeof value.actionId === 'string') && (value.causationId === undefined || typeof value.causationId === 'string');
}

function parseSnapshot(value: unknown): EncounterSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.encounterId !== 'string' || !finite(value.revision) || !finite(value.tick)) return undefined;
  if (!['LOBBY', 'ACTIVE', 'PAUSED', 'VICTORY', 'DEFEAT', 'MUTUAL_DEFEAT', 'ENDED'].includes(String(value.status)) || typeof value.paused !== 'boolean') return undefined;
  if (!Array.isArray(value.entities) || !value.entities.every(isPersistedEntity)) return undefined;
  if (!Array.isArray(value.actions) || !value.actions.every(isPersistedAction)) return undefined;
  if (!isPersistedPlan(value.plan) || !Array.isArray(value.decisions) || !value.decisions.every(isPersistedDecision)) return undefined;
  if (!Array.isArray(value.controls) || !value.controls.every(isPersistedControl) || !Array.isArray(value.logs) || !value.logs.every(isPersistedLog)) return undefined;
  if (value.result !== undefined && !parseResult(value.result)) return undefined;
  if (value.victoryCondition !== undefined && !isEncounterVictoryCondition(value.victoryCondition)) return undefined;
  if (value.relations !== undefined && (!Array.isArray(value.relations) || value.relations.length > 10000
    || !value.relations.every(pair => isRecord(pair) && isEncounterSide(pair.a) && isEncounterSide(pair.b) && isEncounterRelation(pair.relation)))) return undefined;
  return value as unknown as EncounterSnapshot;
}

function parseResult(value: unknown): EncounterResult | undefined {
  if (!isRecord(value)) return undefined;
  if (!['VICTORY', 'DEFEAT', 'MUTUAL_DEFEAT', 'ENDED'].includes(String(value.status)) || !Array.isArray(value.survivors) || !value.survivors.every(item => typeof item === 'string') || !Array.isArray(value.casualties) || !value.casualties.every(item => typeof item === 'string')) return undefined;
  if (!finite(value.resolvedTick) || (value.endedBy !== 'GM' && value.endedBy !== 'RULES')) return undefined;
  if (value.winningFaction !== undefined && !isEncounterFaction(value.winningFaction)) return undefined;
  if (value.winningSides !== undefined && (!Array.isArray(value.winningSides) || value.winningSides.length > 1000 || !value.winningSides.every(isEncounterSide))) return undefined;
  return value as unknown as EncounterResult;
}

function rowString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' ? value : undefined;
}

function rowNumber(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Small standalone SQLite store for demo boundaries.
 *
 * The combat loop remains in memory. Callers persist only opening snapshots,
 * explicit GM checkpoints, and settlement results; no Tick event writes here.
 */
export class SqliteEncounterRepository implements EncounterRepository {
  public readonly databasePath: string;
  public lastLoadError?: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(options: SqliteEncounterRepositoryOptions = {}) {
    const dataDirectory = resolve(options.dataDirectory ?? join(process.cwd(), '.demo'));
    const databasePath = resolve(options.databasePath ?? join(dataDirectory, options.databaseFileName ?? DEFAULT_DATABASE_FILE));
    if (basename(databasePath).toLowerCase() === 'dev.db' || databasePath.toLowerCase().endsWith(`${join('prisma', 'dev.db').toLowerCase()}`)) {
      throw new Error('DemoPersistence cannot use the Prisma dev.db');
    }
    mkdirSync(dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS demo_encounters (
        encounter_id TEXT PRIMARY KEY,
        opening_snapshot_json TEXT NOT NULL,
        latest_snapshot_json TEXT NOT NULL,
        result_json TEXT,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS demo_settlement_history (
        settlement_key TEXT PRIMARY KEY,
        encounter_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS demo_settlement_history_encounter_idx
        ON demo_settlement_history (encounter_id, updated_at);
    `);
  }

  saveOpeningSnapshot(snapshot: EncounterSnapshot): EncounterWriteResult {
    return this.write(() => {
      const encoded = this.encodeSnapshot(snapshot);
      const now = Date.now();
      this.db.prepare(`
        INSERT INTO demo_encounters
          (encounter_id, opening_snapshot_json, latest_snapshot_json, result_json, status, updated_at)
        VALUES (?, ?, ?, NULL, ?, ?)
        ON CONFLICT(encounter_id) DO UPDATE SET
          opening_snapshot_json = excluded.opening_snapshot_json,
          latest_snapshot_json = excluded.latest_snapshot_json,
          result_json = NULL,
          status = excluded.status,
          updated_at = excluded.updated_at
      `).run(snapshot.encounterId, encoded, encoded, snapshot.status, now);
    });
  }

  /** Persist an explicit GM pause/edit checkpoint. */
  saveCheckpoint(snapshot: EncounterSnapshot): EncounterWriteResult {
    return this.write(() => {
      const encoded = this.encodeSnapshot(snapshot);
      const now = Date.now();
      this.db.prepare(`
        UPDATE demo_encounters
        SET latest_snapshot_json = ?, status = ?, result_json = CASE WHEN ? = 'LOBBY' THEN NULL ELSE result_json END, updated_at = ?
        WHERE encounter_id = ?
      `).run(encoded, snapshot.status, snapshot.status, now, snapshot.encounterId);
      if (this.changes() === 0) {
        this.db.prepare(`
          INSERT INTO demo_encounters
            (encounter_id, opening_snapshot_json, latest_snapshot_json, result_json, status, updated_at)
          VALUES (?, ?, ?, NULL, ?, ?)
        `).run(snapshot.encounterId, encoded, encoded, snapshot.status, now);
      }
    });
  }

  saveSettlement(snapshot: EncounterSnapshot, result: EncounterResult, runId?: string): EncounterWriteResult {
    return this.write(() => {
      const snapshotJson = this.encodeSnapshot(snapshot);
      const resultJson = this.encodeResult(result);
      const now = Date.now();
      this.db.prepare(`
        INSERT INTO demo_encounters
          (encounter_id, opening_snapshot_json, latest_snapshot_json, result_json, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(encounter_id) DO UPDATE SET
          latest_snapshot_json = excluded.latest_snapshot_json,
          result_json = excluded.result_json,
          status = excluded.status,
          updated_at = excluded.updated_at
      `).run(snapshot.encounterId, snapshotJson, snapshotJson, resultJson, result.status, now);
      this.db.prepare(`
        INSERT OR IGNORE INTO demo_settlement_history
          (settlement_key, encounter_id, snapshot_json, result_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(this.settlementKey(snapshot, result, runId), snapshot.encounterId, snapshotJson, resultJson, now);
    });
  }

  load(encounterId?: string): PersistedEncounter | undefined {
    if (this.closed) throw new Error('DemoPersistence is closed');
    this.lastLoadError = undefined;
    let row: Record<string, unknown> | undefined;
    try {
      row = encounterId
        ? this.db.prepare('SELECT * FROM demo_encounters WHERE encounter_id = ?').get(encounterId)
        : this.db.prepare('SELECT * FROM demo_encounters ORDER BY updated_at DESC LIMIT 1').get();
    } catch (error) {
      this.lastLoadError = `读取 Demo 存档失败: ${error instanceof Error ? error.message : String(error)}`;
      return undefined;
    }
    if (!row || !isRecord(row)) return undefined;

    const openingJson = rowString(row, 'opening_snapshot_json');
    const latestJson = rowString(row, 'latest_snapshot_json');
    const encounterKey = rowString(row, 'encounter_id');
    const status = rowString(row, 'status');
    const updatedAt = rowNumber(row, 'updated_at');
    if (!openingJson || !latestJson || !encounterKey || !status || updatedAt === undefined) {
      this.lastLoadError = 'Demo 存档缺少必要字段';
      return undefined;
    }

    let openingSnapshot: EncounterSnapshot | undefined;
    let latestSnapshot: EncounterSnapshot | undefined;
    let result: EncounterResult | undefined;
    try {
      openingSnapshot = parseSnapshot(JSON.parse(openingJson) as unknown);
      latestSnapshot = parseSnapshot(JSON.parse(latestJson) as unknown);
      const resultJson = rowString(row, 'result_json');
      result = resultJson ? parseResult(JSON.parse(resultJson) as unknown) : undefined;
    } catch (error) {
      this.lastLoadError = `Demo 存档 JSON 损坏: ${error instanceof Error ? error.message : String(error)}`;
      return undefined;
    }
    if (!openingSnapshot || !latestSnapshot || openingSnapshot.encounterId !== encounterKey || latestSnapshot.encounterId !== encounterKey) {
      this.lastLoadError = 'Demo 存档快照结构无效';
      return undefined;
    }
    if (rowString(row, 'result_json') && !result) {
      this.lastLoadError = 'Demo 存档结算结果结构无效';
      return undefined;
    }
    if (status !== latestSnapshot.status && (!result || status !== result.status)) {
      this.lastLoadError = 'Demo 存档状态与快照不一致';
      return undefined;
    }
    return { encounterId: encounterKey, openingSnapshot, latestSnapshot, result, status, updatedAt };
  }

  loadSettlementHistory(encounterId?: string): Array<{ snapshot: EncounterSnapshot; result: EncounterResult; updatedAt: number }> {
    if (this.closed) throw new Error('DemoPersistence is closed');
    this.lastLoadError = undefined;
    try {
      const rows = encounterId
        ? this.db.prepare('SELECT snapshot_json, result_json, updated_at FROM demo_settlement_history WHERE encounter_id = ? ORDER BY updated_at ASC').all(encounterId)
        : this.db.prepare('SELECT snapshot_json, result_json, updated_at FROM demo_settlement_history ORDER BY updated_at ASC').all();
      const history: Array<{ snapshot: EncounterSnapshot; result: EncounterResult; updatedAt: number }> = [];
      for (const row of rows) {
        if (!isRecord(row)) throw new Error('结算历史行格式无效');
        const snapshot = parseSnapshot(JSON.parse(String(row.snapshot_json)));
        const result = parseResult(JSON.parse(String(row.result_json)));
        const updatedAt = row.updated_at;
        if (!snapshot || !result || !finite(updatedAt)) throw new Error('结算历史结构无效');
        history.push({ snapshot, result, updatedAt });
      }
      return history;
    } catch (error) {
      this.lastLoadError = `读取 Demo 结算历史失败: ${error instanceof Error ? error.message : String(error)}`;
      return [];
    }
  }

  loadOpeningSnapshot(encounterId?: string): EncounterSnapshot | undefined {
    return this.load(encounterId)?.openingSnapshot;
  }

  loadLatestSnapshot(encounterId?: string): EncounterSnapshot | undefined {
    return this.load(encounterId)?.latestSnapshot;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private encodeSnapshot(snapshot: EncounterSnapshot): string {
    if (!parseSnapshot(snapshot)) throw new Error('Snapshot structure is invalid');
    const encoded = JSON.stringify(snapshot);
    if (typeof encoded !== 'string' || encoded.length > 10_000_000) throw new Error('Snapshot is not serializable or is too large');
    return encoded;
  }

  private encodeResult(result: EncounterResult): string {
    if (!parseResult(result)) throw new Error('Encounter result structure is invalid');
    const encoded = JSON.stringify(result);
    if (typeof encoded !== 'string' || encoded.length > 1_000_000) throw new Error('Encounter result is not serializable or is too large');
    return encoded;
  }

  private write(operation: () => void): EncounterWriteResult {
    if (this.closed) return { ok: false, code: 'PERSISTENCE_FAILED', message: 'DemoPersistence is closed' };
    try {
      this.db.exec('BEGIN IMMEDIATE');
      operation();
      this.db.exec('COMMIT');
      return { ok: true };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
      return {
        ok: false,
        code: 'PERSISTENCE_FAILED',
        message: error instanceof Error ? error.message : '无法写入 Demo 数据库',
      };
    }
  }

  private changes(): number {
    const row = this.db.prepare('SELECT changes() AS changes').get();
    if (!row || !isRecord(row)) return 0;
    const value = row.changes;
    return typeof value === 'number' ? value : 0;
  }

  private settlementKey(snapshot: EncounterSnapshot, result: EncounterResult, runId?: string): string {
    // The snapshot revision changes when a client reconnects or requests a
    // fresh sync.  It is therefore not part of settlement identity.  A
    // server supplied run id keeps two separate restarts that happen to end
    // with the same result distinct while repeated writes in one run collide
    // safely on this unique key.
    const resultFingerprint = JSON.stringify({
      status: result.status,
      winningFaction: result.winningFaction,
      winningSides: result.winningSides?.map(side => `${side.kind}:${side.id}`).sort(),
      survivors: [...result.survivors].sort(),
      casualties: [...result.casualties].sort(),
      resolvedTick: result.resolvedTick,
      endedBy: result.endedBy,
      reason: result.reason,
    });
    return `${snapshot.encounterId}:${runId ?? 'legacy'}:${resultFingerprint}`;
  }
}
