import type { DemoCatalogAction, EncounterSnapshot } from '@hard-vtt/shared';
import type { DemoCatalog, DemoSessionInfo } from './types';
import { actionIdLabel, actionLabel, actionTacticalSummary, canAfford, entityLabel, isDown, templateCatalog, weaponLabel } from './format';

interface SpatialTacticsPanelProps {
  catalog: DemoCatalog | null;
  snapshot: EncounterSnapshot;
  session: DemoSessionInfo;
  selectedEntityId: string | null;
  onChooseAction?: (action: DemoCatalogAction) => void;
  submitting?: boolean;
}

const BODY_LABELS: Record<string, string> = {
  HEAD: '头部', TORSO: '躯干', LEFT_ARM: '左臂', RIGHT_ARM: '右臂', LEFT_LEG: '左腿', RIGHT_LEG: '右腿',
};
const STANCE_LABELS = { ADS: '瞄准射击', BLIND_FIRE: '盲射', NONE: '普通姿态' };

/** Scenario instructions and recipient-filtered tactical facts, with real action-picker shortcuts. */
export function SpatialTacticsPanel({ catalog, snapshot, session, selectedEntityId, onChooseAction, submitting }: SpatialTacticsPanelProps) {
  const scenario = catalog?.scenario;
  if (!scenario) return null;
  const actor = snapshot.entities.find(entity => entity.id === selectedEntityId);
  const actions = new Map(templateCatalog(catalog).map(action => [action.id, action]));
  const slot = snapshot.plan.slots.find(candidate => candidate.entityId === actor?.id);
  const controlled = actor && (session.session.role === 'GM' || session.session.controlledEntityIds.includes(actor.id));
  const canChoose = Boolean(onChooseAction && controlled && actor?.type === 'ACTOR' && !isDown(actor)
    && snapshot.status === 'ACTIVE' && !snapshot.paused && !actor.currentActionContext && !slot?.ready
    && (slot?.readyAtTick === undefined || slot.readyAtTick <= snapshot.tick)
    && !snapshot.decisions.some(decision => !decision.resolved) && !submitting);
  const inLobby = snapshot.status === 'LOBBY';
  const guard = actor?.formationContext?.interceptConfig;
  const zones = actor?.formationContext?.blockZones ?? [];
  return <details className="demo-panel demo-spatial-guide" open={inLobby || undefined} style={{ padding: '12px 14px', marginBottom: 10 }}>
    <summary style={{ cursor: 'pointer', color: 'var(--demo-teal)', fontWeight: 700, fontSize: 13 }}>
      空间战术演练 · {scenario.objectives.length} 个连贯环节
    </summary>
    <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
      <div><strong>{scenario.title}</strong><p className="demo-muted" style={{ margin: '5px 0 0', lineHeight: 1.6 }}>{scenario.summary}</p></div>
      <p style={{ margin: 0, color: 'var(--demo-amber)', fontSize: 12, lineHeight: 1.6 }}>
        沿河岸推进 → 在断桥口组成护卫阵型 → 绕至堡垒侧后方。爆炸、锥形与线形攻击会波及同伴；先检查朝向和队友位置。
      </p>
      <ol style={{ display: 'grid', gap: 10, paddingLeft: 0, margin: 0, listStyle: 'none' }}>
        {scenario.objectives.map(objective => <li key={objective.id} style={{ paddingLeft: 3 }}>
          <strong style={{ fontSize: 12 }}>{objective.title}</strong>
          <p className="demo-muted" style={{ margin: '4px 0 6px', fontSize: 12, lineHeight: 1.6 }}>{objective.description}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {objective.actionIds.map(id => {
              const action = actions.get(id);
              const label = action ? actionLabel(action) : actionIdLabel(id);
              const requiredWeapon = action?.spatial?.requiredWeaponId;
              const available = Boolean(canChoose && action && (!requiredWeapon || actor?.equippedWeaponId === requiredWeapon) && canAfford(action, actor));
              return action && onChooseAction
                ? <button key={id} className="demo-button ghost tiny" type="button" disabled={!available} title={[action.description ?? label, actionTacticalSummary(action)].filter(Boolean).join(' · ')} onClick={() => onChooseAction(action)} aria-label={`演练动作：${label}`}>{label}</button>
                : <span key={id} className="demo-target-chip" title={action?.description}>{label}</span>;
            })}
          </div>
        </li>)}
      </ol>
      {!inLobby && <p className="demo-muted" style={{ margin: 0, fontSize: 11 }}>选中可控角色后，点击上方动作进入地图目标选择。其他角色需提交行动或等待；GM 操作敌方，空闲角色可执行等待。</p>}
      {actor && <div style={{ paddingTop: 10, borderTop: '1px solid var(--demo-line)', display: 'grid', gap: 7, fontSize: 12 }} aria-label={`${entityLabel(actor)}空间战术状态`}>
        <strong>{entityLabel(actor)} · 当前战术状态</strong>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 12px' }}>
          <span>朝向 {Math.round(actor.transform.facing)}°</span>
          {actor.currentStance && <span>姿态：{STANCE_LABELS[actor.currentStance]}</span>}
          {actor.equippedWeaponId && <span>武器：{weaponLabel(actor.equippedWeaponId)}</span>}
          {(actor.droppedWeaponIds?.length ?? 0) > 0 && <span>已弃置：{actor.droppedWeaponIds?.map(weaponLabel).join('、')}</span>}
          {actor.coverState && <span>掩体：{actor.coverState.coverType === 'FULL' ? '全掩体' : actor.coverState.coverType === 'HALF' ? '半掩体' : '无'} · DR {actor.coverState.coverDr} · 防护朝向 {Math.round(actor.coverState.facing)}°</span>}
          {actor.bodyBlocking && <span>体积阻挡已开启</span>}
          {guard && <span>团队拦截：范围 {guard.interceptRange} · 减伤 {Math.round(guard.interceptDamageReduction * 100)}%</span>}
          {zones.map(zone => <span key={zone.id}>封锁区域：半径 {zone.radius} · 持续 {zone.durationTicks}T · 进入伤害 {zone.triggerDamage}</span>)}
          {actor.currentActionContext?.consecutiveMoves !== undefined && <span>连续移动 {actor.currentActionContext.consecutiveMoves} 次</span>}
        </div>
        {actor.bodyParts && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }} aria-label="部位耐久">
          {Object.entries(actor.bodyParts).map(([part, state]) => <span key={part} style={{ border: '1px solid var(--demo-line)', borderRadius: 4, padding: '3px 6px', color: state.destroyed ? '#ff9caf' : 'var(--demo-muted)' }}>{BODY_LABELS[part] ?? part} {state.currentHp}/{state.maxHp}{state.destroyed ? ' · 已破坏' : ''}</span>)}
        </div>}
      </div>}
    </div>
  </details>;
}
