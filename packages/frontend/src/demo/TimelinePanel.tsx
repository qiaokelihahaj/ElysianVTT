import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ActionTimelineSegmentPhase, EncounterActionPlan, EncounterEntity, EncounterLogEntry, EncounterSnapshot } from '@hard-vtt/shared';
import type { DemoCatalog } from './types';
import './timeline.css';
import { actionIdLabel, actionLabel, entityLabel, entityFactionColor, isDown, phaseLabel, templateCatalog } from './format';

/**
 * The server timeline is optional for compatibility with older Demo
 * snapshots. Older servers do not have enough information to draw a truthful
 * phase bar, so the component shows a visible compatibility state instead of
 * deriving timings locally.
 */
interface TimelineSegment {
  start: number;
  end: number;
  kind: ActionTimelineSegmentPhase;
  strikeIndex?: number;
}

interface TimelinePanelProps {
  snapshot: EncounterSnapshot;
  entities: EncounterEntity[];
  catalog: DemoCatalog | null;
  focusedActionId?: string | null;
  hoveredActionId?: string | null;
  onFocusAction?: (actionId: string | null) => void;
  onPreviewAction?: (actionId: string | null) => void;
  onRequestEditAction?: (actionId: string) => void;
  isGm?: boolean;
}

const LABEL_WIDTH = 146;
const BASE_PX_PER_TICK = 42;
const RULER_HEIGHT = 28;
const LANE_HEIGHT = 48;
const SUBLANE_HEIGHT = 48;
const RECENT_RESULT_TICKS = 10;

const PHASE_LABELS: Record<TimelineSegment['kind'], string> = {
  STARTUP: '大前摇',
  SMALL_STARTUP: '小前摇',
  ACTIVE: '生效',
  CHANNELING: '引导',
  MOVING: '移动',
  RECOVERY: '后摇',
};

function hasTimeline(action: EncounterActionPlan): action is EncounterActionPlan & { timeline: NonNullable<EncounterActionPlan['timeline']> } {
  const timeline = action.timeline;
  return Boolean(timeline
    && Number.isFinite(timeline.start)
    && Number.isFinite(timeline.startupEnd)
    && Number.isFinite(timeline.recoveryStart)
    && Number.isFinite(timeline.end)
    && timeline.end >= timeline.start);
}

function activeWindows(timeline: NonNullable<EncounterActionPlan['timeline']>): Array<{ start: number; end: number; strikeIndex: number }> {
  const configured = timeline.activeWindows?.filter((window) => Number.isFinite(window.start)
    && Number.isFinite(window.end)
    && window.end > window.start)
    .sort((a, b) => a.start - b.start || a.strikeIndex - b.strikeIndex);
  if (configured && configured.length > 0) return configured;
  // A pulse tick is an event point, not an ACTIVE interval.  Keep it for the
  // point marker below, but never invent a one-Tick window in the client.
  return [];
}

function timelineSegments(action: EncounterActionPlan & { timeline: NonNullable<EncounterActionPlan['timeline']> }): TimelineSegment[] {
  const timeline = action.timeline;
  if (timeline.phaseSegments && timeline.phaseSegments.length > 0) {
    return timeline.phaseSegments
      .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
      .map((segment) => ({ start: segment.start, end: segment.end, kind: segment.phase, strikeIndex: segment.strikeIndex }));
  }
  const windows = activeWindows(timeline);
  const segments: TimelineSegment[] = [];
  if (timeline.startupEnd > timeline.start) {
    segments.push({ start: timeline.start, end: timeline.startupEnd, kind: 'STARTUP' });
  }

  for (const window of windows) {
    if (window.end > window.start) segments.push({ start: window.start, end: window.end, kind: 'ACTIVE', strikeIndex: window.strikeIndex });
  }
  if (timeline.end > timeline.recoveryStart) {
    segments.push({ start: timeline.recoveryStart, end: timeline.end, kind: 'RECOVERY' });
  }
  return segments;
}

function uniqueActions(actions: EncounterActionPlan[]): EncounterActionPlan[] {
  const byId = new Map<string, EncounterActionPlan>();
  for (const action of actions) {
    // A snapshot can contain an old and a newly patched copy while a socket
    // increment is being merged.  The instance id is the only safe key.
    byId.set(action.actionId, action);
  }
  return [...byId.values()].sort((a, b) => {
    const aStart = hasTimeline(a) ? a.timeline.start : a.declaredTick;
    const bStart = hasTimeline(b) ? b.timeline.start : b.declaredTick;
    return aStart - bStart || b.priority - a.priority || a.actionId.localeCompare(b.actionId);
  });
}

function entityName(entity: EncounterEntity | undefined, entityId: string): string {
  return entity ? entityLabel(entity) : entityId;
}

function actionName(action: EncounterActionPlan, catalogActions: Map<string, DemoCatalog['entries'][number]['actions'][number]>): string {
  const template = catalogActions.get(action.actionTemplateId);
  return template ? actionLabel(template) : actionIdLabel(action.actionTemplateId);
}

function phaseFor(action: EncounterActionPlan, entity: EncounterEntity | undefined): string {
  // Match by action instance id.  Matching only template id makes an old
  // action appear to be ACTIVE when the actor has already started another one.
  if (entity?.currentActionContext?.actionId === action.actionId) {
    return phaseLabel(entity.currentActionContext.phase);
  }
  return phaseLabel(action.phase);
}

function laneStatus(entity: EncounterEntity, snapshot: EncounterSnapshot): { label: string; tone: 'idle' | 'ready' | 'waiting' | 'blocked' } {
  if (isDown(entity)) return { label: '已倒下', tone: 'blocked' };
  const slot = snapshot.plan.slots.find((candidate) => candidate.entityId === entity.id);
  if (slot?.waiting) return { label: `等待至 T${slot.readyAtTick ?? snapshot.tick + 5}`, tone: 'waiting' };
  if (slot?.ready) return { label: '已就绪，等待统一提交', tone: 'ready' };
  if (slot?.blockedReason) return { label: slot.blockedReason, tone: 'blocked' };
  if (slot && !slot.connected) return { label: '玩家断线，等待 GM 代决', tone: 'blocked' };
  if (entity.currentActionContext?.phase === 'RECOVERY') {
    return { label: `收招至 T${entity.currentActionContext.resolveTick}`, tone: 'waiting' };
  }
  if (entity.currentActionContext) return { label: phaseLabel(entity.currentActionContext.phase), tone: 'waiting' };
  return { label: '待机 · 可提交行动', tone: 'idle' };
}

function slotIsActionableUnready(slot: EncounterSnapshot['plan']['slots'][number], snapshot: EncounterSnapshot, entities: EncounterEntity[]): boolean {
  if (slot.ready || slot.waiting) return false;
  if (slot.readyAtTick !== undefined && slot.readyAtTick > snapshot.tick) return false;
  const entity = entities.find((candidate) => candidate.id === slot.entityId);
  return entity !== undefined && !isDown(entity) && entity.currentActionContext === undefined;
}

function resultMarker(log: EncounterLogEntry): { label: string; tone: 'hit' | 'miss' | 'interrupt' | 'other' } {
  const message = log.message;
  if (/打断|中断|interrupt/i.test(message)) return { label: '打断', tone: 'interrupt' };
  if (/落空|未命中|范围外|whiff|miss/i.test(message)) return { label: '落空', tone: 'miss' };
  if (/命中|伤害|治疗|恢复|hit|damage|heal/i.test(message)) return { label: '结果', tone: 'hit' };
  return { label: '事件', tone: 'other' };
}

function formatRange(action: EncounterActionPlan, snapshot: EncounterSnapshot): string {
  if (!hasTimeline(action)) return missingTimelineLabel(action, snapshot);
  return `T${action.timeline.start}–T${action.timeline.end}`;
}

function isUndeterminedPlan(action: EncounterActionPlan, snapshot: EncounterSnapshot): boolean {
  return action.phase === 'DECLARED' || snapshot.plan.actions.some((planned) => planned.actionId === action.actionId);
}

function missingTimelineLabel(action: EncounterActionPlan, snapshot: EncounterSnapshot): string {
  return isUndeterminedPlan(action, snapshot) ? '已就绪，等待统一提交 · 执行时间尚未确定' : '阶段数据需更新服务';
}

function nextKnownEvent(actions: EncounterActionPlan[], snapshot: EncounterSnapshot, entities: EncounterEntity[], catalogActions: Map<string, DemoCatalog['entries'][number]['actions'][number]>): string {
  const candidates: Array<{ tick: number; label: string }> = [];
  for (const action of actions) {
    if (!hasTimeline(action)) continue;
    const actor = entityName(entities.find((entity) => entity.id === action.actorId), action.actorId);
    const label = actionName(action, catalogActions);
    for (const segment of action.timeline.phaseSegments ?? []) {
      if (segment.start > snapshot.tick) candidates.push({ tick: segment.start, label: `${actor} · ${label} · ${PHASE_LABELS[segment.phase]}开始` });
      if (segment.start <= snapshot.tick && segment.end > snapshot.tick) candidates.push({ tick: segment.end, label: `${actor} · ${label} · ${PHASE_LABELS[segment.phase]}结束` });
    }
    for (const tick of action.timeline.pulseTicks ?? []) {
      if (tick > snapshot.tick) candidates.push({ tick, label: `${actor} · ${label} · 服务器事件点` });
    }
    if (!action.timeline.phaseSegments?.length) {
      if (action.timeline.start > snapshot.tick) candidates.push({ tick: action.timeline.start, label: `${actor} · ${label} · 动作开始` });
      if (action.timeline.startupEnd > snapshot.tick) candidates.push({ tick: action.timeline.startupEnd, label: `${actor} · ${label} · 已知前摇边界` });
      if (action.timeline.recoveryStart > snapshot.tick) candidates.push({ tick: action.timeline.recoveryStart, label: `${actor} · ${label} · 后摇开始` });
      if (action.timeline.end > snapshot.tick) candidates.push({ tick: action.timeline.end, label: `${actor} · ${label} · 动作结束` });
    }
  }
  candidates.sort((a, b) => a.tick - b.tick || a.label.localeCompare(b.label));
  return candidates.length > 0 ? `下一已知事件 T${candidates[0].tick} · ${candidates[0].label}` : '暂无已知后续事件';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function TimelinePanel({ snapshot, entities, catalog, focusedActionId, hoveredActionId, onFocusAction, onPreviewAction, onRequestEditAction, isGm = false }: TimelinePanelProps) {
  const [viewMode, setViewMode] = useState<'compact' | 'full'>('compact');
  const [zoom, setZoom] = useState(1);
  const [localFocus, setLocalFocus] = useState<string | null>(null);
  const [followCurrent, setFollowCurrent] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const programmaticScroll = useRef(false);
  const followRef = useRef(true);
  const catalogActions = useMemo(() => new Map(templateCatalog(catalog).map((template) => [template.id, template])), [catalog]);
  const actions = useMemo(() => uniqueActions(snapshot.actions), [snapshot.actions]);
  const selectedActionId = focusedActionId === undefined ? localFocus : focusedActionId;
  const visualFocusActionId = hoveredActionId ?? selectedActionId;
  const selectedAction = actions.find((action) => action.actionId === selectedActionId);
  const pxPerTick = BASE_PX_PER_TICK * zoom;
  const rowHeight = viewMode === 'compact' ? 34 : SUBLANE_HEIGHT;
  const rulerHeight = viewMode === 'compact' ? 24 : RULER_HEIGHT;

  const timelineStarts = actions.filter(hasTimeline).map((action) => action.timeline.start);
  const timelineEnds = actions.filter(hasTimeline).map((action) => action.timeline.end);
  const globalStart = Math.max(0, Math.min(snapshot.tick - RECENT_RESULT_TICKS, ...(timelineStarts.length > 0 ? timelineStarts : [snapshot.tick])));
  const globalEnd = Math.max(snapshot.tick + 12, ...(timelineEnds.length > 0 ? timelineEnds : [snapshot.tick + 12]));
  const span = Math.max(12, globalEnd - globalStart);
  const canvasWidth = LABEL_WIDTH + (span + 2) * pxPerTick;
  const tickOffset = useCallback((tick: number) => (tick - globalStart) * pxPerTick, [globalStart, pxPerTick]);

  const lanes = useMemo(() => {
    const entityById = new Map(entities.map((entity) => [entity.id, entity]));
    const laneIds = [...entities.filter((entity) => entity.type === 'ACTOR').map((entity) => entity.id)];
    for (const action of actions) if (!laneIds.includes(action.actorId)) laneIds.push(action.actorId);
    return laneIds.map((entityId, index) => ({
      entityId,
      entity: entityById.get(entityId),
      color: entityFactionColor(entityById.get(entityId)),
      actions: (() => {
        const placed: Array<{ action: EncounterActionPlan; row: number }> = [];
        const rowEnds: number[] = [];
        for (const action of actions.filter((candidate) => candidate.actorId === entityId)) {
          const start = hasTimeline(action) ? action.timeline.start : action.declaredTick;
          const end = hasTimeline(action) ? action.timeline.end : start + 3;
          const row = rowEnds.findIndex((rowEnd) => rowEnd <= start);
          if (row === -1) {
            rowEnds.push(end);
            placed.push({ action, row: rowEnds.length - 1 });
          } else {
            rowEnds[row] = end;
            placed.push({ action, row });
          }
        }
        return placed;
      })(),
      index,
    }));
  }, [actions, entities]);
  const laneHeight = (lane: typeof lanes[number]): number => lane.actions.length > 0
    ? Math.max(viewMode === 'compact' ? 38 : LANE_HEIGHT, (Math.max(...lane.actions.map((entry) => entry.row)) + 1) * rowHeight + 8)
    : viewMode === 'compact' ? 38 : LANE_HEIGHT;
  const totalLaneHeight = lanes.reduce((total, lane) => total + laneHeight(lane), 0);

  const recentLogs = useMemo(() => snapshot.logs.filter((log) => log.tick >= snapshot.tick - RECENT_RESULT_TICKS && log.tick <= snapshot.tick && log.actionId), [snapshot.logs, snapshot.tick]);
  const recentResultLogs = useMemo(() => snapshot.logs
    .filter((log) => log.tick >= snapshot.tick - RECENT_RESULT_TICKS && log.tick <= snapshot.tick)
    .filter((log) => /命中|伤害|治疗|恢复|落空|未命中|范围外|打断|中断|hit|damage|heal|miss|interrupt/i.test(log.message))
    .slice(-12), [snapshot.logs, snapshot.tick]);
  const focused = (actionId: string): void => {
    if (focusedActionId === undefined) setLocalFocus(actionId);
    onFocusAction?.(actionId);
  };
  const preview = (actionId: string | null): void => onPreviewAction?.(actionId);

  const scrollToCurrent = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    followRef.current = true;
    setFollowCurrent(true);
    programmaticScroll.current = true;
    const target = LABEL_WIDTH + tickOffset(snapshot.tick) - element.clientWidth / 2;
    element.scrollTo({ left: Math.max(0, target), behavior: 'auto' });
    window.requestAnimationFrame(() => { programmaticScroll.current = false; });
  }, [snapshot.tick, tickOffset]);

  useEffect(() => {
    if (followRef.current) scrollToCurrent();
  }, [pxPerTick, scrollToCurrent, snapshot.tick]);

  const setFollow = (value: boolean): void => {
    followRef.current = value;
    setFollowCurrent(value);
  };

  const rulerStep = span <= 20 ? 1 : span <= 60 ? 5 : span <= 120 ? 10 : 20;
  const rulerTicks: number[] = [];
  for (let tick = Math.floor(globalStart / rulerStep) * rulerStep; tick <= globalEnd; tick += rulerStep) rulerTicks.push(tick);
  const pendingDecisions = snapshot.decisions.filter((decision) => !decision.resolved).length;
  const pendingSlots = snapshot.status === 'ACTIVE' && !snapshot.paused
    ? snapshot.plan.slots.filter((slot) => slot.connected && slotIsActionableUnready(slot, snapshot, entities)).length
    : 0;
  const disconnectedSlots = snapshot.status === 'ACTIVE' && !snapshot.paused
    ? snapshot.plan.slots.filter((slot) => !slot.connected && slotIsActionableUnready(slot, snapshot, entities)).length
    : 0;
  const terminal = snapshot.result !== undefined || snapshot.status === 'VICTORY' || snapshot.status === 'DEFEAT' || snapshot.status === 'MUTUAL_DEFEAT' || snapshot.status === 'ENDED';
  const timelineStatus = terminal
    ? '遭遇已结束 · 结果已记录'
    : snapshot.status === 'LOBBY'
      ? '等待遭遇开始'
        : snapshot.paused
          ? '已暂停 · GM 可编辑未结算计划'
        : pendingDecisions > 0
          ? `反应窗口待决 · ${pendingDecisions} 个窗口`
          : disconnectedSlots > 0
            ? `等待断线角色 · ${disconnectedSlots} 个槽位，GM 可代决`
          : pendingSlots > 0
            ? `等待多人提交 · ${pendingSlots} 个可行动槽位未就绪`
            : '服务器按事件推进 · 阶段边界来自权威快照';
  const upcomingEvent = nextKnownEvent(actions, snapshot, entities, catalogActions);

  const actionDetail = selectedAction ? (
    <div className="demo-timeline-detail" role="status">
      <div className="demo-timeline-detail-heading">
        <div><span className="demo-eyebrow">ACTION DETAIL</span><strong>{entityName(entities.find((entity) => entity.id === selectedAction.actorId), selectedAction.actorId)} · {actionName(selectedAction, catalogActions)}</strong></div>
        <button className="demo-button ghost tiny" type="button" onClick={() => { if (focusedActionId === undefined) setLocalFocus(null); onFocusAction?.(null); }}>关闭</button>
      </div>
      <div className="demo-timeline-detail-facts">
        <span>{formatRange(selectedAction, snapshot)}</span>
        <span>{phaseFor(selectedAction, entities.find((entity) => entity.id === selectedAction.actorId))}</span>
        <span>优先级 P{selectedAction.priority}</span>
        <span>{selectedAction.targetIds.length > 0 ? `目标 ${selectedAction.targetIds.map((id) => entityName(entities.find((entity) => entity.id === id), id)).join('、')}` : '无目标'}</span>
      </div>
      {!hasTimeline(selectedAction) && !isUndeterminedPlan(selectedAction, snapshot) && <p className="demo-timeline-warning">旧服务未提供服务器派生阶段，当前只显示动作状态；更新服务后会显示真实 Tick 区间。</p>}
      <details className="demo-timeline-causation"><summary>查看因果链 · {selectedAction.causationId}</summary><div>
        {snapshot.logs.filter((log) => log.causationId === selectedAction.causationId || log.actionId === selectedAction.actionId).slice(-12).map((log) => <span key={log.id}>T{log.tick} · {log.message}</span>)}
        {snapshot.logs.every((log) => log.causationId !== selectedAction.causationId && log.actionId !== selectedAction.actionId) && <span>暂无可见的关联结果。</span>}
      </div></details>
      {isGm && snapshot.paused && !selectedAction.cancelled && selectedAction.phase !== 'RESOLVED' && selectedAction.phase !== 'CANCELLED' && onRequestEditAction && <button className="demo-button amber tiny" type="button" onClick={() => onRequestEditAction(selectedAction.actionId)}>在 GM 裁决台编辑此动作</button>}
    </div>
  ) : null;

  return <section className={`demo-panel demo-timeline-panel tactical-clock timeline-view-${viewMode}`} aria-label="战术时间轴">
    <header className="demo-timeline-header">
      <div className="timeline-summary">
        <h2 className="timeline-panel-title">战术时间轴</h2>
        <div className="timeline-clock" aria-label="当前 Tick"><small>T</small><strong>{snapshot.tick}</strong></div>
        <span className="timeline-global-status" title={timelineStatus}>{timelineStatus}</span>
      </div>
      <details className="timeline-options" data-workspace-menu>
        <summary aria-label="时间轴选项">···</summary>
        <div className="timeline-options-popover">
        <p>当前 T{snapshot.tick} · {timelineStatus}</p><p>{upcomingEvent}</p>
        <div className="demo-timeline-tools">
          <span className="timeline-color-keys" role="img" aria-label="阶段颜色：绿色大前摇、黄褐色小前摇、红色生效、蓝色后摇；金色结果标记"><i className="startup" /><i className="small-startup" /><i className="active" /><i className="recovery" /><i className="result" /></span>
          <button className="demo-button ghost tiny" type="button" disabled={zoom <= .5} onClick={() => setZoom((value) => clamp(value - .25, .5, 2))} aria-label="缩小时间轴">−</button>
          <span className="demo-timeline-zoom">{Math.round(zoom * 100)}%</span>
          <button className="demo-button ghost tiny" type="button" disabled={zoom >= 2} onClick={() => setZoom((value) => clamp(value + .25, .5, 2))} aria-label="放大时间轴">＋</button>
          <button className={`demo-button ghost tiny${followCurrent ? ' active-mode' : ''}`} type="button" onClick={() => { setFollow(true); scrollToCurrent(); }}>{followCurrent ? '跟随当前' : '回到当前'}</button>
          <button className="demo-button ghost tiny" type="button" aria-pressed={viewMode === 'full'} aria-label={viewMode === 'compact' ? '切换完整时间轴视图' : '切换紧凑时间轴视图'} onClick={() => setViewMode((value) => value === 'compact' ? 'full' : 'compact')}>{viewMode === 'compact' ? '完整视图' : '紧凑视图'}</button>
        </div>
        </div>
      </details>
    </header>
    <div className="demo-timeline-scroll" ref={scrollRef} tabIndex={0} role="region" aria-label="时间轴轨道，可横向滚动" onScroll={() => { if (!programmaticScroll.current) setFollow(false); }} onWheel={(event) => { if (event.deltaX !== 0 || event.deltaY !== 0) setFollow(false); }} onPointerDown={(event) => { if (!(event.target as HTMLElement).closest('button')) setFollow(false); }} onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) setFollow(false); }}>
      <div className="demo-timeline-canvas" style={{ width: canvasWidth, minWidth: '100%' }}>
        <div className="demo-timeline-ruler" style={{ height: rulerHeight }}>
          <div className="demo-timeline-ruler-label">角色 · {lanes.length}<span>阶段 / TICK →</span></div>
          <div className="demo-timeline-ruler-track" style={{ '--tick-width': `${pxPerTick}px` } as CSSProperties}>
            {rulerTicks.map((tick) => <span key={tick} className={tick === snapshot.tick ? 'is-current' : ''} style={{ left: tickOffset(tick) }}><i />{tick}</span>)}
            {!rulerTicks.includes(snapshot.tick) && <span className="demo-timeline-ruler-current is-current" style={{ left: tickOffset(snapshot.tick) }}><i />{snapshot.tick}</span>}
          </div>
        </div>
        <div className="demo-timeline-lanes">
          {lanes.map((lane) => {
            const status = lane.entity ? laneStatus(lane.entity, snapshot) : { label: '实体暂不可见', tone: 'blocked' as const };
            return <div className="demo-timeline-lane" key={lane.entityId} style={{ height: laneHeight(lane) }}>
              <div className="demo-timeline-lane-label" style={{ '--lane-color': lane.color } as CSSProperties}>
                <strong title={entityName(lane.entity, lane.entityId)}>{entityName(lane.entity, lane.entityId)}</strong>
                <small title={status.label} className={`timeline-lane-status ${status.tone}`}>{status.label}</small>
              </div>
              <div className="demo-timeline-track" style={{ '--tick-width': `${pxPerTick}px` } as CSSProperties}>
                {lane.actions.map(({ action, row }) => {
                  if (!hasTimeline(action)) {
                    return <button key={action.actionId} type="button" className={`demo-timeline-unknown${visualFocusActionId === action.actionId ? ' is-focused' : ''}`} style={{ top: 6 + row * rowHeight, left: tickOffset(action.declaredTick), width: Math.max(100, pxPerTick * 3) }} onMouseEnter={() => preview(action.actionId)} onMouseLeave={() => preview(null)} onFocus={() => preview(action.actionId)} onBlur={() => preview(null)} onClick={() => focused(action.actionId)} title="旧服务未提供阶段数据">
                      <span>{actionName(action, catalogActions)}</span><small>{phaseFor(action, lane.entity)} · {missingTimelineLabel(action, snapshot)}</small>
                    </button>;
                  }
                  const segments = timelineSegments(action);
                  const left = tickOffset(action.timeline.start);
                  const width = Math.max(pxPerTick * .65, tickOffset(action.timeline.end) - left);
                  const markers = recentLogs.filter((log) => log.actionId === action.actionId && log.tick >= action.timeline.start && log.tick <= action.timeline.end);
                  return <button key={action.actionId} type="button" className={`demo-timeline-action${visualFocusActionId === action.actionId ? ' is-focused' : ''}${action.cancelled || action.phase === 'CANCELLED' ? ' is-cancelled' : ''}`} style={{ top: 6 + row * rowHeight, left, width, '--lane-color': lane.color } as CSSProperties} onMouseEnter={() => preview(action.actionId)} onMouseLeave={() => preview(null)} onFocus={() => preview(action.actionId)} onBlur={() => preview(null)} onClick={() => focused(action.actionId)} aria-label={`${actionName(action, catalogActions)}，${formatRange(action, snapshot)}，优先级 ${action.priority}`}>
                    <span className="demo-timeline-action-name">{actionName(action, catalogActions)}</span>
                    <span className="demo-timeline-segments">{segments.map((segment, index) => { const past = segment.end <= snapshot.tick; const current = segment.start <= snapshot.tick && segment.end > snapshot.tick; return <i key={`${segment.kind}-${segment.start}-${index}`} className={`timeline-segment ${segment.kind.toLowerCase()}${past ? ' is-past' : ''}${current ? ' is-current' : ''}`} style={{ left: `${((segment.start - action.timeline.start) / Math.max(.001, action.timeline.end - action.timeline.start)) * 100}%`, width: `${((segment.end - segment.start) / Math.max(.001, action.timeline.end - action.timeline.start)) * 100}%` }} title={`${PHASE_LABELS[segment.kind]} · T${segment.start}–T${segment.end}${segment.strikeIndex === undefined ? '' : ` · 第 ${segment.strikeIndex + 1} 击`}`}><b>{segment.kind === 'ACTIVE' ? `生效${segment.strikeIndex === undefined ? '' : ` ${segment.strikeIndex + 1}`}` : PHASE_LABELS[segment.kind]}</b></i>; })}</span>
                    {!action.timeline.phaseSegments?.length && action.timeline.pulseTicks?.map((tick, index) => <i className="demo-timeline-pulse-point" key={`pulse-${tick}-${index}`} style={{ left: `${((tick - action.timeline.start) / Math.max(.001, action.timeline.end - action.timeline.start)) * 100}%` }} title={`T${tick} · 服务器事件点`} />)}
                    <span className="demo-timeline-action-meta">P{action.priority} · {phaseFor(action, lane.entity)}</span>
                    {markers.map((log) => { const marker = resultMarker(log); return <i key={log.id} className={`timeline-result-marker ${marker.tone}`} style={{ left: `${((log.tick - action.timeline.start) / Math.max(.001, action.timeline.end - action.timeline.start)) * 100}%` }} title={`T${log.tick} · ${log.message}`}>{marker.label}</i>; })}
                  </button>;
                })}
                {lane.actions.length === 0 && <span className="demo-timeline-idle">尚无动作时间段</span>}
              </div>
            </div>;
          })}
          {lanes.length === 0 && <div className="demo-timeline-empty">尚无可见实体或已承诺动作。</div>}
        </div>
        <div className="demo-timeline-playhead" style={{ left: LABEL_WIDTH + tickOffset(snapshot.tick), height: rulerHeight + totalLaneHeight }} aria-hidden="true"><span>T{snapshot.tick}</span></div>
      </div>
    </div>
    {actions.some((action) => !hasTimeline(action) && !isUndeterminedPlan(action, snapshot)) && <p className="demo-timeline-compatibility" role="status">部分动作来自旧服务，服务器更新阶段数据后才会显示真实比例；当前不会根据客户端模板猜测时间。</p>}
    {recentResultLogs.length > 0 && <details className="timeline-results-disclosure"><summary>近 10 TICK 结果 <b>{recentResultLogs.length}</b><span>展开查看</span></summary><div className="demo-timeline-results" aria-label="最近十 Tick 结果">{recentResultLogs.map((log) => { const marker = resultMarker(log); const attached = Boolean(log.actionId && actions.some((action) => action.actionId === log.actionId)); return <span className={`demo-timeline-result-row ${marker.tone}`} key={log.id}><b>T{log.tick}</b><strong>{marker.label}</strong><span>{log.message}</span>{!attached && <small>· 未关联当前动作</small>}</span>; })}</div></details>}
    {actionDetail}
  </section>;
}

export type { TimelinePanelProps };
