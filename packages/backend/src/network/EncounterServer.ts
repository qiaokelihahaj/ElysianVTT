import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { getEntityFaction, isEncounterFaction, isEncounterRelation, isEncounterSide, isEncounterVictoryCondition, normalizeEncounterFaction } from '@hard-vtt/shared';
import type {
  ActionTemplate,
  CommandResult,
  EncounterCommand,
  EncounterCommandResult,
  EncounterActionPlan,
  EncounterEntity,
  EncounterIncrement,
  EncounterPrincipal,
  EncounterRole,
  EncounterRulePack,
  EncounterSnapshot,
  EncounterSide,
  EncounterSideRelation,
  EncounterVictoryCondition,
  EntityId,
  MapData,
  DemoActionPreview,
  DemoActionPreviewResponse,
} from '@hard-vtt/shared';
import type {
  DemoCatalogAction,
  DemoCatalogEntry,
  DemoCatalogResponse,
  DemoAssignmentResponse,
  DemoErrorResponse,
  DemoRosterEntry,
  DemoRosterResponse,
  DemoSessionResponse,
  DemoSessionView,
  DemoSettlementResponse,
  DemoSettlementState,
  DemoSocketAuthAck,
  DemoSocketError,
  DemoSocketIncrementPayload,
  DemoSocketRosterPayload,
} from '@hard-vtt/shared';
import { EncounterCoordinator } from '../encounters/EncounterCoordinator.js';
import {
  LanSessionService,
  type LanCreatedSession,
  type LanSessionLookup,
  type LanSessionRecord,
  type LanSessionServiceOptions,
} from '../sessions/LanSessionService.js';
import type { EncounterRepository } from '../persistence/EncounterRepository.js';

const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_REQUEST_ID_LENGTH = 128;
const DEFAULT_ENCOUNTER_ID = 'elysian-encounter';

/** The concrete coordinator boundary used by the LAN server. */
export interface EncounterCoordinatorPort {
  getSnapshot(): EncounterSnapshot;
  getCatalog(): EncounterRulePack;
  /** Optional while older coordinator adapters are still supported. */
  previewAction?(principal: EncounterPrincipal, entityId: EntityId, actionTemplateId: string): DemoActionPreview;
  handleCommand(principal: EncounterPrincipal, command: EncounterCommand): CommandResult;
  connect(principal: EncounterPrincipal): EncounterSnapshot;
  disconnect(socketId: string): EncounterSnapshot;
  on?(event: string, listener: (...args: unknown[]) => void): this;
  close?(): void;
}

export interface EncounterCoordinatorFactoryOptions {
  encounterId: string;
  content: EncounterRulePack;
  entities: EncounterEntity[];
  relations?: EncounterSideRelation[];
  victoryCondition?: EncounterVictoryCondition;
}

export interface EncounterServerOptions extends LanSessionServiceOptions {
  content: EncounterRulePack;
  entities: EncounterEntity[];
  /** Owned by this server; close() also closes the repository. */
  persistence: EncounterRepository;
  encounterId?: string;
  host?: string;
  port?: number;
  frontendDist?: string;
  allowedOrigins?: string[];
  coordinatorFactory?: (options: EncounterCoordinatorFactoryOptions) => EncounterCoordinatorPort;
  /** Used by isolated tests and by an explicit restart restore. */
  initialSnapshot?: EncounterSnapshot;
}

export interface EncounterServerListenResult {
  port: number;
  url: string;
}

export interface EncounterServerHandle {
  readonly app: express.Express;
  readonly httpServer: HttpServer;
  readonly io: SocketIOServer;
  readonly coordinator: EncounterCoordinatorPort;
  readonly sessionService: LanSessionService;
  readonly persistence: EncounterRepository;
  readonly credentials: { hostCredential: string; joinCode: string };
  listen(): Promise<EncounterServerListenResult>;
  close(): Promise<void>;
  retryPersistence(): boolean;
}

interface DemoSocketData {
  accessToken: string;
  sessionId: string;
}

interface DemoSocket extends Socket {
  data: DemoSocketData;
}

interface PendingPersistence {
  kind: 'opening' | 'checkpoint' | 'settlement';
  snapshot: EncounterSnapshot;
  result?: NonNullable<EncounterSnapshot['result']>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, maxLength = 256): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function vectorValue(value: unknown): value is { x: number; y: number; z: number } {
  return isRecord(value) && finiteNumber(value.x) && finiteNumber(value.y) && finiteNumber(value.z);
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
  const token = header.slice(7).trim();
  return token.length > 0 && token.length <= 256 ? token : undefined;
}

function errorResponse(code: string, message: string, retryable = false): DemoErrorResponse {
  return { ok: false, code, message, ...(retryable ? { retryable: true } : {}) };
}

function snapshotResult(command: Pick<EncounterCommand, 'requestId'>, snapshot: EncounterSnapshot, code: string, reason: string): EncounterCommandResult {
  return {
    ok: false,
    success: false,
    requestId: command.requestId,
    revision: snapshot.revision,
    code,
    reason,
    snapshot,
  };
}

function toSessionView(service: LanSessionService, session: LanSessionRecord): DemoSessionView {
  return service.getView(session);
}

function isHiddenEntity(entity: EncounterEntity): boolean {
  return entity.tags?.includes('HIDDEN') === true || entity.tags?.includes('INVISIBLE') === true || (entity as EncounterEntity & { visibility?: string }).visibility === 'GM';
}

function ownOrPublicEntityIds(snapshot: EncounterSnapshot, session: LanSessionRecord): Set<string> {
  const visible = new Set(session.controlledEntityIds);
  for (const entity of snapshot.entities) {
    const sourceId = entity.type === 'PROJECTILE'
      ? (entity as EncounterEntity & { sourceEntityId?: string }).sourceEntityId : undefined;
    const source = sourceId ? snapshot.entities.find(candidate => candidate.id === sourceId) : undefined;
    if (source && isHiddenEntity(source) && !session.controlledEntityIds.has(source.id)) continue;
    if (!isHiddenEntity(entity)) visible.add(entity.id);
  }
  return visible;
}

function filterEntityForPlayer(entity: EncounterEntity, visibleIds: Set<string>): EncounterEntity {
  if (entity.type === 'PROJECTILE') {
    // Custom/legacy coordinator adapters may return an enumerable runtime
    // Projectile. Only current visible geometry belongs on the wire.
    return {
      id: entity.id, templateId: 'projectile', type: 'PROJECTILE', displayName: '投射物', visibility: 'PUBLIC',
      transform: structuredClone(entity.transform), physics: structuredClone(entity.physics),
      resources: structuredClone(entity.resources), activeEffects: [],
    };
  }
  const filtered = structuredClone(entity);
  // Effects and formation zones carry entity ids below the top-level action
  // boundary. Drop references whose source/owner is hidden rather than
  // relying on a client to understand that an id is unusable.
  filtered.activeEffects = filtered.activeEffects.filter(effect => visibleIds.has(effect.sourceEntityId) || effect.sourceEntityId === filtered.id);
  if (filtered.formationContext?.blockZones) {
    filtered.formationContext.blockZones = filtered.formationContext.blockZones.filter(zone => visibleIds.has(zone.ownerId));
  }
  // Movement waypoints are an internal pathfinding detail.  Keeping them in
  // currentActionContext would disclose an unseen destination even when the
  // corresponding action relation was filtered below.  The map overlay uses
  // the authoritative current position plus the action's public endpoint.
  if (filtered.currentActionContext) {
    // Action ids/templates are duplicated by the recipient-filtered action
    // list.  Keeping a template on an entity would disclose a foreign plan
    // through a second path, especially while its target relation is hidden.
    delete filtered.currentActionContext.actionTemplateId;
    delete filtered.currentActionContext.waypoints;
    delete filtered.currentActionContext.currentWaypointIndex;
    // The engine keeps target and hit ledgers to support event-driven ACTIVE
    // windows.  They are GM/runtime data; exposing ids here would reveal a
    // hidden target through the entity payload even when the action shell was
    // already redacted below.
    delete filtered.currentActionContext.activeTargetIds;
    delete filtered.currentActionContext.activeHitTargetIds;
  }
  return filtered;
}

function encounterFaction(entity: EncounterEntity): string | undefined {
  return getEntityFaction(entity) ?? undefined;
}

function playerFactions(snapshot: EncounterSnapshot, session: LanSessionRecord): Set<string> {
  return new Set(snapshot.entities
    .filter(entity => session.controlledEntityIds.has(entity.id))
    .map(encounterFaction)
    .filter((faction): faction is string => faction !== undefined));
}

function actionIsBeforeStartup(action: EncounterActionPlan): boolean {
  return action.phase === 'DECLARED' || action.phase === 'DELAY';
}

/**
 * Filter one action at the transport boundary.  A player may coordinate with
 * their own faction during the declaration barrier.  Once an action has
 * entered STARTUP, a relation is public only when every entity endpoint is
 * visible to that recipient.  An action shell may remain for a visible actor
 * so its busy state is accurate, but hidden target ids and relation hints are
 * removed together.
 */
function filterActionForPlayer(
  action: EncounterActionPlan,
  snapshot: EncounterSnapshot,
  visibleIds: Set<string>,
  owned: Set<string>,
  factions: Set<string>,
): EncounterActionPlan | undefined {
  const actor = snapshot.entities.find(entity => entity.id === action.actorId);
  if (!actor || !visibleIds.has(actor.id)) return undefined;
  const actorIsOurs = owned.has(actor.id) || (encounterFaction(actor) !== undefined && factions.has(encounterFaction(actor)!));
  if (actionIsBeforeStartup(action) && !actorIsOurs) return undefined;

  const originalTargetIds = action.targetIds;
  const targetIds = originalTargetIds.filter(targetId => visibleIds.has(targetId));
  const allTargetsVisible = targetIds.length === originalTargetIds.length;
  const filtered: EncounterActionPlan = { ...action, targetIds };

  // A pending plan is only shared inside the acting faction.  Movement target
  // coordinates are part of that plan and therefore follow the same rule.
  if (actionIsBeforeStartup(action) && !actorIsOurs) delete filtered.targetCoords;
  if (!allTargetsVisible) {
    // Do not leave a relation/type hint that would let a client infer an
    // unseen endpoint.  The visible actor action itself remains as a status
    // shell for post-STARTUP synchronization.
    delete filtered.relation;
    if (originalTargetIds.length > 0) {
      // A multi-target action must not leave a visible subset that can be
      // paired with a client-side template fallback to infer hidden targets.
      filtered.targetIds = [];
      delete filtered.targetCoords;
    }
  }
  return filtered;
}

function filterActionsForPlayer(
  actions: EncounterActionPlan[],
  snapshot: EncounterSnapshot,
  session: LanSessionRecord,
  visibleIds: Set<string>,
): EncounterActionPlan[] {
  const owned = new Set(session.controlledEntityIds);
  const factions = playerFactions(snapshot, session);
  return actions
    .map(action => filterActionForPlayer(action, snapshot, visibleIds, owned, factions))
    .filter((action): action is EncounterActionPlan => action !== undefined);
}

/**
 * Apply recipient visibility at the last boundary. A PL payload contains no
 * hidden entities/actions/causation metadata and no other user's identity or
 * socket identifier.
 */
export function filterEncounterSnapshot(snapshot: EncounterSnapshot, session: LanSessionRecord): EncounterSnapshot {
  const cloned = structuredClone(snapshot);
  cloned.serverTime = Date.now();
  if (session.role === 'GM') return cloned;

  const owned = new Set(session.controlledEntityIds);
  const visibleIds = ownOrPublicEntityIds(cloned, session);
  const factions = playerFactions(cloned, session);
  const visibleFactions = new Set(cloned.entities.filter(entity => visibleIds.has(entity.id)).map(encounterFaction)
    .filter((faction): faction is string => faction !== undefined));
  const hiddenFactions = new Set(cloned.entities.filter(entity => !visibleIds.has(entity.id)).map(encounterFaction)
    .filter((faction): faction is string => faction !== undefined && !visibleFactions.has(faction)));
  const sideIsVisible = (side: EncounterSide): boolean => side.kind === 'ENTITY'
    ? visibleIds.has(side.id)
    : visibleFactions.has(normalizeEncounterFaction(side.id) ?? '');
  if (cloned.relations !== undefined) {
    cloned.relations = cloned.relations.filter(pair => sideIsVisible(pair.a) && sideIsVisible(pair.b));
  }
  const actionBelongsToPlayer = (action: EncounterActionPlan): boolean => {
    const actor = cloned.entities.find(entity => entity.id === action.actorId);
    return Boolean(actor && (owned.has(actor.id) || (encounterFaction(actor) !== undefined && factions.has(encounterFaction(actor)!))));
  };
  // A submission log is allowed to mention its template only while the
  // corresponding DECLARED/DELAY action is still an unauthorized plan. Once
  // an action has entered execution (or disappeared after settlement), its
  // historical log remains in the feed and is sanitized below instead of
  // being mistaken for an active visibility marker.
  const hiddenPendingActionIds = new Set([
    ...cloned.actions,
    ...cloned.plan.actions,
  ]
    .filter(action => actionIsBeforeStartup(action) && !actionBelongsToPlayer(action))
    .map(action => action.actionId));
  cloned.entities = cloned.entities
    .filter(entity => visibleIds.has(entity.id))
    .map(entity => filterEntityForPlayer(entity, visibleIds));
  cloned.actions = filterActionsForPlayer(cloned.actions, cloned, session, visibleIds);
  cloned.plan = {
    ...cloned.plan,
    slots: cloned.plan.slots
      .filter(slot => visibleIds.has(slot.entityId))
      .map(slot => ({
        ...slot,
        ...(owned.has(slot.entityId) ? {} : { controllerUserId: undefined }),
      })),
    actions: filterActionsForPlayer(cloned.plan.actions, cloned, session, visibleIds),
  };
  const ownedEntityIds = new Set(session.controlledEntityIds);
  const actorIsOurs = (actorId: string | undefined): boolean => {
    if (!actorId) return false;
    const actor = cloned.entities.find(entity => entity.id === actorId);
    return Boolean(actor && (ownedEntityIds.has(actor.id) || (encounterFaction(actor) !== undefined && factions.has(encounterFaction(actor)!))));
  };
  cloned.decisions = cloned.decisions
    .filter(decision => owned.has(decision.reactorEntityId))
    .map(decision => ({
      ...decision,
      sourceActionId: visibleIds.has(decision.sourceEntityId) ? decision.sourceActionId : '',
      sourceEntityId: visibleIds.has(decision.sourceEntityId) ? decision.sourceEntityId : '',
      respondedSocketIds: [],
      causationId: visibleIds.has(decision.sourceEntityId) ? decision.causationId : '',
    }));
  if (cloned.result) {
    const result = cloned.result;
    result.survivors = result.survivors.filter(id => visibleIds.has(id));
    result.casualties = result.casualties.filter(id => visibleIds.has(id));
    if (result.winningSides !== undefined) result.winningSides = result.winningSides.filter(sideIsVisible);
    if (result.winningFaction !== undefined && !sideIsVisible({ kind: 'FACTION', id: result.winningFaction })) delete result.winningFaction;
    const resultReason = result.reason;
    if (resultReason !== undefined && (snapshot.entities.some(entity =>
      isHiddenEntity(entity)
      && !visibleIds.has(entity.id)
      && (resultReason.includes(entity.id) || (entity.displayName !== undefined && resultReason.includes(entity.displayName))),
    ) || [...hiddenFactions].some(faction => resultReason.includes(faction)))) {
      result.reason = '遭遇已结算';
    }
  }
  cloned.controls = cloned.controls
    .filter(control => visibleIds.has(control.entityId))
    .map(control => ({
      ...control,
      userId: control.userId === session.userId ? control.userId : undefined,
      connectedSocketIds: [],
    }));
  cloned.logs = cloned.logs
    .filter(log => log.visibility === undefined || log.visibility === 'PLAYER')
    .filter(log => log.actorId === undefined || visibleIds.has(log.actorId))
    .filter(log => !log.actionId || !hiddenPendingActionIds.has(log.actionId))
    .map(log => {
      const actorOwned = log.actorId !== undefined && owned.has(log.actorId);
      const actorInOwnFaction = actorIsOurs(log.actorId);
      const mentionsHiddenEntity = snapshot.entities.some(entity =>
        isHiddenEntity(entity)
        && !visibleIds.has(entity.id)
        && (log.message.includes(entity.id) || (entity.displayName !== undefined && log.message.includes(entity.displayName))),
      );
      return {
        id: log.id,
        tick: log.tick,
        message: !actorInOwnFaction || mentionsHiddenEntity ? '战斗日志已更新' : log.message,
        ...(log.level === undefined ? {} : { level: log.level }),
        ...(log.visibility === undefined ? {} : { visibility: log.visibility }),
        ...(actorOwned && actorInOwnFaction ? { actorId: log.actorId } : {}),
        ...(actorOwned && actorInOwnFaction && log.actionId !== undefined ? { actionId: log.actionId } : {}),
        ...(actorOwned && actorInOwnFaction && log.causationId !== undefined ? { causationId: log.causationId } : {}),
      };
    });
  return cloned;
}

function isCommandType(value: unknown): value is EncounterCommand['type'] {
  return typeof value === 'string' && new Set([
    'START', 'WAIT', 'ACTION', 'RECOVER', 'REACTION_JOIN', 'REACTION_SELECT', 'REACTION_PASS',
    'GM_PAUSE', 'GM_RESUME', 'GM_STEP', 'GM_TICK_BREAK', 'GM_TAKEOVER',
    'GM_RELEASE', 'GM_ASSIGN_ENTITY', 'GM_EDIT_ACTION', 'GM_ADJUST_ENTITY', 'GM_SPAWN',
    'GM_REMOVE', 'GM_SET_FACTION', 'GM_SET_RELATION', 'GM_SET_VICTORY_CONDITION', 'GM_CORRECT', 'GM_PASS', 'GM_PASS_ALL',
    'GM_END', 'GM_RESTART', 'CANCEL_ACTION', 'GM_CANCEL_ACTION',
  ]).has(value);
}

function validatePayloadForType(type: EncounterCommand['type'], payload: Record<string, unknown>): boolean {
  const entityId = payload.entityId;
  switch (type) {
    case 'START':
      return entityId === undefined || stringValue(entityId, 128) !== undefined;
    case 'WAIT':
      return stringValue(entityId, 128) !== undefined;
    case 'ACTION':
      return stringValue(entityId, 128) !== undefined
        && stringValue(payload.actionTemplateId, 128) !== undefined
        && (payload.targetIds === undefined || (Array.isArray(payload.targetIds) && payload.targetIds.every(item => stringValue(item, 128) !== undefined)))
        && (payload.targetCoords === undefined || vectorValue(payload.targetCoords))
        && (payload.priority === undefined || finiteNumber(payload.priority))
        && (payload.effectiveTick === undefined || finiteNumber(payload.effectiveTick));
    case 'RECOVER':
      return stringValue(entityId, 128) !== undefined && (payload.resource === undefined || stringValue(payload.resource, 64) !== undefined);
    case 'REACTION_JOIN':
      return stringValue(payload.windowId, 128) !== undefined;
    case 'REACTION_SELECT':
      return stringValue(payload.windowId, 128) !== undefined && (payload.optionId === null || stringValue(payload.optionId, 128) !== undefined)
        && (payload.targetIds === undefined || (Array.isArray(payload.targetIds) && payload.targetIds.every(item => stringValue(item, 128) !== undefined)))
        && (payload.targetCoords === undefined || vectorValue(payload.targetCoords));
    case 'REACTION_PASS':
      return stringValue(payload.windowId, 128) !== undefined;
    case 'GM_PAUSE':
      return payload.reason === undefined || stringValue(payload.reason, 512) !== undefined;
    case 'GM_RESUME':
    case 'GM_PASS_ALL':
    case 'GM_RESTART':
      return Object.keys(payload).length === 0;
    case 'GM_STEP':
    case 'GM_TICK_BREAK':
      return payload.count === undefined || (finiteNumber(payload.count) && Number.isInteger(payload.count) && payload.count > 0 && payload.count <= 1000);
    case 'GM_TAKEOVER':
    case 'GM_RELEASE':
    case 'GM_ASSIGN_ENTITY':
    case 'GM_REMOVE':
      return stringValue(entityId, 128) !== undefined
        && (type !== 'GM_ASSIGN_ENTITY' || stringValue(payload.userId, 128) !== undefined);
    case 'CANCEL_ACTION':
    case 'GM_CANCEL_ACTION':
      return stringValue(payload.actionId, 128) !== undefined
        && (payload.reason === undefined || stringValue(payload.reason, 1000) !== undefined);
    case 'GM_EDIT_ACTION':
      return stringValue(payload.actionId, 128) !== undefined
        && (payload.reason === undefined || stringValue(payload.reason, 1000) !== undefined)
        && (payload.targetIds === undefined || (Array.isArray(payload.targetIds) && payload.targetIds.every(item => stringValue(item, 128) !== undefined)))
        && (payload.targetCoords === undefined || vectorValue(payload.targetCoords))
        && (payload.effectiveTick === undefined || finiteNumber(payload.effectiveTick))
        && (payload.priority === undefined || finiteNumber(payload.priority))
        && (payload.actionTemplateId === undefined || stringValue(payload.actionTemplateId, 128) !== undefined)
        && (payload.cancel === undefined || typeof payload.cancel === 'boolean');
    case 'GM_ADJUST_ENTITY':
      return stringValue(entityId, 128) !== undefined
        && stringValue(payload.reason, 1000) !== undefined
        && (payload.position === undefined || vectorValue(payload.position))
        && (payload.facing === undefined || finiteNumber(payload.facing))
        && (payload.resources === undefined || (isRecord(payload.resources) && Object.values(payload.resources).every(finiteNumber)))
        && (payload.activeEffects === undefined || (Array.isArray(payload.activeEffects) && payload.activeEffects.every(effect =>
          isRecord(effect)
          && stringValue(effect.instanceId, 128) !== undefined
          && stringValue(effect.templateId, 128) !== undefined
          && stringValue(effect.sourceEntityId, 128) !== undefined
          && finiteNumber(effect.remainingTicks)
          && finiteNumber(effect.stacks),
        )))
        && (payload.visibility === undefined || payload.visibility === 'PUBLIC' || payload.visibility === 'GM');
    case 'GM_SPAWN':
      return stringValue(payload.templateId, 128) !== undefined
        && (payload.entityId === undefined || stringValue(payload.entityId, 128) !== undefined)
        && (payload.position === undefined || vectorValue(payload.position))
        && (payload.faction === undefined || payload.faction === null || isEncounterFaction(payload.faction));
    case 'GM_SET_FACTION':
      return stringValue(entityId, 128) !== undefined && (payload.faction === null || isEncounterFaction(payload.faction));
    case 'GM_SET_RELATION':
      return isEncounterSide(payload.a) && isEncounterSide(payload.b)
        && (payload.relation === null || isEncounterRelation(payload.relation));
    case 'GM_SET_VICTORY_CONDITION':
      return isEncounterVictoryCondition(payload.condition);
    case 'GM_CORRECT':
      return stringValue(entityId, 128) !== undefined && stringValue(payload.reason, 1000) !== undefined && isRecord(payload.changes)
        && (payload.actionId === undefined || stringValue(payload.actionId, 128) !== undefined);
    case 'GM_PASS':
      return stringValue(payload.windowId, 128) !== undefined;
    case 'GM_END':
      return (payload.reason === undefined || stringValue(payload.reason, 1000) !== undefined)
        && (payload.winningFaction === undefined || isEncounterFaction(payload.winningFaction))
        && (payload.winningSides === undefined || (Array.isArray(payload.winningSides) && payload.winningSides.length <= 1000 && payload.winningSides.every(isEncounterSide)));
    default:
      return false;
  }
}

function parseCommand(input: unknown): EncounterCommand | undefined {
  if (!isRecord(input) || !stringValue(input.requestId, MAX_REQUEST_ID_LENGTH) || !isCommandType(input.type) || !isRecord(input.payload)) return undefined;
  if (input.expectedRevision !== undefined && (!finiteNumber(input.expectedRevision) || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)) return undefined;
  if (input.expectedBarrierVersion !== undefined && (!finiteNumber(input.expectedBarrierVersion) || !Number.isInteger(input.expectedBarrierVersion) || input.expectedBarrierVersion < 0)) return undefined;
  if (input.expectedDecisionVersion !== undefined && (!finiteNumber(input.expectedDecisionVersion) || !Number.isInteger(input.expectedDecisionVersion) || input.expectedDecisionVersion < 0)) return undefined;
  if (input.controlEpoch !== undefined && (!finiteNumber(input.controlEpoch) || !Number.isInteger(input.controlEpoch) || input.controlEpoch < 0)) return undefined;
  if (!validatePayloadForType(input.type, input.payload)) return undefined;
  return input as unknown as EncounterCommand;
}

function catalogAction(template: ActionTemplate): DemoCatalogAction {
  const area = template.effects.find(effect => effect.targetSelector === 'ALL_IN_AOE')?.parameters;
  const shape = area?.aoeShape;
  const radius = area?.aoeRadius;
  const aoe: DemoCatalogAction['aoe'] = (shape === 'CIRCULAR' || shape === 'CONICAL' || shape === 'LINEAR')
    && typeof radius === 'number' && Number.isFinite(radius) && radius > 0
    ? { shape, radius,
      ...(typeof area?.aoeAngle === 'number' ? { angle: area.aoeAngle } : {}),
      ...(typeof area?.aoeWidth === 'number' ? { width: area.aoeWidth } : {}),
    } : undefined;
  return {
    id: template.id,
    label: template.label ?? template.id,
    tags: [...template.tags],
    startupTicks: template.timeCost.startupTicks,
    recoveryTicks: template.timeCost.recoveryTicks,
    resourceCost: { ...template.resourceCost },
    ...(template.description ? { description: template.description } : {}),
    ...(template.targetKind ? { targetKind: template.targetKind } : {}),
    ...(template.spatial ? { spatial: structuredClone(template.spatial) } : {}),
    range: structuredClone(template.range),
    ...(template.launchProjectile ? { launchProjectile: structuredClone(template.launchProjectile) } : {}),
    ...(aoe ? { aoe } : {}),
  };
}

function cloneCatalogMap(rulePack: EncounterRulePack): MapData {
  return structuredClone(rulePack.map);
}

export class EncounterServerImpl implements EncounterServerHandle {
  public readonly app: express.Express;
  public readonly httpServer: HttpServer;
  public readonly io: SocketIOServer;
  public readonly coordinator: EncounterCoordinatorPort;
  public readonly sessionService: LanSessionService;
  public readonly persistence: EncounterRepository;
  public readonly credentials: { hostCredential: string; joinCode: string };

  private readonly encounterId: string;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly frontendDist?: string;
  private readonly rulePack: EncounterRulePack;
  private readonly commandCache = new Map<string, { result: CommandResult; at: number }>();
  private pendingPersistence?: PendingPersistence;
  private settlementState: DemoSettlementState = { status: 'saved', retryable: false };
  private lastPersistedSettlementKey?: string;
  /** Stable identity for one START→settlement run; reconnect revisions are not runs. */
  private settlementRunId?: string;
  private listening = false;
  private closed = false;

  constructor(options: EncounterServerOptions) {
    this.encounterId = options.encounterId ?? DEFAULT_ENCOUNTER_ID;
    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port ?? 3000;
    this.frontendDist = options.frontendDist ?? resolve(process.cwd(), 'packages/frontend/dist');
    this.sessionService = new LanSessionService(options);
    this.persistence = options.persistence;
    this.rulePack = options.content;

    const stored = this.persistence.load(this.encounterId);
    if (this.persistence.lastLoadError) {
      throw new Error(`DEMO_PERSISTENCE_CORRUPT: ${this.persistence.lastLoadError}`);
    }
    if (stored?.result) {
      this.settlementState = { status: 'saved', retryable: false, updatedAt: stored.updatedAt };
      this.lastPersistedSettlementKey = this.settlementKey(stored.latestSnapshot, stored.result);
    }
    const factory = options.coordinatorFactory ?? ((factoryOptions: EncounterCoordinatorFactoryOptions): EncounterCoordinatorPort => new EncounterCoordinator(factoryOptions));
    const openingSnapshot = options.initialSnapshot ?? stored?.openingSnapshot;
    this.coordinator = factory({
      encounterId: this.encounterId,
      content: this.rulePack,
      entities: openingSnapshot?.entities ?? options.entities,
      relations: openingSnapshot?.relations,
      victoryCondition: openingSnapshot?.victoryCondition,
    });
    try {
      if (!stored && !options.initialSnapshot) {
        const opening = this.persistence.saveOpeningSnapshot(this.coordinator.getSnapshot());
        if (!opening.ok) throw new Error(`DEMO_PERSISTENCE_FAILED: ${opening.message ?? '无法保存开局快照'}`);
      }
    } catch (error) {
      this.coordinator.close?.();
      this.sessionService.clear();
      throw error;
    }

    this.app = express();
    // Same-origin browsers need no CORS middleware.  Explicit development
    // origins opt into the narrow allowlist; requests without an Origin (CLI,
    // native clients and tests) remain usable in either mode.
    if (options.allowedOrigins?.length) {
      this.app.use(cors({ origin: options.allowedOrigins, credentials: false }));
    }
    this.app.use(express.json({ limit: MAX_COMMAND_BYTES }));
    this.app.get('/health', (_req, res) => res.json({ ok: true, service: 'elysian-demo', encounterId: this.encounterId }));
    this.installRoutes();
    if (this.frontendDist && existsSync(this.frontendDist)) {
      this.app.use(express.static(this.frontendDist));
      this.app.get(/^(?!\/api\/demo|\/health).*/, (_req, res) => {
        res.sendFile(resolve(this.frontendDist!, 'index.html'), error => {
          if (error && !res.headersSent) res.status(404).json(errorResponse('NOT_FOUND', '页面不存在'));
        });
      });
    }
    this.app.use((error: unknown, _req: Request, res: Response, next: NextFunction): void => {
      if (isRecord(error) && error.type === 'entity.too.large') {
        res.status(413).json(errorResponse('COMMAND_TOO_LARGE', '请求超过大小限制'));
        return;
      }
      if (error instanceof SyntaxError) {
        res.status(400).json(errorResponse('INVALID_JSON', '请求 JSON 格式无效'));
        return;
      }
      next(error);
    });
    this.app.use((_req, res) => res.status(404).json(errorResponse('NOT_FOUND', '资源不存在')));

    this.httpServer = createServer(this.app);
    this.io = new SocketIOServer(this.httpServer, {
      ...(options.allowedOrigins?.length ? {
        cors: {
          origin: options.allowedOrigins,
          methods: ['GET', 'POST'],
          credentials: false,
        },
      } : {}),
      maxHttpBufferSize: MAX_COMMAND_BYTES,
    });
    this.credentials = this.sessionService.credentials;
    this.wireSessionService();
    this.installSocketHandlers();
    this.wireCoordinator();
  }

  async listen(): Promise<EncounterServerListenResult> {
    if (this.closed) throw new Error('Demo server is closed');
    if (this.listening) {
      const address = this.httpServer.address();
      const port = typeof address === 'object' && address ? address.port : this.requestedPort;
      return { port, url: this.makeUrl(port) };
    }
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => {
        this.httpServer.off('listening', onListening);
        rejectListen(error);
      };
      const onListening = (): void => {
        this.httpServer.off('error', onError);
        resolveListen();
      };
      this.httpServer.once('error', onError);
      this.httpServer.once('listening', onListening);
      this.httpServer.listen(this.requestedPort, this.host);
    });
    this.listening = true;
    const address = this.httpServer.address() as AddressInfo;
    return { port: address.port, url: this.makeUrl(address.port) };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.io.sockets.sockets.values()) socket.disconnect(true);
    await new Promise<void>(resolveClose => {
      if (!this.listening) {
        resolveClose();
        return;
      }
      this.httpServer.close(() => resolveClose());
    });
    this.coordinator.close?.();
    this.io.close();
    this.sessionService.clear();
    this.persistence.close();
    this.listening = false;
  }

  retryPersistence(): boolean {
    if (!this.pendingPersistence) {
      this.settlementState = { status: 'saved', retryable: false, updatedAt: Date.now() };
      return true;
    }
    const pending = this.pendingPersistence;
    this.settlementState = { status: 'pending', retryable: true, updatedAt: Date.now() };
    const runId = pending.kind === 'settlement'
      ? (this.settlementRunId ?? (this.settlementRunId = randomUUID()))
      : undefined;
    const result = pending.kind === 'opening'
      ? this.persistence.saveOpeningSnapshot(pending.snapshot)
      : pending.kind === 'settlement' && pending.result
        ? this.persistence.saveSettlement(pending.snapshot, pending.result, runId)
        : this.persistence.saveCheckpoint(pending.snapshot);
    if (result.ok) {
      this.pendingPersistence = undefined;
      this.settlementState = { status: 'saved', retryable: false, updatedAt: Date.now() };
      this.broadcastRoster();
      return true;
    }
    this.settlementState = {
      status: 'failed',
      retryable: true,
      message: result.message ?? '无法写入 Demo 存档',
      updatedAt: Date.now(),
    };
    return false;
  }

  private installRoutes(): void {
    const hostHandler = (req: Request, res: Response): void => {
      const body: Record<string, unknown> = isRecord(req.body) ? req.body : {};
      const credential = stringValue(body.credential, 256) ?? bearerToken(req);
      const created = credential ? this.sessionService.createHostSession(credential, stringValue(body.displayName, 128)) : null;
      if (!created) {
        res.status(401).json(errorResponse('HOST_AUTH_FAILED', '主持凭据无效'));
        return;
      }
      res.json(this.sessionResponse(created));
    };
    const joinHandler = (req: Request, res: Response): void => {
      const body: Record<string, unknown> = isRecord(req.body) ? req.body : {};
      const joinCode = stringValue(body.joinCode, 128);
      const created = joinCode ? this.sessionService.joinPlayer(joinCode, stringValue(body.displayName, 128)) : null;
      if (!created) {
        res.status(403).json(errorResponse('JOIN_FAILED', '房间码无效、房间已满或会话已关闭'));
        return;
      }
      res.json(this.sessionResponse(created));
      this.broadcastRoster();
    };
    const sessionHandler = (req: Request, res: Response): void => {
      const authenticated = this.requireHttpSession(req, res);
      if (!authenticated) return;
      res.json(this.sessionResponse({ accessToken: '', session: authenticated }));
    };
    const rosterHandler = (req: Request, res: Response): void => {
      const authenticated = this.requireHttpSession(req, res);
      if (!authenticated) return;
      const response: DemoRosterResponse = {
        ok: true,
        data: {
          encounterId: this.encounterId,
            entries: this.sessionService.getRoster(authenticated),
            snapshot: filterEncounterSnapshot(this.coordinator.getSnapshot(), authenticated),
            settlement: this.getSettlementState(),
        },
      };
      res.json(response);
    };
    const assignHandler = (req: Request, res: Response): void => {
      const gm = this.requireHttpSession(req, res);
      if (!gm) return;
      if (gm.role !== 'GM') {
        res.status(403).json(errorResponse('FORBIDDEN', '只有 GM 可以分配角色'));
        return;
      }
      const body = isRecord(req.body) ? req.body : {};
      const userId = stringValue(body.userId, 128);
      const entityId = stringValue(body.entityId, 128);
      const entityExists = entityId ? this.coordinator.getSnapshot().entities.some(entity => entity.id === entityId) : false;
      const playerExists = userId ? this.sessionService.getSessions().some(session => session.role === 'PL' && session.userId === userId) : false;
      if (!userId || !entityId || !entityExists || !playerExists) {
        res.status(400).json(errorResponse('ASSIGNMENT_INVALID', '玩家或实体不存在'));
        return;
      }
      const assignment: EncounterCommand = {
        requestId: `http-${randomUUID()}`,
        expectedRevision: this.coordinator.getSnapshot().revision,
        type: 'GM_ASSIGN_ENTITY',
        payload: { entityId, userId },
      } as EncounterCommand;
      const assignmentResult = this.coordinator.handleCommand(
        { userId: gm.userId, role: gm.role, socketId: 'http-gm' },
        assignment,
      );
      if (!assignmentResult.ok) {
        res.status(400).json(this.filterCommandResult(assignmentResult, gm));
        return;
      }
      if (!this.sessionService.assignEntity(userId, entityId)) {
        res.status(400).json(errorResponse('ASSIGNMENT_INVALID', '玩家会话已失效'));
        return;
      }
      this.broadcastRoster();
      this.broadcastSnapshot();
      const response: DemoAssignmentResponse = {
        ok: true,
        data: {
          entries: this.sessionService.getRoster(gm),
          snapshot: filterEncounterSnapshot(this.coordinator.getSnapshot(), gm),
          assignedUserId: userId,
          entityId,
          settlement: this.getSettlementState(),
        },
      };
      res.json(response);
    };
    const settlementStatusHandler = (req: Request, res: Response): void => {
      const session = this.requireHttpSession(req, res);
      if (!session) return;
      const response: DemoSettlementResponse = { ok: true, data: this.getSettlementState() };
      res.json(response);
    };
    const settlementRetryHandler = (req: Request, res: Response): void => {
      const session = this.requireHttpSession(req, res);
      if (!session) return;
      if (session.role !== 'GM') {
        res.status(403).json(errorResponse('FORBIDDEN', '只有 GM 可以重试存档'));
        return;
      }
      const succeeded = this.retryPersistence();
      const response: DemoSettlementResponse = { ok: true, data: this.getSettlementState() };
      res.status(succeeded ? 200 : 503).json(response);
    };
    const logoutHandler = (req: Request, res: Response): void => {
      const token = bearerToken(req);
      const result = this.sessionService.logout(token);
      if (!result.ok) {
        res.status(401).json(errorResponse(result.code, result.message));
        return;
      }
      res.json({ ok: true });
      this.broadcastRoster();
    };
    const catalogHandler = (req: Request, res: Response): void => {
      const session = this.requireHttpSession(req, res);
      if (!session) return;
      res.json(this.catalogResponse(session));
    };
    const actionPreviewHandler = (req: Request, res: Response): void => {
      const session = this.requireHttpSession(req, res);
      if (!session) return;
      if (typeof this.coordinator.previewAction !== 'function') {
        res.status(501).json(errorResponse('PREVIEW_UNSUPPORTED', '当前 Demo 服务不支持动作目标预览'));
        return;
      }
      const body = isRecord(req.body) ? req.body : {};
      const entityId = stringValue(body.entityId, 128);
      const actionTemplateId = stringValue(body.actionTemplateId, 128);
      if (!entityId || !actionTemplateId) {
        res.status(400).json(errorResponse('INVALID_PAYLOAD', '需要实体 ID 和动作模板 ID'));
        return;
      }
      const preview = this.coordinator.previewAction(
        { userId: session.userId, role: session.role, socketId: 'http-preview' },
        entityId,
        actionTemplateId,
      );
      const response: DemoActionPreviewResponse = { ok: true, data: preview };
      res.json(response);
    };

    for (const prefix of ['/api/demo', '/demo']) {
      this.app.post(`${prefix}/host`, hostHandler);
      this.app.post(`${prefix}/join`, joinHandler);
      this.app.get(`${prefix}/session`, sessionHandler);
      this.app.get(`${prefix}/roster`, rosterHandler);
      this.app.post(`${prefix}/assign`, assignHandler);
      this.app.post(`${prefix}/logout`, logoutHandler);
      this.app.get(`${prefix}/catalog`, catalogHandler);
      this.app.post(`${prefix}/action-preview`, actionPreviewHandler);
      this.app.get(`${prefix}/persistence`, settlementStatusHandler);
      this.app.post(`${prefix}/persistence/retry`, settlementRetryHandler);
      this.app.post(`${prefix}/retry-persistence`, settlementRetryHandler);
    }
  }

  private installSocketHandlers(): void {
    this.io.use((socket, next) => {
      const auth = isRecord(socket.handshake.auth) ? socket.handshake.auth : {};
      const accessToken = stringValue(auth.accessToken, 256);
      const attached = this.sessionService.attachSocket(accessToken, socket.id);
      if (!attached.ok) {
        const error = new Error(attached.message);
        (error as Error & { data?: unknown }).data = { code: attached.code };
        next(error);
        return;
      }
      (socket as DemoSocket).data = { accessToken: accessToken!, sessionId: attached.session.sessionId };
      this.coordinator.connect({ userId: attached.session.userId, role: attached.session.role, socketId: socket.id });
      next();
    });

    this.io.on('connection', rawSocket => {
      const socket = rawSocket as DemoSocket;
      socket.join(this.encounterId);
      const session = this.sessionService.sessionForSocket(socket.id);
      if (!session) {
        socket.disconnect(true);
        return;
      }
      socket.emit('DEMO_SNAPSHOT', { snapshot: filterEncounterSnapshot(this.coordinator.getSnapshot(), session) });
      this.emitRoster(socket, session);

      socket.on('AUTHENTICATE', (payload: unknown, ack?: (result: DemoSocketAuthAck | DemoSocketError) => void) => {
        const auth = isRecord(payload) ? payload : {};
        const accessToken = stringValue(auth.accessToken, 256);
        const attached = this.sessionService.attachSocket(accessToken, socket.id);
        if (!attached.ok) {
          const failed = { ok: false, code: attached.code, message: attached.message } as DemoSocketError;
          ack?.(failed);
          socket.emit('DEMO_ERROR', failed);
          return;
        }
        this.coordinator.disconnect(socket.id);
        socket.data = { accessToken: accessToken!, sessionId: attached.session.sessionId };
        this.coordinator.connect({ userId: attached.session.userId, role: attached.session.role, socketId: socket.id });
        const response: DemoSocketAuthAck = {
          ok: true,
          session: toSessionView(this.sessionService, attached.session),
          snapshot: filterEncounterSnapshot(this.coordinator.getSnapshot(), attached.session),
        };
        ack?.(response);
        socket.emit('DEMO_SNAPSHOT', { snapshot: response.snapshot });
        this.broadcastRoster();
      });

      socket.on('DEMO_COMMAND', (rawCommand: unknown, ack?: (result: EncounterCommandResult) => void) => {
        const session = this.sessionService.sessionForSocket(socket.id);
        const auth = this.sessionService.authenticate(socket.data.accessToken);
        if (!session || !auth.ok || auth.session.sessionId !== session.sessionId) {
          const requestId = isRecord(rawCommand)
            ? stringValue(rawCommand.requestId, MAX_REQUEST_ID_LENGTH) ?? 'invalid'
            : 'invalid';
          const rejected = snapshotResult(
            { requestId },
            this.coordinator.getSnapshot(),
            auth.ok ? 'UNAUTHENTICATED' : auth.code,
            auth.ok ? 'Socket 会话已失效' : auth.message,
          );
          ack?.(this.filterCommandResult(rejected, undefined));
          if (!auth.ok) socket.emit('DEMO_ERROR', errorResponse(auth.code, auth.message));
          return;
        }
        const command = parseCommand(rawCommand);
        if (!command) {
          const rejected = snapshotResult(
            { requestId: isRecord(rawCommand) ? stringValue(rawCommand.requestId, MAX_REQUEST_ID_LENGTH) ?? 'invalid' : 'invalid' },
            this.coordinator.getSnapshot(),
            'INVALID_COMMAND',
            '命令格式无效',
          );
          ack?.(this.filterCommandResult(rejected, session));
          return;
        }
        if (Buffer.byteLength(JSON.stringify(rawCommand), 'utf8') > MAX_COMMAND_BYTES) {
          const rejected = snapshotResult(command, this.coordinator.getSnapshot(), 'COMMAND_TOO_LARGE', '命令超过大小限制');
          ack?.(this.filterCommandResult(rejected, session));
          return;
        }
        const authorizationError = this.authorizeCommand(command, auth.session);
        if (authorizationError) {
          const rejected = snapshotResult(command, this.coordinator.getSnapshot(), authorizationError.code, authorizationError.reason);
          ack?.(this.filterCommandResult(rejected, auth.session));
          return;
        }
        const restartBlockReason = command.type === 'GM_RESTART' ? this.restartBlockReason() : undefined;
        if (restartBlockReason) {
          // A completed result must remain durable before a new LOBBY can
          // replace the in-memory result.  Do not send this transient refusal
          // through the command cache: the same request may be retried after
          // the GM has repaired persistence.
          const rejected = snapshotResult(command, this.coordinator.getSnapshot(), 'SETTLEMENT_NOT_SAVED', restartBlockReason);
          const filtered = this.filterCommandResult(rejected, auth.session);
          ack?.(filtered);
          socket.emit('DEMO_ERROR', errorResponse('SETTLEMENT_NOT_SAVED', restartBlockReason, true));
          return;
        }
        const cacheKey = `${auth.session.sessionId}:${command.requestId}`;
        const cached = this.commandCache.get(cacheKey);
        if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
          ack?.(this.filterCommandResult(cached.result, auth.session));
          return;
        }
        const principal: EncounterPrincipal = {
          userId: auth.session.userId,
          role: auth.session.role,
          socketId: socket.id,
        };
        const result = this.coordinator.handleCommand(principal, command);
        this.commandCache.set(cacheKey, { result, at: Date.now() });
        this.pruneCommandCache();
        this.persistAfterCommand(command, result);
        if (result.ok && command.type === 'GM_ASSIGN_ENTITY') {
          // Also support coordinator adapters that do not emit INCREMENT.
          this.broadcastSnapshot();
          this.broadcastRoster();
        }
        ack?.(this.filterCommandResult(result, auth.session));
      });

      socket.on('disconnect', () => {
        this.coordinator.disconnect(socket.id);
        this.sessionService.detachSocket(socket.id);
        this.broadcastRoster();
      });
    });
  }

  private wireCoordinator(): void {
    if (!this.coordinator.on) return;
    const update = (payload?: unknown): void => {
      const increment = this.extractIncrement(payload);
      if (!increment) return;
      this.broadcastSnapshot(increment);
      const snapshot = this.coordinator.getSnapshot();
      if (snapshot.result) this.persistSettlement(snapshot, snapshot.result);
    };
    // EncounterCoordinator emits one INCREMENT and then an internal SNAPSHOT
    // for each revision. INCREMENT is the single transport boundary here.
    this.coordinator.on('INCREMENT', update);
  }

  private wireSessionService(): void {
    const terminate = (payload: unknown): void => {
      if (!isRecord(payload) || !Array.isArray(payload.socketIds)) return;
      const socketIds = payload.socketIds.filter((socketId): socketId is string => typeof socketId === 'string');
      for (const socketId of socketIds) {
        const socket = this.io.sockets.sockets.get(socketId);
        if (socket) {
          // The normal disconnect handler removes the coordinator connection
          // exactly once and emits the roster update.
          socket.disconnect(true);
        } else {
          this.coordinator.disconnect(socketId);
        }
      }
      this.broadcastRoster();
    };
    this.sessionService.on('session:expired', terminate);
    this.sessionService.on('session:revoked', terminate);
  }

  private extractIncrement(payload: unknown): EncounterIncrement | undefined {
    if (!isRecord(payload)) return undefined;
    const candidate = isRecord(payload.increment) ? payload.increment : payload;
    if (!isRecord(candidate) || typeof candidate.encounterId !== 'string' || !finiteNumber(candidate.revision) || !finiteNumber(candidate.tick) || typeof candidate.type !== 'string' || !isRecord(candidate.payload)) return undefined;
    return candidate as unknown as EncounterIncrement;
  }

  private persistAfterCommand(command: EncounterCommand, result: CommandResult): void {
    if (!result.ok) return;
    const snapshot = this.coordinator.getSnapshot();
    if (snapshot.result && command.type !== 'GM_CORRECT' && command.type !== 'GM_ADJUST_ENTITY') {
      this.persistSettlement(snapshot, snapshot.result);
      return;
    }
    const lobbyConfiguration = snapshot.status === 'LOBBY' && [
      'GM_SET_FACTION', 'GM_SET_RELATION', 'GM_SET_VICTORY_CONDITION', 'GM_ADJUST_ENTITY', 'GM_CORRECT', 'GM_SPAWN', 'GM_REMOVE',
    ].includes(command.type);
    if (command.type === 'START' || lobbyConfiguration) {
      // A new START begins a fresh run after GM_RESTART.  Keep this id stable
      // for all later settlement retries and reconnect-triggered snapshots.
      if (command.type === 'START') this.settlementRunId = randomUUID();
      // LOBBY edits define the opening that is mounted after a server restart.
      // A checkpoint alone would report success but restore stale configuration.
      this.settlementState = { status: 'pending', retryable: true, updatedAt: Date.now() };
      const persisted = this.persistence.saveOpeningSnapshot(snapshot);
      if (persisted.ok) {
        this.pendingPersistence = undefined;
        this.settlementState = { status: 'saved', retryable: false, updatedAt: Date.now() };
      } else {
        this.pendingPersistence = { kind: 'opening', snapshot };
        this.markPersistenceFailed(persisted.message);
      }
      return;
    }
    if (command.type === 'GM_PAUSE' || command.type === 'GM_EDIT_ACTION' || command.type === 'GM_ADJUST_ENTITY' || command.type === 'GM_CORRECT' || command.type === 'GM_RESTART'
      || command.type === 'GM_SET_FACTION' || command.type === 'GM_SET_RELATION' || command.type === 'GM_SET_VICTORY_CONDITION') {
      this.settlementState = { status: 'pending', retryable: true, updatedAt: Date.now() };
      const persisted = this.persistence.saveCheckpoint(snapshot);
      if (persisted.ok) {
        this.pendingPersistence = undefined;
        this.settlementState = { status: 'saved', retryable: false, updatedAt: Date.now() };
      } else {
        this.pendingPersistence = { kind: 'checkpoint', snapshot };
        this.markPersistenceFailed(persisted.message);
      }
    }
  }

  private persistSettlement(snapshot: EncounterSnapshot, result: NonNullable<EncounterSnapshot['result']>): void {
    const runId = this.settlementRunId ?? (this.settlementRunId = randomUUID());
    const settlementKey = this.settlementKey(snapshot, result, runId);
    if (settlementKey === this.lastPersistedSettlementKey && this.settlementState.status === 'saved') return;
    this.settlementState = { status: 'pending', retryable: true, updatedAt: Date.now() };
    const persisted = this.persistence.saveSettlement(snapshot, result, runId);
    if (persisted.ok) {
      this.pendingPersistence = undefined;
      this.lastPersistedSettlementKey = settlementKey;
      this.settlementState = { status: 'saved', retryable: false, updatedAt: Date.now() };
      // Settlement status is carried by the roster channel.  Broadcast the
      // successful transition as well as failures so the UI cannot remain on
      // a stale "saving" or "retry" banner after the database write wins.
      this.broadcastRoster();
      return;
    }
    this.pendingPersistence = { kind: 'settlement', snapshot, result };
    this.markPersistenceFailed(persisted.message ?? '结算保存失败，可重试');
  }

  private sessionResponse(created: LanCreatedSession): DemoSessionResponse {
    const session = created.session;
    return {
      ok: true,
      data: {
        accessToken: created.accessToken,
        session: toSessionView(this.sessionService, session),
        snapshot: filterEncounterSnapshot(this.coordinator.getSnapshot(), session),
        settlement: this.getSettlementState(),
        joinCode: session.role === 'GM' ? this.sessionService.credentials.joinCode : undefined,
      },
    };
  }

  private getSettlementState(): DemoSettlementState {
    return { ...this.settlementState };
  }

  private markPersistenceFailed(message = '无法写入 Demo 存档'): void {
    this.settlementState = { status: 'failed', retryable: true, message, updatedAt: Date.now() };
    this.broadcastError(errorResponse('PERSISTENCE_FAILED', message, true));
    this.broadcastRoster();
  }

  private settlementKey(snapshot: EncounterSnapshot, result: NonNullable<EncounterSnapshot['result']>, runId = 'legacy'): string {
    const resultFingerprint = JSON.stringify({
      status: result.status,
      winningFaction: result.winningFaction,
      winningSides: result.winningSides?.map(side => `${side.kind}:${side.id}`).sort(),
      survivors: [...result.survivors].sort(),
      casualties: [...result.casualties].sort(),
      resolvedTick: result.resolvedTick,
      endedBy: result.endedBy,
      reason: result.reason,
    });
    return `${snapshot.encounterId}:${runId}:${resultFingerprint}`;
  }

  private requireHttpSession(req: Request, res: Response): LanSessionRecord | undefined {
    const lookup = this.sessionService.authenticate(bearerToken(req));
    if (!lookup.ok) {
      res.status(401).json(errorResponse(lookup.code, lookup.message));
      return undefined;
    }
    return lookup.session;
  }

  private restartBlockReason(): string | undefined {
    const snapshot = this.coordinator.getSnapshot();
    const settlementPending = this.pendingPersistence?.kind === 'settlement';
    if (settlementPending || (snapshot.result !== undefined && this.settlementState.status !== 'saved')) {
      return '结算尚未可靠保存，请先重试保存后再重开';
    }
    return undefined;
  }

  private authorizeCommand(command: EncounterCommand, session: LanSessionRecord): { code: string; reason: string } | undefined {
    const gmOnly = command.type.startsWith('GM_');
    if (gmOnly && session.role !== 'GM') return { code: 'FORBIDDEN', reason: '只有 GM 可以执行该命令' };
    if (!gmOnly && session.role !== 'GM' && !['START', 'WAIT', 'ACTION', 'RECOVER', 'REACTION_JOIN', 'REACTION_SELECT', 'REACTION_PASS', 'CANCEL_ACTION'].includes(command.type)) {
      return { code: 'FORBIDDEN', reason: '玩家无权执行该命令' };
    }
    if (command.type === 'GM_ASSIGN_ENTITY' && !this.sessionService.getSessions().some(candidate =>
      candidate.role === 'PL' && candidate.userId === command.payload.userId,
    )) return { code: 'ASSIGNMENT_INVALID', reason: '玩家会话不存在或已失效' };
    if (session.role === 'PL') {
      const entityId = isRecord(command.payload) && typeof command.payload.entityId === 'string' ? command.payload.entityId : undefined;
      if (entityId && !session.controlledEntityIds.has(entityId)) return { code: 'NOT_CONTROLLER', reason: '玩家没有该实体的控制权' };
      if (command.type === 'REACTION_SELECT' || command.type === 'REACTION_JOIN') {
        const windowId = typeof command.payload.windowId === 'string' ? command.payload.windowId : undefined;
        const window = windowId ? this.coordinator.getSnapshot().decisions.find(decision => decision.windowId === windowId) : undefined;
        if (!window || !session.controlledEntityIds.has(window.reactorEntityId)) return { code: 'NOT_REACTOR', reason: '该反应窗口不属于当前玩家' };
      }
    }
    return undefined;
  }

  private filterCommandResult(result: CommandResult, session: LanSessionRecord | undefined): CommandResult {
    const snapshot = session ? filterEncounterSnapshot(result.snapshot, session) : filterEncounterSnapshot(result.snapshot, {
      sessionId: '', userId: '', role: 'PL', displayName: '', createdAt: 0, expiresAt: 0, reconnectUntil: 0,
      revoked: true, socketIds: new Set(), controlledEntityIds: new Set(),
    });
    return { ...result, snapshot };
  }

  private broadcastSnapshot(increment?: EncounterIncrement): void {
    const rawSnapshot = this.coordinator.getSnapshot();
    // Assignment emits INCREMENT synchronously inside handleCommand. Reconcile
    // transport ownership before filtering that very first frame, including
    // assignments made through the HTTP route.
    if (this.synchronizeSessionControls(rawSnapshot)) this.broadcastRoster();
    for (const rawSocket of this.io.sockets.sockets.values()) {
      const socket = rawSocket as DemoSocket;
      const session = this.sessionService.sessionForSocket(socket.id);
      if (!session) continue;
      const snapshot = filterEncounterSnapshot(rawSnapshot, session);
      if (increment) {
        const payload: DemoSocketIncrementPayload = { increment: { ...increment, payload: this.filterIncrementPayload(increment.payload, session) }, snapshot };
        socket.emit('DEMO_INCREMENT', payload);
      } else {
        socket.emit('DEMO_SNAPSHOT', { snapshot });
      }
    }
  }

  private synchronizeSessionControls(snapshot: EncounterSnapshot): boolean {
    const playerControls = snapshot.controls.filter(control => control.role === 'PL' && control.userId !== undefined);
    const ownerByEntity = new Map(playerControls.map(control => [control.entityId, control.userId]));
    const players = this.sessionService.getSessions().filter(session => session.role === 'PL');
    let changed = false;
    for (const player of players) {
      for (const entityId of [...player.controlledEntityIds]) {
        if (ownerByEntity.get(entityId) !== player.userId) {
          changed = this.sessionService.unassignEntity(player.userId, entityId) || changed;
        }
      }
    }
    for (const control of playerControls) {
      const player = players.find(session => session.userId === control.userId);
      if (player && !player.controlledEntityIds.has(control.entityId)) {
        changed = this.sessionService.assignEntity(player.userId, control.entityId) || changed;
      }
    }
    return changed;
  }

  private filterIncrementPayload(payload: Partial<EncounterSnapshot>, session: LanSessionRecord): Partial<EncounterSnapshot> {
    const candidate = { ...payload, ...(payload.entities ? { entities: payload.entities } : {}) } as EncounterSnapshot;
    const filtered = filterEncounterSnapshot({ ...this.coordinator.getSnapshot(), ...candidate }, session);
    return {
      ...(payload.entities ? { entities: filtered.entities } : {}),
      ...(payload.actions ? { actions: filtered.actions } : {}),
      ...(payload.plan ? { plan: filtered.plan } : {}),
      ...(payload.decisions ? { decisions: filtered.decisions } : {}),
      ...(payload.controls ? { controls: filtered.controls } : {}),
      ...(payload.logs ? { logs: filtered.logs } : {}),
      ...(payload.result ? { result: filtered.result } : {}),
      ...(payload.relations !== undefined ? { relations: filtered.relations } : {}),
      ...(payload.victoryCondition !== undefined ? { victoryCondition: filtered.victoryCondition } : {}),
    };
  }

  private emitRoster(socket: DemoSocket, session: LanSessionRecord): void {
    const payload: DemoSocketRosterPayload = {
      entries: this.sessionService.getRoster(session),
      settlement: this.getSettlementState(),
    };
    socket.emit('DEMO_ROSTER', payload);
  }

  private broadcastRoster(): void {
    for (const rawSocket of this.io.sockets.sockets.values()) {
      const socket = rawSocket as DemoSocket;
      const session = this.sessionService.sessionForSocket(socket.id);
      if (session) this.emitRoster(socket, session);
    }
  }

  private broadcastError(error: DemoErrorResponse): void {
    for (const rawSocket of this.io.sockets.sockets.values()) {
      (rawSocket as DemoSocket).emit('DEMO_ERROR', error);
    }
  }

  private catalogResponse(session: LanSessionRecord): DemoCatalogResponse {
    const actions = this.coordinator.getCatalog().actionTemplates.map(catalogAction);
    const catalog = this.coordinator.getCatalog();
    const ownedTemplateIds = new Set(this.coordinator.getSnapshot().entities
      .filter(entity => session.controlledEntityIds.has(entity.id))
      .map(entity => entity.templateId));
    const entries: DemoCatalogEntry[] = [];
    for (const templateId of Object.keys(catalog.actorTemplates)) {
      const entity = catalog.actorTemplates[templateId];
      if (!entity) continue;
      const faction = getEntityFaction(entity);
      if (session.role !== 'GM' && !ownedTemplateIds.has(templateId) && !ownedTemplateIds.has(entity.templateId)) continue;
      entries.push({
        templateId,
        label: entity.displayName ?? templateId,
        faction,
        ...(session.role === 'GM' ? { entityTemplate: structuredClone(entity) as unknown as Record<string, unknown> } : {}),
        actions,
      });
    }
    return {
      ok: true,
      data: {
        map: cloneCatalogMap(catalog),
        entries,
        ...(catalog.scenario ? { scenario: structuredClone(catalog.scenario) } : {}),
        capabilities: { actionPreview: typeof this.coordinator.previewAction === 'function' },
      },
    };
  }

  private pruneCommandCache(): void {
    const threshold = Date.now() - 10 * 60 * 1000;
    for (const [key, value] of this.commandCache) {
      if (value.at < threshold) this.commandCache.delete(key);
    }
    while (this.commandCache.size > 4096) {
      const first = this.commandCache.keys().next();
      if (first.done) break;
      this.commandCache.delete(first.value);
    }
  }

  private makeUrl(port: number): string {
    const displayHost = this.host === '0.0.0.0' || this.host === '::' ? '127.0.0.1' : this.host;
    return `http://${displayHost}:${port}`;
  }
}

export async function createEncounterServer(options: EncounterServerOptions): Promise<EncounterServerHandle> {
  return new EncounterServerImpl(options);
}
