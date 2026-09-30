import type {
  EncounterActionPlan,
  EncounterActionRelation,
  EncounterEntity,
} from '@hard-vtt/shared';
import { hexOffsetToPixel } from '@hard-vtt/shared';
import type { JSX } from 'react';
import type { DemoCatalog } from './types';
import { entityLabel } from './format';

interface BattlefieldOverlaysProps {
  entities: EncounterEntity[];
  actions: EncounterActionPlan[];
  catalog: DemoCatalog | null;
  currentTick: number;
  /** Local timeline focus. Actions are already recipient-filtered by server. */
  focusedActionId?: string | null;
}

interface ActionRelationVisual {
  kind: EncounterActionRelation;
  label: string;
  markerId: string;
  color: string;
}

function actionTemplateMap(catalog: DemoCatalog | null): Map<string, DemoCatalog['entries'][number]['actions'][number]> {
  const templates = new Map<string, DemoCatalog['entries'][number]['actions'][number]>();
  for (const entry of catalog?.entries ?? []) {
    for (const action of entry.actions) templates.set(action.id, action);
  }
  return templates;
}

/** Only the server supplied relation hint can create an effect arrow. */
function relationVisual(action: EncounterActionPlan): ActionRelationVisual | undefined {
  switch (action.relation) {
    case 'ATTACK':
      return { kind: 'ATTACK', label: '⚔ 攻击', markerId: 'demo-arrow-attack', color: '#ff708a' };
    case 'HEAL':
      return { kind: 'HEAL', label: '✚ 治疗', markerId: 'demo-arrow-heal', color: '#63d6b2' };
    case 'SUPPORT':
      return { kind: 'SUPPORT', label: '✦ 支援', markerId: 'demo-arrow-support', color: '#e5b768' };
    default:
      return undefined;
  }
}

function actionIsVisibleOnMap(action: EncounterActionPlan): boolean {
  return action.cancelled !== true
    && action.phase !== 'CANCELLED'
    && action.phase !== 'RESOLVED'
    // Recovery is a post-effect lockout.  It must not look like the effect
    // will happen again or remain an active relationship on the map.
    && action.phase !== 'RECOVERY';
}

function isMovement(action: EncounterActionPlan, template: DemoCatalog['entries'][number]['actions'][number] | undefined): boolean {
  return action.actionTemplateId === 'DEMO_MOVE' || template?.tags.some(tag => tag.toUpperCase() === 'MOVEMENT') === true;
}

function insetLine(
  from: { x: number; y: number },
  to: { x: number; y: number },
  startInset: number,
  endInset: number,
): { from: { x: number; y: number }; to: { x: number; y: number }; length: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return { from, to, length };
  const nx = dx / length;
  const ny = dy / length;
  return {
    from: { x: from.x + nx * startInset, y: from.y + ny * startInset },
    to: { x: to.x - nx * endInset, y: to.y - ny * endInset },
    length,
  };
}

function labelWidth(text: string, fontSize = .32): number {
  const glyphUnits = Array.from(text).reduce((total, glyph) => total + (glyph.codePointAt(0)! > 0x2e80 ? 1 : .62), 0);
  return Math.max(.9, glyphUnits * fontSize + .24);
}

function actionLabel(text: string, x: number, y: number, className: string): JSX.Element {
  const width = labelWidth(text);
  return (
    <g className={`demo-action-label ${className}`}>
      <rect x={x - width / 2} y={y - .23} width={width} height=".46" rx=".08" className="demo-action-label-plate" />
      <text x={x} y={y} className="demo-action-relation-label" textAnchor="middle" dominantBaseline="middle">{text}</text>
    </g>
  );
}

function marker(id: string, color: string): JSX.Element {
  return (
    <marker id={id} viewBox="0 0 10 10" refX="8" refY="5" markerWidth=".42" markerHeight=".42" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
    </marker>
  );
}

export function BattlefieldOverlays({ entities, actions, catalog, currentTick, focusedActionId = null }: BattlefieldOverlaysProps): JSX.Element {
  const entityById = new Map(entities.map(entity => [entity.id, entity]));
  const templates = actionTemplateMap(catalog);
  const visibleActions = actions.filter(actionIsVisibleOnMap);
  const focusedAction = focusedActionId
    ? visibleActions.find(action => action.actionId === focusedActionId)
    : undefined;
  const hasTimelineFocus = Boolean(focusedAction);

  return (
    <g className="demo-action-overlays" pointerEvents="none" aria-hidden="true">
      <defs>
        {marker('demo-arrow-attack', '#ff708a')}
        {marker('demo-arrow-heal', '#63d6b2')}
        {marker('demo-arrow-support', '#e5b768')}
        {marker('demo-arrow-move', '#9ac8ff')}
      </defs>
      {visibleActions.map(action => {
        const actor = entityById.get(action.actorId);
        if (!actor) return null;
        const isFocused = action.actionId === focusedAction?.actionId;
        const focusClass = isFocused
          ? ' is-timeline-focused'
          : hasTimelineFocus
            ? ' is-timeline-unfocused'
            : '';
        const focusStyle = hasTimelineFocus && !isFocused ? { opacity: .22 } : undefined;
        const from = hexOffsetToPixel(actor.transform.coords.x, actor.transform.coords.y);
        const template = templates.get(action.actionTemplateId);

        if (isMovement(action, template) && action.targetCoords) {
          const destination = hexOffsetToPixel(action.targetCoords.x, action.targetCoords.y);
          const line = insetLine(from, destination, .34, .4);
          if (line.length < .001) return null;
          const middleX = (from.x + destination.x) / 2;
          const middleY = (from.y + destination.y) / 2;
          const remaining = action.arrivalTick === undefined
            ? undefined
            : Math.max(0, action.arrivalTick - currentTick);
          const atDestination = Math.abs(actor.transform.coords.x - action.targetCoords.x) < .001
            && Math.abs(actor.transform.coords.y - action.targetCoords.y) < .001
            && Math.abs(actor.transform.coords.z - action.targetCoords.z) < .001;
          const movementText = remaining === undefined
            ? '➜ 移动 · 待结算'
            : remaining === 0 && atDestination
              ? '➜ 移动 · 已到达'
              : remaining === 0
                ? '➜ 移动 · 到达待结算'
                : `➜ 移动 · 还剩 ${remaining}T`;
          return (
            <g className={`demo-action-overlay demo-action-overlay-move${focusClass}`} style={focusStyle} data-action-id={action.actionId} key={`${action.actionId}-move`}>
              <line x1={line.from.x} y1={line.from.y} x2={line.to.x} y2={line.to.y} stroke="#9ac8ff" strokeWidth={isFocused ? ".125" : ".075"} strokeDasharray=".16 .1" markerEnd="url(#demo-arrow-move)" />
              <circle cx={destination.x} cy={destination.y} r={isFocused ? ".21" : ".16"} className="demo-action-destination" />
              {actionLabel(movementText, middleX, middleY - .66, 'demo-action-move-label')}
              <title>{`${entityLabel(actor)}：${movementText}`}</title>
            </g>
          );
        }

        const relation = relationVisual(action);
        if (!relation) return null;
        const targetIds = action.targetIds.filter(targetId => entityById.has(targetId));
        const selfTarget = action.selfTarget === true
          && (targetIds.length === 0 || targetIds.includes(actor.id));
        if (selfTarget) {
          const selfLabelY = from.y - .72;
          return (
            <g className={`demo-action-overlay demo-action-overlay-self${focusClass}`} style={focusStyle} data-action-id={action.actionId} key={`${action.actionId}-self`}>
              <path d={`M ${from.x - .23} ${from.y - .16} C ${from.x - .55} ${from.y - .56}, ${from.x + .55} ${from.y - .56}, ${from.x + .23} ${from.y - .16}`} fill="none" stroke={relation.color} strokeWidth={isFocused ? ".11" : ".065"} markerEnd={`url(#${relation.markerId})`} />
              {actionLabel(`${relation.label} · 自身`, from.x, selfLabelY, 'demo-action-self-label')}
              <title>{`${entityLabel(actor)}：${relation.label} · 自身`}</title>
            </g>
          );
        }

        return targetIds.map(targetId => {
          const target = entityById.get(targetId);
          if (!target) return null;
          const to = hexOffsetToPixel(target.transform.coords.x, target.transform.coords.y);
          const line = insetLine(from, to, .34, .42);
          if (line.length < .001) return null;
          const middleX = (line.from.x + line.to.x) / 2;
          const middleY = (line.from.y + line.to.y) / 2;
          const dx = line.to.x - line.from.x;
          const dy = line.to.y - line.from.y;
          const length = Math.max(.001, Math.hypot(dx, dy));
          // Keep simultaneous opposite relationships legible when they share
          // the same two endpoints.
          // Use the same signed curve for attack/heal.  When two actions run
          // in opposite directions this puts them on opposite sides of the
          // shared chord, instead of cancelling the offset with the reversed
          // direction vector.
          const curve = relation.kind === 'ATTACK' || relation.kind === 'HEAL' ? .86 : .24;
          const controlX = middleX - dy / length * curve;
          const controlY = middleY + dx / length * curve;
          const labelX = (line.from.x + 2 * controlX + line.to.x) / 4;
          const labelY = (line.from.y + 2 * controlY + line.to.y) / 4;
          return (
            <g className={`demo-action-overlay demo-action-overlay-relation${focusClass}`} style={focusStyle} data-action-id={action.actionId} key={`${action.actionId}-${targetId}`}>
              <path d={`M ${line.from.x} ${line.from.y} Q ${controlX} ${controlY} ${line.to.x} ${line.to.y}`} fill="none" stroke={relation.color} strokeWidth={isFocused ? ".13" : ".075"} markerEnd={`url(#${relation.markerId})`} />
              {actionLabel(relation.label, labelX, labelY, `demo-action-${relation.kind.toLowerCase()}-label`)}
              <title>{`${entityLabel(actor)} → ${entityLabel(target)} · ${relation.label}`}</title>
            </g>
          );
        });
      })}
    </g>
  );
}
