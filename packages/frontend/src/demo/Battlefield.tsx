import type { ActionTargeting } from './useActionTargeting';
import { hexAxialToOffset, hexOffsetToPixel } from '@hard-vtt/shared';
import { useState } from 'react';
import type {
  DemoActionPreviewCell,
  DemoActionPreviewEntity,
  EncounterActionPlan,
  EncounterEntity,
  EncounterSideRelation,
} from '@hard-vtt/shared';
import type { DemoCatalog, DemoSelectedCell } from './types';
import { entityLabel, entityOptionLabel, entityRoleGlyph, entityRoleLabel, entityFactionColor, entityFactionLabel, entityRelation, relationLabel, isDown } from './format';
import { BattlefieldOverlays } from './BattlefieldOverlays';
import { BattlefieldSpatialOverlays } from './BattlefieldSpatialOverlays';

interface BattlefieldProps {
  interaction?: ActionTargeting;
  entities: EncounterEntity[];
  relations?: EncounterSideRelation[];
  /** Already recipient-filtered by the server; never local hover state. */
  actions?: EncounterActionPlan[];
  currentTick?: number;
  /** Local-only focus from the timeline; never changes command state. */
  focusedActionId?: string | null;
  catalog: DemoCatalog | null;
  selectedEntityId: string | null;
  selectedTargetId: string | null;
  selectedCell: DemoSelectedCell | null;
  onSelectEntity: (entityId: string | null) => void;
  onSelectTarget: (entityId: string | null) => void;
  onSelectCell: (cell: DemoSelectedCell) => void;
}

type PreviewCandidate = DemoActionPreviewCell | DemoActionPreviewEntity;

const RANGE_ENTRY_HINT = '当前在范围外，生效窗口内进入才命中';

function candidateInRange(candidate: PreviewCandidate | undefined): boolean | undefined {
  if (!candidate || !('inRange' in candidate)) return undefined;
  return candidate.inRange;
}

function candidateIsInRange(candidate: PreviewCandidate | undefined): boolean {
  return candidateInRange(candidate) ?? candidate?.allowed ?? false;
}

function candidateIsPendingRange(candidate: PreviewCandidate | undefined): boolean {
  return candidate?.allowed === true && candidateInRange(candidate) === false;
}

function candidateHint(candidate: PreviewCandidate | undefined, fallback: string): string {
  if (candidate?.allowed && candidateInRange(candidate) === false) return RANGE_ENTRY_HINT;
  return candidate?.reason ?? fallback;
}

function terrainClass(terrain: string | undefined): string {
  switch (terrain) {
    case 'WALL':
      return 'demo-grid-wall';
    case 'WATER':
      return 'demo-grid-water';
    case 'OBSTACLE':
      return 'demo-grid-obstacle';
    case 'DOOR':
      return 'demo-grid-door';
    default:
      return 'demo-grid-ground';
  }
}

export function Battlefield({
  interaction,
  entities,
  relations,
  actions = [],
  currentTick = 0,
  focusedActionId = null,
  catalog,
  selectedEntityId,
  selectedTargetId,
  selectedCell,
  onSelectEntity,
  onSelectTarget,
  onSelectCell,
}: BattlefieldProps) {
  const [hover, setHover] = useState({ key: '', text: '' });
  const choosing = interaction?.state;
  const reference = entities.find(entity => entity.id === selectedEntityId);
  const hoverKey = `${choosing?.actorId}:${choosing?.action.id}:${choosing?.generation}`;
  const hoverText = hover.key === hoverKey ? hover.text : '';
  const setHoverText = (text: string) => setHover({ key: hoverKey, text });
  const legacy = !interaction?.enabled;
  const pickCell = (cell: DemoSelectedCell) => choosing ? interaction?.pickCell(cell) : onSelectCell(cell);
  const focusedAction = focusedActionId
    ? actions.find((action) => action.actionId === focusedActionId)
    : undefined;
  const focusedTargetIds = new Set(focusedAction?.targetIds ?? []);
  if (focusedAction?.selfTarget === true) focusedTargetIds.add(focusedAction.actorId);
  const timelineFocusActive = Boolean(focusedAction);
  const focusRoleFor = (entityId: string): 'actor' | 'target' | 'actor-target' | undefined => {
    const isActor = focusedAction?.actorId === entityId;
    const isTarget = focusedTargetIds.has(entityId);
    if (isActor && isTarget) return 'actor-target';
    if (isActor) return 'actor';
    if (isTarget) return 'target';
    return undefined;
  };
  const width = Math.max(1, catalog?.map.width ?? 12);
  const height = Math.max(1, catalog?.map.height ?? 8);
  const tileMap = new Map((catalog?.map.tiles ?? []).map((tile) => {
    const { col, row } = hexAxialToOffset(tile.hex.q, tile.hex.r);
    return [`${col},${row}`, tile];
  }));
  const mapWidth = 1.5 * (width - 1) + 2;
  const mapHeight = Math.sqrt(3) * (height + (width > 1 ? .5 : 0));
  const hexPoints = Array.from({ length: 6 }, (_, i) => `${Math.cos(i * Math.PI / 3)},${Math.sin(i * Math.PI / 3)}`).join(' ');
  const selectToken = (entityId: string): void => {
    if (choosing) { interaction?.pickEntity(entityId); return; }
    if (!legacy) { interaction?.selectEntity(entityId); return; }
    const entity = entities.find((candidate) => candidate.id === entityId);
    if (selectedEntityId) onSelectTarget(entityId);
    else if (entity?.type === 'ACTOR') onSelectEntity(entityId);
  };

  // Polygon/core strokes provide focus cues; CSS outlines on SVG groups
  // scale with map units and can obscure entire cells.
  return (
    <section className="demo-panel demo-battlefield-panel" aria-label="战术战场">
      {legacy && <p className="demo-muted demo-legacy-notice" role="status">当前服务尚未支持动作预览：暂用列表选施放者、地图点选目标。</p>}
      {choosing && <div className="demo-targeting-banner" role="status" aria-live="polite">
        <div><strong>{interaction?.label}</strong><span>{choosing.phase === 'submitting' ? '提交中…' : choosing.loading ? '正在校验可选目标…' : choosing.phase === 'cell' ? '点击六边格指定位置 · Esc / 右键取消' : '点击目标提交 · Esc / 右键取消'}</span><small>{interaction?.detail}</small></div>
        <button type="button" className="demo-button ghost tiny" disabled={choosing.phase === 'submitting'} onClick={() => interaction?.cancel()}>取消</button>
        <p>{choosing.message || (choosing.loading ? '' : hoverText) || (!choosing.loading && choosing.phase === 'entity' && choosing.preview?.entities.some(candidateIsPendingRange) ? RANGE_ENTRY_HINT : !choosing.loading && choosing.preview && !(choosing.phase === 'cell' ? choosing.preview.cells : choosing.preview.entities).some((candidate) => candidate.allowed) ? '当前没有合法目标，可切换动作或取消' : '悬停查看目标；点击合法目标即提交')}</p>
      </div>}
      <div className={`demo-battlefield-wrap${choosing ? ' is-choosing' : ''}`} onContextMenu={(event) => { if (choosing) { event.preventDefault(); if (choosing.phase !== 'submitting') interaction?.cancel(); } }}>
        <svg className="demo-battlefield" viewBox={`-1.1 ${-Math.sqrt(3) / 2 - .1} ${mapWidth + .2} ${mapHeight + .2}`} role="img" aria-label="可点击六边形战场网格">
          {Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => {
            const tile = tileMap.get(`${x},${y}`);
            const center = hexOffsetToPixel(x, y);
            const selected = !choosing && selectedCell?.x === x && selectedCell.y === y;
            const candidate = choosing?.preview?.cells.find((cell) => cell.x === x && cell.y === y);
            const allowed = choosing?.phase === 'cell' && !choosing.loading && candidate?.allowed;
            const inRange = choosing?.phase === 'entity' && !choosing.loading && candidateIsInRange(candidate);
            const pendingRange = choosing?.phase === 'entity' && !choosing.loading && candidateIsPendingRange(candidate);
            const hint = `格${x},${y} · ${allowed ? '可选位置 · ' + interaction?.detail : inRange ? '在动作范围内 · 点击实体目标' : pendingRange ? RANGE_ENTRY_HINT : candidate?.reason ?? '当前不可选择此格'}`;
            const cellClass = !choosing ? '' : choosing.phase === 'cell'
              ? allowed ? ' is-legal' : ' is-illegal'
              : inRange ? ' is-range' : pendingRange ? ' is-pending-range' : ' is-illegal';
            return (
              <g key={`${x}-${y}`} transform={`translate(${center.x} ${center.y})`} onClick={() => pickCell({ x, y })} onMouseEnter={() => setHoverText(hint)} onFocus={() => setHoverText(hint)} className={`demo-map-cell${cellClass}`} style={{ outline: 'none' }} role="button" tabIndex={0} aria-label={`格${x},${y}`} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pickCell({ x, y }); } }}>
                <title>{choosing ? hint : `格${x},${y} · ${tile?.terrain === 'WATER' ? '河流' : tile?.terrain === 'WALL' ? '墙体' : tile?.terrain === 'OBSTACLE' ? '障碍' : tile?.terrain === 'DOOR' ? '门' : '地面'}`}</title>
                <polygon points={hexPoints} stroke="rgba(145, 170, 190, .14)" strokeWidth=".022" className={`${terrainClass(tile?.terrain)} demo-map-cell-polygon`} />
                {selected && <polygon points={hexPoints} transform="scale(.92)" className="demo-map-cell-selected" />}
              </g>
            );
          }))}
          <BattlefieldSpatialOverlays entities={entities} selectedEntityId={selectedEntityId} width={width} height={height} actions={actions} catalog={catalog} />
          <BattlefieldOverlays entities={entities} actions={actions} catalog={catalog} currentTick={currentTick} focusedActionId={focusedActionId} />
          {entities.map((entity) => {
            const { x, y } = hexOffsetToPixel(entity.transform.coords.x, entity.transform.coords.y);
            const color = entityFactionColor(entity);
            const selected = entity.id === selectedEntityId;
            const target = entity.id === selectedTargetId;
            const down = isDown(entity);
            const relation = entityRelation(entity, reference, relations);
            const factionClass = relation === 'ALLY' || relation === 'SELF'
              ? 'is-friendly'
              : relation === 'HOSTILE'
                ? 'is-hostile'
                : 'is-neutral';
            const roleGlyph = entityRoleGlyph(entity);
            const focusRole = focusRoleFor(entity.id);
            const focusLabel = focusRole === 'actor-target'
              ? '，时间轴聚焦施放者与目标'
              : focusRole === 'actor'
                ? '，时间轴聚焦施放者'
                : focusRole === 'target'
                  ? '，时间轴聚焦目标'
                  : '';
            const candidate = choosing?.phase === 'cell'
              ? choosing.preview?.cells.find((cell) => cell.x === entity.transform.coords.x && cell.y === entity.transform.coords.y)
              : choosing?.preview?.entities.find((item) => item.entityId === entity.id);
            const allowed = Boolean(choosing && !choosing.loading && choosing.phase !== 'submitting' && candidate?.allowed);
            const pendingRange = Boolean(choosing?.phase === 'entity' && !choosing.loading && candidateIsPendingRange(candidate));
            const hint = `${entityLabel(entity)} · ${allowed ? pendingRange ? RANGE_ENTRY_HINT : '点击提交 · ' + interaction?.detail : candidateHint(candidate, '当前不可选择此目标')}`;
            return (
              <g
                key={entity.id}
                transform={`translate(${x} ${y})`}
                className={`demo-entity-token ${factionClass}${selected ? ' is-selected' : ''}${target ? ' is-target' : ''}${down ? ' is-down' : ''}${choosing ? allowed ? ` is-legal${pendingRange ? ' is-pending-range' : ''}` : ' is-illegal' : ''}${focusRole ? ` is-timeline-focus is-timeline-focus-${focusRole}` : ''}`}
                style={{ outline: 'none' }}
                data-entity-id={entity.id}
                data-faction={entity.faction ?? 'UNKNOWN'}
                onMouseEnter={() => setHoverText(hint)} onFocus={() => setHoverText(hint)}
                onClick={(event) => {
                  event.stopPropagation();
                  selectToken(entity.id);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectToken(entity.id);
                  }
                }}
                aria-label={`${entityLabel(entity)}，${entityFactionLabel(entity)}，${relationLabel(relation)}，${entityRoleLabel(entity)}${down ? '，倒下' : ''}${focusLabel}`}
              >
                <title>{choosing ? hint : `${entityOptionLabel(entity)} · ${entityFactionLabel(entity)} · ${reference ? `相对${entityLabel(reference)}：${relationLabel(relation)}` : '未选择参照实体'} · ${entityRoleLabel(entity)}`}</title>
                {focusRole && <circle
                  r={focusRole === 'actor-target' ? '.56' : focusRole === 'actor' ? '.52' : '.49'}
                  className={`demo-map-timeline-focus-ring demo-map-timeline-focus-ring-${focusRole}`}
                  style={{
                    fill: 'none',
                    stroke: focusRole === 'target' ? '#ffcf78' : '#a9fff0',
                    strokeWidth: focusRole === 'actor-target' ? '.045' : '.035',
                    strokeDasharray: focusRole === 'target' ? '.12 .065' : '.18 .08',
                    opacity: timelineFocusActive ? .98 : 0,
                    pointerEvents: 'none',
                  }}
                />}
                {allowed && <circle r=".46" className="demo-candidate-ring" />}
                {(selected || target) && <circle r=".38" className={selected ? 'demo-entity-ring-selected' : 'demo-entity-ring-target'} />}
                {entity.type === 'PROP' ? <rect x="-.36" y="-.3" width=".72" height=".6" rx=".06" fill={down ? '#394451' : '#596471'} stroke="#c5c0ae" strokeWidth=".045" data-cover-prop={entity.id} />
                  : entity.type === 'PROJECTILE' ? <path d="M -.26 0 L .1 0 M .1 -.09 L .27 0 L .1 .09" stroke="#ffe7a9" strokeWidth=".06" fill="none" transform={`rotate(${entity.transform.facing})`} data-projectile={entity.id} />
                    : <circle r=".27" fill={color} className="demo-entity-token-core" />}
                {entity.type === 'ACTOR' && <path d="M -.04 -.26 L .06 -.26 L .06 -.39 L .13 -.39 L 0 -.55 L -.13 -.39 L -.06 -.39 L -.06 -.26 Z" fill={color} transform={`rotate(${entity.transform.facing + 90})`} />}
                {entity.coverState && entity.coverState.coverType !== 'NONE' && <path d="M .38 -.28 L .44 -.28 L .44 .28 L .38 .28" fill="none" stroke={entity.coverState.coverType === 'FULL' ? '#e5b768' : '#cbd3de'} strokeWidth=".06" transform={`rotate(${entity.coverState.facing})`} data-cover-facing={entity.coverState.facing} />}
                {entity.type !== 'PROJECTILE' && <text y=".08" textAnchor="middle" className="demo-entity-role-symbol" aria-hidden="true">{roleGlyph}</text>}
                <text y=".61" textAnchor="middle" className="demo-entity-label">{entityLabel(entity).slice(0, 12)}</text>
                {typeof entity.resources.current.hp === 'number' && typeof entity.resources.max.hp === 'number' && (
                  <g transform="translate(-.3 -.45)">
                    <rect width=".6" height=".055" rx=".02" className="demo-hp-track" />
                    <rect width={Math.max(0, Math.min(.6, .6 * entity.resources.current.hp / Math.max(1, entity.resources.max.hp)))} height=".055" rx=".02" fill={down ? '#708092' : color} />
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      {catalog?.scenario && <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 10, color: 'var(--demo-muted)', paddingTop: 7 }} aria-label="战场图例"><span>▣ 可破坏掩体</span><span>➜ 朝向 / 实体弹道</span><span style={{ color: 'var(--demo-teal)' }}>虚线格：选中护卫的拦截范围</span><span style={{ color: 'var(--demo-amber)' }}>金色格：封锁区域</span><span style={{ color: '#ff708a' }}>红色格：范围动作几何覆盖</span></div>}
    </section>
  );
}
