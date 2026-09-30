import { useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type Ref } from 'react';
import { Pin } from 'lucide-react';
import { defaultWorkspaceLayout, fitPanel, fitDockedPanel, layoutDockTabs, nearestDockEdge, PANEL_IDS, readWorkspaceLayout, type DockEdge, type PanelId, type PanelLayout } from './workspaceLayout';
import { useWorkspaceAutoHide } from './useWorkspaceAutoHide';
import type { EncounterRole } from '@hard-vtt/shared';
import './workspace.css';

const titles: Record<PanelId, string> = { actions: '行动与反应', entities: '实体列表', timeline: '战术时间轴', logs: '战斗日志', gm: '主持工具' };
export interface WorkspaceHandle { open: (id: PanelId) => void; }
interface Props {
  role: EncounterRole; map: ReactNode; actions: ReactNode; entities: ReactNode; timeline: ReactNode; logs: ReactNode; gm: ReactNode;
  attention: boolean; targetSelectionKey?: string | null; workspaceRef?: Ref<WorkspaceHandle>;
  headerVisible?: boolean; onToggleHeader?: () => void;
}

export function Workspace({ role, map, actions, entities, timeline, logs, gm, attention, targetSelectionKey, workspaceRef, headerVisible = true, onToggleHeader }: Props) {
  const storageKey = `elysian-workspace-v3-${role}`;
  const [layout, setLayout] = useState(() => {
    try { return readWorkspaceLayout(window.localStorage.getItem(storageKey) ?? window.localStorage.getItem(`elysian-workspace-v2-${role}`), { width: window.innerWidth, height: window.innerHeight, headerHeight: headerVisible ? 68 : 0 }); } catch { return defaultWorkspaceLayout({ width: window.innerWidth, height: window.innerHeight, headerHeight: headerVisible ? 68 : 0 }); }
  });
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const compact = viewport.width <= 760;
  const [compactCollapsed, setCompactCollapsed] = useState<Partial<Record<PanelId, boolean>>>({ logs: true, gm: true });
  const [dragging, setDragging] = useState<PanelId | null>(null);
  const [keyboardFloating, setKeyboardFloating] = useState<PanelId | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuElement = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !menuElement.current?.contains(event.target)) setMenuOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuElement.current?.querySelector<HTMLButtonElement>('.workspace-menu-toggle')?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [menuOpen]);
  const panelViewport = { ...viewport, headerHeight: headerVisible ? 68 : 0 };
  const [order, setOrder] = useState<PanelId[]>([...PANEL_IDS]);
  const raise = (id: PanelId) => setOrder(current => [...current.filter(item => item !== id), id]);
  const gesture = useRef<{ id: PanelId; mode: 'move' | 'resize'; x: number; y: number; initial: PanelLayout; current: PanelLayout; movement?: { x: number; y: number } } | null>(null);
  const busy = useRef<PanelId | null>(null);
  const actionBody = useRef<HTMLDivElement | null>(null);
  const mapElement = useRef<HTMLDivElement | null>(null);
  const panelElements = useRef<Partial<Record<PanelId, HTMLElement>>>({});
  const dockTabs = useRef<Partial<Record<PanelId, HTMLButtonElement>>>({});
  const autoHide = useWorkspaceAutoHide({ layout, compact, attention, panels: panelElements, busy });
  const pendingScroll = useRef<PanelId | null>(null);
  const ids = PANEL_IDS.filter(id => id !== 'gm' || role === 'GM');
  const panelContent: Record<PanelId, ReactNode> = { actions, entities, timeline, logs, gm };

  useEffect(() => {
    if (compact && targetSelectionKey) mapElement.current?.scrollIntoView({ block: 'start' });
  }, [compact, targetSelectionKey]);

  useEffect(() => {
    if (attention) {
      actionBody.current?.scrollTo({ top: 0 });
      if (compact) panelElements.current.actions?.scrollIntoView({ block: 'start' });
    }
  }, [attention, compact]);
  useEffect(() => {
    const id = pendingScroll.current;
    pendingScroll.current = null;
    if (compact && id) panelElements.current[id]?.scrollIntoView({ block: 'start' });
  }, [layout, compact]);
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { window.localStorage.setItem(storageKey, JSON.stringify({ version: 3, panels: layout })); } catch { /* Storage can be unavailable in private contexts. */ }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [layout, storageKey]);

  function update(id: PanelId, change: Partial<PanelLayout>) {
    setLayout(current => ({ ...current, [id]: { ...current[id], ...change } }));
  }
  function reveal(id: PanelId) {
    pendingScroll.current = id;
    update(id, { hidden: false, collapsed: false });
    setCompactCollapsed(current => ({ ...current, [id]: false }));
    autoHide.open(id);
    raise(id);
  }
  useImperativeHandle(workspaceRef, () => ({ open: reveal }));

  function displayedPanel(id: PanelId) {
    const panel = { ...layout[id], collapsed: false };
    return panel.pinned || dragging === id || keyboardFloating === id ? fitPanel(panel, panelViewport) : fitDockedPanel(panel, panelViewport);
  }
  function openDock(event: MouseEvent<HTMLButtonElement>) {
    const id = event.currentTarget.dataset.panel;
    if (PANEL_IDS.some(candidate => candidate === id)) reveal(id as PanelId);
  }
  function togglePin(id: PanelId) {
    const panel = displayedPanel(id);
    update(id, { ...panel, pinned: !layout[id].pinned, collapsed: false, dockEdge: nearestDockEdge(panel, panelViewport) });
    autoHide.open(id, false);
    autoHide.scheduleClose(id);
  }
  function minimize(id: PanelId) {
    update(id, { collapsed: true });
    autoHide.minimize(id);
    requestAnimationFrame(() => dockTabs.current[id]?.focus({ preventScroll: true }));
  }
  function resetLayout() {
    autoHide.reset();
    setCompactCollapsed({ logs: true, gm: true });
    setLayout(defaultWorkspaceLayout(panelViewport));
  }

  function start(event: PointerEvent<HTMLButtonElement>, id: PanelId, mode: 'move' | 'resize') {
    if (compact || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const initial = displayedPanel(id);
    gesture.current = { id, mode, x: event.clientX, y: event.clientY, initial, current: initial };
    busy.current = id;
    setDragging(id);
    autoHide.clear(id);
    raise(id);
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const active = gesture.current;
    if (compact || !active) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    const next = active.mode === 'move'
      ? { ...active.initial, x: active.initial.x + dx, y: active.initial.y + dy }
      : { ...active.initial, width: active.initial.width + dx, height: active.initial.height + dy };
    const fitted = fitPanel(next, panelViewport);
    const movement = { x: fitted.x - active.current.x, y: fitted.y - active.current.y };
    // Clamped pointer motion and a stationary release must not erase the last
    // actual drag direction. Resizing does not contribute a drag direction.
    if (active.mode === 'move' && (movement.x !== 0 || movement.y !== 0)) active.movement = movement;
    active.current = fitted;
    update(active.id, active.current);
  }
  function endGesture() {
    const active = gesture.current;
    if (!active) return;
    update(active.id, { ...active.current, dockEdge: nearestDockEdge(active.current, panelViewport, active.initial.dockEdge, active.movement) });
    gesture.current = null;
    busy.current = null;
    setDragging(null);
    autoHide.scheduleClose(active.id);
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, id: PanelId, mode: 'move' | 'resize') {
    if (compact) return;
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 10;
    const panel = displayedPanel(id);
    const next = fitPanel(mode === 'move'
      ? { ...panel, x: panel.x + direction[0] * step, y: panel.y + direction[1] * step }
      : { ...panel, width: panel.width + direction[0] * step, height: panel.height + direction[1] * step }, panelViewport);
    const movement = mode === 'move' ? { x: next.x - panel.x, y: next.y - panel.y } : undefined;
    update(id, { ...next, dockEdge: nearestDockEdge(next, panelViewport, panel.dockEdge, movement) });
    setKeyboardFloating(id);
  }
  function windowPanel(id: PanelId, children: ReactNode) {
    const urgent = id === 'actions' && attention;
    const titleless = id === 'actions' || id === 'timeline';
    const state = displayedPanel(id);
    const collapsed = compact && !urgent && Boolean(compactCollapsed[id]);
    const autoHidden = !compact && !urgent && !(layout[id].pinned ? !layout[id].collapsed : autoHide.expanded[id]);
    const gripOnly = titleless && !collapsed;
    const shiftX = state.dockEdge === 'left' ? -(state.x + state.width + 32) : state.dockEdge === 'right' ? viewport.width - state.x + 32 : 0;
    const shiftY = state.dockEdge === 'top' ? -(state.y + state.height + 32) : state.dockEdge === 'bottom' ? viewport.height - state.y + 32 : 0;
    const style: CSSProperties | undefined = compact ? undefined : { left: state.x, top: state.y, width: state.width, height: state.height, zIndex: urgent ? 59 : 40 + order.indexOf(id), '--dock-shift-x': `${shiftX}px`, '--dock-shift-y': `${shiftY}px` } as CSSProperties;
    return <section key={id} ref={element => { if (element) panelElements.current[id] = element; else delete panelElements.current[id]; }} hidden={layout[id].hidden && !urgent} inert={autoHidden} aria-hidden={autoHidden || undefined} style={style} className={`workspace-window ${compact ? 'is-stacked' : 'is-floating'} ${collapsed ? 'is-collapsed' : ''} ${autoHidden ? 'is-auto-hidden' : ''} ${urgent ? 'needs-attention' : ''}`} data-panel={id} data-dock-edge={state.dockEdge} aria-label={`${titles[id]}窗口`}
      onPointerDownCapture={() => { if (!compact) raise(id); }} onPointerEnter={event => autoHide.enter(id, false, event.pointerType)} onPointerLeave={event => autoHide.leave(id, event.pointerType)}
      onFocusCapture={() => autoHide.focus(id)} onBlurCapture={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setKeyboardFloating(current => current === id ? null : current);
        autoHide.blur(id);
      }}>
      <header className={`workspace-window-bar${gripOnly ? ' is-titleless' : ''}${id === 'timeline' ? ' is-overlay' : ''}`}>
        <button type="button" className={`workspace-drag${gripOnly ? ' is-grip-only' : ''}`} disabled={compact} aria-label={compact ? titles[id] : `移动${titles[id]}窗口`} title={compact ? undefined : '拖动标题移动；方向键微调，Shift 加速'} onPointerDown={event => start(event, id, 'move')} onPointerMove={move} onPointerUp={endGesture} onPointerCancel={endGesture} onLostPointerCapture={endGesture} onKeyDown={event => keyboard(event, id, 'move')}>
          {gripOnly ? <span className="workspace-drag-grip" aria-hidden="true" /> : <strong>{titles[id]}</strong>}
          {urgent && <b>待响应</b>}
        </button>
        <div className="workspace-window-tools">
          {!compact && <button type="button" className="workspace-pin" disabled={urgent} aria-label={`${layout[id].pinned ? '取消固定' : '固定'}${titles[id]}`} title={layout[id].pinned ? '取消固定，离开后自动收起' : '固定在屏幕上'} aria-pressed={layout[id].pinned} onClick={() => togglePin(id)}><Pin size={14} fill={layout[id].pinned ? 'currentColor' : 'none'} aria-hidden="true" /></button>}
          <button type="button" disabled={urgent} aria-label={`${compact ? collapsed ? '展开' : '折叠' : '最小化'}${titles[id]}`} aria-expanded={!collapsed && !autoHidden} onClick={() => compact ? setCompactCollapsed(current => ({ ...current, [id]: !collapsed })) : minimize(id)}>{collapsed ? '+' : '−'}</button>
          <button type="button" disabled={urgent} aria-label={`隐藏${titles[id]}`} title="隐藏；从右上角工作台菜单重新打开" onClick={() => { update(id, { hidden: true }); autoHide.close(id); }}>×</button>
        </div>
      </header>
      <div ref={id === 'actions' ? actionBody : undefined} className="workspace-window-body" hidden={collapsed}>{children}</div>
      {!compact && <button type="button" className="workspace-resize" aria-label={`调整${titles[id]}窗口大小`} title="拖动或使用方向键调整大小" onPointerDown={event => start(event, id, 'resize')} onPointerMove={move} onPointerUp={endGesture} onPointerCancel={endGesture} onLostPointerCapture={endGesture} onKeyDown={event => keyboard(event, id, 'resize')}>◢</button>}
    </section>;
  }

  return <main className={`workspace${compact ? ' is-compact' : ''}`}>
    <div ref={menuElement} className="workspace-menu" style={{ top: headerVisible ? 80 : 12 }}>
    <button type="button" className="workspace-menu-toggle" aria-label="工作台菜单" aria-expanded={menuOpen} aria-controls="workspace-menu-content" onClick={() => setMenuOpen(value => !value)}>☰</button>
    <nav id="workspace-menu-content" className="workspace-menu-content" aria-label="工作区模块" hidden={!menuOpen} onClick={event => { if ((event.target as HTMLElement).closest('button')) setMenuOpen(false); }}>
      {onToggleHeader && <button type="button" aria-expanded={headerVisible} onClick={onToggleHeader} title={headerVisible ? '隐藏标题和房间信息，释放战场空间' : '显示标题、房间信息和退出入口'}>{headerVisible ? '收起房间信息' : '房间信息'}</button>}
      <div className="workspace-module-buttons">{ids.map(id => <button type="button" key={id} aria-pressed={!layout[id].hidden || (id === 'actions' && attention)} className={id === 'actions' && attention ? 'needs-attention' : ''} onClick={() => reveal(id)}>{titles[id]}{id === 'actions' && attention ? ' · 待响应' : layout[id].hidden ? ' +' : ''}</button>)}</div>
      <button type="button" className="workspace-reset" onClick={resetLayout}>恢复默认布局</button>
    </nav>
    </div>
    <div ref={mapElement} className="workspace-map">{map}</div>
    {!compact && (['top', 'bottom', 'left', 'right'] as DockEdge[]).map(edge => {
      const dockedIds = ids.filter(id => layout[id].dockEdge === edge && !layout[id].hidden && (!layout[id].pinned || layout[id].collapsed) && !(id === 'actions' && attention));
      if (dockedIds.length === 0) return null;
      const edgeLabel = { top: '顶部', bottom: '底部', left: '左侧', right: '右侧' }[edge];
      const horizontal = edge === 'top' || edge === 'bottom';
      const rail = layoutDockTabs(dockedIds.map(id => ({ id, panel: layout[id] })), edge, panelViewport);
      return <nav key={edge} className="workspace-dock-rail" data-dock-edge={edge} aria-label={`${edgeLabel}窗口`} style={{ '--dock-top': `${headerVisible ? 68 : 0}px` } as CSSProperties}>
        <div className="workspace-dock-track" style={horizontal ? { width: rail.extent } : { height: rail.extent }}>
          {rail.tabs.map(({ id, offset }) => <button key={id} type="button" className="workspace-dock-tab" data-panel={id} data-pinned={layout[id].pinned} style={horizontal ? { left: offset } : { top: offset }} ref={element => { if (element) dockTabs.current[id] = element; else delete dockTabs.current[id]; }} aria-label={`展开${titles[id]}`} aria-expanded={Boolean(autoHide.expanded[id]) && !(layout[id].pinned && layout[id].collapsed)} onPointerEnter={event => autoHide.enter(id, true, event.pointerType)} onPointerLeave={event => autoHide.leave(id, event.pointerType)} onClick={openDock}>{titles[id]}</button>)}
        </div>
      </nav>;
    })}
    {ids.map(id => windowPanel(id, panelContent[id]))}
  </main>;
}
