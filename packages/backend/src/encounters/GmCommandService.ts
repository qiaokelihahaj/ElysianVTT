import type {
  AppliedEffect,
  EncounterActionPlan,
  EncounterCommand,
  EncounterControl,
  EncounterEntity,
  EncounterPrincipal,
  EncounterReadySlot,
  EncounterRulePack,
  EntityId,
  Tick,
  Vector3D,
} from '@hard-vtt/shared';
import { isEncounterFaction, normalizeEncounterFaction } from '@hard-vtt/shared';
import { CombatEngine } from '../campaigns/engines/CombatEngine.js';
import { generateId } from '../utils/IdGenerator.js';
import { validateGmCorrection } from './GmCorrectionValidation.js';
import { ActionPlanService } from './ActionPlanService.js';

export interface GmCorrectionRecord {
  id: string;
  gmUserId: string;
  reason: string;
  tick: Tick;
  entityId?: EntityId;
  actionId?: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  causationId?: string;
}

export interface GmCommandServicePort {
  readonly content: EncounterRulePack;
  readonly engine: CombatEngine;
  currentTick(): Tick;
  getEntity(entityId: EntityId): EncounterEntity | undefined;
  getControl(entityId: EntityId): EncounterControl | undefined;
  getSlot(entityId: EntityId): EncounterReadySlot | undefined;
  connectedSocketsForUser(userId: string): string[];
  syncEnginePlayerControls(): void;
  registerEntity(entity: EncounterEntity): void;
  clearEntityDecisionState(entityId: EntityId): void;
  removeEntityRegistries(entityId: EntityId): void;
  actionPlans: ActionPlanService;
  bumpState(): void;
  addLog(message: string, userId?: string, entityId?: EntityId, actionId?: string, audit?: Record<string, unknown>): void;
  isActiveAndRunning(): boolean;
  schedulePump(): void;
  refreshTerminalState(): void;
}

export type GmCommandOutcome =
  | { ok: true; message: string }
  | { ok: false; code: string; reason: string };

/**
 * Applies GM-authorized mutations and owns their audit history. Lifecycle
 * pause/end/restart remains coordinated by EncounterCoordinator itself.
 */
export class GmCommandService {
  private readonly corrections: GmCorrectionRecord[] = [];

  public constructor(private readonly port: GmCommandServicePort) {}

  public getCorrections(): GmCorrectionRecord[] {
    return this.corrections.map(record => structuredClone(record));
  }

  public adjustEntity(
    principal: EncounterPrincipal,
    command: EncounterCommand,
    payload: Record<string, unknown>,
  ): GmCommandOutcome {
    if (!this.requireGm(principal)) return this.failure('FORBIDDEN', '只有 GM 可以调整实体');
    const entityId = this.stringValue(payload.entityId);
    const entity = entityId ? this.port.getEntity(entityId) : undefined;
    const reason = this.stringValue(payload.reason);
    if (!entityId || !entity) return this.failure('UNKNOWN_ENTITY', '实体不存在');
    if (!reason) return this.failure('AUDIT_REQUIRED', '调整实体必须填写原因');
    const hasPosition = Object.prototype.hasOwnProperty.call(payload, 'position');
    const hasFacing = Object.prototype.hasOwnProperty.call(payload, 'facing');
    const hasResources = Object.prototype.hasOwnProperty.call(payload, 'resources');
    const hasEffects = Object.prototype.hasOwnProperty.call(payload, 'activeEffects');
    const hasVisibility = Object.prototype.hasOwnProperty.call(payload, 'visibility');
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const position = this.vectorValue(payload.position);
    if (hasPosition && !position) return this.failure('INVALID_PAYLOAD', 'position 必须是完整坐标');
    const facing = this.numberValue(payload.facing);
    if (hasFacing && facing === undefined) return this.failure('INVALID_PAYLOAD', 'facing 必须是有限数字');
    if (hasVisibility && payload.visibility !== 'PUBLIC' && payload.visibility !== 'GM') {
      return this.failure('INVALID_PAYLOAD', 'visibility 必须为 PUBLIC 或 GM');
    }
    const resources = hasResources && payload.resources && typeof payload.resources === 'object'
      ? payload.resources as Record<string, unknown>
      : undefined;
    if (hasResources && !resources) return this.failure('INVALID_PAYLOAD', 'resources 必须是记录');
    if (resources && Object.values(resources).some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      return this.failure('INVALID_PAYLOAD', 'resources 必须只包含有限数字');
    }
    const effects = hasEffects && Array.isArray(payload.activeEffects)
      ? payload.activeEffects as AppliedEffect[]
      : undefined;
    if (hasEffects && !effects) return this.failure('INVALID_PAYLOAD', 'activeEffects 必须是数组');
    if (position) {
      before.position = structuredClone(entity.transform.coords);
      entity.transform.coords = position;
      after.position = structuredClone(position);
    }
    if (facing !== undefined) {
      before.facing = entity.transform.facing;
      entity.transform.facing = facing;
      after.facing = facing;
    }
    if (resources) {
      before.resources = structuredClone(entity.resources.current);
      for (const [key, value] of Object.entries(resources)) entity.resources.current[key] = value as number;
      after.resources = structuredClone(entity.resources.current);
    }
    if (effects) {
      before.activeEffects = structuredClone(entity.activeEffects);
      entity.activeEffects = structuredClone(effects);
      after.activeEffects = structuredClone(entity.activeEffects);
    }
    if (hasVisibility) {
      before.visibility = entity.visibility ?? 'PUBLIC';
      entity.visibility = payload.visibility as 'PUBLIC' | 'GM';
      after.visibility = entity.visibility;
    }
    this.recordCorrection(principal.userId, reason, entityId, undefined, before, after);
    if (position) this.port.engine.notifyPositionChanged(entityId);
    this.port.bumpState();
    this.port.refreshTerminalState();
    if ((position || resources) && this.port.isActiveAndRunning()) this.port.schedulePump();
    return { ok: true, message: '实体已调整' };
  }

  public spawn(
    principal: EncounterPrincipal,
    command: EncounterCommand,
    payload: Record<string, unknown>,
  ): GmCommandOutcome {
    if (!this.requireGm(principal)) return this.failure('FORBIDDEN', '只有 GM 可以刷怪');
    const templateId = this.stringValue(payload.templateId);
    const template = templateId && Object.prototype.hasOwnProperty.call(this.port.content.actorTemplates, templateId)
      ? this.port.content.actorTemplates[templateId]
      : undefined;
    if (!templateId || !template) return this.failure('UNKNOWN_TEMPLATE', '刷怪模板不存在');
    const hasFaction = Object.prototype.hasOwnProperty.call(payload, 'faction');
    if (hasFaction && payload.faction !== null && !isEncounterFaction(payload.faction)) {
      return this.failure('INVALID_PAYLOAD', '阵营必须为有效名称或 null');
    }
    const id = this.stringValue(payload.entityId) ?? `${templateId}-${generateId()}`;
    if (this.port.getEntity(id)) return this.failure('DUPLICATE_ENTITY', '实体 ID 已存在');
    const position = this.vectorValue(payload.position) ?? { x: 0, y: 0, z: 0 };
    const clonedTemplate = structuredClone(template);
    const entity: EncounterEntity = {
      ...clonedTemplate,
      id,
      transform: { ...clonedTemplate.transform, coords: { ...position } },
      resources: {
        current: { ...clonedTemplate.resources.current },
        max: { ...clonedTemplate.resources.max },
      },
      activeEffects: [],
    };
    if (hasFaction) entity.faction = isEncounterFaction(payload.faction) ? normalizeEncounterFaction(payload.faction) : null;
    this.port.engine.mountEntities([entity]);
    this.port.registerEntity(entity);
    this.port.syncEnginePlayerControls();
    this.port.bumpState();
    this.port.addLog(`GM 刷出 ${entity.displayName ?? entity.id}。`, principal.userId, entity.id);
    return { ok: true, message: '实体已刷出' };
  }

  public remove(
    principal: EncounterPrincipal,
    command: EncounterCommand,
    payload: Record<string, unknown>,
  ): GmCommandOutcome {
    if (!this.requireGm(principal)) return this.failure('FORBIDDEN', '只有 GM 可以移除实体');
    const entityId = this.stringValue(payload.entityId);
    if (!entityId || !this.port.getEntity(entityId)) return this.failure('UNKNOWN_ENTITY', '实体不存在');
    this.port.clearEntityDecisionState(entityId);
    for (const [actorId, plan] of Array.from(this.port.actionPlans.plans.entries())) {
      if (actorId !== entityId && !plan.targetIds.includes(entityId)) continue;
      this.port.actionPlans.deletePending(actorId);
      this.port.actionPlans.remember({ ...plan, cancelled: true });
      const slot = this.port.getSlot(actorId);
      if (slot) {
        slot.ready = false;
        slot.waiting = false;
        slot.readyAtTick = undefined;
        slot.blockedReason = '目标或行动者已被 GM 移除';
      }
    }
    this.port.engine.unmountEntities([entityId]);
    this.port.removeEntityRegistries(entityId);
    this.port.syncEnginePlayerControls();
    this.port.bumpState();
    this.port.addLog(`GM 移除 ${entityId}。`, principal.userId, entityId);
    this.port.refreshTerminalState();
    return { ok: true, message: '实体已移除' };
  }

  public setFaction(
    principal: EncounterPrincipal,
    command: EncounterCommand,
    payload: Record<string, unknown>,
  ): GmCommandOutcome {
    if (!this.requireGm(principal)) return this.failure('FORBIDDEN', '只有 GM 可以设置阵营');
    const entityId = this.stringValue(payload.entityId);
    const entity = entityId ? this.port.getEntity(entityId) : undefined;
    const faction = payload.faction;
    if (!entity || !entityId) return this.failure('UNKNOWN_ENTITY', '实体不存在');
    if (faction !== null && !isEncounterFaction(faction)) {
      return this.failure('INVALID_PAYLOAD', '阵营无效');
    }
    entity.faction = normalizeEncounterFaction(faction);
    entity.tags = (entity.tags ?? []).filter(tag => !['PLAYER', 'PLAYERS', 'ENEMY', 'ENEMIES', 'NEUTRAL'].includes(tag));
    const slot = this.port.getSlot(entityId);
    if (slot) slot.faction = entity.faction;
    this.port.bumpState();
    this.port.addLog(`GM 将 ${entityId} 设置为 ${entity.faction ?? '独立'}。`, principal.userId, entityId);
    this.port.refreshTerminalState();
    if (this.port.isActiveAndRunning()) this.port.schedulePump();
    return { ok: true, message: '阵营已设置' };
  }

  public takeover(
    principal: EncounterPrincipal,
    command: EncounterCommand,
    payload: Record<string, unknown>,
    take: boolean,
  ): GmCommandOutcome {
    if (!this.requireGm(principal)) return this.failure('FORBIDDEN', '只有 GM 可以接管控制');
    const entityId = this.stringValue(payload.entityId);
    const control = entityId ? this.port.getControl(entityId) : undefined;
    if (!control || !entityId) return this.failure('UNKNOWN_ENTITY', '实体不存在');
    control.controlEpoch++;
    control.takenOverByGm = take;
    if (!take && control.userId) control.connectedSocketIds = this.port.connectedSocketsForUser(control.userId);
    this.port.syncEnginePlayerControls();
    this.port.bumpState();
    this.port.addLog(take ? `${entityId} 已由 GM 接管。` : `${entityId} 已释放回玩家。`, principal.userId, entityId);
    return { ok: true, message: take ? '已接管' : '已释放' };
  }

  public assign(
    principal: EncounterPrincipal,
    command: EncounterCommand,
    payload: Record<string, unknown>,
  ): GmCommandOutcome {
    if (!this.requireGm(principal)) return this.failure('FORBIDDEN', '只有 GM 可以分配角色');
    const entityId = this.stringValue(payload.entityId);
    const userId = this.stringValue(payload.userId);
    const control = entityId ? this.port.getControl(entityId) : undefined;
    if (!entityId || !control || !userId) return this.failure('INVALID_PAYLOAD', '缺少实体或玩家');
    control.userId = userId;
    control.role = 'PL';
    control.takenOverByGm = false;
    control.controlEpoch++;
    control.connectedSocketIds = this.port.connectedSocketsForUser(userId);
    this.port.syncEnginePlayerControls();
    const slot = this.port.getSlot(entityId);
    if (slot) {
      slot.controllerUserId = userId;
      slot.connected = control.connectedSocketIds.length > 0;
    }
    this.port.bumpState();
    this.port.addLog(`GM 将 ${entityId} 分配给 ${userId}。`, principal.userId, entityId);
    return { ok: true, message: '角色已分配' };
  }

  public correct(
    principal: EncounterPrincipal,
    command: EncounterCommand,
    payload: Record<string, unknown>,
  ): GmCommandOutcome {
    if (!this.requireGm(principal)) return this.failure('FORBIDDEN', '只有 GM 可以修正结果');
    const entityId = this.stringValue(payload.entityId);
    const reason = this.stringValue(payload.reason);
    const changes = payload.changes;
    const entity = entityId ? this.port.getEntity(entityId) : undefined;
    if (!entityId || !entity || !reason || !changes || typeof changes !== 'object') {
      return this.failure('AUDIT_REQUIRED', '修正必须填写实体、原因和变更');
    }
    const validated = validateGmCorrection(entity, changes);
    if (!validated.ok) return this.failure('INVALID_CORRECTION', validated.reason);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(validated.changes)) {
      before[path] = this.getPath(entity, path);
      this.setPath(entity, path, value);
      after[path] = this.getPath(entity, path);
    }
    const positionChanged = Object.keys(validated.changes).some(path => path.startsWith('transform.coords.'));
    if (positionChanged) this.port.engine.notifyPositionChanged(entityId);
    this.recordCorrection(principal.userId, reason, entityId, this.stringValue(payload.actionId), before, after);
    this.port.bumpState();
    this.port.refreshTerminalState();
    if (this.port.isActiveAndRunning()) this.port.schedulePump();
    return { ok: true, message: '修正已追加' };
  }

  private recordCorrection(
    gmUserId: string,
    reason: string,
    entityId: EntityId,
    actionId: string | undefined,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): void {
    const record: GmCorrectionRecord = {
      id: generateId(),
      gmUserId,
      reason,
      tick: this.port.currentTick(),
      entityId,
      actionId,
      before,
      after,
    };
    this.corrections.push(record);
    this.port.addLog(`GM 修正：${reason}`, gmUserId, entityId, actionId, { ...structuredClone(record) });
  }

  private requireGm(principal: EncounterPrincipal): boolean {
    return principal.role === 'GM';
  }

  private failure(code: string, reason: string): GmCommandOutcome {
    return { ok: false, code, reason };
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

  private getPath(object: object, path: string): unknown {
    return path.split('.').reduce<unknown>((current, key) => {
      if (!current || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[key];
    }, object);
  }

  private setPath(object: object, path: string, value: unknown): void {
    const keys = path.split('.').filter(Boolean);
    if (keys.length === 0 || keys.some(key => key === '__proto__' || key === 'constructor' || key === 'prototype')) return;
    let current = object as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) {
      const next = current[key];
      if (!next || typeof next !== 'object') current[key] = {};
      current = current[key] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]] = value;
  }
}
