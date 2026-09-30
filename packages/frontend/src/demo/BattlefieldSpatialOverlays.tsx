import { hexOffsetToPixel } from '@hard-vtt/shared';
import type { DemoCatalogAction, EncounterActionPlan, EncounterEntity, Vector3D } from '@hard-vtt/shared';
import type { DemoCatalog } from './types';
import { actionLabel, templateCatalog } from './format';

interface BattlefieldSpatialOverlaysProps {
  entities: EncounterEntity[];
  selectedEntityId: string | null;
  width: number;
  height: number;
  actions: EncounterActionPlan[];
  catalog: DemoCatalog | null;
}

function inArea(x: number, y: number, origin: Vector3D, facing: number, area: NonNullable<DemoCatalogAction['aoe']>): boolean {
  const dx = x - origin.x;
  const dy = y - origin.y;
  const distance = Math.hypot(dx, dy, origin.z);
  if (distance > area.radius) return false;
  if (area.shape === 'CIRCULAR') return true;
  const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  const difference = ((angle - facing) % 360 + 540) % 360 - 180;
  if (area.shape === 'CONICAL') return Math.abs(difference) <= (area.angle ?? 90) / 2;
  if (Math.abs(difference) > 30) return false;
  const radians = facing * Math.PI / 180;
  const along = dx * Math.cos(radians) + dy * Math.sin(radians);
  const perpendicular = Math.sqrt(Math.max(0, distance * distance - along * along));
  return along >= 0 && along <= area.radius && perpendicular <= (area.width ?? 1);
}

/** The grid uses the same map-local Euclidean distances as the server's spatial systems. */
export function BattlefieldSpatialOverlays({ entities, selectedEntityId, width, height, actions, catalog }: BattlefieldSpatialOverlaysProps) {
  const selected = entities.find(entity => entity.id === selectedEntityId);
  const guard = selected?.formationContext?.interceptConfig;
  const zones = entities.flatMap(entity => (entity.formationContext?.blockZones ?? []).map(zone => ({ zone, owner: entity })));
  const points = Array.from({ length: 6 }, (_, i) => `${Math.cos(i * Math.PI / 3)},${Math.sin(i * Math.PI / 3)}`).join(' ');
  const templates = new Map(templateCatalog(catalog).map(template => [template.id, template]));
  const areas = actions.flatMap(action => {
    // A redacted action shell must not regain a relationship through catalog metadata.
    if (action.relation !== 'ATTACK' || action.cancelled || ['RECOVERY', 'CANCELLED', 'RESOLVED'].includes(action.phase)) return [];
    const template = templates.get(action.actionTemplateId);
    const actor = entities.find(entity => entity.id === action.actorId);
    if (!template?.aoe || !actor) return [];
    const target = entities.find(entity => action.targetIds.includes(entity.id));
    const origin = action.targetCoords ?? target?.transform.coords ?? actor.transform.coords;
    return [{ action, template, actor, origin, aoe: template.aoe }];
  });
  return <g className="demo-spatial-overlays" pointerEvents="none" aria-label="护卫与封锁区域">
    {Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => {
      const center = hexOffsetToPixel(x, y);
      const zone = zones.find(({ zone }) => Math.hypot(x - zone.center.x, y - zone.center.y, zone.center.z) <= zone.radius);
      const guarded = guard && selected && Math.hypot(x - selected.transform.coords.x, y - selected.transform.coords.y, selected.transform.coords.z) <= guard.interceptRange;
      const area = areas.find(area => inArea(x, y, area.origin, area.actor.transform.facing, area.aoe));
      if (!zone && !guarded && !area) return null;
      return <g key={`${x}-${y}`} transform={`translate(${center.x} ${center.y})`}>
        {guarded && <polygon points={points} transform="scale(.9)" fill="rgba(99,214,191,.055)" stroke="rgba(99,214,191,.42)" strokeWidth=".026" strokeDasharray=".1 .08" data-guard-cell={`${x},${y}`}><title>{`${selected?.displayName ?? '护卫'}的拦截范围`}</title></polygon>}
        {zone && <polygon points={points} transform="scale(.83)" fill="rgba(229,183,104,.13)" stroke="#e5b768" strokeWidth=".035" strokeDasharray=".12 .06" data-block-zone={zone.zone.id}><title>{`${zone.owner.displayName ?? '单位'}的封锁区 · 进入伤害 ${zone.zone.triggerDamage}`}</title></polygon>}
        {area && <polygon points={points} transform="scale(.75)" fill="rgba(255,112,138,.15)" stroke="#ff708a" strokeWidth=".04" data-aoe-action={area.action.actionId} data-aoe-cell={`${x},${y}`}><title>{`${actionLabel(area.template)}几何覆盖 · 包括友军；伤害与掩体由服务器结算`}</title></polygon>}
      </g>;
    }))}
  </g>;
}
