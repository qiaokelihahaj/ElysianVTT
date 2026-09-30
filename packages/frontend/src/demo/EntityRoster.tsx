import type {
  DemoCatalogAction,
  EncounterDecisionStage,
  EncounterEntity,
  EncounterReadySlot,
  EncounterSnapshot,
} from '@hard-vtt/shared';
import type { DemoCatalog, DemoSessionInfo } from './types';
import {
  actionIdLabel,
  actionLabel,
  entityLabel,
  entityRoleLabel,
  entityFactionLabel,
  entityFactionColor,
  entityRelation,
  relationLabel,
  isDown,
  phaseLabel,
  resourceLabel,
  templateCatalog,
} from './format';

export interface EntityRosterProps {
  snapshot: EncounterSnapshot;
  session: DemoSessionInfo;
  catalog: DemoCatalog | null;
  selectedEntityId: string | null;
  selectionDisabled?: boolean;
  onSelectEntity: (id: string) => void;
}

interface RosterAction {
  actionId?: string;
  label: string;
  phase: string;
  resolveLabel?: string;
  resolveTick?: number;
  effectiveTick?: number;
  targetIds: string[];
  current: boolean;
}

interface SlotStatus {
  label: string;
  tone: 'ready' | 'waiting' | 'blocked' | 'pending' | 'neutral';
}

const MAIN_RESOURCE_KEYS = ['hp', 'poise', 'focus'] as const;
type MainResourceKey = (typeof MAIN_RESOURCE_KEYS)[number];

function actionTemplateMap(catalog: DemoCatalog | null): Map<string, DemoCatalogAction> {
  return new Map(templateCatalog(catalog).map((template) => [template.id, template]));
}

function actionTemplateLabel(actionTemplateId: string | undefined, catalogActions: Map<string, DemoCatalogAction>): string {
  if (!actionTemplateId) return '当前动作';
  const template = catalogActions.get(actionTemplateId);
  return template ? actionLabel(template) : actionIdLabel(actionTemplateId);
}

function actionForEntity(entity: EncounterEntity, snapshot: EncounterSnapshot, catalogActions: Map<string, DemoCatalogAction>): RosterAction | undefined {
  const context = entity.currentActionContext;
  if (context) {
    const actorActions = snapshot.actions.filter((candidate) => candidate.actorId === entity.id && !candidate.cancelled && candidate.phase !== 'RESOLVED' && candidate.phase !== 'CANCELLED');
    const action = actorActions.find((candidate) => candidate.actionId === context.actionId)
      ?? (context.actionTemplateId
      ? actorActions.find((candidate) => candidate.actionTemplateId === context.actionTemplateId)
      : undefined)
      ?? actorActions[0];
    return {
      actionId: action?.actionId,
      label: actionTemplateLabel(action?.actionTemplateId ?? context.actionTemplateId, catalogActions),
      phase: phaseLabel(context.phase),
      resolveLabel: context.phase === 'ACTIVE' || context.phase === 'CHANNELING' ? '下一阶段' : '阶段结束',
      resolveTick: context.resolveTick,
      targetIds: action?.targetIds ?? [],
      current: true,
    };
  }

  const planned = snapshot.plan.actions.find((candidate) => candidate.actorId === entity.id
      && !candidate.cancelled
      && candidate.phase !== 'RESOLVED'
      && candidate.phase !== 'CANCELLED')
    ?? snapshot.actions.find((candidate) => candidate.actorId === entity.id
      && !candidate.cancelled
      && candidate.phase !== 'RESOLVED'
      && candidate.phase !== 'CANCELLED');
  if (!planned) return undefined;
  return {
    actionId: planned.actionId,
    label: actionTemplateLabel(planned.actionTemplateId, catalogActions),
    phase: phaseLabel(planned.phase),
    effectiveTick: planned.effectiveTick,
    targetIds: planned.targetIds,
    current: false,
  };
}

function encounterStateLabel(status: EncounterSnapshot['status']): string {
  if (status === 'LOBBY') return '等待遭遇开始';
  if (status === 'ACTIVE') return '进行中';
  if (status === 'PAUSED') return '已暂停';
  return '已结束';
}

function slotStatus(slot: EncounterReadySlot | undefined, windowTick: number, currentTick: number, entity: EncounterEntity, snapshot: EncounterSnapshot): SlotStatus {
  if (!slot) return { label: '本窗口无提交槽位', tone: 'neutral' };
  if (isDown(entity)) return { label: '实体已倒下', tone: 'blocked' };
  if (entity.currentActionContext) {
    return entity.currentActionContext.phase === 'RECOVERY'
      ? { label: `收招至 T${entity.currentActionContext.resolveTick}`, tone: 'waiting' }
      : { label: `行动中 · ${phaseLabel(entity.currentActionContext.phase)}`, tone: 'waiting' };
  }
  if (snapshot.status !== 'ACTIVE') return { label: encounterStateLabel(snapshot.status), tone: snapshot.status === 'PAUSED' ? 'blocked' : 'neutral' };
  if (snapshot.paused && !slot.ready) return { label: '已暂停', tone: 'blocked' };
  if (slot.waiting) return { label: `等待至 T${slot.readyAtTick ?? windowTick + 5}`, tone: 'waiting' };
  if (slot.ready) return { label: '已提交', tone: 'ready' };
  if (slot.readyAtTick !== undefined && slot.readyAtTick > currentTick) return { label: `等待至 T${slot.readyAtTick}`, tone: 'waiting' };
  if (slot.blockedReason) {
    const awaitingSubmission = slot.connected && (slot.blockedReason === '等待该玩家提交行动' || slot.blockedReason === 'GM 取消后等待重新提交');
    return { label: slot.blockedReason, tone: awaitingSubmission ? 'pending' : 'blocked' };
  }
  if (slot.connected) return { label: '待提交', tone: 'pending' };
  return { label: slot.controllerUserId ? '等待 GM 代决' : 'GM 待提交', tone: 'blocked' };
}

function decisionStageLabel(stage: EncounterDecisionStage): string {
  switch (stage) {
    case 'REACTION_JOIN': return '接入反应';
    case 'REACTION_SELECT': return '选择反应';
    case 'GM_REVIEW': return 'GM 裁决';
  }
}

function entityTypeLabel(entity: EncounterEntity): string {
  switch (entity.type) {
    case 'ACTOR': return '角色';
    case 'PROP': return '场景物';
    case 'PROJECTILE': return '投射物';
  }
}

function coordinateLabel(entity: EncounterEntity): string {
  const { x, y, z } = entity.transform.coords;
  return z === 0 ? `${x}, ${y}` : `${x}, ${y}, ${z}`;
}

function resourceKeys(entity: EncounterEntity): string[] {
  return [...new Set([...Object.keys(entity.resources.current), ...Object.keys(entity.resources.max)])];
}

function resourceSymbol(key: MainResourceKey): string {
  switch (key) {
    case 'hp': return '●';
    case 'poise': return '◆';
    case 'focus': return '✦';
  }
}

function meterPercent(current: number | undefined, max: number | undefined): number {
  if (typeof current !== 'number' || typeof max !== 'number' || !Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, (current / max) * 100));
}

function meterValue(current: number | undefined, max: number | undefined): number | undefined {
  if (typeof current !== 'number' || typeof max !== 'number') return undefined;
  if (max <= 0) return 0;
  return Math.min(max, Math.max(0, current));
}

function phaseSymbol(phase: string): string {
  if (phase.includes('收招')) return '↺';
  if (phase.includes('生效')) return '◆';
  if (phase.includes('引导')) return '≈';
  if (phase.includes('延迟')) return '…';
  if (phase.includes('前摇')) return '→';
  return '•';
}

function slotSymbol(status: SlotStatus): string {
  switch (status.tone) {
    case 'ready': return '✓';
    case 'waiting': return '◷';
    case 'blocked': return '⊘';
    case 'pending': return '○';
    case 'neutral': return '·';
  }
}

function controlLabel(entity: EncounterEntity, control: EncounterSnapshot['controls'][number] | undefined, slot: EncounterReadySlot | undefined, session: DemoSessionInfo): string {
  if (control?.takenOverByGm) return 'GM 托管';
  if (control?.role === 'GM') return 'GM 控制';
  if (session.session.controlledEntityIds.includes(entity.id)) return '你控制';
  if (control?.userId || slot?.controllerUserId) return '玩家控制';
  return '未分配';
}

function connectionLabel(
  slot: EncounterReadySlot | undefined,
  control: EncounterSnapshot['controls'][number] | undefined,
  playerControlled: boolean,
): '在线' | '断线' | 'GM 托管' | undefined {
  if (control?.takenOverByGm) return 'GM 托管';
  if (control?.role === 'GM') return undefined;
  if (!playerControlled) return undefined;
  if (slot) return slot.connected ? '在线' : '断线';
  if (control && control.connectedSocketIds.length > 0) return '在线';
  return undefined;
}

function targetLabels(action: RosterAction | undefined, entities: Map<string, EncounterEntity>): string {
  if (!action || action.targetIds.length === 0) return '无目标';
  return action.targetIds.map((id) => {
    const target = entities.get(id);
    return target ? entityLabel(target) : '不可见目标';
  }).join('、');
}

export function EntityRoster({ snapshot, session, catalog, selectedEntityId, selectionDisabled = false, onSelectEntity }: EntityRosterProps) {
  const catalogActions = actionTemplateMap(catalog);
  const entities = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
  const slots = new Map(snapshot.plan.slots.map((slot) => [slot.entityId, slot]));
  const controls = new Map(snapshot.controls.map((control) => [control.entityId, control]));
  const reference = selectedEntityId ? entities.get(selectedEntityId) : undefined;

  return (
    <section className="demo-panel demo-entity-roster" aria-label="实体列表数据">
      <div className="demo-entity-roster-columns">
        <span>实体</span>
        {MAIN_RESOURCE_KEYS.map((key) => <span className={`demo-entity-roster-column-resource is-${key}`} key={key}><i aria-hidden="true">{resourceSymbol(key)}</i>{resourceLabel(key)}</span>)}
        <span>状态</span>
        <span>动作 / 阶段</span>
        <span aria-hidden="true" />
      </div>
      <div className="demo-entity-roster-list" role="list">
        {snapshot.entities.map((entity) => {
          const name = entityLabel(entity);
          const slot = slots.get(entity.id);
          const control = controls.get(entity.id);
          const action = actionForEntity(entity, snapshot, catalogActions);
          const ready = slotStatus(slot, snapshot.plan.windowTick, snapshot.tick, entity, snapshot);
          const pendingReactions = snapshot.decisions.filter((decision) => !decision.resolved && decision.reactorEntityId === entity.id);
          const down = isDown(entity);
          const playerControlled = control?.role !== 'GM' && !control?.takenOverByGm && (session.session.controlledEntityIds.includes(entity.id) || Boolean(control?.userId ?? slot?.controllerUserId));
          const connection = connectionLabel(slot, control, playerControlled);
          const selected = selectedEntityId === entity.id;
          const faction = entityFactionLabel(entity);
          const relation = entityRelation(entity, reference, snapshot.relations);
          const relationship = reference ? `相对${entityLabel(reference)}：${relationLabel(relation)}` : '选择实体查看相对关系';
          const relationSymbol = { ALLY: '=', NEUTRAL: '–', HOSTILE: '×', UNKNOWN: '?', SELF: '' }[relation];
          const reactionLabel = pendingReactions.map((decision) => decisionStageLabel(decision.stage)).join('、');
          const statusAriaLabel = pendingReactions.length > 0 ? `反应待决：${reactionLabel}；提交状态：${ready.label}` : `提交状态：${ready.label}`;
          return (
            <article className={`demo-entity-roster-row${selected ? ' is-selected' : ''}${down ? ' is-down' : ''}`} data-entity-id={entity.id} style={{ borderLeftColor: entityFactionColor(entity) }} role="listitem" key={entity.id}>
              <div className="demo-entity-roster-main">
                <button className="demo-entity-roster-select" type="button" aria-label={`选择${name}`} aria-pressed={selected} disabled={selectionDisabled} onClick={() => onSelectEntity(entity.id)}>
                  <span className="demo-entity-roster-faction-dot" aria-hidden="true" style={{ color: entityFactionColor(entity) }} />
                  <span className="demo-entity-roster-name"><strong title={name}>{name}</strong><small title={`${faction} · ${relationship}`}><span>{faction}</span>{reference && relation !== 'SELF' && <i className={`demo-entity-roster-relation is-${relation.toLowerCase()}`} aria-label={`${name}${relationship}`}>{relationSymbol}</i>}</small></span>
                </button>
                {MAIN_RESOURCE_KEYS.map((key) => {
                  const current = entity.resources.current[key];
                  const max = entity.resources.max[key];
                  const currentLabel = typeof current === 'number' ? current : '—';
                  const maxLabel = typeof max === 'number' ? max : '—';
                  const hasEffectiveRange = typeof current === 'number' && Number.isFinite(current) && typeof max === 'number' && Number.isFinite(max) && max > 0;
                  const meterNow = hasEffectiveRange ? meterValue(current, max) : undefined;
                  return (
                    <div className={`demo-entity-roster-meter is-${key}`} role={hasEffectiveRange ? 'meter' : 'group'} aria-label={`${name}${resourceLabel(key)}`} aria-valuetext={hasEffectiveRange ? `${currentLabel}/${maxLabel}` : undefined} aria-valuemin={hasEffectiveRange ? 0 : undefined} aria-valuemax={hasEffectiveRange ? max : undefined} aria-valuenow={meterNow} title={`${resourceLabel(key)} ${currentLabel}/${maxLabel}`} key={key}>
                      <span className="demo-entity-roster-meter-reading"><span>{currentLabel}/{maxLabel}</span></span>
                      <span className="demo-entity-roster-meter-track" aria-hidden="true"><span style={{ width: `${meterPercent(current, max)}%` }} /></span>
                    </div>
                  );
                })}
                <span className={`demo-entity-roster-slot is-${ready.tone}${pendingReactions.length > 0 ? ' has-reaction' : ''}`} title={statusAriaLabel} aria-label={statusAriaLabel}>
                  <span className={`demo-entity-roster-status-symbol${pendingReactions.length > 0 ? ' is-reaction' : ''}`} aria-hidden="true">{pendingReactions.length > 0 ? '!' : slotSymbol(ready)}</span>
                </span>
                <span className={`demo-entity-roster-action${action?.current ? ' is-current' : ''}`} title={action ? `${action.label} · ${action.phase}` : '无当前动作'}>
                  {action ? <><span className="demo-entity-roster-phase-symbol" aria-hidden="true">{phaseSymbol(action.phase)}</span><strong>{action.label}</strong><small>{action.phase}</small></> : <span>无当前动作</span>}
                </span>
                <details className="demo-entity-roster-details">
                  <summary aria-label={`展开${name}详情`}>更多</summary>
                  <div className="demo-entity-roster-detail-grid">
                    <div className="demo-entity-roster-resources" aria-label={`${name}资源`}>
                      {resourceKeys(entity).map((key) => <span key={key} title={key}><b>{resourceLabel(key)}</b> {entity.resources.current[key] ?? '—'}/{entity.resources.max[key] ?? '—'}</span>)}
                    </div>
                  <span>提交状态：{ready.label}</span>
                  <span>阵营：{faction} · {relationship}</span>
                  <span>职业：{entityRoleLabel(entity)} · 类型：{entityTypeLabel(entity)}</span>
                  <span>位置：{coordinateLabel(entity)}</span>
                  <span>朝向：{Math.round(entity.transform.facing)}°</span>
                  {entity.currentStance && <span>战术姿态：{entity.currentStance === 'ADS' ? '瞄准射击' : entity.currentStance === 'BLIND_FIRE' ? '盲射' : '普通姿态'}</span>}
                  {entity.coverState && <span>掩体：{entity.coverState.coverType} · DR {entity.coverState.coverDr} · 防护朝向 {Math.round(entity.coverState.facing)}°</span>}
                  {entity.equippedWeaponId && <span>装备武器：{entity.equippedWeaponId}</span>}
                  {entity.bodyBlocking && <span>体积阻挡：开启</span>}
                  {entity.formationContext?.interceptConfig && <span>护卫拦截范围：{entity.formationContext.interceptConfig.interceptRange}</span>}
                  {entity.bodyParts && <span>部位破坏：{Object.values(entity.bodyParts).filter(part => part.destroyed).length}/{Object.keys(entity.bodyParts).length}</span>}
                  <span>控制：{controlLabel(entity, control, slot, session)}</span>
                  {connection && <span className={`demo-entity-roster-connection is-${connection === '在线' ? 'online' : connection === 'GM 托管' ? 'managed' : 'offline'}`}>连接：{connection}</span>}
                  {action && <span>目标：{targetLabels(action, entities)}</span>}
                  {action && <span>阶段：{action.phase}{action.resolveTick !== undefined ? `，${action.resolveLabel ?? '阶段结束'} T${action.resolveTick}` : action.effectiveTick !== undefined ? `，生效 T${action.effectiveTick}` : ''}</span>}
                  {pendingReactions.length > 0 && <span>反应：{pendingReactions.map((decision) => decisionStageLabel(decision.stage)).join('、')}</span>}
                  <code>实体 ID：{entity.id}</code>
                  {action?.actionId && <code>动作 ID：{action.actionId}</code>}
                  {entity.activeEffects.length > 0 && <span>效果：{entity.activeEffects.length} 项</span>}
                  </div>
                </details>
              </div>
            </article>
          );
        })}
        {snapshot.entities.length === 0 && <p className="demo-empty">当前没有可见实体。</p>}
      </div>
    </section>
  );
}
