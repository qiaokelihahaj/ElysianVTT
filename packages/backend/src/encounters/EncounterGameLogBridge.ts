import type { EventEmitter } from 'node:events';
import type { EncounterLogEntry, EntityId, LogPayload } from '@hard-vtt/shared';
import { LogLevel, LogVisibility } from '@hard-vtt/shared';
import { EventBus, InternalEvent } from '../core/events/EventBus.js';
import { generateId } from '../utils/IdGenerator.js';

export interface EncounterGameLogBridgeOptions {
  /** Only events emitted for this encounter are allowed through. */
  sceneId: string;
  /** Tick used when an engine log omitted its optional context. */
  currentTick: () => number;
  append: (entry: EncounterLogEntry) => void;
}

interface GameLogEventLike {
  payload?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, maxLength = 256): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function entityId(value: unknown): EntityId | undefined {
  return stringValue(value, 128);
}

/**
 * The logger context contains a live entity Map.  Keep only JSON-like
 * metadata that is useful to a GM; this also prevents an internal object from
 * crossing the snapshot boundary by accident.
 */
function jsonValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.slice(0, 32).map(item => jsonValue(item, depth + 1)).filter(item => item !== undefined);
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    const parsed = jsonValue(item, depth + 1);
    if (parsed !== undefined) result[key] = parsed;
  }
  return result;
}

function safeMeta(value: unknown): Record<string, unknown> | undefined {
  const parsed = jsonValue(value);
  return isRecord(parsed) ? parsed : undefined;
}

function inferActorId(message: string): EntityId | undefined {
  // EffectSystem damage logs begin with [actorId].  This is deliberately
  // conservative; an unrecognised message is retained without an actor.
  const damageActor = message.match(/^\[([^:\]]+)\]\s+施放/)?.[1];
  if (damageActor) return entityId(damageActor);
  return entityId(message.match(/被\s*([^\s]+)\s*打断/)?.[1]);
}

function toEncounterLog(payload: LogPayload, currentTick: number): EncounterLogEntry | undefined {
  if (payload.level !== LogLevel.GAME || typeof payload.message !== 'string' || payload.message.length === 0) return undefined;
  const meta = safeMeta(payload.meta);
  const actorId = entityId(meta?.actorId) ?? inferActorId(payload.message);
  const targetId = entityId(meta?.targetId)
    ?? entityId(meta?.targetEntityId)
    // CombatEngine's lifecycle interrupt log calls the interrupted entity
    // `entityId`; expose that association as a target without guessing the
    // source actor.
    ?? (payload.message.includes('打断') ? entityId(meta?.entityId) : undefined);
  const actionTemplateId = stringValue(meta?.actionTemplateId) ?? stringValue(meta?.actionId);
  const actionId = stringValue(meta?.actionInstanceId) ?? stringValue(meta?.sourceActionId) ?? actionTemplateId;
  const causationId = stringValue(meta?.causationId);
  const association: Record<string, unknown> = {
    ...(meta ?? {}),
    ...(actorId ? { actorId } : {}),
    ...(targetId ? { targetId } : {}),
    ...(actionTemplateId ? { actionTemplateId } : {}),
    ...(causationId ? { causationId } : {}),
  };
  return {
    id: generateId(),
    tick: finiteNumber(payload.tick) ? payload.tick : currentTick,
    message: payload.message.slice(0, 4096),
    level: payload.level,
    visibility: payload.visibility,
    ...(actorId ? { actorId } : {}),
    ...(actionId ? { actionId } : {}),
    ...(causationId ? { causationId } : {}),
    ...(Object.keys(association).length > 0 ? { meta: association } : {}),
  };
}

/**
 * Bridges committed GAME_LOG events from the process-wide EventBus into one
 * encounter's append-only log.  Logs are buffered until CombatEngine emits
 * STATE_MUTATED, so ClashPool's pre-commit calculations never reach clients
 * as a standalone update.
 */
export class EncounterGameLogBridge {
  private readonly sceneId: string;
  private readonly currentTick: () => number;
  private readonly append: (entry: EncounterLogEntry) => void;
  private readonly pending: LogPayload[] = [];
  private closed = false;

  private readonly onGameLog = (event: GameLogEventLike): void => {
    if (this.closed || !isRecord(event) || !isRecord(event.payload)) return;
    const payload = event.payload as unknown as LogPayload;
    if (payload.sceneId !== this.sceneId || payload.level !== LogLevel.GAME) return;
    if (payload.visibility !== LogVisibility.PLAYER && payload.visibility !== LogVisibility.GM) return;
    if (typeof payload.message !== 'string' || payload.message.length === 0) return;
    this.pending.push({
      timestamp: finiteNumber(payload.timestamp) ? payload.timestamp : Date.now(),
      namespace: stringValue(payload.namespace, 128) ?? 'Game',
      level: LogLevel.GAME,
      visibility: payload.visibility === LogVisibility.GM ? LogVisibility.GM : LogVisibility.PLAYER,
      message: payload.message.slice(0, 4096),
      ...(finiteNumber(payload.tick) ? { tick: payload.tick } : {}),
      ...(payload.meta !== undefined ? { meta: payload.meta } : {}),
    });
    if (this.pending.length > 500) this.pending.splice(0, this.pending.length - 500);
  };

  private readonly onStateMutated = (): void => {
    if (this.closed || this.pending.length === 0) return;
    const pending = this.pending.splice(0, this.pending.length);
    for (const payload of pending) {
      const entry = toEncounterLog(payload, this.currentTick());
      if (entry) this.append(entry);
    }
  };

  public constructor(engine: EventEmitter, options: EncounterGameLogBridgeOptions) {
    this.sceneId = options.sceneId;
    this.currentTick = options.currentTick;
    this.append = options.append;
    EventBus.on(InternalEvent.GAME_LOG, this.onGameLog);
    engine.on('STATE_MUTATED', this.onStateMutated);
  }

  public close(engine: EventEmitter): void {
    if (this.closed) return;
    this.closed = true;
    EventBus.off(InternalEvent.GAME_LOG, this.onGameLog);
    engine.off('STATE_MUTATED', this.onStateMutated);
    this.pending.splice(0, this.pending.length);
  }
}
