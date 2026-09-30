import type { EncounterEntity, EncounterFaction, EncounterRelation, EncounterSide, EncounterSideRelation, EncounterVictoryCondition } from './index.js';

export function isEncounterFaction(value: unknown): value is EncounterFaction {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)
    && !['__proto__', 'constructor', 'prototype'].includes(value);
}

export function normalizeEncounterFaction(faction: EncounterFaction | null | undefined): EncounterFaction | null {
  if (!faction || faction === 'NEUTRAL') return null;
  if (faction === 'PLAYER') return 'PLAYERS';
  if (faction === 'ENEMY') return 'ENEMIES';
  return faction;
}

export function getEntityFaction(entity: Pick<EncounterEntity, 'faction' | 'tags'>): EncounterFaction | null {
  if (entity.faction !== undefined) return normalizeEncounterFaction(entity.faction);
  if (entity.tags?.some(tag => tag === 'PLAYERS' || tag === 'PLAYER')) return 'PLAYERS';
  if (entity.tags?.some(tag => tag === 'ENEMIES' || tag === 'ENEMY')) return 'ENEMIES';
  return null;
}

export function getEncounterSide(entity: Pick<EncounterEntity, 'id' | 'faction' | 'tags'>): EncounterSide {
  const faction = getEntityFaction(entity);
  return faction ? { kind: 'FACTION', id: faction } : { kind: 'ENTITY', id: entity.id };
}

export function isEncounterSide(value: unknown): value is EncounterSide {
  if (!value || typeof value !== 'object') return false;
  const side = value as Record<string, unknown>;
  if (side.kind === 'FACTION') return isEncounterFaction(side.id) && normalizeEncounterFaction(side.id) !== null;
  return side.kind === 'ENTITY' && typeof side.id === 'string' && side.id.length > 0 && side.id.length <= 128
    && side.id === side.id.trim() && !/[\u0000-\u001f\u007f]/u.test(side.id)
    && !['__proto__', 'constructor', 'prototype'].includes(side.id);
}

export function sameEncounterSide(a: EncounterSide, b: EncounterSide): boolean {
  return a.kind === b.kind && (a.kind === 'FACTION'
    ? normalizeEncounterFaction(a.id) === normalizeEncounterFaction(b.id)
    : a.id === b.id);
}

export function isEncounterRelation(value: unknown): value is EncounterRelation {
  return value === 'ALLY' || value === 'NEUTRAL' || value === 'HOSTILE';
}

export function isEncounterVictoryCondition(value: unknown): value is EncounterVictoryCondition {
  return value === 'LAST_SIDE' || value === 'MANUAL';
}

export function getEncounterRelation(a: EncounterSide, b: EncounterSide, relations: readonly EncounterSideRelation[] = []): EncounterRelation | 'UNKNOWN' {
  if (sameEncounterSide(a, b)) return 'ALLY';
  const configured = relations.find(pair => (sameEncounterSide(pair.a, a) && sameEncounterSide(pair.b, b))
    || (sameEncounterSide(pair.a, b) && sameEncounterSide(pair.b, a)));
  if (configured) return configured.relation;
  // Backward-compatible default for the original demo; all other pairs are unspecified.
  if (a.kind === 'FACTION' && b.kind === 'FACTION') {
    const factions = new Set([normalizeEncounterFaction(a.id), normalizeEncounterFaction(b.id)]);
    if (factions.has('PLAYERS') && factions.has('ENEMIES')) return 'HOSTILE';
  }
  return 'UNKNOWN';
}
