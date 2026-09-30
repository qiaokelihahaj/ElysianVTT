import type {
  EncounterEntity,
  EncounterResult,
  EncounterSide,
  EncounterSideRelation,
  EncounterVictoryCondition,
  Tick,
} from '@hard-vtt/shared';
import {
  getEncounterRelation,
  getEncounterSide,
  isEncounterFaction,
  isEncounterRelation,
  isEncounterSide,
  isEncounterVictoryCondition,
  normalizeEncounterFaction,
  sameEncounterSide,
} from '@hard-vtt/shared';

type Validation<T> = { ok: true; value: T } | { ok: false; code: string; reason: string };

/** Encounter allegiance and outcomes are separate from player ownership. */
export class EncounterOutcomeService {
  private relations: EncounterSideRelation[];
  private victoryCondition: EncounterVictoryCondition;
  private baselineRelations: EncounterSideRelation[];
  private baselineVictoryCondition: EncounterVictoryCondition;
  private participantSides: EncounterSide[] = [];
  private contested = false;

  public constructor(
    entities: EncounterEntity[],
    relations: EncounterSideRelation[] = [],
    victoryCondition: EncounterVictoryCondition = 'LAST_SIDE',
  ) {
    if (!isEncounterVictoryCondition(victoryCondition)) throw new Error('Invalid encounter victory condition');
    if (!Array.isArray(relations) || relations.length > 10_000) throw new Error('Invalid encounter side relations');
    this.relations = [];
    for (const pair of relations) {
      if (!pair || !isEncounterSide(pair.a) || !isEncounterSide(pair.b)
        || sameEncounterSide(pair.a, pair.b) || !isEncounterRelation(pair.relation)) {
        throw new Error('Invalid encounter side relation');
      }
      const a = this.canonicalSide(pair.a);
      const b = this.canonicalSide(pair.b);
      if (this.findRelation(a, b) !== -1) throw new Error('Duplicate encounter side relation');
      this.relations.push({ a, b, relation: pair.relation });
    }
    this.victoryCondition = victoryCondition;
    this.baselineRelations = structuredClone(this.relations);
    this.baselineVictoryCondition = victoryCondition;
    this.observe(entities);
  }

  public configuration(): { relations: EncounterSideRelation[]; victoryCondition: EncounterVictoryCondition } {
    return { relations: structuredClone(this.relations), victoryCondition: this.victoryCondition };
  }

  /** Lobby edits form the opening state; pre-start transitory sides do not count. */
  public start(entities: EncounterEntity[]): void {
    this.baselineRelations = structuredClone(this.relations);
    this.baselineVictoryCondition = this.victoryCondition;
    this.participantSides = [];
    this.contested = false;
    this.observe(entities);
  }

  public restart(entities: EncounterEntity[]): void {
    this.relations = structuredClone(this.baselineRelations);
    this.victoryCondition = this.baselineVictoryCondition;
    this.participantSides = [];
    this.contested = false;
    this.observe(entities);
  }

  public setRelation(payload: Record<string, unknown>, entities: EncounterEntity[]): Validation<void> {
    if (!isEncounterSide(payload.a) || !isEncounterSide(payload.b)
      || (payload.relation !== null && !isEncounterRelation(payload.relation))) {
      return this.invalid('阵营关系必须包含合法的双方和关系');
    }
    const a = this.canonicalSide(payload.a);
    const b = this.canonicalSide(payload.b);
    if (sameEncounterSide(a, b)) return this.invalid('同一方的内部关系固定为同盟');
    const sides = this.sides(entities);
    if (![a, b].every(side => sides.some(candidate => sameEncounterSide(candidate, side)))) {
      return this.invalid('关系双方必须存在于当前遭遇');
    }
    const index = this.findRelation(a, b);
    if (index === -1 && payload.relation !== null && this.relations.length >= 10_000) {
      return this.invalid('阵营关系数量已达上限');
    }
    if (index !== -1) this.relations.splice(index, 1);
    if (payload.relation !== null) this.relations.push({ a, b, relation: payload.relation });
    return { ok: true, value: undefined };
  }

  public setVictoryCondition(value: unknown): Validation<void> {
    if (!isEncounterVictoryCondition(value)) return this.invalid('结算条件必须为 LAST_SIDE 或 MANUAL');
    this.victoryCondition = value;
    return { ok: true, value: undefined };
  }

  /** Remember removed combatants as well as current ones, including post-start spawns. */
  public observe(entities: EncounterEntity[]): void {
    const currentSides = this.sides(entities);
    for (const side of currentSides) {
      if (!this.participantSides.some(existing => sameEncounterSide(existing, side))) this.participantSides.push(side);
    }
    if (!this.allAllied(currentSides)) this.contested = true;
  }

  public isTerminalCandidate(entities: EncounterEntity[]): boolean {
    this.observe(entities);
    return this.victoryCondition === 'LAST_SIDE' && this.contested && this.allAllied(this.survivingSides(entities));
  }

  public validateWinners(payload: Record<string, unknown>, entities: EncounterEntity[]): Validation<EncounterSide[] | undefined> {
    const hasFaction = Object.prototype.hasOwnProperty.call(payload, 'winningFaction');
    const hasSides = Object.prototype.hasOwnProperty.call(payload, 'winningSides');
    if (hasFaction && hasSides) return this.invalid('winningFaction 与 winningSides 不能同时指定');
    if (!hasFaction && !hasSides) return { ok: true, value: undefined };
    let winners: EncounterSide[];
    if (hasFaction) {
      if (!isEncounterFaction(payload.winningFaction)) return this.invalid('胜方阵营无效');
      const id = normalizeEncounterFaction(payload.winningFaction);
      if (!id) return this.invalid('独立实体必须通过 winningSides 指定');
      winners = [{ kind: 'FACTION', id }];
    } else {
      if (!Array.isArray(payload.winningSides) || payload.winningSides.length > 256
        || !payload.winningSides.every(isEncounterSide)) return this.invalid('winningSides 必须是合法参战方数组');
      winners = payload.winningSides.map(side => this.canonicalSide(side));
    }
    const known = [...this.participantSides, ...this.sides(entities)];
    for (let index = 0; index < winners.length; index++) {
      if (!known.some(side => sameEncounterSide(side, winners[index]))) return this.invalid('指定的胜方未参加本次遭遇');
      if (winners.slice(0, index).some(side => sameEncounterSide(side, winners[index]))) return this.invalid('胜方不能重复');
    }
    return { ok: true, value: winners.length > 0 ? winners : undefined };
  }

  public buildResult(
    entities: EncounterEntity[],
    tick: Tick,
    endedBy: 'RULES' | 'GM',
    reason?: string,
    declaredWinners?: EncounterSide[],
  ): EncounterResult {
    this.observe(entities);
    const winningSides = endedBy === 'RULES' ? this.survivingSides(entities) : declaredWinners;
    const legacy = this.participantSides.length === 2 && this.participantSides.every(side =>
      side.kind === 'FACTION' && (side.id === 'PLAYERS' || side.id === 'ENEMIES'));
    const winner = winningSides?.length === 1 ? winningSides[0] : undefined;
    let status: EncounterResult['status'] = 'ENDED';
    if (legacy && winner?.kind === 'FACTION') {
      status = winner.id === 'PLAYERS' ? 'VICTORY' : 'DEFEAT';
    } else if (legacy && endedBy === 'RULES' && winningSides?.length === 0) {
      status = 'MUTUAL_DEFEAT';
    }
    return {
      status,
      winningSides: winningSides ? structuredClone(winningSides) : undefined,
      winningFaction: winner?.kind === 'FACTION' ? winner.id : undefined,
      survivors: entities.filter(entity => (entity.resources.current.hp ?? 0) > 0).map(entity => entity.id),
      casualties: entities.filter(entity => (entity.resources.current.hp ?? 0) <= 0).map(entity => entity.id),
      resolvedTick: tick,
      endedBy,
      reason,
    };
  }

  private sides(entities: EncounterEntity[]): EncounterSide[] {
    const result: EncounterSide[] = [];
    for (const entity of entities) {
      if (entity.type !== 'ACTOR') continue;
      const side = getEncounterSide(entity);
      if (!result.some(existing => sameEncounterSide(existing, side))) result.push(side);
    }
    return result;
  }

  private survivingSides(entities: EncounterEntity[]): EncounterSide[] {
    return this.sides(entities.filter(entity => (entity.resources.current.hp ?? 0) > 0));
  }

  private allAllied(sides: EncounterSide[]): boolean {
    return sides.every((side, index) => sides.slice(index + 1).every(other =>
      getEncounterRelation(side, other, this.relations) === 'ALLY'));
  }

  private findRelation(a: EncounterSide, b: EncounterSide): number {
    return this.relations.findIndex(pair => (sameEncounterSide(pair.a, a) && sameEncounterSide(pair.b, b))
      || (sameEncounterSide(pair.a, b) && sameEncounterSide(pair.b, a)));
  }

  private canonicalSide(side: EncounterSide): EncounterSide {
    return { kind: side.kind, id: side.kind === 'FACTION' ? normalizeEncounterFaction(side.id)! : side.id };
  }

  private invalid(reason: string): { ok: false; code: string; reason: string } {
    return { ok: false, code: 'INVALID_PAYLOAD', reason };
  }
}
