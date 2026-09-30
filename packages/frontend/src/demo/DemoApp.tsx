import { useActionTargeting } from './useActionTargeting';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Radio, Shield, Users } from 'lucide-react';
import type { EncounterCommandResult, EncounterResult, EncounterSide, EncounterSnapshot } from '@hard-vtt/shared';
import { demoApi, getDemoApiError } from './api';
import { makeCommand } from './commands';
import { Battlefield } from './Battlefield';
import { Workspace, type WorkspaceHandle } from './Workspace';
import { GmPanel, LobbyPanel, ReactionPanel, ActionPanel, TimelinePanel, LogPanel, type DemoCommandSender } from './Panels';
import { EntityRoster } from './EntityRoster';
import { SpatialTacticsPanel } from './SpatialTacticsPanel';
import { DemoSocket } from './socket';
import { mergeRefreshedSession, type StoredDemoSession } from './session';
import { useDemoStore } from './store';
import type { DemoRoomInfo, DemoSessionInfo } from './types';
import { EncounterIntro } from './EncounterIntro';
import { entityLabel, factionLabel } from './format';

const SESSION_STORAGE_KEY = 'elysian-vtt-demo-session';

type LoginMode = 'GM' | 'PL';

function readStoredSession(): StoredDemoSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.accessToken !== 'string' || typeof record.session !== 'object' || record.session === null) return null;
    return parsed as StoredDemoSession;
  } catch {
    return null;
  }
}

function persistSession(session: DemoSessionInfo | StoredDemoSession): void {
  const persisted: StoredDemoSession = { accessToken: session.accessToken, session: session.session, joinCode: session.joinCode };
  try { window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(persisted)); } catch { /* 存储不可用时当前连接仍可继续。 */ }
}

function clearPersistedSession(): void {
  try { window.sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* 私密浏览上下文可能禁止存储。 */ }
}

function roomFrom(snapshot: EncounterSnapshot, entries: DemoRoomInfo['entries'] = [], settlement?: DemoRoomInfo['settlement']): DemoRoomInfo {
  return { encounterId: snapshot.encounterId, entries, snapshot, ...(settlement ? { settlement } : {}) };
}

function winningSideLabel(side: EncounterSide, snapshot: EncounterSnapshot): string {
  if (side.kind === 'FACTION') return factionLabel(side.id);
  const entity = snapshot.entities.find((candidate) => candidate.id === side.id);
  return entity ? entityLabel(entity) : '独立实体';
}

function resultTitle(result: EncounterResult, snapshot: EncounterSnapshot): string {
  const winners = result.winningSides?.map((side) => winningSideLabel(side, snapshot)).filter(Boolean) ?? [];
  if (winners.length > 0) return `胜者：${winners.join('、')}`;
  return result.status === 'VICTORY' ? '遭遇胜利' : result.status === 'MUTUAL_DEFEAT' ? '双方覆灭' : result.status === 'ENDED' ? '遭遇已结束' : '遭遇失败';
}

function connectionLabel(connection: ReturnType<typeof useDemoStore.getState>['connection']): string {
  switch (connection) {
    case 'connected': return '已连接';
    case 'connecting': return '连接中';
    case 'reconnecting': return '重连中';
    default: return '离线';
  }
}

function AppHeader({ session, snapshot, connection, onLogout }: { session: DemoSessionInfo; snapshot: EncounterSnapshot; connection: ReturnType<typeof useDemoStore.getState>['connection']; onLogout: () => void }) {
  return <header className="demo-header">
    <div className="demo-brand"><span className="demo-brand-mark">E</span><div><strong>ELYSIAN<span>VTT</span></strong><small>TACTICAL ENCOUNTER DEMO</small></div></div>
    <div className="demo-header-center"><span className="demo-header-connection"><span className={`demo-status-dot ${connection === 'connected' ? 'connected' : connection === 'reconnecting' ? 'warning' : 'offline'}`} />{connectionLabel(connection)}</span><span className="demo-header-divider" /><span className="demo-header-room" title={snapshot.encounterId}>房间 {snapshot.encounterId}</span><span className="demo-header-divider" /><span className="demo-header-tick">T{snapshot.tick}</span></div>
    <div className="demo-header-user"><div className="demo-user-avatar" aria-hidden="true">{session.session.displayName.slice(0, 1)}</div><span><b>{session.session.displayName}</b><small>{session.session.role === 'GM' ? 'GM 主持' : 'PL 玩家'}</small></span><button className="demo-button ghost tiny" type="button" onClick={onLogout}>退出</button></div>
  </header>;
}

function LoginView({ onSession }: { onSession: (session: DemoSessionInfo) => void }) {
  const [mode, setMode] = useState<LoginMode>('GM');
  const [nickname, setNickname] = useState('');
  const [credential, setCredential] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = mode === 'GM'
        ? await demoApi.createGmSession({ nickname: nickname.trim(), credential })
        : await demoApi.joinPlayerSession({ nickname: nickname.trim(), roomCode: joinCode });
      persistSession(session);
      onSession(session);
    } catch (requestError) {
      setError(getDemoApiError(requestError).reason);
    } finally {
      setBusy(false);
    }
  }

  return <main className="demo-login-page">
    <div className="demo-login-backdrop" aria-hidden="true" />
    <header className="demo-login-topbar">
      <div className="demo-brand"><span className="demo-brand-mark" aria-hidden="true">E</span><div><strong>ELYSIAN<span>VTT</span></strong><small>TACTICAL VIRTUAL TABLETOP</small></div></div>
      <span className="demo-login-edition"><span /> LAN MULTIPLAYER · DEMO</span>
    </header>
    <div className="demo-login-layout">
    <EncounterIntro />
    <section className="demo-login-card">
      <div className="demo-login-title"><span className="demo-eyebrow">JOIN THE ENCOUNTER</span><h2>就位，准备启程</h2><p>{mode === 'GM' ? '开启战局、分配角色，带领玩家进入故事。' : '输入主持人提供的加入码，与队友会合。'}</p></div>
      <div className="demo-login-tabs" role="group" aria-label="选择加入身份"><button type="button" aria-pressed={mode === 'GM'} disabled={busy} className={mode === 'GM' ? 'active' : ''} onClick={() => { setMode('GM'); setError(null); }}><Shield size={15} aria-hidden="true" />主持人登录</button><button type="button" aria-pressed={mode === 'PL'} disabled={busy} className={mode === 'PL' ? 'active' : ''} onClick={() => { setMode('PL'); setError(null); }}><Users size={15} aria-hidden="true" />玩家加入</button></div>
      <form onSubmit={submit} aria-busy={busy}>
        <label className="demo-field"><span>昵称</span><input className="demo-input" autoComplete="nickname" value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder={mode === 'GM' ? 'GM-阿斯特拉' : '玩家昵称'} minLength={1} maxLength={32} required /></label>
        {mode === 'GM' ? <label className="demo-field"><span>主持凭据</span><input className="demo-input" type="password" aria-label="主持凭据" aria-describedby="demo-host-help" autoComplete="current-password" value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="输入本机主持凭据" minLength={1} required /><small id="demo-host-help">请从本机 .demo/credentials.json 获取主持凭据。</small></label> : <label className="demo-field"><span>房间加入码</span><input className="demo-input code" aria-label="房间加入码" aria-describedby="demo-join-help" autoComplete="off" spellCheck={false} value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="例如 7F3A9C21" minLength={4} maxLength={32} required /><small id="demo-join-help">向主持人获取加入码，并确认已连接同一局域网。</small></label>}
        {error && <div className="demo-form-error" role="alert">{error}</div>}
        <button className="demo-button primary full large-button" type="submit" disabled={busy}>{busy ? '正在连接…' : mode === 'GM' ? '进入主持大厅' : '加入遭遇'}<ArrowRight size={17} aria-hidden="true" /></button>
      </form>
      <p className="demo-login-note"><Radio size={13} aria-hidden="true" />局域网直连 · 每个标签页独立会话</p>
    </section>
    </div>
    <footer className="demo-login-footer"><span>ELYSIAN VTT · 战术由你决定</span><span>主持裁决 / 多人协作 / 离散时间轴</span></footer>
  </main>;
}

export default function DemoApp() {
  const session = useDemoStore((state) => state.session);
  const room = useDemoStore((state) => state.room);
  const snapshot = useDemoStore((state) => state.snapshot);
  const catalog = useDemoStore((state) => state.catalog);
  const connection = useDemoStore((state) => state.connection);
  const selectedEntityId = useDemoStore((state) => state.selectedEntityId);
  const selectedTargetId = useDemoStore((state) => state.selectedTargetId);
  const selectedCell = useDemoStore((state) => state.selectedCell);
  const notices = useDemoStore((state) => state.notices);
  const storeError = useDemoStore((state) => state.error);
  const socketRef = useRef<DemoSocket | null>(null);
  const workspaceRef = useRef<WorkspaceHandle | null>(null);
  const [headerVisible, setHeaderVisible] = useState(false);
  const cleanupSocketRef = useRef<(() => void) | null>(null);
  const hydrationIdRef = useRef(0);
  const sessionRequestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const noticeTimersRef = useRef(new Map<string, number>());
  const catalogRefreshKeyRef = useRef('');
  const catalogRefreshRequestRef = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const [restoring, setRestoring] = useState(() => Boolean(readStoredSession()));
  const [focusedActionId, setFocusedActionId] = useState<string | null>(null);
  const [hoveredActionId, setHoveredActionId] = useState<string | null>(null);
  const [gmFocusActionRequest, setGmFocusActionRequest] = useState<{ actionId: string; nonce: number } | null>(null);

  const setSession = useDemoStore((state) => state.setSession);
  const setRoom = useDemoStore((state) => state.setRoom);
  const setCatalog = useDemoStore((state) => state.setCatalog);
  const setSnapshot = useDemoStore((state) => state.setSnapshot);
  const setConnection = useDemoStore((state) => state.setConnection);
  const setSelectedTarget = useDemoStore((state) => state.setSelectedTarget);
  const setSelectedCell = useDemoStore((state) => state.setSelectedCell);
  const addPendingRequest = useDemoStore((state) => state.addPendingRequest);
  const removePendingRequest = useDemoStore((state) => state.removePendingRequest);
  const addNotice = useDemoStore((state) => state.addNotice);
  const setError = useDemoStore((state) => state.setError);
  const clearStore = useDemoStore((state) => state.clear);

  const controlledCatalogKey = session?.session.role === 'PL' && snapshot
    ? [
      session.session.userId,
      ...session.session.controlledEntityIds
        .map((entityId) => {
          const entity = snapshot.entities.find((candidate) => candidate.id === entityId);
          return `${entityId}:${entity?.templateId ?? entity?.encounterTemplateId ?? ''}`;
        })
        .sort(),
    ].join('|')
    : '';
  const catalogToken = session?.accessToken;
  const catalogRole = session?.session.role;
  const catalogLoaded = catalog !== null;

  useEffect(() => {
    document.title = `${catalog?.scenario?.title ?? '暮色渡口'} · Elysian VTT`;
  }, [catalog?.scenario?.title]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!catalogToken || catalogRole !== 'PL' || !catalogLoaded || !controlledCatalogKey) return;
    const requestKey = `${catalogToken}|${controlledCatalogKey}`;
    if (catalogRefreshKeyRef.current === requestKey) return;
    catalogRefreshKeyRef.current = requestKey;
    const requestId = catalogRefreshRequestRef.current + 1;
    catalogRefreshRequestRef.current = requestId;
    let active = true;
    void demoApi.getCatalog(catalogToken).then((nextCatalog) => {
      if (active && catalogRefreshRequestRef.current === requestId) setCatalog(nextCatalog);
    }).catch((error) => {
      if (active && catalogRefreshRequestRef.current === requestId) addNotice({ tone: 'warning', message: `角色目录刷新失败：${getDemoApiError(error).reason}` });
    });
    return () => { active = false; };
  }, [addNotice, catalogLoaded, catalogRole, catalogToken, controlledCatalogKey, setCatalog]);

  const applySettlement = useCallback((settlement: DemoRoomInfo['settlement']): void => {
    const currentSnapshot = useDemoStore.getState().snapshot;
    if (!currentSnapshot || !settlement) return;
    const currentRoom = useDemoStore.getState().room;
    setRoom({ ...roomFrom(currentSnapshot, currentRoom?.entries ?? [], settlement), snapshot: currentSnapshot });
  }, [setRoom]);

  const refreshSettlement = useCallback(async (token: string): Promise<void> => {
    const encounterId = useDemoStore.getState().snapshot?.encounterId;
    const resultTick = useDemoStore.getState().snapshot?.result?.resolvedTick;
    try {
      const settlement = await demoApi.getSettlement(token);
      const current = useDemoStore.getState();
      if (!mountedRef.current || current.session?.accessToken !== token || current.snapshot?.encounterId !== encounterId || current.snapshot?.result?.resolvedTick !== resultTick) return;
      applySettlement(settlement);
    } catch {
      // The command result and socket error remain authoritative when the
      // optional persistence status endpoint is temporarily unavailable.
    }
  }, [applySettlement]);

  const hydrate = useCallback(async (nextSession: DemoSessionInfo): Promise<void> => {
    if (!mountedRef.current) return;
    const hydrationId = ++hydrationIdRef.current;
    const isCurrent = () => mountedRef.current && hydrationIdRef.current === hydrationId && useDemoStore.getState().session?.accessToken === nextSession.accessToken;
    cleanupSocketRef.current?.();
    cleanupSocketRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    const currentSnapshot = useDemoStore.getState().snapshot;
    if (!currentSnapshot || currentSnapshot.encounterId !== nextSession.snapshot.encounterId) {
      setFocusedActionId(null);
      setHoveredActionId(null);
      setGmFocusActionRequest(null);
    }
    setSession(nextSession, roomFrom(nextSession.snapshot, [], nextSession.settlement));
    setSnapshot(nextSession.snapshot);
    try {
      const [roster, catalog] = await Promise.all([
        demoApi.getRoster(nextSession.accessToken),
        demoApi.getCatalog(nextSession.accessToken),
      ]);
      if (!isCurrent()) return;
      setRoom({ ...roster, settlement: roster.settlement ?? nextSession.settlement });
      setCatalog(catalog);
    } catch (error) {
      if (!isCurrent()) return;
      addNotice({ tone: 'warning', message: `大厅目录暂时不可用：${getDemoApiError(error).reason}` });
    }
    if (!isCurrent()) return;
    const socket = new DemoSocket(nextSession);
    socketRef.current = socket;
    setConnection('connecting');
    const offConnection = socket.on('connection', (connected) => { if (isCurrent()) setConnection(connected ? 'connected' : 'reconnecting'); });
    const offSnapshot = socket.on('snapshot', (nextSnapshot) => {
      if (!isCurrent()) return;
      setSnapshot(nextSnapshot);
      const currentSession = useDemoStore.getState().session ?? nextSession;
      persistSession({ ...currentSession, snapshot: nextSnapshot });
    });
    const offRoster = socket.on('roster', (entries) => {
      if (!isCurrent()) return;
      const currentSnapshot = useDemoStore.getState().snapshot;
      const currentRoom = useDemoStore.getState().room;
      if (currentSnapshot) setRoom({ ...roomFrom(currentSnapshot, entries, currentRoom?.settlement), snapshot: currentSnapshot });
      const currentSession = useDemoStore.getState().session;
      const viewer = currentSession && currentSession.session.role === 'PL'
        ? entries.find((entry) => entry.userId === currentSession.session.userId)
        : undefined;
      if (currentSession && viewer && currentSession.session.role === 'PL') {
        const nextControlled = [...viewer.controlledEntityIds].sort();
        const currentControlled = [...currentSession.session.controlledEntityIds].sort();
        if (nextControlled.join('|') !== currentControlled.join('|')) {
          const nextSession = { ...currentSession, session: { ...currentSession.session, controlledEntityIds: viewer.controlledEntityIds } };
          setSession(nextSession);
          persistSession(nextSession);
        }
      }
    });
    const offCommand = socket.on('command', (result) => {
      if (!isCurrent()) return;
      removePendingRequest(result.requestId);
      if (result.ok) addNotice({ tone: 'success', message: result.message ?? '命令已接受' });
      else addNotice({ tone: 'error', message: result.reason ?? '命令被拒绝' });
      if (result.snapshot.result) void refreshSettlement(nextSession.accessToken);
    });
    const offError = socket.on('error', (error) => {
      if (!isCurrent()) return;
      if (error.requestId) removePendingRequest(error.requestId);
      addNotice({ tone: 'error', message: error.reason });
      setError(error.reason);
      if (error.code === 'PERSISTENCE_FAILED') void refreshSettlement(nextSession.accessToken);
    });
    socket.connect();
    cleanupSocketRef.current = () => {
      offConnection();
      offSnapshot();
      offRoster();
      offCommand();
      offError();
      socket.disconnect();
    };
  }, [addNotice, refreshSettlement, removePendingRequest, setCatalog, setConnection, setError, setRoom, setSession, setSnapshot]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      hydrationIdRef.current += 1;
      sessionRequestIdRef.current += 1;
      cleanupSocketRef.current?.();
    };
  }, []);

  useEffect(() => {
    const stored = readStoredSession();
    if (!stored) return;
    const requestId = ++sessionRequestIdRef.current;
    let active = true;
    void demoApi.refresh(stored.accessToken).then((fresh) => {
      if (!active || requestId !== sessionRequestIdRef.current) return;
      const merged = mergeRefreshedSession(fresh, stored);
      persistSession(merged);
      return hydrate(merged);
    }).catch((error) => {
      if (!active || requestId !== sessionRequestIdRef.current) return;
      clearPersistedSession();
      addNotice({ tone: 'warning', message: `会话恢复失败：${getDemoApiError(error).reason}` });
    }).finally(() => { if (active && requestId === sessionRequestIdRef.current) setRestoring(false); });
    return () => { active = false; };
  }, [addNotice, hydrate]);

  const onLogin = useCallback((nextSession: DemoSessionInfo) => {
    sessionRequestIdRef.current += 1;
    setError(null);
    void hydrate(nextSession);
  }, [hydrate, setError]);

  const onLogout = useCallback(() => {
    hydrationIdRef.current += 1;
    sessionRequestIdRef.current += 1;
    const activeSession = useDemoStore.getState().session;
    if (activeSession) void demoApi.logout(activeSession.accessToken).catch(() => undefined);
    cleanupSocketRef.current?.();
    cleanupSocketRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    clearPersistedSession();
    clearStore();
    catalogRefreshKeyRef.current = '';
    catalogRefreshRequestRef.current += 1;
    setFocusedActionId(null);
    setHoveredActionId(null);
    setGmFocusActionRequest(null);
  }, [clearStore]);

  const onFocusTimelineAction = useCallback((actionId: string | null) => {
    setFocusedActionId(actionId);
  }, []);

  const onPreviewTimelineAction = useCallback((actionId: string | null) => {
    setHoveredActionId(actionId);
  }, []);

  const onRequestTimelineEdit = useCallback((actionId: string) => {
    workspaceRef.current?.open('gm');
    setFocusedActionId(actionId);
    setGmFocusActionRequest((current) => ({ actionId, nonce: (current?.nonce ?? 0) + 1 }));
    window.setTimeout(() => {
      document.querySelector<HTMLElement>('[data-demo-gm-edit-plan]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
  }, []);

  const onRetrySettlement = useCallback(async (): Promise<void> => {
    const { session: activeSession, snapshot: activeSnapshot } = useDemoStore.getState();
    if (!activeSession || activeSession.session.role !== 'GM') return;
    const hydrationId = hydrationIdRef.current;
    const isCurrent = () => {
      const current = useDemoStore.getState();
      return mountedRef.current && hydrationId === hydrationIdRef.current && current.session?.accessToken === activeSession.accessToken
        && current.snapshot?.encounterId === activeSnapshot?.encounterId && current.snapshot?.result?.resolvedTick === activeSnapshot?.result?.resolvedTick;
    };
    try {
      const settlement = await demoApi.retrySettlement(activeSession.accessToken);
      if (!isCurrent()) return;
      applySettlement(settlement);
      addNotice({ tone: settlement.status === 'saved' ? 'success' : 'warning', message: settlement.message ?? (settlement.status === 'saved' ? '结算已保存' : '结算仍未保存') });
    } catch (error) {
      if (!isCurrent()) return;
      await refreshSettlement(activeSession.accessToken);
      if (!isCurrent()) return;
      addNotice({ tone: 'error', message: getDemoApiError(error).reason });
    }
  }, [addNotice, applySettlement, refreshSettlement]);

  const sendCommand = useCallback<DemoCommandSender>((type, payload, entityId, onResult) => {
    const activeSession = useDemoStore.getState().session;
    const activeSnapshot = useDemoStore.getState().snapshot;
    const socket = socketRef.current;
    if (!activeSession || !activeSnapshot || !socket) {
      addNotice({ tone: 'error', message: '尚未连接到遭遇服务器' });
      return;
    }
    const controlEpoch = entityId ? activeSnapshot.controls.find((control) => control.entityId === entityId)?.controlEpoch : undefined;
    const isMainAction = type === 'START' || type === 'WAIT' || type === 'ACTION' || type === 'RECOVER';
    const isDecision = type === 'REACTION_JOIN' || type === 'REACTION_SELECT' || type === 'REACTION_PASS' || type === 'GM_PASS';
    const windowId = typeof payload.windowId === 'string' ? payload.windowId : undefined;
    const decisionVersion = windowId ? activeSnapshot.decisions.find((decision) => decision.windowId === windowId)?.version : undefined;
    const command = makeCommand(type, payload, {
      expectedRevision: activeSnapshot.revision,
      ...(isMainAction ? { expectedBarrierVersion: activeSnapshot.plan.barrierVersion } : {}),
      ...(isDecision ? { expectedDecisionVersion: decisionVersion } : {}),
      ...(controlEpoch !== undefined ? { controlEpoch } : {}),
    });
    addPendingRequest(command.requestId);
    socket.sendCommand(command, (_result: EncounterCommandResult) => {
      removePendingRequest(_result.requestId);
      onResult?.(_result);
    });
  }, [addNotice, addPendingRequest, removePendingRequest]);

  const targeting = useActionTargeting(sendCommand);

  const onAssign = useCallback(async (userId: string, entityId: string) => {
    const activeSession = useDemoStore.getState().session;
    if (!activeSession) return;
    const hydrationId = hydrationIdRef.current;
    const isCurrent = () => mountedRef.current && hydrationId === hydrationIdRef.current && useDemoStore.getState().session?.accessToken === activeSession.accessToken;
    try {
      const nextRoom = await demoApi.assignEntity(activeSession.accessToken, { userId, entityId });
      if (!isCurrent()) return;
      setSnapshot(nextRoom.snapshot);
      const currentSnapshot = useDemoStore.getState().snapshot ?? nextRoom.snapshot;
      setRoom({ ...nextRoom, snapshot: currentSnapshot });
      addNotice({ tone: 'success', message: '角色控制权已分配' });
    } catch (error) {
      if (!isCurrent()) return;
      addNotice({ tone: 'error', message: getDemoApiError(error).reason });
    }
  }, [addNotice, setRoom, setSnapshot]);

  const onRefresh = useCallback(() => {
    const activeSession = useDemoStore.getState().session;
    if (!activeSession) return;
    const requestId = ++sessionRequestIdRef.current;
    void demoApi.refresh(activeSession.accessToken).then((nextSession) => {
      if (!mountedRef.current || requestId !== sessionRequestIdRef.current || useDemoStore.getState().session?.accessToken !== activeSession.accessToken) return;
      const merged = mergeRefreshedSession(nextSession, { accessToken: activeSession.accessToken, session: activeSession.session, joinCode: activeSession.joinCode });
      persistSession(merged);
      void hydrate(merged);
    }).catch((error) => {
      if (mountedRef.current && requestId === sessionRequestIdRef.current) addNotice({ tone: 'error', message: getDemoApiError(error).reason });
    });
  }, [addNotice, hydrate]);

  const dismissNotice = useDemoStore((state) => state.dismissNotice);
  useEffect(() => {
    const timers = noticeTimersRef.current;
    const activeIds = new Set(notices.map((notice) => notice.id));
    for (const [noticeId, timer] of timers) {
      if (!activeIds.has(noticeId)) {
        window.clearTimeout(timer);
        timers.delete(noticeId);
      }
    }
    for (const notice of notices) {
      if ((notice.tone !== 'success' && notice.tone !== 'info') || timers.has(notice.id)) continue;
      const timer = window.setTimeout(() => {
        timers.delete(notice.id);
        dismissNotice(notice.id);
      }, 4000);
      timers.set(notice.id, timer);
    }
  }, [dismissNotice, notices]);
  useEffect(() => () => {
    for (const timer of noticeTimersRef.current.values()) window.clearTimeout(timer);
    noticeTimersRef.current.clear();
  }, []);
  const result = snapshot?.result;
  const inLobby = !snapshot || snapshot.status === 'LOBBY';

  if (restoring) return <main className="demo-login-page"><section className="demo-login-card"><span className="demo-eyebrow">ELYSIAN VTT</span><h1>正在恢复遭遇…</h1><p className="demo-muted">先向服务器验证当前标签页会话，再加载权威快照。</p></section></main>;
  if (!session || !snapshot) return <LoginView onSession={onLogin} />;
  const visibleFocusedActionId = focusedActionId && snapshot.actions.some((action) => action.actionId === focusedActionId) ? focusedActionId : null;
  const visibleHoveredActionId = hoveredActionId && snapshot.actions.some((action) => action.actionId === hoveredActionId) ? hoveredActionId : null;
  const mapFocusedActionId = visibleHoveredActionId ?? visibleFocusedActionId;

  return <div className={`demo-app${!inLobby && !headerVisible ? ' is-header-hidden' : ''}`}>
    {(inLobby || headerVisible) && <AppHeader session={session} snapshot={snapshot} connection={connection} onLogout={onLogout} />}
    <div className="demo-notices" aria-live="polite">{notices.map((notice) => <button key={notice.id} type="button" className={`demo-notice ${notice.tone}`} onClick={() => dismissNotice(notice.id)}>{notice.message}<span>×</span></button>)}</div>
    {storeError && connection === 'connected' && <div className="demo-inline-error" role="status">{storeError}<button type="button" onClick={() => setError(null)}>×</button></div>}
    {inLobby ? <div className="demo-lobby-stage">
      <LobbyPanel session={session} room={room} snapshot={snapshot} catalog={catalog} onAssign={onAssign} onStart={() => sendCommand('START', {})} onRefresh={onRefresh} />
      <SpatialTacticsPanel session={session} snapshot={snapshot} catalog={catalog} selectedEntityId={selectedEntityId} />
      <div className="demo-lobby-setup">
         <Battlefield interaction={targeting} entities={snapshot.entities} actions={snapshot.actions} currentTick={snapshot.tick} catalog={catalog} relations={snapshot.relations} selectedEntityId={selectedEntityId} selectedTargetId={selectedTargetId} selectedCell={selectedCell} onSelectEntity={targeting.selectEntity} onSelectTarget={(entityId) => setSelectedTarget(entityId)} onSelectCell={(cell) => setSelectedCell(cell)} />
       <EntityRoster snapshot={snapshot} session={session} catalog={catalog} selectedEntityId={selectedEntityId} selectionDisabled={targeting.state?.phase === 'submitting'} onSelectEntity={targeting.selectEntity} />
       <GmPanel session={session} snapshot={snapshot} catalog={catalog} selectedEntityId={selectedEntityId} selectedTargetId={selectedTargetId} selectedCell={selectedCell} onCommand={sendCommand} onRestart={() => sendCommand('GM_RESTART', {})} settlement={room?.settlement} focusActionRequest={gmFocusActionRequest} />
      </div>
    </div> : <>
      <Workspace key={session.session.role} workspaceRef={workspaceRef} role={session.session.role}
        headerVisible={headerVisible} onToggleHeader={() => setHeaderVisible(value => !value)}
        targetSelectionKey={targeting.state?.preview && targeting.state.phase !== 'submitting' ? `${targeting.state.actorId}:${targeting.state.action.id}` : null}
        attention={snapshot.decisions.some(decision => !decision.resolved && (session.session.role === 'GM' || session.session.controlledEntityIds.includes(decision.reactorEntityId)))}
        timeline={<TimelinePanel snapshot={snapshot} entities={snapshot.entities} catalog={catalog} focusedActionId={visibleFocusedActionId} hoveredActionId={visibleHoveredActionId} onFocusAction={onFocusTimelineAction} onPreviewAction={onPreviewTimelineAction} onRequestEditAction={onRequestTimelineEdit} isGm={session.session.role === 'GM'} />}
        map={
           <Battlefield interaction={targeting} entities={snapshot.entities} actions={snapshot.actions} currentTick={snapshot.tick} focusedActionId={mapFocusedActionId} catalog={catalog} relations={snapshot.relations} selectedEntityId={selectedEntityId} selectedTargetId={selectedTargetId} selectedCell={selectedCell} onSelectEntity={targeting.selectEntity} onSelectTarget={(entityId) => setSelectedTarget(entityId)} onSelectCell={(cell) => setSelectedCell(cell)} />
        }
        actions={<>
          <SpatialTacticsPanel session={session} snapshot={snapshot} catalog={catalog} selectedEntityId={selectedEntityId} onChooseAction={targeting.enabled ? targeting.choose : undefined} submitting={targeting.state?.phase === 'submitting'} />
          {snapshot.decisions.some(decision => !decision.resolved) && <ReactionPanel session={session} snapshot={snapshot} now={now} onCommand={sendCommand} />}
          <ActionPanel onChooseAction={targeting.enabled ? targeting.choose : undefined} activeTemplateId={targeting.state?.action.id} submitting={targeting.state?.phase === 'submitting'} session={session} snapshot={snapshot} catalog={catalog} selectedEntityId={selectedEntityId} selectedTargetId={selectedTargetId} selectedCell={selectedCell} onCommand={targeting.enabled ? targeting.immediate : sendCommand} now={now} />
        </>}
         entities={<EntityRoster snapshot={snapshot} session={session} catalog={catalog} selectedEntityId={selectedEntityId} selectionDisabled={targeting.state?.phase === 'submitting'} onSelectEntity={targeting.selectEntity} />}
        logs={<LogPanel snapshot={snapshot} />}
        gm={<GmPanel session={session} snapshot={snapshot} catalog={catalog} selectedEntityId={selectedEntityId} selectedTargetId={selectedTargetId} selectedCell={selectedCell} onCommand={sendCommand} onRestart={() => sendCommand('GM_RESTART', {})} settlement={room?.settlement} focusActionRequest={gmFocusActionRequest} />}
      />
      {result && (() => {
        const settlementStatus = room?.settlement?.status ?? 'pending';
        const settlementLabel = settlementStatus === 'saved' ? '已保存' : settlementStatus === 'failed' ? '保存失败，可重试' : '保存中…';
         return <div className="demo-result-banner"><div><span className="demo-eyebrow">ENCOUNTER RESOLVED · T{result.resolvedTick}</span><strong>{resultTitle(result, snapshot)}</strong><span>{result.reason ?? `由 ${result.endedBy === 'GM' ? 'GM' : '规则'} 结束`}</span><span className="demo-muted">结算状态：{settlementLabel}</span></div>{session.session.role === 'GM' && <button className="demo-button primary" type="button" disabled={settlementStatus !== 'saved'} onClick={() => sendCommand('GM_RESTART', {})}>重开遭遇</button>}</div>;
      })()}
      {room?.settlement && room.settlement.status !== 'saved' && <div className={`demo-settlement-status ${room.settlement.status}`} role="status"><span>{room.settlement.status === 'pending' ? '结算保存中…' : `结算保存失败：${room.settlement.message ?? '可重试'}`}</span>{session.session.role === 'GM' && room.settlement.retryable && room.settlement.status === 'failed' && <button className="demo-button ghost tiny" type="button" onClick={() => void onRetrySettlement()}>重试保存</button>}</div>}
    </>}
  </div>;
}
