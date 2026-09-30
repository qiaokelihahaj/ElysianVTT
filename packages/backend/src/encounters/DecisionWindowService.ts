import type {
  ActionTemplate,
  DecisionPollPayload,
  EncounterActionPlan,
  EncounterCommand,
  EncounterControl,
  EncounterDecisionWindow,
  EncounterEntity,
  EncounterPrincipal,
  EncounterReadySlot,
  EncounterRulePack,
  EntityId,
  Tick,
  Vector3D,
} from '@hard-vtt/shared';
import { CombatEngine } from '../campaigns/engines/CombatEngine.js';
import { RuleEvaluator } from '../core/systems/RuleEvaluator.js';
import { generateId } from '../utils/IdGenerator.js';

export interface DecisionWindowServicePort {
  readonly content: EncounterRulePack;
  readonly engine: CombatEngine;
  readonly reactionJoinMs: number;
  readonly reactionSelectMs: number;
  now(): number;
  getEntity(entityId: EntityId): EncounterEntity | undefined;
  getControl(entityId: EntityId): EncounterControl | undefined;
  getSlot(entityId: EntityId): EncounterReadySlot | undefined;
  canControl(principal: EncounterPrincipal, entityId: EntityId): boolean;
  getAction(actionTemplateId: string): ActionTemplate | undefined;
  getRevision(): number;
  historyValues(): Iterable<EncounterActionPlan>;
  bumpDecisionRevision(): void;
  addLog(message: string, actorId?: EntityId, actionId?: string, causationId?: string): void;
  emitDecision(window: EncounterDecisionWindow): void;
  armDeadlineTimer(): void;
  processAfterDecision(): void;
}

export type DecisionCommandOutcome =
  | { ok: true }
  | { ok: false; code: string; reason: string };

interface PendingReactionSelection {
  windowId: string;
  sourceEntityId: EntityId;
  reactorEntityId: EntityId;
  causationId: string;
  socketId: string;
  serverOverride?: boolean;
  chosenOptionId: string | null;
  targetCoords?: Vector3D;
  resourceCost: Record<string, number>;
}

interface CausationState {
  reactedEntityIds: Set<EntityId>;
  parentCausationId?: string;
}

/** Owns reaction windows, socket engagement, deadlines, and causal choices. */
export class DecisionWindowService {
  private readonly windows = new Map<string, EncounterDecisionWindow>();
  private readonly polls = new Map<string, DecisionPollPayload>();
  private readonly pendingSelections = new Map<string, PendingReactionSelection>();
  private readonly reservedCosts = new Map<EntityId, Record<string, number>>();
  private readonly causations = new Map<string, CausationState>();

  public constructor(private readonly port: DecisionWindowServicePort) {}

  public get size(): number {
    return this.windows.size;
  }

  public values(): IterableIterator<EncounterDecisionWindow> {
    return this.windows.values();
  }

  public get(windowId: string): EncounterDecisionWindow | undefined {
    return this.windows.get(windowId);
  }

  public hasPendingSelections(): boolean {
    return this.pendingSelections.size > 0;
  }

  public clear(): void {
    this.windows.clear();
    this.polls.clear();
    this.pendingSelections.clear();
    this.reservedCosts.clear();
    this.causations.clear();
  }

  public cleanupResolved(): void {
    for (const [windowId, window] of this.windows) {
      if (window.resolved || !this.polls.has(windowId)) {
        this.windows.delete(windowId);
        this.polls.delete(windowId);
      }
    }
  }

  public expireDeadlines(at: number, paused: boolean): boolean {
    if (paused) return false;
    let expiredAny = false;
    for (const window of Array.from(this.windows.values())) {
      const expired = window.stage === 'REACTION_JOIN'
        ? at >= window.joinDeadlineAt
        : window.selectDeadlineAt !== undefined && at >= window.selectDeadlineAt;
      if (!expired || window.resolved) continue;
      window.resolved = true;
      expiredAny = true;
      this.port.engine.expireDecisionWindow(window.windowId);
      this.windows.delete(window.windowId);
      this.polls.delete(window.windowId);
    }
    if (expiredAny) this.flush();
    return expiredAny;
  }

  public refreshDeadlines(at: number, paused: boolean): void {
    for (const window of this.windows.values()) {
      if (window.resolved || paused) continue;
      if (window.stage === 'REACTION_JOIN') window.joinRemainingMs = Math.max(0, window.joinDeadlineAt - at);
      else if (window.selectDeadlineAt !== undefined) window.selectRemainingMs = Math.max(0, window.selectDeadlineAt - at);
    }
  }

  public releaseSocketDecisionEngagement(socketId: string): number {
    let released = 0;
    for (const window of this.windows.values()) {
      if (window.resolved || window.stage !== 'REACTION_SELECT' || !window.respondedSocketIds.includes(socketId)) continue;
      window.respondedSocketIds = window.respondedSocketIds.filter(id => id !== socketId);
      released++;
    }
    if (released > 0) this.port.engine.releaseSocketDecisionEngagement(socketId);
    return released;
  }

  public pauseDeadlines(): void {
    for (const window of this.windows.values()) {
      if (window.stage === 'REACTION_JOIN') window.joinDeadlineAt = Number.MAX_SAFE_INTEGER;
      else if (window.selectDeadlineAt !== undefined) window.selectDeadlineAt = Number.MAX_SAFE_INTEGER;
    }
  }

  public resumeDeadlines(at: number): void {
    for (const window of this.windows.values()) {
      if (window.stage === 'REACTION_JOIN') window.joinDeadlineAt = at + window.joinRemainingMs;
      else if (window.selectRemainingMs !== undefined) window.selectDeadlineAt = at + window.selectRemainingMs;
    }
  }

  public join(
    principal: EncounterPrincipal,
    command: EncounterCommand,
    payload: Record<string, unknown>,
  ): DecisionCommandOutcome {
    const windowId = this.stringValue(payload.windowId);
    const window = windowId ? this.windows.get(windowId) : undefined;
    if (!windowId || !window || window.resolved) return this.failure('UNKNOWN_DECISION', '决策窗口不存在或已结束');
    if (window.stage !== 'REACTION_JOIN' && window.respondedSocketIds.length > 0) return this.failure('INVALID_STAGE', '决策窗口已经接战');
    if (!this.port.canControl(principal, window.reactorEntityId)) return this.failure('FORBIDDEN', '没有该反应者的控制权');
    if (!this.checkVersion(command, window)) return this.failure('STALE_DECISION', '决策窗口版本已过期');
    const socketId = principal.socketId;
    this.port.engine.handleDecisionEngage(windowId, socketId);
    if (window.stage === 'REACTION_JOIN') {
      window.stage = 'REACTION_SELECT';
      window.selectDeadlineAt = this.port.now() + this.port.reactionSelectMs;
      window.selectRemainingMs = this.port.reactionSelectMs;
    }
    window.respondedSocketIds.push(socketId);
    this.port.armDeadlineTimer();
    this.port.bumpDecisionRevision();
    return { ok: true };
  }

  public select(
    principal: EncounterPrincipal,
    command: EncounterCommand,
    payload: Record<string, unknown>,
    pass: boolean,
  ): DecisionCommandOutcome {
    const windowId = this.stringValue(payload.windowId);
    const window = windowId ? this.windows.get(windowId) : undefined;
    if (!windowId || !window || window.resolved) return this.failure('UNKNOWN_DECISION', '决策窗口不存在或已结束');
    if (!this.checkVersion(command, window)) return this.failure('STALE_DECISION', '决策窗口版本已过期');
    const isGm = principal.role === 'GM';
    if (!isGm && !this.port.canControl(principal, window.reactorEntityId)) {
      return this.failure('FORBIDDEN', '没有该反应者的控制权');
    }
    if (!isGm && window.stage === 'REACTION_JOIN' && !window.respondedSocketIds.includes(principal.socketId)) {
      return this.failure('JOIN_REQUIRED', '请先接战');
    }
    if (!isGm && window.stage === 'REACTION_SELECT' && window.respondedSocketIds.length > 0 && !window.respondedSocketIds.includes(principal.socketId)) {
      return this.failure('DECISION_ENGAGED', '决策窗口已由另一个连接接战');
    }
    const optionId = pass ? null : (typeof payload.optionId === 'string' ? payload.optionId : null);
    let reactor: EncounterEntity | undefined;
    let reactionCost: Record<string, number> = {};
    if (optionId !== null) {
      const option = window.availableOptions.find(candidate => candidate.id === optionId);
      if (!option) return this.failure('INVALID_OPTION', '伪造或不可用的反应选项');
      if (optionId !== 'DO_NOTHING') {
        const slotAlreadyReserved = Array.from(this.pendingSelections.values())
          .some(selection => selection.reactorEntityId === window.reactorEntityId && selection.chosenOptionId !== null);
        if (slotAlreadyReserved) return this.failure('REACTION_SLOT_BUSY', '该实体已在本批次预订反应行动槽');
        reactor = this.port.getEntity(window.reactorEntityId);
        const reactionTemplate = this.port.getAction(optionId);
        if (!reactor || !reactionTemplate || !reactionTemplate.tags.includes('REACTION')) {
          return this.failure('INVALID_OPTION', '反应动作不存在或不可用');
        }
        reactionCost = this.resourceCost(reactionTemplate, reactor);
        const reserved = this.reservedCosts.get(reactor.id) ?? {};
        const affordable = Object.entries(reactionCost).every(([key, value]) =>
          (reactor!.resources.current[key] ?? 0) - (reserved[key] ?? 0) >= value,
        );
        if (!affordable) return this.failure('INSUFFICIENT_RESOURCE', '反应资源不足');
        const chain = this.causations.get(window.causationId);
        if (chain?.reactedEntityIds.has(window.reactorEntityId)) {
          return this.failure('CHAIN_ALREADY_USED', '该实体已经在此触发链中反应');
        }
        chain?.reactedEntityIds.add(window.reactorEntityId);
        this.reserveCost(reactor.id, reactionCost);
      }
    }
    if (optionId !== null && optionId !== 'DO_NOTHING') {
      const slot = this.port.getSlot(window.reactorEntityId);
      if (slot) {
        slot.readyAtTick = undefined;
        slot.waiting = false;
        slot.blockedReason = undefined;
      }
    }
    if (!isGm && window.stage === 'REACTION_SELECT' && window.respondedSocketIds.length === 0) {
      this.port.engine.handleDecisionEngage(windowId, principal.socketId);
    }
    window.resolved = true;
    window.respondedSocketIds.push(principal.socketId);
    this.pendingSelections.set(windowId, {
      windowId,
      sourceEntityId: window.sourceEntityId,
      reactorEntityId: window.reactorEntityId,
      causationId: window.causationId,
      socketId: principal.socketId,
      serverOverride: isGm,
      chosenOptionId: optionId === 'DO_NOTHING' ? null : optionId,
      targetCoords: this.vectorValue(payload.targetCoords),
      resourceCost: reactionCost,
    });
    this.windows.delete(windowId);
    this.polls.delete(windowId);
    this.port.armDeadlineTimer();
    this.port.bumpDecisionRevision();
    if (this.windows.size === 0) this.flush();
    return { ok: true };
  }

  public flush(): void {
    if (this.windows.size > 0 || this.pendingSelections.size === 0) return;
    const selections = Array.from(this.pendingSelections.values()).sort((left, right) => {
      const actorOrder = left.reactorEntityId.localeCompare(right.reactorEntityId);
      return actorOrder !== 0 ? actorOrder : left.windowId.localeCompare(right.windowId);
    });
    this.pendingSelections.clear();
    this.reservedCosts.clear();
    for (const selection of selections) {
      const response = {
        windowId: selection.windowId,
        chosenOptionId: selection.chosenOptionId,
        targetCoords: selection.targetCoords,
      };
      if (selection.serverOverride) this.port.engine.handleServerDecisionResponse(response);
      else this.port.engine.handleDecisionResponse(response, selection.socketId);
    }
    this.port.processAfterDecision();
  }

  public collectGmPasses(socketId: string): void {
    for (const window of Array.from(this.windows.values())) {
      if (window.resolved) continue;
      window.resolved = true;
      window.respondedSocketIds.push(socketId);
      this.pendingSelections.set(window.windowId, {
        windowId: window.windowId,
        sourceEntityId: window.sourceEntityId,
        reactorEntityId: window.reactorEntityId,
        causationId: window.causationId,
        socketId,
        serverOverride: true,
        chosenOptionId: null,
        resourceCost: {},
      });
      this.windows.delete(window.windowId);
      this.polls.delete(window.windowId);
    }
    this.port.armDeadlineTimer();
  }

  public passAll(socketId: string): void {
    let rounds = 0;
    do {
      this.collectGmPasses(socketId);
      this.flush();
      rounds += 1;
    } while (this.windows.size > 0 && rounds < 32);
  }

  public open(poll: DecisionPollPayload): void {
    const sourcePlan = Array.from(this.port.historyValues()).reverse()
      .find(plan => plan.actorId === poll.sourceAction?.actorId);
    const causationId = poll.causationId ?? sourcePlan?.causationId ?? generateId();
    const chain = this.causations.get(causationId) ?? { reactedEntityIds: new Set<EntityId>() };
    this.causations.set(causationId, chain);
    const control = this.port.getControl(poll.actorId);
    const window: EncounterDecisionWindow = {
      windowId: poll.windowId,
      stage: 'REACTION_JOIN',
      sourceActionId: poll.sourceActionId ?? sourcePlan?.actionId ?? poll.sourceAction?.actionName ?? poll.windowId,
      sourceEntityId: poll.sourceAction?.actorId ?? 'SYSTEM',
      reactorEntityId: poll.actorId,
      causationId,
      openedTick: poll.tick,
      joinDeadlineAt: this.port.now() + this.port.reactionJoinMs,
      selectDeadlineAt: undefined,
      joinRemainingMs: this.port.reactionJoinMs,
      selectRemainingMs: undefined,
      version: sourcePlan?.decisionVersion ?? poll.version ?? this.port.getRevision(),
      controlEpoch: control?.controlEpoch ?? 0,
      availableOptions: poll.availableOptions,
      respondedSocketIds: [],
      resolved: false,
    };
    if (chain.reactedEntityIds.has(poll.actorId)) {
      window.resolved = true;
      this.port.engine.handleDecisionResponse({ windowId: poll.windowId, chosenOptionId: null }, '__chain_guard__');
      return;
    }
    this.windows.set(window.windowId, window);
    this.polls.set(window.windowId, poll);
    this.port.armDeadlineTimer();
    this.port.bumpDecisionRevision();
    this.port.addLog(`${poll.actorId} 获得对 ${poll.sourceAction?.actionName ?? '动作'} 的反应窗口。`, poll.actorId, window.sourceActionId, causationId);
    this.port.emitDecision(window);
  }

  public invalidate(plan: EncounterActionPlan): void {
    const affected = Array.from(this.windows.values()).filter(window =>
      window.causationId === plan.causationId || window.sourceActionId === plan.actionId,
    );
    const selected = Array.from(this.pendingSelections.values()).filter(selection => selection.causationId === plan.causationId);
    if (affected.length === 0 && selected.length === 0) return;
    this.port.engine.invalidateCoordinatedDecisionWindows(plan.causationId);
    for (const window of affected) {
      window.resolved = true;
      this.windows.delete(window.windowId);
      this.polls.delete(window.windowId);
      this.pendingSelections.delete(window.windowId);
      this.causations.get(window.causationId)?.reactedEntityIds.delete(window.reactorEntityId);
    }
    for (const selection of selected) {
      this.pendingSelections.delete(selection.windowId);
      this.causations.get(selection.causationId)?.reactedEntityIds.delete(selection.reactorEntityId);
    }
    this.rebuildReservations();
    this.port.armDeadlineTimer();
  }

  public clearEntity(entityId: EntityId): void {
    const causationIds = new Set<string>();
    for (const window of this.windows.values()) {
      if (window.sourceEntityId === entityId || window.reactorEntityId === entityId) causationIds.add(window.causationId);
    }
    for (const selection of this.pendingSelections.values()) {
      if (selection.sourceEntityId === entityId || selection.reactorEntityId === entityId) causationIds.add(selection.causationId);
    }
    for (const [windowId, window] of Array.from(this.windows.entries())) {
      if (!causationIds.has(window.causationId)) continue;
      window.resolved = true;
      this.windows.delete(windowId);
      this.polls.delete(windowId);
      this.pendingSelections.delete(windowId);
    }
    for (const [windowId, selection] of Array.from(this.pendingSelections.entries())) {
      if (causationIds.has(selection.causationId)) this.pendingSelections.delete(windowId);
    }
    for (const causationId of causationIds) {
      this.port.engine.invalidateCoordinatedDecisionWindows(causationId);
      this.causations.delete(causationId);
    }
    this.rebuildReservations();
    this.port.armDeadlineTimer();
  }

  public rebuildReservations(): void {
    this.reservedCosts.clear();
    for (const selection of this.pendingSelections.values()) {
      const reserved = this.reservedCosts.get(selection.reactorEntityId) ?? {};
      for (const [resource, amount] of Object.entries(selection.resourceCost)) {
        reserved[resource] = (reserved[resource] ?? 0) + amount;
      }
      this.reservedCosts.set(selection.reactorEntityId, reserved);
    }
  }

  private checkVersion(command: EncounterCommand, window: EncounterDecisionWindow): boolean {
    if (command.expectedDecisionVersion !== undefined && command.expectedDecisionVersion !== window.version) return false;
    if (command.controlEpoch !== undefined && command.controlEpoch !== window.controlEpoch) return false;
    return true;
  }

  private reserveCost(entityId: EntityId, cost: Record<string, number>): void {
    if (Object.keys(cost).length === 0) return;
    const reserved = this.reservedCosts.get(entityId) ?? {};
    for (const [resource, amount] of Object.entries(cost)) reserved[resource] = (reserved[resource] ?? 0) + amount;
    this.reservedCosts.set(entityId, reserved);
  }

  private resourceCost(template: ActionTemplate, entity: EncounterEntity): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, expression] of Object.entries(template.resourceCost ?? {})) {
      const value = Math.abs(RuleEvaluator.evaluate(expression, { actor: entity }).total);
      if (value > 0) result[key] = value;
    }
    return result;
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private vectorValue(value: unknown): Vector3D | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number' || typeof candidate.z !== 'number') return undefined;
    if (![candidate.x, candidate.y, candidate.z].every(Number.isFinite)) return undefined;
    return { x: candidate.x, y: candidate.y, z: candidate.z };
  }

  private failure(code: string, reason: string): DecisionCommandOutcome {
    return { ok: false, code, reason };
  }
}
