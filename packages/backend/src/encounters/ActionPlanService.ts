import type {
  ActionTemplate,
  ClientIntent,
  ActionScheduledPayload,
  EncounterActionPlan,
  EncounterActionRelation,
  EncounterCommand,
  EncounterControl,
  EncounterEntity,
  EncounterPrincipal,
  EncounterReadySlot,
  EncounterRulePack,
  EntityId,
  Vector3D,
} from '@hard-vtt/shared';
import { CombatEngine } from '../campaigns/engines/CombatEngine.js';
import { RuleEvaluator } from '../core/systems/RuleEvaluator.js';
import { generateId } from '../utils/IdGenerator.js';
import { VectorMath } from '../utils/VectorMath.js';
import { SpatialActionSystem } from '../core/systems/SpatialActionSystem.js';

export interface ActionPlanServicePort {
  readonly content: EncounterRulePack;
  readonly engine: CombatEngine;
  getEntity(entityId: EntityId): EncounterEntity | undefined;
  getControl(entityId: EntityId): EncounterControl | undefined;
  getSlot(entityId: EntityId): EncounterReadySlot | undefined;
  canControl(principal: EncounterPrincipal, entityId: EntityId): boolean;
  isActionWindowOpen(command: EncounterCommand): boolean;
  getBarrierVersion(): number;
  getAction(actionTemplateId: string): ActionTemplate | undefined;
}

export type ActionValidation = { ok: true } | { ok: false; code: string; reason: string };

export type ActionPlanDeclaration =
  | { ok: true; plan: EncounterActionPlan; entity: EncounterEntity }
  | { ok: false; code: string; reason: string };

export interface LocatedActionPlan {
  plan: EncounterActionPlan;
  committed: boolean;
}

/**
 * Owns declaration plans and their authoritative history.  The coordinator
 * supplies only encounter state lookups; this service performs admission,
 * creates plans, and translates a ready barrier into engine intents.
 */
export class ActionPlanService {
  private readonly pending = new Map<EntityId, EncounterActionPlan>();
  private readonly history = new Map<string, EncounterActionPlan>();

  /** Read-only compatibility views for the coordinator's snapshot path. */
  public get plans(): ReadonlyMap<EntityId, EncounterActionPlan> {
    return this.pending;
  }

  public get planHistory(): ReadonlyMap<string, EncounterActionPlan> {
    return this.history;
  }

  public constructor(private readonly port: ActionPlanServicePort) {}

  public get size(): number {
    return this.pending.size;
  }

  public values(): IterableIterator<EncounterActionPlan> {
    return this.pending.values();
  }

  public historyValues(): IterableIterator<EncounterActionPlan> {
    return this.history.values();
  }

  public pendingFor(entityId: EntityId): EncounterActionPlan | undefined {
    return this.pending.get(entityId);
  }

  public historyFor(actionId: string): EncounterActionPlan | undefined {
    return this.history.get(actionId);
  }

  public declare(
    principal: EncounterPrincipal,
    command: EncounterCommand,
    payload: Record<string, unknown>,
  ): ActionPlanDeclaration {
    if (!this.port.isActionWindowOpen(command)) {
      return { ok: false, code: 'INVALID_STATE', reason: '当前没有可提交的行动窗口' };
    }
    const entityId = this.stringValue(payload.entityId);
    const actionTemplateId = this.stringValue(payload.actionTemplateId);
    if (!entityId || !actionTemplateId) {
      return { ok: false, code: 'INVALID_PAYLOAD', reason: '缺少实体或动作模板' };
    }
    if (principal.role !== 'GM' && (payload.priority !== undefined || payload.effectiveTick !== undefined)) {
      return { ok: false, code: 'FORBIDDEN_OVERRIDE', reason: '玩家不能覆盖动作优先级或生效 Tick' };
    }
    if (payload.priority !== undefined && this.numberValue(payload.priority) === undefined) {
      return { ok: false, code: 'INVALID_PAYLOAD', reason: 'priority 必须是有限数字' };
    }
    if (payload.effectiveTick !== undefined && this.numberValue(payload.effectiveTick) === undefined) {
      return { ok: false, code: 'INVALID_PAYLOAD', reason: 'effectiveTick 必须是有限数字' };
    }
    if (principal.role === 'GM' && payload.effectiveTick !== undefined) {
      const effectiveTick = this.numberValue(payload.effectiveTick);
      if (effectiveTick === undefined || !Number.isInteger(effectiveTick) || effectiveTick < 0) {
        return { ok: false, code: 'INVALID_PAYLOAD', reason: 'effectiveTick 必须是非负整数 Tick' };
      }
    }
    if (payload.targetIds !== undefined && !Array.isArray(payload.targetIds)) {
      return { ok: false, code: 'INVALID_PAYLOAD', reason: 'targetIds 必须是数组' };
    }
    if (Array.isArray(payload.targetIds) && payload.targetIds.some(value => typeof value !== 'string' || value.length === 0)) {
      return { ok: false, code: 'INVALID_PAYLOAD', reason: 'targetIds 只能包含实体 ID' };
    }

    const entity = this.port.getEntity(entityId);
    if (!entity || entity.type !== 'ACTOR') {
      return { ok: false, code: 'UNKNOWN_ENTITY', reason: '实体不存在' };
    }
    if (!this.port.canControl(principal, entityId)) {
      return { ok: false, code: 'FORBIDDEN', reason: '没有该实体的控制权' };
    }
    const control = this.port.getControl(entityId);
    const slot = this.port.getSlot(entityId);
    if (!control || !slot) {
      return { ok: false, code: 'UNKNOWN_ENTITY', reason: '实体不存在' };
    }
    if (command.controlEpoch !== undefined && command.controlEpoch !== control.controlEpoch) {
      return { ok: false, code: 'STALE_CONTROL', reason: '控制权版本已变化' };
    }
    if (command.expectedBarrierVersion !== undefined && command.expectedBarrierVersion !== this.port.getBarrierVersion()) {
      return { ok: false, code: 'STALE_BARRIER', reason: '行动屏障版本已变化' };
    }
    if (slot.ready) return { ok: false, code: 'ALREADY_READY', reason: '该实体已经提交本窗口行动' };
    if ((entity.resources.current.hp ?? 0) <= 0) {
      return { ok: false, code: 'ENTITY_DEAD', reason: '已倒地实体不能行动' };
    }
    if (entity.currentActionContext) return { ok: false, code: 'IN_RECOVERY', reason: '实体仍在动作或收招中' };
    if (slot.readyAtTick !== undefined && this.port.engine.currentTick < slot.readyAtTick) {
      return { ok: false, code: 'ALREADY_WAITING', reason: `该实体已等待至 Tick ${slot.readyAtTick}` };
    }

    const template = this.getAction(actionTemplateId);
    if (!template) return { ok: false, code: 'UNKNOWN_ACTION', reason: `动作模板不存在: ${actionTemplateId}` };
    if (!this.port.content.actionTemplates.some(candidate => candidate.id === actionTemplateId)) {
      return { ok: false, code: 'ACTION_NOT_ALLOWED', reason: '动作不属于当前遭遇规则包' };
    }
    if (template.tags.includes('REACTION')) {
      return { ok: false, code: 'ACTION_NOT_ALLOWED', reason: '反应动作只能在反应窗口中选择' };
    }
    if (template.spatial?.requiredWeaponId && entity.equippedWeaponId !== template.spatial.requiredWeaponId) {
      return { ok: false, code: 'WEAPON_REQUIRED', reason: `需要先装备 ${template.spatial.requiredWeaponId}` };
    }
    const targetIds = this.entityIds(payload.targetIds);
    for (const targetId of targetIds) {
      if (!this.port.getEntity(targetId)) {
        return { ok: false, code: 'UNKNOWN_TARGET', reason: `目标不存在: ${targetId}` };
      }
    }
    const targetCoords = this.vectorValue(payload.targetCoords);
    if (payload.targetCoords !== undefined && !targetCoords) {
      return { ok: false, code: 'INVALID_PAYLOAD', reason: '目标坐标必须是完整有限坐标' };
    }
    const targetError = this.validateActionTargets(principal, entity, template, targetIds, targetCoords);
    if (!targetError.ok) return targetError;
    const paidResources = this.resourceCost(template, entity);
    if (!this.canAfford(entity, paidResources)) {
      return { ok: false, code: 'INSUFFICIENT_RESOURCE', reason: '资源不足' };
    }
    const effectiveTick = this.numberValue(payload.effectiveTick);
    if (effectiveTick !== undefined && effectiveTick < this.port.engine.currentTick) {
      return { ok: false, code: 'TIME_IN_PAST', reason: '生效 Tick 不能早于当前 Tick' };
    }
    const plan: EncounterActionPlan = {
      actionId: generateId(),
      actorId: entityId,
      actionTemplateId,
      targetIds,
      targetCoords,
      phase: 'DECLARED',
      declaredTick: this.port.engine.currentTick,
      effectiveTick,
      priority: this.numberValue(payload.priority) ?? this.priority(template, entity, targetIds),
      paidResources,
      decisionVersion: 1,
      controlEpoch: control.controlEpoch,
      causationId: generateId(),
      relation: this.actionRelation(template),
      selfTarget: this.actionSelfTargets(template),
      source: principal.role === 'GM' ? 'GM' : 'PLAYER',
    };
    this.pending.set(entityId, plan);
    this.history.set(plan.actionId, structuredClone(plan));
    slot.ready = true;
    slot.waiting = false;
    slot.blockedReason = undefined;
    return { ok: true, plan, entity };
  }

  /** Declaration and GM replacement must admit the same target shape. */
  public validateActionTargets(
    principal: EncounterPrincipal,
    entity: EncounterEntity,
    template: ActionTemplate,
    targetIds: EntityId[],
    targetCoords?: Vector3D,
  ): ActionValidation {
    const targetError = this.validateTargets(principal, entity, template, targetIds);
    if (!targetError.ok) return targetError;
    if (template.targetKind === 'entity' && targetIds.length === 0) {
      return { ok: false, code: 'TARGET_REQUIRED', reason: '动作需要目标实体' };
    }
    if (template.targetKind === 'none' && (targetIds.length > 0 || targetCoords)) {
      return { ok: false, code: 'INVALID_PAYLOAD', reason: '该动作不接受目标' };
    }
    if (template.tags.includes('MOVEMENT') || template.targetKind === 'cell') {
      if (!targetCoords) return { ok: false, code: 'INVALID_PAYLOAD', reason: '落点动作必须提供完整目标坐标' };
      const moveError = this.validateMoveTarget(targetCoords, template.tags.includes('MOVEMENT'), entity);
      if (!moveError.ok) return moveError;
      if (targetIds.length > 0) return { ok: false, code: 'INVALID_PAYLOAD', reason: '落点动作不能携带目标实体' };
      const maxRange = Math.abs(RuleEvaluator.evaluate(template.range.distanceExpr, { actor: entity }).total);
      const distance = VectorMath.distance(entity.transform.coords, targetCoords);
      if (distance > maxRange || distance < (template.launchProjectile?.minRange ?? template.spatial?.reach?.minReach ?? 0)) {
        return { ok: false, code: 'OUT_OF_RANGE', reason: '目标落点超出动作有效范围或位于最小射程盲区' };
      }
    }
    return { ok: true };
  }

  public commit(slots: Iterable<EncounterReadySlot>): void {
    const intents: ClientIntent[] = [];
    const wakeTicks: number[] = [];
    for (const slot of slots) {
      const plan = this.pending.get(slot.entityId);
      if (plan) {
        intents.push({
          actorId: plan.actorId,
          intentType: this.isMovement(plan.actionTemplateId) ? 'MOVE' : 'CAST_ACTION',
          clientTick: this.port.engine.currentTick,
          payload: {
            actionId: plan.actionId,
            actionTemplateId: plan.actionTemplateId,
            targetIds: plan.targetIds,
            targetCoords: plan.targetCoords,
            priority: plan.priority,
            effectiveTick: plan.effectiveTick,
            causationId: plan.causationId,
          },
        });
      }
      if (slot.waiting && slot.readyAtTick !== undefined) wakeTicks.push(slot.readyAtTick);
    }
    intents.sort((left, right) => left.actorId.localeCompare(right.actorId));
    for (const plan of this.pending.values()) plan.phase = 'DELAY';
    this.port.engine.receiveCoordinatedIntents(intents);
    for (const tick of wakeTicks) this.port.engine.scheduleWakeTick(tick);
    this.pending.clear();
  }

  public remember(plan: EncounterActionPlan): void {
    this.history.set(plan.actionId, structuredClone(plan));
  }

  public setPending(plan: EncounterActionPlan): void {
    this.pending.set(plan.actorId, plan);
  }

  public deletePending(actorId: EntityId): void {
    this.pending.delete(actorId);
  }

  public clear(): void {
    this.pending.clear();
    this.history.clear();
  }

  public findPending(actionId: string): LocatedActionPlan | undefined {
    const pending = Array.from(this.pending.values()).find(plan => plan.actionId === actionId);
    return pending ? { plan: structuredClone(pending), committed: false } : undefined;
  }

  public locate(
    actionId: string,
    scheduledToPlan: (action: ActionScheduledPayload) => EncounterActionPlan,
  ): LocatedActionPlan | undefined {
    const pending = this.findPending(actionId);
    if (pending) return pending;
    const scheduled = this.port.engine.getScheduledActions().find(action => action.executionId === actionId);
    if (!scheduled) return undefined;
    const plan = scheduledToPlan(scheduled);
    if (plan.cancelled) return undefined;
    return { plan, committed: true };
  }

  private getAction(actionTemplateId: string): ActionTemplate | undefined {
    return this.port.getAction(actionTemplateId);
  }

  private isMovement(actionTemplateId: string): boolean {
    return this.port.content.actionTemplates.some(template =>
      template.id === actionTemplateId && template.tags.includes('MOVEMENT'),
    );
  }

  private resourceCost(template: ActionTemplate, entity: EncounterEntity): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, expression] of Object.entries(template.resourceCost ?? {})) {
      const value = Math.abs(RuleEvaluator.evaluate(expression, { actor: entity }).total);
      if (value > 0) result[key] = value;
    }
    return result;
  }

  private canAfford(entity: EncounterEntity, cost: Record<string, number>): boolean {
    return Object.entries(cost).every(([key, value]) => (entity.resources.current[key] ?? 0) >= value);
  }

  private priority(template: ActionTemplate, entity: EncounterEntity, targetIds: EntityId[]): number {
    if (!template.priorityExpr) return 0;
    const target = targetIds.length > 0 ? this.port.getEntity(targetIds[0]) : undefined;
    return RuleEvaluator.evaluate(template.priorityExpr, { actor: entity, target }).total;
  }

  private validateTargets(
    principal: EncounterPrincipal,
    actor: EncounterEntity,
    template: ActionTemplate,
    targetIds: EntityId[],
    checkCurrentRange = template.activeWindowTicks === undefined && template.strikeSequence === undefined,
  ): ActionValidation {
    const maxRange = template.range?.distanceExpr
      ? Math.abs(RuleEvaluator.evaluate(template.range.distanceExpr, { actor }).total)
      : Number.POSITIVE_INFINITY;
    for (const targetId of targetIds) {
      const target = this.port.getEntity(targetId);
      if (!target) return { ok: false, code: 'UNKNOWN_TARGET', reason: `目标不存在: ${targetId}` };
      if (principal.role !== 'GM' && target.visibility === 'GM') {
        return { ok: false, code: 'FORBIDDEN_TARGET', reason: '目标不可见' };
      }
      const distance = VectorMath.distance(actor.transform.coords, target.transform.coords);
      if (checkCurrentRange && !SpatialActionSystem.inReach(template, actor, target, maxRange)) {
        return { ok: false, code: 'OUT_OF_RANGE', reason: `目标超出动作范围（${distance.toFixed(2)} > ${maxRange}）` };
      }
    }
    return { ok: true };
  }

  private validateMoveTarget(target: Vector3D, movement = true, actor?: EncounterEntity): ActionValidation {
    const width = this.port.content.map.width;
    const height = this.port.content.map.height;
    if (target.x < 0 || target.x > width - 1 || target.y < 0 || target.y > height - 1) {
      return { ok: false, code: 'INVALID_POSITION', reason: '移动目标不在战场范围内' };
    }
    if (movement && SpatialActionSystem.mapObstacles(this.port.content.map).some(obstacle =>
      Math.hypot(obstacle.x - target.x, obstacle.y - target.y) < 0.7)) {
      return { ok: false, code: 'BLOCKED_POSITION', reason: '移动目标被墙体或障碍物占据' };
    }
    if (movement && SpatialActionSystem.isOccupiedDestination(target, this.port.engine.getAllEntities(), actor)) {
      return { ok: false, code: 'BLOCKED_POSITION', reason: '移动目标被实体占据' };
    }
    return { ok: true };
  }

  private actionRelation(template: ActionTemplate | undefined): EncounterActionRelation | undefined {
    if (!template) return undefined;
    if (template.effects.some(effect => effect.type === 'DAMAGE')) return 'ATTACK';
    if (template.effects.some(effect => effect.type === 'HEAL' && effect.parameters?.resource === 'hp')) return 'HEAL';
    if (template.effects.some(effect => effect.type === 'APPLY_BUFF' || effect.type === 'PUSH' || effect.type === 'INTERRUPT')) return 'SUPPORT';
    return undefined;
  }

  private actionSelfTargets(template: ActionTemplate | undefined): boolean {
    return this.actionRelation(template) === 'HEAL'
      && Boolean(template?.effects.some(effect => effect.type === 'HEAL' && effect.targetSelector === 'SELF'));
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private vectorValue(value: unknown): Vector3D | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number' || typeof candidate.z !== 'number') return undefined;
    if (![candidate.x, candidate.y, candidate.z].every(Number.isFinite)) return undefined;
    return { x: candidate.x, y: candidate.y, z: candidate.z };
  }

  private entityIds(value: unknown): EntityId[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }
}
