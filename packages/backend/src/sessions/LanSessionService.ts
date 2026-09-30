import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { EncounterRole } from '@hard-vtt/shared';
import type { DemoRosterEntry, DemoSessionView } from '@hard-vtt/shared';

export interface LanSessionServiceOptions {
  hostCredential?: string;
  joinCode?: string;
  sessionTtlMs?: number;
  reconnectGraceMs?: number;
  maxPlayers?: number;
  now?: () => number;
}

export interface LanSessionRecord {
  readonly sessionId: string;
  readonly userId: string;
  readonly role: EncounterRole;
  readonly displayName: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  reconnectUntil: number;
  lastDisconnectedAt?: number;
  revoked: boolean;
  readonly socketIds: Set<string>;
  readonly controlledEntityIds: Set<string>;
}

export type LanSessionLookup =
  | { ok: true; session: LanSessionRecord }
  | { ok: false; code: 'UNAUTHENTICATED' | 'SESSION_EXPIRED' | 'RECONNECT_EXPIRED' | 'SESSION_REVOKED'; message: string };

export interface LanCreatedSession {
  accessToken: string;
  session: LanSessionRecord;
}

export interface LanSessionServiceCredentials {
  hostCredential: string;
  joinCode: string;
}

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_RECONNECT_GRACE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PLAYERS = 3;

function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

function normalizeJoinCode(value: string): string {
  return value.trim().toUpperCase();
}

function hashSecret(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function secretsEqual(left: string, right: string): boolean {
  const leftHash = hashSecret(left);
  const rightHash = hashSecret(right);
  return timingSafeEqual(leftHash, rightHash);
}

/**
 * In-memory LAN demo identity and connection registry.
 *
 * This service intentionally has no dependency on the legacy authentication
 * service. A token maps to one server-created session, while each Socket.io
 * connection is tracked separately so a second tab cannot create a second
 * player identity or bypass command de-duplication.
 */
export class LanSessionService extends EventEmitter {
  private readonly hostCredentialValue: string;
  private readonly joinCodeValue: string;
  private readonly sessionTtlMs: number;
  private readonly reconnectGraceMs: number;
  private readonly maxPlayers: number;
  private readonly now: () => number;

  private readonly sessions = new Map<string, LanSessionRecord>();
  private readonly tokenToSessionId = new Map<string, string>();
  private readonly socketToSessionId = new Map<string, string>();
  private readonly playerIds = new Set<string>();
  private hostSessionId?: string;

  constructor(options: LanSessionServiceOptions = {}) {
    super();
    this.hostCredentialValue = options.hostCredential?.trim() || randomToken('gm', 24);
    this.joinCodeValue = normalizeJoinCode(options.joinCode || randomBytes(4).toString('hex').toUpperCase());
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.reconnectGraceMs = options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
    this.maxPlayers = options.maxPlayers ?? DEFAULT_MAX_PLAYERS;
    this.now = options.now ?? Date.now;

    if (!Number.isFinite(this.sessionTtlMs) || this.sessionTtlMs <= 0) {
      throw new Error('sessionTtlMs must be a positive finite number');
    }
    if (!Number.isFinite(this.reconnectGraceMs) || this.reconnectGraceMs < 0) {
      throw new Error('reconnectGraceMs must be a non-negative finite number');
    }
    if (!Number.isInteger(this.maxPlayers) || this.maxPlayers < 1) {
      throw new Error('maxPlayers must be a positive integer');
    }
  }

  /** Credentials are returned by createDemoServer to the local launcher only. */
  get credentials(): LanSessionServiceCredentials {
    return {
      hostCredential: this.hostCredentialValue,
      joinCode: this.joinCodeValue,
    };
  }

  createHostSession(credential: string, displayName = 'GM'): LanCreatedSession | null {
    if (typeof credential !== 'string' || !secretsEqual(credential, this.hostCredentialValue)) {
      return null;
    }

    this.pruneExpired();
    const existing = this.hostSessionId ? this.sessions.get(this.hostSessionId) : undefined;
    if (existing && !existing.revoked && this.now() < existing.expiresAt) {
      const accessToken = randomToken('demo');
      this.tokenToSessionId.set(hashSecret(accessToken).toString('hex'), existing.sessionId);
      return { accessToken, session: existing };
    }
    const created = this.createSession('gm', 'GM', displayName.trim() || 'GM');
    this.hostSessionId = created.session.sessionId;
    this.emit('session:created', this.toView(created.session));
    return created;
  }

  joinPlayer(joinCode: string, displayName?: string): LanCreatedSession | null {
    if (typeof joinCode !== 'string' || !secretsEqual(normalizeJoinCode(joinCode), this.joinCodeValue)) {
      return null;
    }

    this.pruneExpired();
    if (this.playerIds.size >= this.maxPlayers) return null;

    const playerNumber = this.playerIds.size + 1;
    const userId = randomToken('pl', 12);
    const created = this.createSession(
      userId,
      'PL',
      displayName?.trim() || `Player ${playerNumber}`,
    );
    this.playerIds.add(userId);
    this.emit('session:created', this.toView(created.session));
    return created;
  }

  authenticate(accessToken: string | undefined): LanSessionLookup {
    if (typeof accessToken !== 'string' || accessToken.length < 16 || accessToken.length > 256) {
      return { ok: false, code: 'UNAUTHENTICATED', message: '需要有效的 Demo 访问令牌' };
    }

    const sessionId = this.tokenToSessionId.get(hashSecret(accessToken).toString('hex'));
    if (!sessionId) {
      return { ok: false, code: 'UNAUTHENTICATED', message: '访问令牌无效' };
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, code: 'UNAUTHENTICATED', message: '会话不存在' };
    }
    const now = this.now();
    if (session.revoked) {
      return { ok: false, code: 'SESSION_REVOKED', message: '会话已登出' };
    }
    if (now >= session.expiresAt) {
      this.expire(session);
      return { ok: false, code: 'SESSION_EXPIRED', message: '会话已过期' };
    }
    if (session.lastDisconnectedAt !== undefined && now >= session.reconnectUntil) {
      this.expire(session);
      return { ok: false, code: 'RECONNECT_EXPIRED', message: '断线重连期限已过' };
    }
    return { ok: true, session };
  }

  attachSocket(accessToken: string | undefined, socketId: string): LanSessionLookup {
    const lookup = this.authenticate(accessToken);
    if (!lookup.ok) return lookup;
    if (typeof socketId !== 'string' || socketId.length === 0 || socketId.length > 200) {
      return { ok: false, code: 'UNAUTHENTICATED', message: 'Socket 标识无效' };
    }

    const previousSessionId = this.socketToSessionId.get(socketId);
    if (previousSessionId && previousSessionId !== lookup.session.sessionId) {
      // Re-authentication is a real disconnect for the old identity. This
      // preserves its reconnect grace and emits the same detach event as a
      // transport-level disconnect.
      this.detachSocket(socketId);
    }
    this.socketToSessionId.set(socketId, lookup.session.sessionId);
    lookup.session.socketIds.add(socketId);
    lookup.session.lastDisconnectedAt = undefined;
    lookup.session.reconnectUntil = lookup.session.expiresAt;
    this.emit('socket:attached', { socketId, sessionId: lookup.session.sessionId });
    return lookup;
  }

  detachSocket(socketId: string): LanSessionRecord | undefined {
    const sessionId = this.socketToSessionId.get(socketId);
    if (!sessionId) return undefined;
    this.socketToSessionId.delete(socketId);
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.socketIds.delete(socketId);
    if (session.socketIds.size === 0 && !session.revoked) {
      const now = this.now();
      session.lastDisconnectedAt = now;
      session.reconnectUntil = Math.min(session.expiresAt, now + this.reconnectGraceMs);
    }
    this.emit('socket:detached', { socketId, sessionId, connectedSocketCount: session.socketIds.size });
    return session;
  }

  sessionForSocket(socketId: string): LanSessionRecord | undefined {
    const sessionId = this.socketToSessionId.get(socketId);
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  logout(accessToken: string | undefined): LanSessionLookup {
    const lookup = this.authenticate(accessToken);
    if (!lookup.ok) return lookup;

    const socketIds = Array.from(lookup.session.socketIds);
    lookup.session.revoked = true;
    for (const socketId of socketIds) {
      this.socketToSessionId.delete(socketId);
    }
    lookup.session.socketIds.clear();
    if (lookup.session.role === 'PL') this.playerIds.delete(lookup.session.userId);
    if (lookup.session.sessionId === this.hostSessionId) this.hostSessionId = undefined;
    this.emit('session:revoked', { ...this.toView(lookup.session), socketIds });
    return lookup;
  }

  assignEntity(userId: string, entityId: string): boolean {
    const session = this.findPlayerSession(userId);
    if (!session || !this.isSafeIdentifier(entityId)) return false;

    for (const other of this.sessions.values()) {
      if (other.role === 'PL' && other.userId !== userId) {
        other.controlledEntityIds.delete(entityId);
      }
    }
    session.controlledEntityIds.add(entityId);
    this.emit('control:changed', { userId, entityId, assigned: true });
    return true;
  }

  unassignEntity(userId: string, entityId: string): boolean {
    const session = this.findPlayerSession(userId);
    if (!session || !this.isSafeIdentifier(entityId)) return false;
    const changed = session.controlledEntityIds.delete(entityId);
    if (changed) this.emit('control:changed', { userId, entityId, assigned: false });
    return changed;
  }

  getSession(sessionId: string): LanSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  getSessions(): LanSessionRecord[] {
    this.pruneExpired();
    return Array.from(this.sessions.values()).filter(session => !session.revoked);
  }

  getView(session: LanSessionRecord): DemoSessionView {
    return this.toView(session);
  }

  getRoster(viewer: LanSessionRecord): DemoRosterEntry[] {
    return this.getSessions().map(session => {
      const isViewer = session.sessionId === viewer.sessionId;
      const isGm = viewer.role === 'GM';
      return {
        ...(isGm ? { userId: session.userId } : {}),
        displayName: session.displayName,
        role: session.role,
        connectedSocketCount: session.socketIds.size,
        connected: session.socketIds.size > 0,
        controlledEntityIds: isGm || isViewer ? Array.from(session.controlledEntityIds) : [],
      };
    });
  }

  /** Used by tests and by the launcher on shutdown. */
  clear(): void {
    this.sessions.clear();
    this.tokenToSessionId.clear();
    this.socketToSessionId.clear();
    this.playerIds.clear();
    this.hostSessionId = undefined;
  }

  private createSession(userId: string, role: EncounterRole, displayName: string): LanCreatedSession {
    const now = this.now();
    const accessToken = randomToken('demo');
    const session: LanSessionRecord = {
      sessionId: randomToken('session', 18),
      userId,
      role,
      displayName,
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
      reconnectUntil: now + this.sessionTtlMs,
      revoked: false,
      socketIds: new Set<string>(),
      controlledEntityIds: new Set<string>(),
    };
    this.sessions.set(session.sessionId, session);
    this.tokenToSessionId.set(hashSecret(accessToken).toString('hex'), session.sessionId);
    return { accessToken, session };
  }

  private findPlayerSession(userId: string): LanSessionRecord | undefined {
    return Array.from(this.sessions.values()).find(session => session.role === 'PL' && session.userId === userId && !session.revoked);
  }

  private expire(session: LanSessionRecord): void {
    const socketIds = Array.from(session.socketIds);
    session.revoked = true;
    for (const socketId of socketIds) this.socketToSessionId.delete(socketId);
    session.socketIds.clear();
    if (session.role === 'PL') this.playerIds.delete(session.userId);
    if (session.sessionId === this.hostSessionId) this.hostSessionId = undefined;
    this.emit('session:expired', { ...this.toView(session), socketIds });
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (session.revoked) continue;
      if (now >= session.expiresAt || (session.lastDisconnectedAt !== undefined && now >= session.reconnectUntil)) {
        this.expire(session);
      }
    }
  }

  private toView(session: LanSessionRecord): DemoSessionView {
    return {
      sessionId: session.sessionId,
      userId: session.userId,
      role: session.role,
      displayName: session.displayName,
      expiresAt: session.expiresAt,
      reconnectUntil: session.reconnectUntil,
      connectedSocketCount: session.socketIds.size,
      controlledEntityIds: Array.from(session.controlledEntityIds),
    };
  }

  private isSafeIdentifier(value: string): boolean {
    return /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
  }
}
