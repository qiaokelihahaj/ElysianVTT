import { getEntityFaction, getEncounterRelation, getEncounterSide, normalizeEncounterFaction } from '@hard-vtt/shared';
import type { DemoCatalogAction, EncounterActionPlan, EncounterEntity, EncounterFaction, EncounterRelation, EncounterSideRelation } from '@hard-vtt/shared';
import type { DemoCatalog } from './types';

const ACTION_LABELS: Record<string, string> = {
  DEMO_MELEE_STRIKE: '近战突击',
  DEMO_RANGED_SHOT: '远程射击',
  DEMO_GUIDED_PULSE: '引导脉冲',
  DEMO_MOVE: '移动',
  DEMO_RECOVER_WOUND: '包扎治疗',
  DEMO_RECOVER_FOCUS: '恢复资源',
  PARRY: '招架',
  DODGE: '闪避',
  INTERRUPT: '打断',
  MOVE: '移动',
  move: '移动',
  ATTACK_MELEE: '近战攻击',
  ATTACK_RANGED: '远程射击',
  CHANNEL: '持续引导',
  RECOVER: '恢复资源',
  WAIT: '等待',
  TACTIC_SPRINT: '冲刺移动',
  TACTIC_SPEAR: '长枪突刺',
  TACTIC_PRECISION: '要害重击',
  TACTIC_LINEAR_SHOT: '直射弹道',
  TACTIC_LOB: '抛射爆弹',
  TACTIC_CONE: '扇形扫荡',
  TACTIC_LINE: '线形贯穿',
  TACTIC_BACKSTAB: '侧翼背刺',
  TACTIC_ADS: '架枪姿态',
  TACTIC_BLIND_FIRE: '撩枪姿态',
  TACTIC_TURN_LEFT: '左转 60°',
  TACTIC_TURN_RIGHT: '右转 60°',
  TACTIC_GUARD: '护卫阵型',
  TACTIC_UNGUARD: '解除护卫',
  TACTIC_BLOCK_ZONE: '封锁通道',
  TACTIC_DROP_WEAPON: '弃武器',
  TACTIC_EQUIP_SPEAR: '装备长枪',
  TACTIC_EQUIP_SIDEARM: '切换副武器',
  TACTIC_EQUIP_RIFLE: '装备步枪',
  TACTIC_SIDEARM: '副武器速击',
  TACTIC_DODGE: '位移闪避',
};

const RESOURCE_LABELS: Record<string, string> = {
  hp: '生命',
  poise: '韧性',
  focus: '专注',
  agi: '敏捷',
};

/**
 * Resource keys are rule-pack data, so unknown keys remain visible instead of
 * being dropped when a new pack adds a resource the demo does not know yet.
 */
export function resourceLabel(key: string): string {
  return RESOURCE_LABELS[key] ?? key;
}

export function actionIdLabel(actionId: string): string {
  return ACTION_LABELS[actionId] ?? actionId;
}

export function actionLabel(template: DemoCatalogAction): string {
  const catalogLabel = template.label.trim();
  return (catalogLabel.length > 0 && catalogLabel !== template.id)
    ? catalogLabel
    : actionIdLabel(template.id) || ACTION_LABELS[template.tags[0] ?? ''] || template.id;
}

export function factionLabel(faction: EncounterFaction | null | undefined): string {
  const normalized = normalizeEncounterFaction(faction);
  switch (normalized) {
    case 'PLAYERS':
    case 'PLAYER':
      return '队伍 A';
    case 'ENEMIES':
    case 'ENEMY':
      return '队伍 B';
    case null:
      return '独立';
    default:
      return normalized;
  }
}

function identityColor(identity: string): string {
  let hash = 2166136261;
  for (const character of identity) hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619);
  // Mix nearby names (such as 势力1…势力10) across the hue range as well.
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash ^= hash >>> 16;
  return `hsl(${(hash >>> 0) % 360} 48% 67%)`;
}

export function weaponLabel(id: string): string {
  const labels: Record<string, string> = { spear: '长枪', sidearm: '副武器', rifle: '步枪' };
  return labels[id] ?? id;
}

/** Public rule-pack facts for tooltips; expressions are displayed, never evaluated here. */
export function actionTacticalSummary(action: DemoCatalogAction): string {
  const facts: string[] = [];
  if (action.range && !['SELF', 'MOVEMENT'].includes(action.range.type)) facts.push(`射程 ${action.range.distanceExpr}`);
  if (action.spatial?.reach?.minReach !== undefined) facts.push(`最短触及 ${action.spatial.reach.minReach}`);
  if (action.spatial?.requiredWeaponId) facts.push(`需要${weaponLabel(action.spatial.requiredWeaponId)}`);
  if (action.launchProjectile) {
    facts.push(action.launchProjectile.trajectoryType === 'PARABOLIC' ? `抛射 · 最高 ${action.launchProjectile.maxHeight ?? 0}` : '直射弹道');
    if (action.launchProjectile.minRange !== undefined) facts.push(`盲区 ${action.launchProjectile.minRange}`);
  }
  if (action.aoe) {
    const shape = { CIRCULAR: '圆形', CONICAL: '扇形', LINEAR: '线形' }[action.aoe.shape];
    facts.push(`${shape} ${action.aoe.radius}${action.aoe.angle === undefined ? '' : ` · ${action.aoe.angle}°`}${action.aoe.width === undefined ? '' : ` · 半宽 ${action.aoe.width}`} · 含友伤`);
  }
  if (action.spatial?.guard?.interceptConfig) facts.push(`拦截范围 ${action.spatial.guard.interceptConfig.interceptRange}`);
  if (action.spatial?.blockZone) facts.push(`封锁半径 ${action.spatial.blockZone.radius} · ${action.spatial.blockZone.durationTicks}T`);
  if (action.spatial?.backstabMultiplier !== undefined) facts.push(`背刺 ×${action.spatial.backstabMultiplier}`);
  return facts.join(' · ');
}

export function factionColor(faction: EncounterFaction | null | undefined): string {
  switch (normalizeEncounterFaction(faction)) {
    case 'PLAYERS':
    case 'PLAYER':
      return '#63d6bf';
    case 'ENEMIES':
    case 'ENEMY':
      return '#ff708a';
    case null:
      return '#92a4ba';
    default:
      return identityColor(`faction:${faction}`);
  }
}

export function entityFactionLabel(entity: EncounterEntity): string {
  return factionLabel(getEntityFaction(entity));
}

export function entityFactionColor(entity: EncounterEntity | undefined): string {
  if (!entity) return '#92a4ba';
  const faction = getEntityFaction(entity);
  return faction ? factionColor(faction) : identityColor(`entity:${entity.id}`);
}

export function entityRelation(entity: EncounterEntity, reference: EncounterEntity | undefined, relations?: EncounterSideRelation[]): EncounterRelation | 'UNKNOWN' | 'SELF' {
  if (!reference) return 'UNKNOWN';
  if (entity.id === reference.id) return 'SELF';
  return getEncounterRelation(getEncounterSide(reference), getEncounterSide(entity), relations);
}

export function relationLabel(relation: EncounterRelation | 'UNKNOWN' | 'SELF'): string {
  return { ALLY: '同盟', NEUTRAL: '中立', HOSTILE: '敌对', UNKNOWN: '关系未设置', SELF: '自身' }[relation];
}

export function entityLabel(entity: EncounterEntity): string {
  return entity.displayName ?? entity.encounterTemplateId ?? entity.templateId ?? entity.id;
}

export function entityRoleGlyph(entity: EncounterEntity): string {
  if (entity.type === 'PROP') return '▣';
  if (entity.type === 'PROJECTILE') return '➜';
  const key = `${entity.encounterTemplateId ?? ''} ${entity.templateId ?? ''}`.toLowerCase();
  if (/melee|bruiser|近战|先锋|战士|骑士/.test(key)) return '⚔';
  if (/ranged|marksman|远程|远射|游侠|弓/.test(key)) return '⌁';
  if (/guide|channel|引导|术士|法师/.test(key)) return '✦';
  return '◇';
}

export function entityRoleLabel(entity: EncounterEntity): string {
  if (entity.type === 'PROP') return entity.coverState ? '掩体' : '场景物';
  if (entity.type === 'PROJECTILE') return '实体弹道';
  const key = `${entity.encounterTemplateId ?? ''} ${entity.templateId ?? ''}`.toLowerCase();
  if (/melee|bruiser|近战|先锋|战士|骑士/.test(key)) return '近战';
  if (/ranged|marksman|远程|远射|游侠|弓/.test(key)) return '远程';
  if (/guide|channel|引导|术士|法师/.test(key)) return '引导';
  return '单位';
}

export function entityOptionLabel(entity: EncounterEntity): string {
  const { x, y } = entity.transform.coords;
  return `${entityLabel(entity)} (${x},${y})`;
}

export function entityTechnicalLabel(entity: EncounterEntity): string {
  return `${entityLabel(entity)} · ${entity.id}`;
}

export function isDown(entity: EncounterEntity): boolean {
  const hp = entity.resources.current.hp;
  return typeof hp === 'number' && hp <= 0;
}

export function resourceCostLabel(template: DemoCatalogAction): string {
  const entries = Object.entries(template.resourceCost);
  if (entries.length === 0) return '免费';
  return entries.map(([key, value]) => `${resourceLabel(key)} ${value}`).join(' · ');
}

export function numericCost(template: DemoCatalogAction, resource: string): number | undefined {
  const value = template.resourceCost[resource];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function canAfford(template: DemoCatalogAction, entity: EncounterEntity | undefined): boolean {
  if (!entity) return false;
  return Object.entries(template.resourceCost).every(([key, expression]) => {
    const cost = Number(expression);
    const current = entity.resources.current[key] ?? 0;
    return Number.isFinite(cost) ? current >= cost : true;
  });
}

export function phaseLabel(phase: EncounterActionPlan['phase']): string {
  const labels: Record<EncounterActionPlan['phase'], string> = {
    DECLARED: '已声明',
    DELAY: '延迟',
    STARTUP: '前摇',
    ACTIVE: '生效中',
    CHANNELING: '引导中',
    RECOVERY: '收招',
    CANCELLED: '已取消',
    RESOLVED: '已结算',
  };
  return labels[phase];
}

export function templateCatalog(catalog: DemoCatalog | null): DemoCatalogAction[] {
  const seen = new Set<string>();
  const actions: DemoCatalogAction[] = [];
  for (const entry of catalog?.entries ?? []) {
    for (const action of entry.actions) {
      if (!seen.has(action.id)) {
        seen.add(action.id);
        actions.push(action);
      }
    }
  }
  return actions;
}

export function actionGroup(action: DemoCatalogAction): string {
  const tags = action.tags.map(tag => tag.toUpperCase());
  if (tags.some(tag => tag === 'MOVE' || tag === 'MOVEMENT')) return '移动';
  if (tags.includes('ATTACK')) return '攻击';
  return '辅助';
}
