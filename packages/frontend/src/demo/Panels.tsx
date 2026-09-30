import { useEffect, useRef, useState } from 'react';
import { getEncounterSide } from '@hard-vtt/shared';
import type {
  DemoCatalogAction,
  EncounterCommandType,
  EncounterCommandResult,
  EncounterEntity,
  EncounterResult,
  EncounterSnapshot,
} from '@hard-vtt/shared';
import type { DemoCatalog, DemoRoomInfo, DemoSessionInfo, DemoSelectedCell } from './types';
import { actionGroup, actionIdLabel, actionLabel, actionTacticalSummary, canAfford, entityLabel, entityOptionLabel, factionLabel, isDown, phaseLabel, resourceCostLabel, resourceLabel, templateCatalog, weaponLabel } from './format';
import { ActionGlyph } from './ActionGlyph';
import './actionHotbar.css';
import { finiteInput } from './numbers';
import { TimelinePanel as DemoTimelinePanel, type TimelinePanelProps } from './TimelinePanel';
import { FactionControls } from './FactionControls';

export type { TimelinePanelProps } from './TimelinePanel';

export type DemoCommandSender = (type: EncounterCommandType, payload: Record<string, unknown>, entityId?: string, onResult?: (result: EncounterCommandResult) => void) => void;

function controlEpochFor(snapshot: EncounterSnapshot, entityId: string | null): number | undefined {
  if (!entityId) return undefined;
  return snapshot.controls.find((control) => control.entityId === entityId)?.controlEpoch;
}

function entityPhase(entity: EncounterEntity): 'DECLARED' | 'DELAY' | 'STARTUP' | 'ACTIVE' | 'CHANNELING' | 'RECOVERY' {
  const phase = entity.currentActionContext?.phase;
  if (phase === 'DELAY' || phase === 'STARTUP' || phase === 'ACTIVE' || phase === 'CHANNELING' || phase === 'RECOVERY') return phase;
  return 'DECLARED';
}

function controlledBy(session: DemoSessionInfo, entityId: string): boolean {
  return session.session.role === 'GM' || session.session.controlledEntityIds.includes(entityId);
}

interface LobbyPanelProps {
  session: DemoSessionInfo;
  room: DemoRoomInfo | null;
  snapshot: EncounterSnapshot | null;
  catalog?: DemoCatalog | null;
  onAssign: (userId: string, entityId: string) => void;
  onStart: () => void;
  onRefresh: () => void;
}

export function LobbyPanel({ session, room, snapshot, catalog, onAssign, onStart, onRefresh }: LobbyPanelProps) {
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const players = room?.entries.filter((entry) => entry.role === 'PL') ?? [];
  const playerEntities = snapshot?.entities.filter((entity) => entity.type === 'ACTOR') ?? [];
  const soloTactics = catalog?.scenario?.id === 'spatial-tactics';
  const startDisabled = session.session.role !== 'GM' || !soloTactics && players.length < 3;

  return (
    <main className="demo-lobby demo-shell-card">
      <div className="demo-lobby-hero">
        <div>
          <span className="demo-eyebrow">ELYSIAN VTT · LAN ENCOUNTER</span>
          <h1>{catalog?.scenario?.title ?? '暮色渡口'}</h1>
          <p>{catalog?.scenario?.summary ?? '召集队伍，分配角色。准备好后，一同踏入暮色中的渡口。'}</p>
          {soloTactics && <p className="demo-muted">可由主持人控制双方，或邀请 3 名玩家。单人演练时无需分配角色。</p>}
        </div>
        <div className="demo-lobby-status"><span className="demo-status-dot connected" />大厅等待中</div>
      </div>
      <div className="demo-lobby-steps" aria-label="遭遇准备流程"><span className={players.length < 3 ? 'is-current' : ''}><b>01</b>邀请玩家</span><span className={players.length >= 3 && players.some((entry) => entry.controlledEntityIds.length === 0) ? 'is-current' : ''}><b>02</b>分配角色</span><span className={players.length >= 3 && players.every((entry) => entry.controlledEntityIds.length > 0) ? 'is-current' : ''}><b>03</b>开始遭遇</span></div>
      <div className="demo-lobby-grid">
        <section className="demo-card demo-room-card">
          <span className="demo-eyebrow">ROOM ACCESS</span>
          <h2>局域网房间</h2>
          <div className="demo-room-code">{session.session.role === 'GM' ? (session.joinCode ?? '启动日志提供') : '已加入'}</div>
          <p className="demo-muted">{session.session.role === 'GM' ? '将加入码分享给同一局域网内的玩家。' : '你已加入队伍，等待主持人分配角色。'}</p>
          <button className="demo-button ghost" type="button" onClick={onRefresh}>刷新大厅状态</button>
        </section>
        <section className="demo-card demo-roster-card">
          <div className="demo-section-title"><div><span className="demo-eyebrow">PARTY ROSTER</span><h2>在线玩家</h2></div><span className="demo-counter">{players.length}/3</span></div>
          <div className="demo-roster-list">
            {(room?.entries ?? []).map((entry) => {
              const value = assignments[entry.userId ?? entry.displayName] ?? entry.controlledEntityIds[0] ?? '';
              const userKey = entry.userId ?? entry.displayName;
              return (
                <div className="demo-roster-row" key={userKey}>
                  <span className={`demo-status-dot ${entry.connected ? 'connected' : 'offline'}`} />
                  <div className="demo-roster-name"><strong>{entry.displayName}</strong><small>{entry.role === 'GM' ? '主持人' : '玩家'} · {entry.connectedSocketCount} 个连接</small></div>
                  {session.session.role === 'GM' && entry.role === 'PL' && entry.userId ? (
                    <select className="demo-select compact" value={value} onChange={(event) => {
                      const entityId = event.target.value;
                      setAssignments((current) => ({ ...current, [userKey]: entityId }));
                      if (entityId && entry.userId) onAssign(entry.userId, entityId);
                    }} aria-label={`${entry.displayName} 的角色`}>
                      <option value="">分配角色</option>
                      {playerEntities.map((entity) => <option value={entity.id} key={entity.id}>{entityOptionLabel(entity)}</option>)}
                    </select>
                  ) : (
                    <span className="demo-roster-role">{entry.controlledEntityIds.length > 0 ? entry.controlledEntityIds.map((id) => playerEntities.find((entity) => entity.id === id)?.displayName ?? id).join('、') : '未分配'}</span>
                  )}
                </div>
              );
            })}
            {(room?.entries ?? []).length === 0 && <p className="demo-empty">等待玩家使用加入码进入。</p>}
            {Array.from({ length: Math.max(0, 3 - players.length) }, (_, index) => <div className="demo-roster-vacancy" key={`vacant-${index}`}><span aria-hidden="true">◇</span><span>等待玩家加入</span><small>使用房间加入码入场</small></div>)}
          </div>
        </section>
      </div>
      <div className="demo-lobby-footer">
        <div><span className="demo-eyebrow">SESSION</span><strong>{session.session.displayName}</strong><span className="demo-muted"> · {session.session.role === 'GM' ? 'GM 主持' : 'PL 玩家'}</span></div>
        {session.session.role === 'GM' && <button className="demo-button primary" type="button" onClick={onStart} disabled={startDisabled}>{soloTactics ? '开始战术演练' : players.length < 3 ? `等待 3 名玩家（当前 ${players.length}）` : '开始遭遇'}</button>}
        {session.session.role !== 'GM' && <span className="demo-muted">等待 GM 分配角色并开始遭遇…</span>}
      </div>
    </main>
  );
}

interface ActionPanelProps {
  onChooseAction?: (action: DemoCatalogAction) => void;
  activeTemplateId?: string;
  submitting?: boolean;
  session: DemoSessionInfo;
  snapshot: EncounterSnapshot;
  catalog: DemoCatalog | null;
  selectedEntityId: string | null;
  selectedTargetId: string | null;
  selectedCell: DemoSelectedCell | null;
  onCommand: DemoCommandSender;
  now?: number;
}

function actionNeedsTarget(template: DemoCatalogAction): boolean {
  if (template.targetKind) return template.targetKind === 'entity';
  const id = template.id.toUpperCase();
  const tags = new Set(template.tags.map((tag) => tag.toUpperCase()));
  if (id === 'DEMO_RECOVER_FOCUS' || id === 'PARRY' || id === 'DODGE' || tags.has('DEFENSE') || tags.has('RESOURCE')) return false;
  return tags.has('ATTACK') || tags.has('INTERRUPT') || id === 'DEMO_RECOVER_WOUND';
}

function actionNeedsCell(template: DemoCatalogAction): boolean {
  if (template.targetKind) return template.targetKind === 'cell';
  const id = template.id.toUpperCase();
  return id === 'MOVE' || id === 'DEMO_MOVE' || template.tags.some((tag) => tag.toUpperCase() === 'MOVE');
}

function actionReason(
  template: DemoCatalogAction,
  actor: EncounterEntity | undefined,
  targetId: string | null,
  cell: DemoSelectedCell | null,
  allowed: boolean,
  paused: boolean,
  active: boolean,
  ready: boolean,
  readyAtTick: number | undefined,
  currentTick: number,
  decisionPending: boolean,
  choosing = false,
): string | undefined {
  if (!actor) return '先在战场选择一个实体';
  if (!allowed) return '当前控制权不属于你';
  if (!active) return paused ? '遭遇已暂停，GM 可先编辑计划' : '当前阶段不可提交行动';
  if (isDown(actor)) return '实体已倒下';
  if (actor.currentActionContext) return actor.currentActionContext.phase === 'RECOVERY' ? '实体正在收招' : `实体正在${phaseLabel(entityPhase(actor))}`;
  if (ready) return '本窗口已提交行动';
  if (readyAtTick !== undefined && readyAtTick > currentTick) return `等待至 T${readyAtTick}`;
  if (decisionPending) return '反应窗口处理中';
  if (template.spatial?.requiredWeaponId && actor.equippedWeaponId !== template.spatial.requiredWeaponId) return `需先装备${weaponLabel(template.spatial.requiredWeaponId)}`;
  if (!canAfford(template, actor)) return '资源不足，必须先执行恢复动作';
  if (!choosing && actionNeedsCell(template) && !cell) return '请点击目标格';
  if (!choosing && actionNeedsTarget(template) && !targetId && !cell) return '请在战场选择目标实体';
  return undefined;
}

export function ActionPanel({ session, snapshot, catalog, selectedEntityId, selectedTargetId, selectedCell, onCommand, onChooseAction, activeTemplateId, submitting, now }: ActionPanelProps) {
  const [group, setGroup] = useState('全部');
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const actor = snapshot.entities.find((entity) => entity.id === selectedEntityId && entity.type === 'ACTOR');
  const allowed = Boolean(actor && controlledBy(session, actor.id));
  const epoch = controlEpochFor(snapshot, selectedEntityId);
  const templates = templateCatalog(catalog).filter((template) => !template.tags.some((tag) => tag.toUpperCase() === 'REACTION'));
  const targetIds = selectedTargetId ? [selectedTargetId] : [];
  const coords = selectedCell ? { x: selectedCell.x, y: selectedCell.y, z: 0 } : undefined;
  const currentAction = actor ? snapshot.actions.find((action) => action.actorId === actor.id && !action.cancelled) : undefined;
  const slot = actor ? snapshot.plan.slots.find((candidate) => candidate.entityId === actor.id) : undefined;
  const decisionPending = snapshot.decisions.some((decision) => !decision.resolved);
  const active = snapshot.status === 'ACTIVE' && !snapshot.paused;
  const mainActionBlocked = !actor || !allowed || !active || isDown(actor) || Boolean(actor.currentActionContext) || Boolean(slot?.ready) || (slot?.readyAtTick !== undefined && slot.readyAtTick > snapshot.tick) || decisionPending;
  const inspected = templates.find(template => template.id === inspectedId) ?? templates.find(template => template.id === activeTemplateId);
  const reasonFor = (template: DemoCatalogAction) => actionReason(template, actor, selectedTargetId, selectedCell, allowed, snapshot.paused, active, Boolean(slot?.ready), slot?.readyAtTick, snapshot.tick, decisionPending, Boolean(onChooseAction));
  const groups = ['全部', ...new Set(templates.map(actionGroup))];
  const ownDecision = session.session.role === 'GM'
    ? undefined
    : snapshot.decisions.find((decision) => !decision.resolved && session.session.controlledEntityIds.includes(decision.reactorEntityId));
  const relevantDecision = session.session.role === 'GM'
    ? snapshot.decisions.find((decision) => !decision.resolved)
    : ownDecision;
  const decisionServerRemainingMs = relevantDecision
    ? relevantDecision.stage === 'REACTION_JOIN' ? relevantDecision.joinRemainingMs : relevantDecision.selectRemainingMs
    : undefined;
  const decisionRemainingMs = relevantDecision
    ? now === undefined
      ? decisionServerRemainingMs
      : remaining(
        relevantDecision.stage === 'REACTION_JOIN' ? relevantDecision.joinDeadlineAt : relevantDecision.selectDeadlineAt,
        decisionServerRemainingMs,
        now,
        snapshot.paused,
      )
    : undefined;
  const otherDecisionPending = snapshot.decisions.some((decision) => !decision.resolved && decision !== ownDecision && session.session.role !== 'GM');
  const actionStatus = snapshot.paused
    ? session.session.role === 'GM' ? 'GM 暂停 · 可编辑计划' : 'GM 暂停'
    : ownDecision
      ? '本人待反应'
      : session.session.role === 'GM' && relevantDecision
        ? 'GM 待裁决'
        : otherDecisionPending
          ? '等待其他角色反应'
          : actor && isDown(actor)
            ? '实体已倒下'
        : actor?.currentActionContext?.phase === 'RECOVERY'
          ? `等待收招 · T${actor.currentActionContext.resolveTick}`
          : actor?.currentActionContext
            ? `行动中 · ${phaseLabel(entityPhase(actor))}`
            : slot?.waiting
              ? `等待至 T${slot.readyAtTick ?? snapshot.plan.windowTick + 5}`
              : slot?.ready
                ? '已提交'
                  : !active
                  ? snapshot.status === 'LOBBY' ? '等待遭遇开始' : '遭遇已结束'
                  : actor && allowed ? '选择行动' : actor ? '选择可控角色' : '选择角色';
  return (
    <section className="demo-panel demo-action-panel crpg-hotbar" aria-label="角色动作栏">
      <div className="action-status-strip" role="status" aria-live="polite">
        <div className="action-status-primary"><span>个人行动</span><strong>{actionStatus}</strong><small>{actor ? (allowed ? '你控制的角色' : '角色不在你的控制权内') : '先从战场选择角色'}</small></div>
        {relevantDecision && <div className="action-reaction-summary"><span>反应窗口</span><strong>{relevantDecision.stage === 'REACTION_JOIN' ? '接入反应' : relevantDecision.stage === 'REACTION_SELECT' ? '选择反应' : 'GM 裁决'}</strong><small>{snapshot.paused ? '已暂停' : `剩余 ${seconds(decisionRemainingMs)}`}</small></div>}
      </div>
      <div className="hotbar-character">
      <div className="hotbar-portrait" aria-hidden="true">{actor ? (actor.displayName ?? actor.id).slice(0, 1) : "◇"}</div>
      <div className="demo-actor-strip">
        <strong>{actor ? actor.displayName ?? actor.id : '未选择实体'}</strong>
        {actor && <span className="demo-muted">{actor.currentActionContext ? phaseLabel(entityPhase(actor)) : '待机'} · {factionLabel(actor.faction)}</span>}
      </div>
      <div className="demo-resource-strip">
        {(actor ? Object.entries(actor.resources.current) : []).map(([key, value]) => <span key={key} title={key}><b>{resourceLabel(key)}</b> {value}/{actor?.resources.max[key] ?? '—'}<i aria-hidden="true" style={{ width: `${Math.max(0, Math.min(100, value / (actor?.resources.max[key] || 1) * 100))}%` }} /></span>)}
        {!actor && <span className="demo-muted">选择实体查看资源</span>}
      </div>
      </div>
      <div className="hotbar-categories" role="group" aria-label="动作分类">{groups.map(item => <button key={item} type="button" aria-pressed={group === item} onClick={() => setGroup(item)}>{item}</button>)}<span>选择技能 → 地图点选</span></div>
      <div className="demo-action-list">
        {templates.filter(template => group === '全部' || actionGroup(template) === group).map((template) => {
          const reason = reasonFor(template);
          const description = [actionLabel(template), `${template.startupTicks}T 前摇`, `${template.recoveryTicks}T 收招`, resourceCostLabel(template), actionTacticalSummary(template), template.description, reason].filter(Boolean).join(' · ');
          return <div className={`hotbar-slot group-${actionGroup(template)}`} key={template.id} title={description} onMouseEnter={() => setInspectedId(template.id)} onFocus={() => setInspectedId(template.id)} tabIndex={reason || submitting ? 0 : undefined} aria-label={reason || submitting ? description : undefined}><button aria-label={actionLabel(template)} aria-pressed={activeTemplateId === template.id} className={`demo-action-card${activeTemplateId === template.id ? " is-targeting" : ""}`} key={template.id} type="button" disabled={Boolean(reason) || submitting} onClick={() => onChooseAction ? onChooseAction(template) : onCommand('ACTION', {
            entityId: actor?.id ?? '',
            actionTemplateId: template.id,
            targetIds,
            ...(coords ? { targetCoords: coords } : {}),
          }, epoch !== undefined ? actor?.id : undefined)}>
            <span className="hotbar-timing">{template.startupTicks}<small>T</small></span>
            <span className="demo-action-icon"><ActionGlyph action={template} /></span>
            <span className="demo-action-copy"><strong>{actionLabel(template)}</strong></span>
            {activeTemplateId === template.id && <span className="hotbar-selected">选取目标</span>}
          </button></div>;
        })}
        {templates.length === 0 && <p className="demo-empty">等待 RulePack 目录同步。</p>}
      </div>
      <div className="hotbar-description" aria-live="polite">{inspected ? <><strong>{actionLabel(inspected)}</strong><span>{[`${inspected.startupTicks}T 前摇`, `${inspected.recoveryTicks}T 收招`, resourceCostLabel(inspected), actionTacticalSummary(inspected), inspected.description].filter(Boolean).join(' · ')}</span><em>{reasonFor(inspected) ?? (activeTemplateId === inspected.id ? '正在选择目标 · 在地图上点选，Esc 取消' : '点击技能准备行动')}</em></> : <span>悬停或聚焦技能查看消耗与可用条件 · 图标右上角为前摇 Tick</span>}</div>
      <div className="demo-action-secondary">
        <button className="demo-button ghost" type="button" disabled={mainActionBlocked || submitting} onClick={() => actor && onCommand('WAIT', { entityId: actor.id }, actor.id)}>等待 +5 Tick</button>
        <button className="demo-button ghost" type="button" disabled={mainActionBlocked || submitting} onClick={() => actor && onCommand('RECOVER', { entityId: actor.id }, actor.id)}>恢复资源</button>
        {currentAction && <button className="demo-button ghost danger-text" type="button" disabled={!allowed} onClick={() => onCommand('CANCEL_ACTION', { actionId: currentAction.actionId }, actor?.id)}>取消当前行动</button>}
        {!onChooseAction && selectedTargetId && <span className="demo-target-chip">目标：{snapshot.entities.find((entity) => entity.id === selectedTargetId)?.displayName ?? selectedTargetId}</span>}
        {!onChooseAction && selectedCell && <span className="demo-target-chip">格点：{selectedCell.x},{selectedCell.y}</span>}
      </div>
    </section>
  );
}

interface ReactionPanelProps {
  session: DemoSessionInfo;
  snapshot: EncounterSnapshot;
  now: number;
  onCommand: DemoCommandSender;
}

function remaining(
  deadline: number | undefined,
  serverRemaining: number | undefined,
  now: number,
  paused: boolean,
): number | undefined {
  if (paused) return serverRemaining === undefined ? undefined : Math.max(0, serverRemaining);
  if (deadline === undefined) return undefined;
  return Math.max(0, deadline - now);
}

function seconds(ms: number | undefined): string {
  if (ms === undefined) return '—';
  return `${Math.ceil(ms / 1000)}s`;
}

export function ReactionPanel({ session, snapshot, now, onCommand }: ReactionPanelProps) {
  const active = snapshot.decisions.filter((decision) => !decision.resolved);
  const pausedForPlayer = snapshot.paused && session.session.role !== 'GM';
  return (
    <section className="demo-panel demo-reaction-panel">
      <div className="demo-section-title"><div><span className="demo-eyebrow">REACTION WINDOWS</span><h2>反应与打断</h2></div><span className={`demo-pill ${active.length > 0 ? 'danger' : 'quiet'}`}>{active.length > 0 ? `${active.length} 个待决` : '暂无窗口'}</span></div>
      <div className="demo-reaction-list">
        {active.map((decision) => {
          const canRespond = session.session.role === 'GM' || session.session.controlledEntityIds.includes(decision.reactorEntityId);
          const joinMs = remaining(decision.joinDeadlineAt, decision.joinRemainingMs, now, snapshot.paused);
          const selectMs = remaining(decision.selectDeadlineAt, decision.selectRemainingMs, now, snapshot.paused);
          const source = snapshot.entities.find((entity) => entity.id === decision.sourceEntityId);
          const reactor = snapshot.entities.find((entity) => entity.id === decision.reactorEntityId);
          const sourceName = source ? entityLabel(source) : '未知角色';
          const reactorName = reactor ? entityLabel(reactor) : '未知角色';
          return <article className={`demo-reaction-card ${canRespond ? 'actionable' : ''}`} data-decision-window={decision.windowId} key={decision.windowId}>
            <div className="demo-reaction-top"><strong>{decision.stage === 'REACTION_JOIN' ? '接入窗口' : decision.stage === 'REACTION_SELECT' ? '选择窗口' : 'GM 裁决'}</strong><span>{snapshot.paused ? `已暂停 · 剩余 ${seconds(decision.stage === 'REACTION_JOIN' ? joinMs : selectMs)}` : decision.stage === 'REACTION_JOIN' ? `接入剩余 ${seconds(joinMs)}` : `选择剩余 ${seconds(selectMs)}`}</span></div>
            <p><strong>{sourceName}</strong> 发起动作 · 反应者 <strong>{reactorName}</strong></p>
            <details className="demo-reaction-technical"><summary>技术详情</summary><code>源 {decision.sourceEntityId} · 反应者 {decision.reactorEntityId} · 窗口 {decision.windowId}</code></details>
            <div className="demo-reaction-actions">
              {decision.stage === 'REACTION_JOIN' && <button className="demo-button amber" type="button" disabled={!canRespond || joinMs === 0 || pausedForPlayer} onClick={() => onCommand('REACTION_JOIN', { windowId: decision.windowId }, decision.reactorEntityId)}>接入反应</button>}
              {decision.stage === 'REACTION_SELECT' && decision.availableOptions.map((option) => <button className="demo-button ghost" type="button" key={option.id} disabled={!canRespond || !option.canAfford || selectMs === 0 || pausedForPlayer} onClick={() => onCommand('REACTION_SELECT', { windowId: decision.windowId, optionId: option.id }, decision.reactorEntityId)}>{option.label}<small>{Object.entries(option.resourceCost).map(([key, value]) => `${resourceLabel(key)} ${value}`).join(' ')}</small></button>)}
              {(session.session.role === 'GM' || canRespond) && <button className="demo-button ghost danger-text" type="button" aria-label="放弃反应" disabled={pausedForPlayer} onClick={() => onCommand(session.session.role === 'GM' ? 'GM_PASS' : 'REACTION_PASS', { windowId: decision.windowId }, decision.reactorEntityId)}>放弃反应</button>}
            </div>
          </article>;
        })}
        {active.length === 0 && <p className="demo-empty">来源动作进入前摇时，符合资格的待机角色会在这里看到反应窗口。</p>}
      </div>
      {session.session.role === 'GM' && active.length > 0 && <button className="demo-button danger" type="button" aria-label="全部放弃反应" onClick={() => onCommand('GM_PASS_ALL', {})}>全部放弃反应</button>}
    </section>
  );
}

export function TimelinePanel(props: TimelinePanelProps) {
  return <DemoTimelinePanel {...props} />;
}

interface LogPanelProps { snapshot: EncounterSnapshot; }

export function LogPanel({ snapshot }: LogPanelProps) {
  return <section className="demo-panel demo-log-panel">
    <div className="demo-section-title"><div><span className="demo-eyebrow">CAUSAL LOG</span><h2>战斗日志</h2></div><span className="demo-muted">追加记录</span></div>
    <div className="demo-log-list">
      {snapshot.logs.slice(-24).reverse().map((log) => {
        const auditMeta = log.meta && typeof log.meta === 'object' ? log.meta : undefined;
        const hasDetails = Boolean(log.actionId || log.causationId || auditMeta && Object.keys(auditMeta).length > 0);
        return <div className={`demo-log-row ${(log.level ?? 1) >= 3 ? 'warn' : ''}`} key={log.id}>
          <span>T{log.tick}</span>
          <p>{log.message}</p>
          {hasDetails && <details className="demo-log-details"><summary>裁决详情</summary><div><span>Tick {log.tick}</span>{log.actionId && <span>动作 {log.actionId}</span>}{log.causationId && <span>因果链 {log.causationId}</span>}{auditMeta && Object.entries(auditMeta).map(([key, value]) => <span key={key}>{key} {typeof value === 'string' ? value : JSON.stringify(value)}</span>)}</div></details>}
        </div>;
      })}
      {snapshot.logs.length === 0 && <p className="demo-empty">行动、反应和 GM 裁决会按因果链追加到这里。</p>}
    </div>
  </section>;
}

interface GmPanelProps {
  session: DemoSessionInfo;
  snapshot: EncounterSnapshot;
  catalog: DemoCatalog | null;
  selectedEntityId: string | null;
  selectedTargetId: string | null;
  selectedCell: DemoSelectedCell | null;
  onCommand: DemoCommandSender;
  onRestart: () => void;
  settlement?: DemoRoomInfo['settlement'];
  /** Local-only focus requested from the tactical timeline. */
  focusActionRequest?: { actionId: string; nonce: number } | null;
}

export function GmPanel({ session, snapshot, catalog, selectedEntityId, selectedTargetId, selectedCell, onCommand, onRestart, settlement, focusActionRequest }: GmPanelProps) {
  const [pauseReason, setPauseReason] = useState('裁决检查');
  const [correctionReason, setCorrectionReason] = useState('');
  const [hp, setHp] = useState('');
  const [poise, setPoise] = useState('');
  const [focus, setFocus] = useState('');
  const [facing, setFacing] = useState('');
  const [adjustReason, setAdjustReason] = useState('GM 调整实体状态');
  const [visibilityDraft, setVisibilityDraft] = useState<{ source: string; value: 'PUBLIC' | 'GM' } | null>(null);
  const [effectTemplateId, setEffectTemplateId] = useState('');
  const [effectTicks, setEffectTicks] = useState('-1');
  const [effectStacks, setEffectStacks] = useState('1');
  const [clearEffects, setClearEffects] = useState(false);
  const [editTick, setEditTick] = useState('');
  const [editPriority, setEditPriority] = useState('');
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [selectedActionId, setSelectedActionId] = useState(snapshot.actions[0]?.actionId ?? '');
  const [planReason, setPlanReason] = useState('GM 调整未结算行动');
  const [manualWinner, setManualWinner] = useState('');
  const appliedFocusNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!focusActionRequest || appliedFocusNonce.current === focusActionRequest.nonce) return;
    const focused = snapshot.actions.find((action) => action.actionId === focusActionRequest.actionId);
    if (!focused) return;
    const timer = window.setTimeout(() => {
      appliedFocusNonce.current = focusActionRequest.nonce;
      const actionGroup = document.querySelector<HTMLElement>('[data-demo-gm-edit-plan]')?.closest('details');
      if (actionGroup instanceof HTMLDetailsElement) actionGroup.open = true;
      setSelectedActionId(focused.actionId);
      setEditTarget(focused.targetIds[0] ?? null);
      setEditTick('');
      setEditPriority('');
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusActionRequest, snapshot.actions]);
  if (session.session.role !== 'GM') return null;
  const selected = snapshot.entities.find((entity) => entity.id === selectedEntityId);
  const visibilitySource = JSON.stringify([selectedEntityId, selected?.visibility ?? 'PUBLIC']);
  const visibility = visibilityDraft?.source === visibilitySource ? visibilityDraft.value : selected?.visibility ?? 'PUBLIC';
  const winnerOptions = [...new Map(snapshot.entities.filter(entity => entity.type === 'ACTOR').map(entity => {
    const side = getEncounterSide(entity);
    return [JSON.stringify(side), { side, label: side.kind === 'FACTION' ? factionLabel(side.id) : `${entityLabel(entity)}（独立）` }];
  })).entries()];
  const winningSide = winnerOptions.find(([key]) => key === manualWinner)?.[1].side;
  const visibleActionId = snapshot.actions.some((action) => action.actionId === selectedActionId)
    ? selectedActionId
    : snapshot.actions[0]?.actionId ?? '';
  const selectedAction = snapshot.actions.find((action) => action.actionId === visibleActionId);
  const editTargetValue = editTarget ?? selectedAction?.targetIds[0] ?? selectedTargetId ?? '';
  const adjustResources: Record<string, number> = {};
  const hpValue = finiteInput(hp);
  const poiseValue = finiteInput(poise);
  const focusValue = finiteInput(focus);
  const facingValue = finiteInput(facing);
  const effectTicksValue = finiteInput(effectTicks);
  const effectStacksValue = finiteInput(effectStacks);
  if (hpValue !== undefined) adjustResources.hp = hpValue;
  if (poiseValue !== undefined) adjustResources.poise = poiseValue;
  if (focusValue !== undefined) adjustResources.focus = focusValue;
  const position = selectedCell ? { x: selectedCell.x, y: selectedCell.y, z: 0 } : undefined;
  const visibilityChanged = selected !== undefined && visibility !== (selected.visibility ?? 'PUBLIC');
  const effectsChanged = clearEffects || effectTemplateId.trim().length > 0;
  const correctionChanges: Record<string, unknown> = Object.fromEntries(
    Object.entries(adjustResources).map(([key, value]) => [`resources.current.${key}`, value]),
  );

  return <section className="demo-panel demo-gm-panel" data-demo-gm-panel>
    <div className="demo-section-title"><div><span className="demo-eyebrow">GM OVERRIDE DECK</span><h2>主持裁决台</h2></div><span className="demo-pill danger">完整权限</span></div>
       <div className="demo-gm-toolbar">
       <button className="demo-button amber" type="button" disabled={snapshot.status === 'LOBBY' || snapshot.status === 'ENDED' || snapshot.status === 'VICTORY' || snapshot.status === 'DEFEAT' || snapshot.status === 'MUTUAL_DEFEAT'} onClick={() => snapshot.paused ? onCommand('GM_RESUME', {}) : onCommand('GM_PAUSE', { reason: pauseReason })}>{snapshot.paused ? '继续' : '暂停'}</button>
       <button className="demo-button ghost" type="button" disabled={!snapshot.paused} onClick={() => onCommand('GM_TICK_BREAK', { count: 1 })}>下一 Tick 断点</button>
       <button className="demo-button ghost" type="button" disabled={!snapshot.paused} onClick={() => onCommand('GM_STEP', { count: 1 })}>单步结算</button>
      <input className="demo-input mini" value={pauseReason} onChange={(event) => setPauseReason(event.target.value)} aria-label="暂停原因" placeholder="暂停原因" />
    </div>
     <div className="demo-gm-grid">
       <details className="demo-gm-section" open>
         <summary>实体与场景</summary>
         <div className="demo-gm-grid">
       <FactionControls snapshot={snapshot} catalog={catalog} selectedEntityId={selectedEntityId} selectedCell={selectedCell} onCommand={onCommand} />
       <div className="demo-gm-block"><span className="demo-eyebrow">CONTROL EPOCH</span><h3>{selected ? entityLabel(selected) : '未选择实体'}</h3><div className="demo-inline-controls"><button className="demo-button ghost" type="button" disabled={!selectedEntityId} onClick={() => selectedEntityId && onCommand('GM_TAKEOVER', { entityId: selectedEntityId })}>接管</button><button className="demo-button ghost" type="button" disabled={!selectedEntityId} onClick={() => selectedEntityId && onCommand('GM_RELEASE', { entityId: selectedEntityId })}>释放</button><span className="demo-muted">epoch {snapshot.controls.find((control) => control.entityId === selectedEntityId)?.controlEpoch ?? '—'}</span></div><button className="demo-button ghost full" type="button" disabled={!selectedEntityId} onClick={() => selectedEntityId && onCommand('GM_REMOVE', { entityId: selectedEntityId })}>移除选中实体</button></div>
       <div className="demo-gm-block"><span className="demo-eyebrow">ENTITY ADJUST</span><h3>资源 / 朝向 / 位置 / 状态</h3><div className="demo-input-row"><input className="demo-input" value={hp} onChange={(event) => setHp(event.target.value)} placeholder="HP" inputMode="numeric" /><input className="demo-input" value={poise} onChange={(event) => setPoise(event.target.value)} placeholder="韧性" inputMode="numeric" /><input className="demo-input" value={focus} onChange={(event) => setFocus(event.target.value)} placeholder="专注" inputMode="numeric" /><input className="demo-input" value={facing} onChange={(event) => setFacing(event.target.value)} placeholder="朝向" inputMode="numeric" /></div><div className="demo-inline-controls"><select className="demo-select" value={visibility} onChange={(event) => setVisibilityDraft({ source: visibilitySource, value: event.target.value === 'GM' ? 'GM' : 'PUBLIC' })}><option value="PUBLIC">公开可见</option><option value="GM">仅 GM 可见</option></select><label className="demo-check"><input type="checkbox" checked={clearEffects} onChange={(event) => setClearEffects(event.target.checked)} /> 清空状态</label></div><div className="demo-input-row"><input className="demo-input" value={effectTemplateId} onChange={(event) => setEffectTemplateId(event.target.value)} placeholder="效果模板 ID" /><input className="demo-input" value={effectTicks} onChange={(event) => setEffectTicks(event.target.value)} placeholder="持续 Tick" inputMode="numeric" /><input className="demo-input" value={effectStacks} onChange={(event) => setEffectStacks(event.target.value)} placeholder="层数" inputMode="numeric" /></div><input className="demo-input full" value={adjustReason} onChange={(event) => setAdjustReason(event.target.value)} placeholder="调整原因" /><button className="demo-button ghost full" type="button" disabled={!selectedEntityId || adjustReason.trim().length === 0 || Object.keys(adjustResources).length === 0 && !selectedCell && facingValue === undefined && !visibilityChanged && !effectsChanged} onClick={() => {
         if (!selectedEntityId) return;
         const effectSeed = clearEffects ? [] : (selected?.activeEffects ?? []);
         const activeEffects = effectsChanged ? (effectTemplateId.trim().length > 0 && effectTicksValue !== undefined && effectStacksValue !== undefined
           ? [...effectSeed, { instanceId: `gm-effect-${Date.now()}`, templateId: effectTemplateId.trim(), sourceEntityId: selectedEntityId, remainingTicks: effectTicksValue, stacks: effectStacksValue }]
           : effectSeed) : undefined;
         onCommand('GM_ADJUST_ENTITY', { entityId: selectedEntityId, reason: adjustReason.trim(), ...(position ? { position } : {}), ...(facingValue !== undefined ? { facing: facingValue } : {}), ...(Object.keys(adjustResources).length > 0 ? { resources: adjustResources } : {}), ...(activeEffects ? { activeEffects } : {}), ...(visibilityChanged ? { visibility } : {}) });
       }}>应用调整</button></div>
         </div>
       </details>
       <details className="demo-gm-section">
         <summary>行动与反应</summary>
         <div className="demo-gm-grid">
       <div className="demo-gm-block" data-demo-gm-edit-plan><span className="demo-eyebrow">EDIT PLAN</span><h3>未结算动作</h3><select className="demo-select full" value={visibleActionId} onChange={(event) => { const actionId = event.target.value; const action = snapshot.actions.find((item) => item.actionId === actionId); setSelectedActionId(actionId); setEditTarget(action?.targetIds[0] ?? ''); setEditTick(''); setEditPriority(''); }} aria-label="选择待裁决动作"><option value="">暂无可编辑动作</option>{snapshot.actions.map((action) => <option key={action.actionId} value={action.actionId}>{actionIdLabel(action.actionTemplateId)} · T{action.effectiveTick ?? action.declaredTick} · P{action.priority}</option>)}</select><div className="demo-input-row"><select className="demo-select" value={editTargetValue} onChange={(event) => setEditTarget(event.target.value)} aria-label="编辑动作目标"><option value="">清除目标</option>{snapshot.entities.map((entity) => <option value={entity.id} key={entity.id}>{entityLabel(entity)}</option>)}</select><input className="demo-input" value={editTick} onChange={(event) => setEditTick(event.target.value)} placeholder="生效 Tick" inputMode="numeric" aria-label="编辑生效 Tick" /><input className="demo-input" value={editPriority} onChange={(event) => setEditPriority(event.target.value)} placeholder="优先级" inputMode="numeric" aria-label="编辑优先级" /></div><input className="demo-input full" value={planReason} onChange={(event) => setPlanReason(event.target.value)} placeholder="本次编辑或取消原因（必填）" aria-label="行动编辑或取消原因" /><div className="demo-inline-controls"><button className="demo-button ghost" type="button" disabled={!selectedAction || planReason.trim().length < 2} onClick={() => selectedAction && onCommand('GM_EDIT_ACTION', { actionId: selectedAction.actionId, reason: planReason.trim(), targetIds: editTargetValue ? [editTargetValue] : [], ...(finiteInput(editTick) !== undefined ? { effectiveTick: finiteInput(editTick) } : {}), ...(finiteInput(editPriority) !== undefined ? { priority: finiteInput(editPriority) } : {}) })}>保存动作编辑</button><button className="demo-button ghost danger-text" type="button" disabled={!selectedAction || planReason.trim().length < 2} onClick={() => selectedAction && onCommand('GM_CANCEL_ACTION', { actionId: selectedAction.actionId, reason: planReason.trim() })}>取消动作</button></div></div>
       </div>
       </details>
       <details className="demo-gm-section">
         <summary>裁决与历史</summary>
         <div className="demo-gm-grid">
       <div className="demo-gm-block correction"><span className="demo-eyebrow">APPEND CORRECTION</span><h3>追加修正（保留历史）</h3><textarea className="demo-textarea" value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} placeholder="写明 GM、原因与修改依据" /><button className="demo-button amber full" type="button" disabled={!selectedEntityId || correctionReason.trim().length < 3 || Object.keys(correctionChanges).length === 0} onClick={() => selectedEntityId && onCommand('GM_CORRECT', { entityId: selectedEntityId, reason: correctionReason.trim(), changes: correctionChanges, ...(selectedAction ? { actionId: selectedAction.actionId } : {}) })}>记录修正</button></div>
         </div>
       </details>
     </div>
    {snapshot.result && <ResultCard result={snapshot.result} entities={snapshot.entities} settlement={settlement} onRestart={() => { setManualWinner(''); onRestart(); }} />}
     <select className="demo-select full" aria-label="手动胜方" value={winningSide ? manualWinner : ''} disabled={Boolean(snapshot.result)} onChange={event => setManualWinner(event.target.value)}><option value="">不指定胜方</option>{winnerOptions.map(([key, option]) => <option value={key} key={key}>{option.label}</option>)}</select>
     <button className="demo-button danger full" type="button" disabled={snapshot.status === 'LOBBY' || snapshot.status === 'ENDED' || snapshot.status === 'VICTORY' || snapshot.status === 'DEFEAT' || snapshot.status === 'MUTUAL_DEFEAT'} onClick={() => onCommand('GM_END', { reason: 'GM 手动结束遭遇', ...(winningSide ? { winningSides: [winningSide] } : {}) })}>明确结束遭遇</button>
  </section>;
}

function ResultCard({ result, entities, settlement, onRestart }: { result: EncounterResult; entities: EncounterEntity[]; settlement?: DemoRoomInfo['settlement']; onRestart: () => void }) {
  const winners = result.winningSides?.map(side => {
    if (side.kind === 'FACTION') return factionLabel(side.id);
    const entity = entities.find(candidate => candidate.id === side.id);
    return entity ? entityLabel(entity) : '独立参战者';
  }) ?? (result.winningFaction ? [factionLabel(result.winningFaction)] : []);
  const title = winners.length ? `${winners.join('、')}获胜` : result.status === 'VICTORY' ? '队伍 A 获胜' : result.status === 'DEFEAT' ? '队伍 B 获胜' : result.status === 'MUTUAL_DEFEAT' ? '各方覆灭' : '遭遇已结束';
  const status = settlement?.status ?? 'pending';
  const statusLabel = status === 'saved' ? '已保存' : status === 'failed' ? '保存失败，可重试' : '保存中…';
  return <div className="demo-result-card"><span className="demo-eyebrow">SETTLEMENT · T{result.resolvedTick}</span><h3>{title}</h3><p>{result.reason ?? `由 ${result.endedBy === 'GM' ? 'GM' : '规则'} 结束`}</p><p className="demo-muted">结算状态：{statusLabel}</p><button className="demo-button primary" type="button" disabled={status !== 'saved'} onClick={onRestart}>重开遭遇</button></div>;
}
