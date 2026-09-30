import { io, type Socket } from 'socket.io-client';
import type {
  DemoRosterEntry,
  DemoSocketError,
  DemoSocketEvents as WireDemoSocketEvents,
  EncounterCommand,
  EncounterCommandResult,
  EncounterSnapshot,
} from '@hard-vtt/shared';
import type { DemoSessionInfo, DemoSocketEvents, DemoTransportError } from './types';

const configuredServer = typeof import.meta.env === 'object' && import.meta.env !== null
  ? import.meta.env.VITE_SERVER_URL
  : undefined;
const serverOrigin = configuredServer && configuredServer.trim().length > 0
  ? configuredServer.replace(/\/$/, '')
  : (typeof window === 'undefined' ? '' : window.location.origin);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function errorFrom(value: DemoSocketError | unknown): DemoTransportError {
  const record = asRecord(value);
  return {
    code: typeof record?.code === 'string' ? record.code : undefined,
    reason: typeof record?.message === 'string' ? record.message : typeof record?.reason === 'string' ? record.reason : '服务器连接错误',
  };
}

function isSnapshot(value: unknown): value is EncounterSnapshot {
  const record = asRecord(value);
  return Boolean(
    record &&
    typeof record.encounterId === 'string' &&
    typeof record.revision === 'number' &&
    typeof record.tick === 'number' &&
    Array.isArray(record.entities) &&
    Array.isArray(record.actions) &&
    Array.isArray(record.decisions) &&
    Array.isArray(record.controls) &&
    Array.isArray(record.logs) &&
    record.plan,
  );
}

function snapshotFrom(value: unknown): EncounterSnapshot | undefined {
  if (isSnapshot(value)) return value;
  const record = asRecord(value);
  const snapshot = record?.snapshot;
  return isSnapshot(snapshot) ? snapshot : undefined;
}

function rosterFrom(value: unknown): DemoRosterEntry[] | undefined {
  const record = asRecord(value);
  const entries = record?.entries;
  if (!Array.isArray(entries)) return undefined;
  return entries.filter((entry): entry is DemoRosterEntry => {
    const item = asRecord(entry);
    return Boolean(
      item &&
      typeof item.displayName === 'string' &&
      typeof item.role === 'string' &&
      typeof item.connectedSocketCount === 'number' &&
      typeof item.connected === 'boolean' &&
      Array.isArray(item.controlledEntityIds),
    );
  });
}

export class DemoSocket {
  private socket: Socket | undefined;
  private readonly session: DemoSessionInfo;
  private readonly handlers: {
    snapshot: Set<DemoSocketEvents['snapshot']>;
    roster: Set<DemoSocketEvents['roster']>;
    command: Set<DemoSocketEvents['command']>;
    error: Set<DemoSocketEvents['error']>;
    connection: Set<DemoSocketEvents['connection']>;
  } = {
    snapshot: new Set(),
    roster: new Set(),
    command: new Set(),
    error: new Set(),
    connection: new Set(),
  };

  public constructor(session: DemoSessionInfo) {
    this.session = session;
  }

  public connect(): void {
    if (this.socket) return;
    const socket = io(serverOrigin || undefined, {
      transports: ['websocket'],
      autoConnect: false,
      auth: { accessToken: this.session.accessToken },
    });
    this.socket = socket;
    socket.on('connect', () => {
      this.emitConnection(true);
    });
    socket.on('disconnect', () => this.emitConnection(false));
    socket.on('connect_error', (error: Error) => {
      this.emitConnection(false);
      this.emitError({ code: 'CONNECT_ERROR', message: error.message });
    });
    socket.on('DEMO_SNAPSHOT', (payload: Parameters<WireDemoSocketEvents['DEMO_SNAPSHOT']>[0]) => {
      this.emitSnapshot(payload.snapshot);
    });
    socket.on('DEMO_INCREMENT', (payload: Parameters<WireDemoSocketEvents['DEMO_INCREMENT']>[0]) => {
      this.emitSnapshot(payload.snapshot);
    });
    socket.on('DEMO_ROSTER', (payload: Parameters<WireDemoSocketEvents['DEMO_ROSTER']>[0]) => {
      const entries = rosterFrom(payload);
      if (entries) this.emitRoster(entries);
    });
    socket.on('DEMO_ERROR', (payload: Parameters<WireDemoSocketEvents['DEMO_ERROR']>[0]) => this.emitError(payload));
    socket.connect();
  }

  public disconnect(): void {
    this.socket?.disconnect();
    this.socket = undefined;
  }

  public get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  public on<K extends keyof DemoSocketEvents>(event: K, handler: DemoSocketEvents[K]): () => void {
    if (event === 'snapshot') {
      this.handlers.snapshot.add(handler as DemoSocketEvents['snapshot']);
      return () => this.handlers.snapshot.delete(handler as DemoSocketEvents['snapshot']);
    }
    if (event === 'roster') {
      this.handlers.roster.add(handler as DemoSocketEvents['roster']);
      return () => this.handlers.roster.delete(handler as DemoSocketEvents['roster']);
    }
    if (event === 'command') {
      this.handlers.command.add(handler as DemoSocketEvents['command']);
      return () => this.handlers.command.delete(handler as DemoSocketEvents['command']);
    }
    if (event === 'error') {
      this.handlers.error.add(handler as DemoSocketEvents['error']);
      return () => this.handlers.error.delete(handler as DemoSocketEvents['error']);
    }
    this.handlers.connection.add(handler as DemoSocketEvents['connection']);
    return () => this.handlers.connection.delete(handler as DemoSocketEvents['connection']);
  }

  public sendCommand(command: EncounterCommand, onResult?: (result: EncounterCommandResult) => void): void {
    if (!this.socket?.connected) {
      this.emitError({ code: 'NOT_CONNECTED', message: '尚未连接遭遇服务器', requestId: command.requestId });
      return;
    }
    this.socket.timeout(10000).emit('DEMO_COMMAND', command, (timeoutError: Error | null, payload: EncounterCommandResult | undefined) => {
      if (timeoutError || !payload) {
        this.emitError({ code: 'COMMAND_TIMEOUT', message: '服务器未在 10 秒内确认命令', requestId: command.requestId });
        return;
      }
      this.emitCommand(payload);
      onResult?.(payload);
    });
  }

  private emitSnapshot(snapshot: unknown): void {
    const value = snapshotFrom(snapshot);
    if (!value) {
      this.emitError({ code: 'INVALID_SNAPSHOT', message: '服务器返回了无法识别的遭遇快照' });
      return;
    }
    for (const handler of this.handlers.snapshot) handler(value);
  }

  private emitRoster(entries: DemoRosterEntry[]): void {
    for (const handler of this.handlers.roster) handler(entries);
  }

  private emitCommand(result: EncounterCommandResult): void {
    for (const handler of this.handlers.command) handler(result);
    this.emitSnapshot(result.snapshot);
  }

  private emitError(error: DemoSocketError | { code: string; message: string; requestId?: string }): void {
    const normalized = errorFrom(error);
    const record = asRecord(error);
    if (typeof record?.requestId === 'string') normalized.requestId = record.requestId;
    for (const handler of this.handlers.error) handler(normalized);
  }

  private emitConnection(connected: boolean): void {
    for (const handler of this.handlers.connection) handler(connected);
  }
}
