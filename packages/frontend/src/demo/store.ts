import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Draft } from 'immer';
import type { EncounterEntity, EncounterSnapshot } from '@hard-vtt/shared';
import type { DemoCatalog, DemoRoomInfo, DemoSessionInfo, DemoSelectedCell } from './types';

export type DemoConnectionState = 'offline' | 'connecting' | 'connected' | 'reconnecting';

export interface DemoNotice {
  id: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

interface DemoState {
  session: DemoSessionInfo | null;
  room: DemoRoomInfo | null;
  catalog: DemoCatalog | null;
  snapshot: EncounterSnapshot | null;
  connection: DemoConnectionState;
  selectedEntityId: string | null;
  selectedTargetId: string | null;
  selectedCell: DemoSelectedCell | null;
  pendingRequests: string[];
  notices: DemoNotice[];
  error: string | null;
  setSession: (session: DemoSessionInfo, room?: DemoRoomInfo, snapshot?: EncounterSnapshot, catalog?: DemoCatalog) => void;
  setRoom: (room: DemoRoomInfo) => void;
  setCatalog: (catalog: DemoCatalog) => void;
  setSnapshot: (snapshot: EncounterSnapshot) => void;
  setConnection: (connection: DemoConnectionState) => void;
  setSelectedEntity: (entityId: string | null) => void;
  setSelectedTarget: (entityId: string | null) => void;
  setSelectedCell: (cell: DemoSelectedCell | null) => void;
  addPendingRequest: (requestId: string) => void;
  removePendingRequest: (requestId: string) => void;
  addNotice: (notice: Omit<DemoNotice, 'id'>) => void;
  dismissNotice: (id: string) => void;
  setError: (error: string | null) => void;
  clear: () => void;
}

const initialState = {
  session: null,
  room: null,
  catalog: null,
  snapshot: null,
  connection: 'offline' as DemoConnectionState,
  selectedEntityId: null,
  selectedTargetId: null,
  selectedCell: null,
  pendingRequests: [],
  notices: [],
  error: null,
};

function noticeId(): string {
  return `notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** HTTP 与 socket 共用同一版本检查，房间元数据不能携带较旧的游戏状态。 */
function applySnapshot(state: Draft<DemoState>, snapshot: EncounterSnapshot): void {
  if (state.snapshot && state.snapshot.encounterId === snapshot.encounterId && snapshot.revision < state.snapshot.revision) return;
  state.snapshot = snapshot;
  if (state.room?.encounterId === snapshot.encounterId) state.room.snapshot = snapshot;
  if (state.session?.session.role === 'PL') {
    const userId = state.session.session.userId;
    state.session.session.controlledEntityIds = snapshot.controls
      .filter((control) => control.role === 'PL' && control.userId === userId && !control.takenOverByGm)
      .map((control) => control.entityId);
  }
  const currentIds = new Set(snapshot.entities.map((entity: EncounterEntity) => entity.id));
  if (state.selectedEntityId && !currentIds.has(state.selectedEntityId)) state.selectedEntityId = null;
  if (!state.selectedEntityId && state.session?.session.role === 'PL') {
    state.selectedEntityId = state.session.session.controlledEntityIds.find((id) => currentIds.has(id)) ?? null;
  }
  if (state.selectedTargetId && !currentIds.has(state.selectedTargetId)) state.selectedTargetId = null;
}

function applyRoom(state: Draft<DemoState>, room: DemoRoomInfo): void {
  if (state.session && room.encounterId !== state.session.snapshot.encounterId) return;
  applySnapshot(state, room.snapshot);
  state.room = { ...room, snapshot: state.snapshot ?? room.snapshot };
}

export const useDemoStore = create<DemoState>()(immer((set) => ({
  ...initialState,
  setSession: (session, room, snapshot, catalog) => set((state) => {
    if (state.session?.accessToken !== session.accessToken || state.session.session.sessionId !== session.session.sessionId) {
      Object.assign(state, initialState);
    }
    state.session = session;
    if (room) applyRoom(state, room);
    if (snapshot) applySnapshot(state, snapshot);
    if ((room || snapshot) && state.snapshot) applySnapshot(state, state.snapshot);
    if (catalog) state.catalog = catalog;
  }),
  setRoom: (room) => set((state) => { applyRoom(state, room); }),
  setCatalog: (catalog) => set((state) => { state.catalog = catalog; }),
  setSnapshot: (snapshot) => set((state) => {
    applySnapshot(state, snapshot);
  }),
  setConnection: (connection) => set((state) => { state.connection = connection; }),
  setSelectedEntity: (entityId) => set((state) => { state.selectedEntityId = entityId; state.selectedTargetId = null; }),
  setSelectedTarget: (entityId) => set((state) => { state.selectedTargetId = entityId; }),
  setSelectedCell: (cell) => set((state) => { state.selectedCell = cell; }),
  addPendingRequest: (requestId) => set((state) => {
    if (!state.pendingRequests.includes(requestId)) state.pendingRequests.push(requestId);
  }),
  removePendingRequest: (requestId) => set((state) => { state.pendingRequests = state.pendingRequests.filter((id) => id !== requestId); }),
  addNotice: (notice) => set((state) => {
    state.notices.unshift({ ...notice, id: noticeId() });
    state.notices = state.notices.slice(0, 8);
  }),
  dismissNotice: (id) => set((state) => { state.notices = state.notices.filter((notice) => notice.id !== id); }),
  setError: (error) => set((state) => { state.error = error; }),
  clear: () => set((state) => {
    Object.assign(state, initialState);
  }),
})));

export function getEntity(snapshot: EncounterSnapshot | null, entityId: string | null): EncounterEntity | undefined {
  if (!snapshot || !entityId) return undefined;
  return snapshot.entities.find((entity) => entity.id === entityId);
}
