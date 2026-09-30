import type {
  DemoAssignmentResponse,
  DemoActionPreviewResponse,
  DemoCatalogResponse,
  DemoSessionResponse,
  DemoRosterResponse,
  DemoSettlementResponse,
  DemoSettlementState,
} from '@hard-vtt/shared';
import type {
  DemoApiError,
  DemoCatalog,
  DemoRoomAssignment,
  DemoRoomInfo,
  DemoSessionInfo,
} from './types';

type RequestMethod = 'GET' | 'POST';

const configuredServer = typeof import.meta.env === 'object' && import.meta.env !== null
  ? import.meta.env.VITE_SERVER_URL
  : undefined;
const serverOrigin = configuredServer && configuredServer.trim().length > 0
  ? configuredServer.replace(/\/$/, '')
  : (typeof window === 'undefined' ? '' : window.location.origin);

function readReason(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (typeof value !== 'object' || value === null) return fallback;
  const record = value as Record<string, unknown>;
  for (const key of ['reason', 'message', 'error']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return fallback;
}

interface SuccessEnvelope<T> {
  ok: true;
  data: T;
}

function readSuccess<T>(value: unknown): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw { status: 502, reason: '服务器返回格式无效' } satisfies DemoApiError;
  }
  const envelope = value as SuccessEnvelope<T>;
  if (envelope.ok !== true || !('data' in envelope)) {
    throw { status: 502, reason: '服务器没有返回成功数据' } satisfies DemoApiError;
  }
  return envelope.data;
}

async function request<T>(
  method: RequestMethod,
  path: string,
  token?: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${serverOrigin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '无法连接服务器';
    throw { status: 0, reason } satisfies DemoApiError;
  }

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    const data = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined;
    const code = data && typeof data.code === 'string' ? data.code : undefined;
    throw { status: response.status, code, reason: readReason(parsed, `请求失败（${response.status}）`) } satisfies DemoApiError;
  }

  return parsed as T;
}

export interface CreateGmSessionInput {
  nickname: string;
  credential: string;
}

export interface JoinPlayerSessionInput {
  nickname: string;
  roomCode: string;
}

export const demoApi = {
  async previewAction(token: string, entityId: string, actionTemplateId: string) {
    return readSuccess<DemoActionPreviewResponse['data']>(await request<DemoActionPreviewResponse>('POST', '/api/demo/action-preview', token, { entityId, actionTemplateId }));
  },
  async createGmSession(input: CreateGmSessionInput): Promise<DemoSessionInfo> {
    const envelope = await request<DemoSessionResponse>('POST', '/api/demo/host', undefined, {
      credential: input.credential.trim(),
      displayName: input.nickname.trim(),
    });
    return readSuccess<DemoSessionInfo>(envelope);
  },

  async joinPlayerSession(input: JoinPlayerSessionInput): Promise<DemoSessionInfo> {
    const envelope = await request<DemoSessionResponse>('POST', '/api/demo/join', undefined, {
      joinCode: input.roomCode.trim().toUpperCase(),
      displayName: input.nickname.trim(),
    });
    return readSuccess<DemoSessionInfo>(envelope);
  },

  async refresh(token: string): Promise<DemoSessionInfo> {
    const envelope = await request<DemoSessionResponse>('GET', '/api/demo/session', token);
    return readSuccess<DemoSessionInfo>(envelope);
  },

  async logout(token: string): Promise<void> {
    await request<{ ok: true }>('POST', '/api/demo/logout', token);
  },

  async getSettlement(token: string): Promise<DemoSettlementState> {
    const envelope = await request<DemoSettlementResponse>('GET', '/api/demo/persistence', token);
    return readSuccess<DemoSettlementResponse['data']>(envelope);
  },

  async retrySettlement(token: string): Promise<DemoSettlementState> {
    const envelope = await request<DemoSettlementResponse>('POST', '/api/demo/persistence/retry', token);
    return readSuccess<DemoSettlementResponse['data']>(envelope);
  },

  async getRoster(token: string): Promise<DemoRoomInfo> {
    const envelope = await request<DemoRosterResponse>('GET', '/api/demo/roster', token);
    return readSuccess<DemoRosterResponse['data']>(envelope);
  },

  async assignEntity(token: string, assignment: DemoRoomAssignment): Promise<DemoRoomInfo> {
    const envelope = await request<DemoAssignmentResponse>('POST', '/api/demo/assign', token, assignment);
    const data = readSuccess<DemoAssignmentResponse['data']>(envelope);
    return {
      encounterId: data.snapshot.encounterId,
      entries: data.entries,
      snapshot: data.snapshot,
      ...(data.settlement ? { settlement: data.settlement } : {}),
    };
  },

  async getCatalog(token: string): Promise<DemoCatalog> {
    const envelope = await request<DemoCatalogResponse>('GET', '/api/demo/catalog', token);
    return readSuccess<DemoCatalogResponse['data']>(envelope);
  },
};

export function getDemoApiError(error: unknown): DemoApiError {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const status = typeof record.status === 'number' ? record.status : 0;
    const code = typeof record.code === 'string' ? record.code : undefined;
    return { status, code, reason: readReason(record.reason, '请求失败') };
  }
  return { status: 0, reason: readReason(error, '请求失败') };
}
