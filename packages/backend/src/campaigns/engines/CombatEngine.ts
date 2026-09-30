// packages/backend/src/campaigns/engines/CombatEngine.ts
import { EventEmitter } from 'events';
import {
    IEngineInstance, Tick, ClientIntent, Entity, EntityId, Vector3D, ActionTemplate,
    AttackTag, MapData,
    TickEvent, ActionExecutionEvent, MovementStepEvent, StateMutationPayload,
    ActionScheduledPayload, DecisionPollPayload, DecisionResponsePayload, DecisionOption,
    PlayerPriorityToggle, HookPreset, HookTrigger, LogVisibility, UnifiedHook
} from '@hard-vtt/shared';
import { PriorityQueue } from '../../core/engine/PriorityQueue.js';
import { TickLoop } from '../../core/engine/TickLoop.js';
import { ClashPool } from '../../core/engine/ClashPool.js';
import type { ClashResult } from '../../core/engine/ClashPool.js';
import { generateId } from '../../utils/IdGenerator.js';
import { Dictionary, DictionaryActionCatalog } from '../../db/Dictionary.js';
import { RulePackLoader } from '../../db/RulePackLoader.js';
import { EffectSystem } from '../../core/systems/EffectSystem.js';
import { SpatialSystem } from '../../core/systems/SpatialSystem.js';
import { SpatialActionSystem } from '../../core/systems/SpatialActionSystem.js';
import { FormationService } from '../../core/systems/FormationService.js';
import { RuleEvaluator } from '../../core/systems/RuleEvaluator.js';
import { VectorMath } from '../../utils/VectorMath.js';
import { Logger } from '../../utils/Logger.js';
import { HookRegistry } from './HookRegistry.js';
import { CombatProjectileRuntime } from './CombatProjectileRuntime.js';
import { buildActionPhaseSegments, buildActionTimelinePatch } from './CombatActionTimeline.js';
import {
    activeWindowTicks,
    buildActiveWindowEndEvent,
    isWindowOpen,
    strikeCount,
    strikeStartupTicks,
    strikeWindowTicks,
    unhitTargets,
} from './CombatActiveWindowRuntime.js';
import type { RulePackDefs, CombatSummary } from '@hard-vtt/shared';
import { CoverService } from '../../core/systems/CoverService.js';
import type { ProjectileAdvanceEvent, TacticalStance } from '@hard-vtt/shared';
import type { ActionCatalog } from '../../rules/ActionCatalog.js';
import { InMemoryActionCatalog } from '../../rules/ActionCatalog.js';

const MOVE_INTERVAL_TICKS = 10;
const MOVE_STEP_SIZE = 1.0;
const MOVE_RECOVERY_TICKS = 5;

type PositionChangeWakeEvent = TickEvent & {
    eventType: 'POSITION_CHANGE';
    entityId: EntityId;
};

type BlockZoneExpiryEvent = TickEvent & {
    eventType: 'BLOCK_ZONE_EXPIRE';
    ownerId: EntityId;
    zoneId: string;
};

export interface CombatEngineOptions {
    rulePackId?: string;
    actionCatalog?: ActionCatalog;
}

function isActionCatalog(value: unknown): value is ActionCatalog {
    return typeof value === 'object'
        && value !== null
        && typeof (value as { getAction?: unknown }).getAction === 'function';
}

/** Resolve explicit templates first, then templates loaded for this engine's pack. */
class RulePackCatalogOverlay implements ActionCatalog {
    constructor(
        private readonly primary: ActionCatalog,
        private readonly rulePack: ActionCatalog,
    ) {}

    public getAction(id: string): ActionTemplate | undefined {
        return this.primary.getAction(id) ?? this.rulePack.getAction(id);
    }
}

export type CoordinatedActionMutationResult =
    | { ok: true; actionId: string; eventId?: string }
    | {
        ok: false;
        code: 'UNKNOWN_ACTION' | 'ACTION_ACTIVE' | 'ACTION_RECOVERY' | 'INVALID_ACTION';
        reason: string;
    };

export class CombatEngine extends EventEmitter implements IEngineInstance {
    public engineId: string;
    public engineType: 'COMBAT' | 'EXPLORE' = 'COMBAT';
    public get currentTick(): Tick { return this.tickLoop.getCurrentTick(); }

    private eventQueue = new PriorityQueue();
    private tickLoop = new TickLoop(this.eventQueue);
    private entities = new Map<EntityId, Entity>();
    private projectileRuntime: CombatProjectileRuntime;
    private battlefield?: MapData;
    private scheduledBlockZones = new Set<string>();
    private previousPositions = new Map<EntityId, Vector3D>();
    private movementTiming = new Map<EntityId, { interval: number; recovery: number }>();
    private pendingStances = new Map<EntityId, TacticalStance>();
    private pendingRotations = new Map<EntityId, number>();
    private combatEnded = false;
    private combatResult: CombatSummary | null = null;

    public getCombatResult(): CombatSummary | null {
        return this.combatResult ? structuredClone(this.combatResult) : null;
    }
    
    private pendingMutations: StateMutationPayload = { tick: 0, mutations: [], actionPatches: [] };
    /** 等待决策的窗口数量，> 0 时暂停 processQueue */
    private pendingDecisionCount = 0;
    /** generateSystemHooks 是否在本 tick 发出了 DECISION_POLL（需要等决策） */
    private systemDecisionPending = false;

    private hookRegistry: HookRegistry;
    private scheduledActions: ActionScheduledPayload[] = [];
    private decisionTargets: Map<string, { reactorId: EntityId; sourceId: EntityId; causationId?: string }> = new Map();
    /** 当前活跃决策（供 SCENE_SYNC / 全前端状态栏同步） */
    private activeDecisionPolls: Map<string, DecisionPollPayload> = new Map();
    /** 已按空格进入主动决策的窗口 → 对应的 socketId（防止多客户端自动跳过低消接战状态） */
    private engagedWindows: Map<string, string> = new Map();
    /** 已收到响应的窗口（防重复 + 竞争条件导致计数器负值） */
    private respondedWindows: Set<string> = new Set();
    /** Coordinated demo actions open their reaction windows at declaration. */
    private preOpenedReactionActions: Set<string> = new Set();
    /** Hook tombstones keyed by the coordinated source causation. */
    private coordinatedHookIds: Map<string, Set<string>> = new Map();
    /** Position changes are collected while a Tick is being resolved. */
    private pendingPositionChanges = new Set<EntityId>();
    /** At most one wake marker is needed for a batch of same-Tick changes. */
    private pendingPositionWakeTick: Tick | undefined;

    /** 玩家控制的实体 ID 集合（仅这些实体的 DECISION_POLL 会阻塞队列） */
    private playerControlledEntities: Set<EntityId> = new Set();
    private _playerControlInitialized = false;

    private playerToggles: Map<EntityId, PlayerPriorityToggle> = new Map();

    private rulePackDefs: RulePackDefs | null = null;
    private readonly rulePackCatalog: InMemoryActionCatalog | undefined;
    private actionCatalog: ActionCatalog;
    private rulePackReady: Promise<void> = Promise.resolve();
    private rulePackLoadError: Error | null = null;

    private logger: Logger;
    /** 防止 DECISION_POLL 同步响应导致 processQueue 重入当前结算。 */
    private processingQueue = false;

    constructor(engineId: string, rulePackIdOrCatalogOrOptions?: string | ActionCatalog | CombatEngineOptions, actionCatalog?: ActionCatalog) {
        super();
        let rulePackId: string | undefined;
        let explicitCatalog = actionCatalog;
        if (typeof rulePackIdOrCatalogOrOptions === 'string') {
            rulePackId = rulePackIdOrCatalogOrOptions;
        } else if (isActionCatalog(rulePackIdOrCatalogOrOptions)) {
            explicitCatalog = explicitCatalog ?? rulePackIdOrCatalogOrOptions;
        } else if (rulePackIdOrCatalogOrOptions) {
            rulePackId = rulePackIdOrCatalogOrOptions.rulePackId;
            explicitCatalog = explicitCatalog ?? rulePackIdOrCatalogOrOptions.actionCatalog;
        }
        if (explicitCatalog && !isActionCatalog(explicitCatalog)) {
            throw new TypeError('CombatEngine actionCatalog must implement getAction(id)');
        }

        this.engineId = engineId;
        this.actionCatalog = explicitCatalog ?? new DictionaryActionCatalog();
        if (rulePackId) {
            this.rulePackCatalog = new InMemoryActionCatalog();
            this.actionCatalog = explicitCatalog
                ? new RulePackCatalogOverlay(explicitCatalog, this.rulePackCatalog)
                : this.rulePackCatalog;
        }
        this.logger = Logger.create(`Engine:Combat`);
        this.logger.info(`Engine created`, null, { sceneId: this.engineId });
        this.hookRegistry = new HookRegistry();
        this.projectileRuntime = new CombatProjectileRuntime({
            entities: this.entities,
            currentTick: () => this.currentTick,
            schedule: event => this.eventQueue.push(event),
            recordMutation: (entityId, changes) => this.recordMutation(entityId, changes),
            emitVisual: payload => this.emit('VISUAL_FX', payload),
            logger: this.logger,
            logContext: () => this.logCtx(),
            getActionCatalog: () => this.actionCatalog,
            onInterrupt: target => this.triggerInterrupt(target),
        });

        if (rulePackId) {
            this.rulePackReady = this.loadRulePack(rulePackId).catch(error => {
                const normalized = error instanceof Error ? error : new Error(String(error));
                this.rulePackLoadError = normalized;
                this.logger.error(
                    `RulePack '${rulePackId}' failed to bind: ${normalized.message}`,
                    normalized,
                    { sceneId: this.engineId },
                );
                throw normalized;
            });
            // A caller may await ready() for diagnostics. Attach a rejection
            // handler here as well so a forgotten await cannot become an
            // unhandled rejection during server startup.
            void this.rulePackReady.catch(() => undefined);
        }
    }

    private async loadRulePack(rulePackId: string): Promise<void> {
        const [defs, actions] = await Promise.all([
            RulePackLoader.load(rulePackId),
            this.loadRulePackActions(rulePackId),
        ]);
        if (!defs) {
            throw new Error(`RulePack '${rulePackId}' not found`);
        }

        // Validate and snapshot every action before publishing anything to
        // the visible per-engine catalog. A malformed template therefore
        // cannot leave a partially loaded pack behind.
        const defsSnapshot = structuredClone(defs);
        const loadedCatalog = new InMemoryActionCatalog(actions.values());
        const loadedTemplates = loadedCatalog.getAllActions();
        try {
            this.rulePackCatalog?.clear();
            this.rulePackCatalog?.registerActions(loadedTemplates);
        } catch (error) {
            this.rulePackCatalog?.clear();
            throw error;
        }
        // RulePackLoader caches shared definitions. Keep an engine-owned
        // snapshot so another caller cannot mutate this engine's rules.
        this.rulePackDefs = defsSnapshot;
        this.logger.info(`RulePack '${rulePackId}' bound to engine`, null, { sceneId: this.engineId });
    }

    private async loadRulePackActions(rulePackId: string): Promise<Map<string, ActionTemplate>> {
        const cached = Dictionary.getActionsByPack(rulePackId);
        return cached ?? Dictionary.loadByRulePackId(rulePackId);
    }

    private logCtx() {
        return { tick: this.tickLoop.getCurrentTick(), sceneId: this.engineId, entities: this.entities };
    }

    public getAllEntities(): Entity[] {
        return Array.from(this.entities.values());
    }

    /**
     * Notify the combat timeline that an authoritative position changed.
     *
     * The notification is an event, rather than a Tick poll: changes made
     * while a Tick is being resolved are coalesced and evaluated after that
     * Tick's normal action/clash snapshot commits.  Changes made by a GM
     * while the coordinator is paused remain as a wake marker in the heap and
     * therefore cannot deal damage until resume/step advances the queue.
     */
    public notifyPositionChanged(entityId: EntityId): void {
        if (!this.entities.has(entityId) || this.combatEnded) return;
        if (this.processingQueue) this.applyPositionTactics(entityId);
        this.pendingPositionChanges.add(entityId);
        if (this.processingQueue || this.pendingPositionWakeTick === this.currentTick) return;

        const wake: PositionChangeWakeEvent = {
            eventId: `__position_change_${this.currentTick}_${generateId()}`,
            targetTick: this.currentTick,
            status: 'PENDING',
            eventType: 'POSITION_CHANGE',
            entityId,
        };
        this.pendingPositionWakeTick = this.currentTick;
        this.eventQueue.push(wake);
    }

    /** 获取已安排动作列表（供前端 SCENE_SYNC 同步） */
    public getScheduledActions(): ActionScheduledPayload[] {
        return this.scheduledActions;
    }

    /**
     * Replace a coordinator-owned action while its first effect has not yet
     * become ACTIVE.  The old queue entries remain as cancellation tombstones
     * and the replacement is enqueued through the normal action path without
     * charging the actor a second time.
     */
    public replaceCoordinatedAction(actionId: string, intent: ClientIntent): CoordinatedActionMutationResult {
        const scheduled = this.scheduledActions.find(action => action.executionId === actionId);
        if (!scheduled) {
            return { ok: false, code: 'UNKNOWN_ACTION', reason: '行动不存在或已结算' };
        }

        const actor = this.entities.get(scheduled.entityId);
        const context = actor?.currentActionContext;
        if (!actor || !context) {
            return { ok: false, code: 'UNKNOWN_ACTION', reason: '行动不存在或已结算' };
        }
        if (context.phase === 'ACTIVE' || context.phase === 'CHANNELING') {
            return { ok: false, code: 'ACTION_ACTIVE', reason: '行动已经进入 ACTIVE，不能编辑' };
        }
        if (context.phase === 'RECOVERY') {
            return { ok: false, code: 'ACTION_RECOVERY', reason: '行动已经进入收招，不能编辑' };
        }
        if (intent.actorId !== actor.id || !intent.payload.actionTemplateId) {
            return { ok: false, code: 'INVALID_ACTION', reason: '替换行动缺少合法动作模板' };
        }
        const targetCoords = intent.payload.targetCoords;
        if (intent.intentType === 'MOVE') {
            if (!targetCoords) {
                return { ok: false, code: 'INVALID_ACTION', reason: '移动替换缺少目标坐标' };
            }
        } else if (intent.intentType === 'CAST_ACTION') {
            const template = this.actionCatalog.getAction(intent.payload.actionTemplateId);
            if (!template) {
                return { ok: false, code: 'INVALID_ACTION', reason: '替换动作模板不存在' };
            }
        } else {
            return { ok: false, code: 'INVALID_ACTION', reason: '替换行动类型不受支持' };
        }

        this.cancelCurrentAction(actor);
        this.removeScheduledActionByExecutionId(actionId);
        const previousBatchMode = this._batchMode;
        this._batchMode = true;
        try {
            if (intent.intentType === 'MOVE') {
                // Target coordinates were validated before the old action was
                // tombstoned, so this branch cannot fail part-way through.
                if (!targetCoords) {
                    return { ok: false, code: 'INVALID_ACTION', reason: '移动替换缺少目标坐标' };
                }
                this.handleMoveIntent(actor, targetCoords, intent);
            } else if (intent.intentType === 'CAST_ACTION') {
                this.handleActionIntent(actor, intent, false);
            }
        } finally {
            this._batchMode = previousBatchMode;
        }
        return { ok: true, actionId, eventId: actor.currentActionContext?.actionId };
    }

    /**
     * Cancel a coordinator-owned action.  GM cancellation stops a pending
     * declaration; a normal player cancellation may request a recovery
     * boundary so it cannot skip the action's post-action delay.
     */
    public cancelCoordinatedAction(actionId: string, enterRecovery: boolean): CoordinatedActionMutationResult {
        const scheduled = this.scheduledActions.find(action => action.executionId === actionId);
        if (!scheduled) {
            return { ok: false, code: 'UNKNOWN_ACTION', reason: '行动不存在或已结算' };
        }

        const actor = this.entities.get(scheduled.entityId);
        const context = actor?.currentActionContext;
        if (!actor || !context) {
            this.removeScheduledActionByExecutionId(actionId);
            return { ok: true, actionId };
        }
        if (context.phase === 'RECOVERY') {
            return { ok: false, code: 'ACTION_RECOVERY', reason: '行动已经进入收招，不能取消' };
        }
        if (!enterRecovery && (context.phase === 'ACTIVE' || context.phase === 'CHANNELING')) {
            return { ok: false, code: 'ACTION_ACTIVE', reason: '行动已经进入 ACTIVE，不能取消' };
        }

        const previousContext = structuredClone(context);
        this.cancelCurrentAction(actor);
        this.removeScheduledActionByExecutionId(actionId);

        if (enterRecovery) {
            const template = previousContext.actionTemplateId
                ? this.actionCatalog.getAction(previousContext.actionTemplateId)
                : undefined;
            const recoveryTicks = previousContext.type === 'MOVING'
                ? MOVE_RECOVERY_TICKS
                : template?.timeCost.recoveryTicks ?? 0;
            const recoveryEvent: ActionExecutionEvent = {
                eventId: generateId(),
                eventType: 'ACTION_PHASE',
                targetTick: this.currentTick + 1 + recoveryTicks,
                status: 'PENDING',
                actorId: actor.id,
                actionTemplateId: previousContext.actionTemplateId ?? '__BUILTIN_MOVE__',
                phase: 'RECOVERY',
                causationId: undefined,
            };
            this.eventQueue.push(recoveryEvent);
            actor.currentActionContext = {
                ...previousContext,
                actionId: recoveryEvent.eventId,
                phase: 'RECOVERY',
                resolveTick: recoveryEvent.targetTick,
            };
            this.truncateScheduledActionForRecovery(
                actor,
                previousContext.actionTemplateId ?? '__BUILTIN_MOVE__',
                previousContext.timelineStart,
                this.currentTick,
                recoveryEvent.targetTick,
            );
            this.recordMutation(actor.id, { currentActionContext: actor.currentActionContext });
        } else {
            this.recordMutation(actor.id, { currentActionContext: null });
        }

        return { ok: true, actionId, eventId: actor.currentActionContext?.actionId };
    }

    /** Invalidate queued reaction polls belonging to an edited source action. */
    public invalidateCoordinatedDecisionWindows(causationId: string): number {
        const hookIds = this.coordinatedHookIds.get(causationId);
        if (hookIds) {
            for (const hookId of hookIds) this.hookRegistry.unregister(hookId);
            this.coordinatedHookIds.delete(causationId);
        }
        const windowIds = Array.from(this.activeDecisionPolls.entries())
            .filter(([, poll]) => poll.causationId === causationId)
            .map(([windowId]) => windowId);
        for (const windowId of windowIds) {
            this.activeDecisionPolls.delete(windowId);
            this.decisionTargets.delete(windowId);
            this.engagedWindows.delete(windowId);
            this.respondedWindows.add(windowId);
            this.pendingDecisionCount = Math.max(0, this.pendingDecisionCount - 1);
        }
        if (windowIds.length > 0 && this.pendingDecisionCount === 0) {
            this.emit('DECISION_ALL_RESOLVED', { remainingTargets: this.decisionTargets.size });
        }
        return windowIds.length;
    }

    /** 获取当前活跃决策窗口（供 SCENE_SYNC 同步） */
    public getActiveDecisionPoll(): DecisionPollPayload | null {
        const first = this.activeDecisionPolls.values().next();
        return first.done ? null : first.value;
    }

    /** 获取所有活跃决策窗口（供 SCENE_SYNC 同步） */
    public getActiveDecisionPolls(): DecisionPollPayload[] {
        return Array.from(this.activeDecisionPolls.values());
    }

    /** 获取待决决策窗口数量（供 SCENE_SYNC 同步） */
    public getPendingDecisionCount(): number {
        return this.pendingDecisionCount;
    }

    public setPlayerControlledEntities(ids: EntityId[]): void {
        this.playerControlledEntities = new Set(ids);
        this._playerControlInitialized = true;
    }

    public addPlayerControlledEntity(id: EntityId): void {
        this.playerControlledEntities.add(id);
        this._playerControlInitialized = true;
    }

    public removePlayerControlledEntity(id: EntityId): void {
        this.playerControlledEntities.delete(id);
    }

    public getActiveHookPresets(): { id: string; entityId: string; label: string; trigger: HookTrigger; enabled: boolean }[] {
        return this.hookRegistry.getAll()
            .filter(h => h.enabled && !h.fired)
            .map(h => ({
                id: h.id,
                entityId: h.entityId,
                label: h.label,
                trigger: h.trigger,
                enabled: h.enabled
            }));
    }

    /** Resolve an action through this engine's isolated rule catalog. */
    public getActionCatalog(): ActionCatalog {
        return this.actionCatalog;
    }

    /**
     * Bind a catalog before action processing starts. Mounted idle entities
     * are allowed for coordinator compatibility, while queued or active work
     * is rejected so a running encounter cannot change rules midway.
     */
    public bindActionCatalog(actionCatalog: ActionCatalog): void {
        if (!isActionCatalog(actionCatalog)) {
            throw new TypeError('CombatEngine actionCatalog must implement getAction(id)');
        }
        if (actionCatalog === this.actionCatalog) return;

        const hasActiveContext = Array.from(this.entities.values()).some(entity => entity.currentActionContext !== undefined);
        if (this.eventQueue.size > 0
            || this.scheduledActions.length > 0
            || this.pendingDecisionCount > 0
            || this.activeDecisionPolls.size > 0
            || this.processingQueue
            || hasActiveContext) {
            throw new Error('Cannot bind action catalog while combat work is active');
        }

        this.actionCatalog = this.rulePackCatalog
            ? new RulePackCatalogOverlay(actionCatalog, this.rulePackCatalog)
            : actionCatalog;
    }

    /** Wait for an explicitly requested RulePack and its action templates. */
    public async ready(): Promise<void> {
        await this.rulePackReady;
    }

    public getRulePackLoadError(): Error | null {
        return this.rulePackLoadError;
    }

    public getRulePackDefs(): RulePackDefs | null {
        return this.rulePackDefs ? structuredClone(this.rulePackDefs) : null;
    }

    public mountEntities(entities: Entity[]): void {
        for (const entity of entities) {
            this.entities.set(entity.id, entity);
            this.previousPositions.set(entity.id, { ...entity.transform.coords });
            // 初始化部位状态（ACTOR 类型且无预设部位时使用默认值）
            if (entity.type === 'ACTOR' && !entity.bodyParts) {
                entity.bodyParts = this.createDefaultBodyParts(entity);
            }
        }
        for (const entity of this.entities.values()) {
            for (const [id, changes] of SpatialActionSystem.refreshCover(entity, this.entities)) this.recordMutation(id, changes);
        }
    }

    public unmountEntities(entityIds: EntityId[]): Entity[] {
        const removed: Entity[] = [];
        for (const id of entityIds) {
            const ent = this.entities.get(id);
            if (ent) {
                this.cancelCurrentAction(ent);
                removed.push(ent);
                this.entities.delete(id);
                this.previousPositions.delete(id);
                this.movementTiming.delete(id);
                this.playerControlledEntities.delete(id);
                this.playerToggles.delete(id);
                this.pendingPositionChanges.delete(id);
                for (const hook of [...this.hookRegistry.getHooksForEntity(id)]) this.hookRegistry.unregister(hook.id);
            }
        }
        const removedIds = new Set(removed.map(entity => entity.id));
        this.scheduledActions = this.scheduledActions.filter(action => !removedIds.has(action.entityId));
        const removedWindows = this.getActiveDecisionPolls()
            .filter(poll => removedIds.has(poll.actorId) || (poll.sourceAction && removedIds.has(poll.sourceAction.actorId)));
        for (const poll of removedWindows) this.expireDecisionWindow(poll.windowId);
        return removed;
    }

    /** 为实体创建默认部位状态 */
    private createDefaultBodyParts(_entity: Entity): Record<string, { currentHp: number; maxHp: number; destroyed: boolean }> {
        return {
            HEAD:       { currentHp: 30, maxHp: 30, destroyed: false },
            TORSO:      { currentHp: 100, maxHp: 100, destroyed: false },
            LEFT_ARM:   { currentHp: 30, maxHp: 30, destroyed: false },
            RIGHT_ARM:  { currentHp: 30, maxHp: 30, destroyed: false },
            LEFT_LEG:   { currentHp: 35, maxHp: 35, destroyed: false },
            RIGHT_LEG:  { currentHp: 35, maxHp: 35, destroyed: false },
        };
    }

    private _batchMode = false;
    private deferCoordinatedReactionOpen = false;
    private pendingReactionOpenEvents: ActionExecutionEvent[] = [];
    /**
     * Coordinated encounters collect intents outside of the engine and then
     * explicitly advance it.  Legacy callers keep the historical eager
     * behaviour (autoProcess=true).
     */
    private autoProcess = true;

    /** Disable eager queue draining for the encounter coordinator. */
    public setAutoProcess(enabled: boolean): void {
        this.autoProcess = enabled;
    }

    public isAutoProcessEnabled(): boolean {
        return this.autoProcess;
    }

    /** Queue several already-authorized intents as one deterministic batch. */
    public receiveCoordinatedIntents(intents: ClientIntent[]): void {
        this._batchMode = true;
        this.deferCoordinatedReactionOpen = true;
        try {
            for (const intent of intents) this.receiveIntent(intent);
        } finally {
            this.deferCoordinatedReactionOpen = false;
            this._batchMode = false;
        }
        const startupEvents = this.pendingReactionOpenEvents.splice(0);
        if (!this.autoProcess) {
            for (const event of startupEvents) {
                if (this.generateSystemHooks(event)) this.preOpenedReactionActions.add(event.eventId);
            }
        }
        if (this.autoProcess) this.processQueue();
    }

    /** Advance the existing event heap. maxSteps=1 is the GM single-step path. */
    public processPending(maxSteps?: number): void {
        this.processQueue(maxSteps);
    }

    public hasPendingEvents(): boolean {
        return !this.tickLoop.isEmpty();
    }

    public getNextEventTick(): Tick | null {
        return this.tickLoop.peekNextTick();
    }

    /**
     * Pending game events still need to settle before a coordinator may end
     * the encounter.  Wake markers and hook breakpoints are control events,
     * so they do not count as an outstanding combat effect.
     */
    public hasPendingActionEvents(): boolean {
        const heap = this.eventQueue.getAllEvents();
        return heap.some(event => {
            if (event.status !== 'PENDING') return false;
            const eventType = (event as TickEvent & { eventType?: string }).eventType;
            // Position wakes are control markers consumed by the next queue
            // step; they do not represent an outstanding combat effect.
            return eventType !== undefined && eventType !== 'POSITION_CHANGE';
        });
    }

    /** Reset the in-memory timeline for a new encounter from a saved opening snapshot. */
    public reset(): void {
        this.tickLoop.reset();
        this.entities.clear();
        this.projectileRuntime.reset();
        this.previousPositions.clear();
        this.scheduledBlockZones.clear();
        this.movementTiming.clear();
        this.pendingStances.clear();
        this.pendingRotations.clear();
        this.combatEnded = false;
        this.combatResult = null;
        this.pendingMutations = { tick: 0, mutations: [], actionPatches: [] };
        this.pendingDecisionCount = 0;
        this.systemDecisionPending = false;
        this.scheduledActions = [];
        this.decisionTargets.clear();
        this.activeDecisionPolls.clear();
        this.engagedWindows.clear();
        this.respondedWindows.clear();
        this.preOpenedReactionActions.clear();
        this.coordinatedHookIds.clear();
        this.pendingPositionChanges.clear();
        this.pendingPositionWakeTick = undefined;
        this.deferCoordinatedReactionOpen = false;
        this.pendingReactionOpenEvents = [];
        this.playerToggles.clear();
        this.hookRegistry.clear();
        this.playerControlledEntities.clear();
        this._playerControlInitialized = false;
    }

    /** Add a harmless wake-up marker so WAIT can move the authoritative Tick. */
    public scheduleWakeTick(targetTick: Tick, eventId = generateId()): void {
        if (targetTick < this.currentTick) return;
        this.eventQueue.push({ eventId, targetTick, status: 'PENDING' });
    }

    public receiveIntent(intent: ClientIntent): void {
        if (this.combatEnded) return;
        // BATCH_CAST 不依赖单个 actor
        if (intent.intentType === 'BATCH_CAST' && intent.payload.batchIntents?.length) {
            this.handleBatchCast(intent.payload.batchIntents);
            return;
        }

        const actor = this.entities.get(intent.actorId);
        if (!actor) return;

        if (intent.intentType === 'CANCEL_ACTION') {
            this.triggerInterrupt(actor);
            if (!this._batchMode && this.autoProcess) this.processQueue();
            return;
        }

        if (intent.intentType === 'ROTATE') {
            this.handleRotateIntent(actor, intent.payload.rotationDelta ?? 60);
            return;
        }

        if (intent.intentType === 'MOVE' && intent.payload.targetCoords) {
            this.handleMoveIntent(actor, intent.payload.targetCoords, intent);
            return;
        }

        if (intent.intentType === 'DEFEND') {
            this.handleDefendIntent(actor, intent);
            return;
        }

        if (intent.intentType === 'DODGE' && intent.payload.targetCoords) {
            this.handleDodgeIntent(actor, intent.payload.targetCoords);
            return;
        }

        if (intent.intentType === 'CAST_ACTION' && intent.payload.actionTemplateId) {
            this.handleActionIntent(actor, intent);
            return;
        }

        if (intent.intentType === 'INTERACT') {
            this.handleInteractIntent(actor, intent);
            return;
        }

        if (intent.intentType === 'MICRO_EVADE') {
            this.handleMicroEvade(actor, intent);
            return;
        }

        if (intent.intentType === 'PRIORITY_TOGGLE') {
            this.handleToggleIntent(actor, intent);
            return;
        }

        if (intent.intentType === 'HOOK_PRESET') {
            this.handleHookIntent(actor, intent);
            return;
        }

        if (intent.intentType === 'GAMBIT_PRESET') {
            this.logger.warn(`GAMBIT_PRESET not yet implemented for ${actor.id}`, null, this.logCtx());
            return;
        }

        if (intent.intentType === 'CHANGE_STANCE' && intent.payload.stance) {
            this.handleStanceIntent(actor, intent.payload.stance);
            return;
        }
    }

    private handleBatchCast(batchIntents: ClientIntent['payload']['batchIntents']): void {
        this._batchMode = true;
        for (const bi of batchIntents!) {
            const actor = this.entities.get(bi.actorId);
            if (!actor) continue;
            const intent: ClientIntent = {
                actorId: bi.actorId,
                intentType: 'CAST_ACTION',
                clientTick: 0,
                payload: { actionTemplateId: bi.actionTemplateId, targetIds: bi.targetIds }
            };
            this.handleActionIntent(actor, intent);
        }
        this._batchMode = false;
        if (this.autoProcess) this.processQueue();
    }

    // ============================================================
    //  移动
    // ============================================================

    private handleMoveIntent(
        actor: Entity,
        targetCoords: { x: number; y: number; z: number },
        intent?: ClientIntent,
    ): void {
        this.cancelCurrentAction(actor);

        const movementTemplate = intent?.payload.actionTemplateId
            ? this.actionCatalog.getAction(intent.payload.actionTemplateId) : undefined;
        const baseInterval = movementTemplate?.timeCost.startupTicks ?? MOVE_INTERVAL_TICKS;
        const recoveryTicks = movementTemplate?.timeCost.recoveryTicks ?? MOVE_RECOVERY_TICKS;
        const clippedTarget = SpatialActionSystem.clipMovement(actor.transform.coords, targetCoords, this.battlefield);
        let waypoints = SpatialSystem.planWaypoints(actor, clippedTarget, MOVE_STEP_SIZE);

        if (waypoints.length === 0) {
            this.logger.warn(`${actor.id} 已在目标位置`, null, this.logCtx());
            return;
        }

        // Phase 3.5: 阵型物理拦截 — 检查移动路径是否有 bodyBlocking 实体
        const moveBlocked = FormationService.checkMoveBlocked(
            actor, clippedTarget, this.entities, this.logCtx()
        );
        if (moveBlocked.blocked && moveBlocked.blocker) {
            // 截断航点到阻挡点
            const blockPoint = moveBlocked.adjustedTarget;
            waypoints = SpatialSystem.planWaypoints(actor, blockPoint, MOVE_STEP_SIZE);
            if (waypoints.length === 0) {
                this.logger.game(
                    `🧱 [Formation] ${actor.id} 被 ${moveBlocked.blocker.id} 完全阻挡，移动取消`,
                    null, LogVisibility.PLAYER, this.logCtx()
                );
                return;
            }
        }
        if (movementTemplate) this.payTemplateCost(movementTemplate, actor);
        this.movementTiming.set(actor.id, { interval: baseInterval, recovery: recoveryTicks });

        this.logger.game(
            `🏃 [Move] Tick ${this.currentTick}: ${actor.id} → (${targetCoords.x.toFixed(1)},${targetCoords.y.toFixed(1)}) 共 ${waypoints.length} 步`,
            null, LogVisibility.PLAYER, this.logCtx()
        );

        // Phase 3.4: 冲刺动量追踪 — 检查是否中断或继续
        const ctx = actor.currentActionContext;
        let consecutiveMoves = ctx?.consecutiveMoves ?? 0;
        const lastMoveTick = ctx?.lastMoveTick ?? 0;

        if (SpatialSystem.isSprintBroken(this.currentTick, lastMoveTick, 20)) {
            consecutiveMoves = 0; // 超时中断，重置冲刺
        }

        // 使用冲刺加速后的 Tick 消耗
        const moveInterval = SpatialSystem.sprintTickCost(
            consecutiveMoves,
            baseInterval,
            0.1,
            0.5,
            1
        ) * SpatialActionSystem.movementCost(this.battlefield, waypoints[0]);

        const ct = this.currentTick;
        const evt: ActionExecutionEvent = {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: ct + moveInterval,
            status: 'PENDING',
            actorId: actor.id,
            actionTemplateId: '__BUILTIN_MOVE__',
            phase: 'STARTUP'
        };

        this.eventQueue.push(evt);

        // 更新冲刺计数
        const newConsecutiveMoves = consecutiveMoves + 1;

        actor.currentActionContext = {
            type: 'MOVING',
            actionId: evt.eventId,
            phase: 'STARTUP',
            resolveTick: evt.targetTick,
            pulseCount: 0,
            waypoints,
            currentWaypointIndex: 0,
            consecutiveMoves: newConsecutiveMoves,
            lastMoveTick: this.currentTick,
            pulseTickHistory: [],
            timelineStart: ct
        };

        this.logger.game(
            `🏃 [Sprint] Tick ${this.currentTick}: ${actor.id} 冲刺 x${newConsecutiveMoves}, 间隔=${moveInterval} Tick`,
            { actorId: actor.id, consecutiveMoves: newConsecutiveMoves, interval: moveInterval },
            LogVisibility.PLAYER, this.logCtx()
        );

        // 广播时间轴数据 — 预计算冲刺加速后的动态间隔，与 resolveMovementPulse 保持一致
        const moveActiveTicks: number[] = [];
        let cumulativeTick = evt.targetTick;
        let sprintCount = newConsecutiveMoves;
        for (let i = 0; i < waypoints.length; i++) {
            moveActiveTicks.push(cumulativeTick);
            if (i < waypoints.length - 1) {
                const nextInterval = SpatialSystem.sprintTickCost(sprintCount, baseInterval, 0.1, 0.5, 1)
                    * SpatialActionSystem.movementCost(this.battlefield, waypoints[i + 1]);
                cumulativeTick += nextInterval;
                sprintCount++;
            }
        }
        const moveEndTick = moveActiveTicks[moveActiveTicks.length - 1] + 1 + recoveryTicks;
        const movementTimeline = {
            start: ct,
            startupEnd: evt.targetTick,
            recoveryStart: moveActiveTicks[moveActiveTicks.length - 1] + 1,
            end: moveEndTick,
            pulseTicks: moveActiveTicks,
        };
        const movePayload: ActionScheduledPayload = {
            entityId: actor.id,
            actionId: '__BUILTIN_MOVE__',
            actionName: 'Move',
            executionId: intent?.payload.actionId ?? evt.eventId,
            priority: intent?.payload.priority,
            effectiveTick: intent?.payload.effectiveTick,
            causationId: intent?.payload.causationId,
            targetCoords: { ...waypoints[waypoints.length - 1] },
            timeline: {
                ...movementTimeline,
                phaseSegments: buildActionPhaseSegments(movementTimeline, { movement: true }),
            },
            tags: ['MOVEMENT']
        };
        this.scheduledActions.push(movePayload);
        this.emit('ACTION_SCHEDULED', movePayload);

        if (!this._batchMode && this.autoProcess) this.processQueue();
    }

    // ============================================================
    //  技能意图
    // ============================================================

    private handleActionIntent(actor: Entity, intent: ClientIntent, chargeResources = true): void {
        const template = this.actionCatalog.getAction(intent.payload.actionTemplateId!);
        if (!template) {
            this.logger.warn(`技能 ${intent.payload.actionTemplateId} 不存在`);
            return;
        }

        this.cancelCurrentAction(actor);

        const ct = this.currentTick;
        const startupTicks = template.timeCost.startupTicks;
        const recoveryTicks = template.timeCost.recoveryTicks;

        const sequenceFirstStartup = strikeStartupTicks(template);
        const activeTick = intent.payload.effectiveTick !== undefined
            ? Math.max(ct, intent.payload.effectiveTick)
            : ct + startupTicks + sequenceFirstStartup;
        const sequenceStrikeCount = strikeCount(template);
        const firstWindowTicks = strikeWindowTicks(template);
        const evt: ActionExecutionEvent = {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: activeTick,
            status: 'PENDING',
            actorId: intent.actorId,
            targetIds: intent.payload.targetIds,
            targetCoords: intent.payload.targetCoords ? { ...intent.payload.targetCoords } : undefined,
            actionTemplateId: template.id,
            phase: 'STARTUP',
            priorityOverride: intent.payload.priority,
            causationId: intent.payload.causationId,
            strikeIndex: 0,
            strikeCount: sequenceStrikeCount,
            activeWindowStart: activeTick,
            activeWindowEnd: activeTick + firstWindowTicks,
        };
        if (!CombatEngine.usesEventDrivenWindows(template)) {
            delete evt.activeWindowStart;
            delete evt.activeWindowEnd;
        }

        this.eventQueue.push(evt);

        // 计算 channel 持续时长和脉冲节点
        // 引擎行为：第一个脉冲在 activeTick，之后每 intervalTicks 一个脉冲
        // pushRecovery 在最后一个脉冲 tick + 1 + recoveryTicks 触发
        const pulseTicks: number[] = [activeTick];
        const activeWindows: Array<{ start: Tick; end: Tick; strikeIndex: number }> = [];
        if (template.strikeSequence) {
            const windowTicks = strikeWindowTicks(template);
            for (let i = 0; i < sequenceStrikeCount; i++) {
                const start = i === 0
                    ? activeTick
                        : (pulseTicks[i - 1] + windowTicks + strikeStartupTicks(template));
                if (i > 0) pulseTicks.push(start);
                activeWindows.push({ start, end: start + windowTicks, strikeIndex: i });
            }
        } else if (template.channelOptions) {
            const pulses = template.channelOptions.maxPulses ?? 1;
            const interval = template.channelOptions.intervalTicks;
            for (let i = 1; i < pulses; i++) {
                pulseTicks.push(activeTick + i * interval);
            }
        }
        if (activeWindows.length === 0) {
            const windowTicks = activeWindowTicks(template);
            for (let i = 0; i < pulseTicks.length; i++) {
                activeWindows.push({ start: pulseTicks[i], end: pulseTicks[i] + windowTicks, strikeIndex: i });
            }
        }
        const lastPulseTick = pulseTicks[pulseTicks.length - 1];
        const lastWindow = activeWindows[activeWindows.length - 1];
        const endTick = (lastWindow?.end ?? lastPulseTick + 1) + recoveryTicks;
        const castTimeline = {
            start: ct,
            startupEnd: activeTick,
            recoveryStart: lastWindow?.end ?? pulseTicks[pulseTicks.length - 1] + 1,
            end: endTick,
            pulseTicks,
            activeWindows,
        };
        const initialActiveWasDelayed = intent.payload.effectiveTick !== undefined;
        const exposePhaseSegments = template.activeWindowTicks !== undefined || template.strikeSequence !== undefined;
        const castPhaseSegments = exposePhaseSegments
            ? buildActionPhaseSegments(castTimeline, {
                ...(template.strikeSequence
                    ? {
                        interWindowPhase: 'SMALL_STARTUP' as const,
                        ...(!initialActiveWasDelayed ? { initialStartupEnd: ct + startupTicks } : {}),
                    }
                    : {}),
            })
            : undefined;

        actor.currentActionContext = {
            type: 'CASTING',
            actionId: evt.eventId,
            actionTemplateId: template.id,
            phase: 'STARTUP',
            resolveTick: evt.targetTick,
            pulseCount: 0,
            pulseTickHistory: [],
            timelineStart: ct,
            activeStrikeIndex: 0,
            activeStrikeCount: sequenceStrikeCount,
            priorityOverride: intent.payload.priority,
        };

        // 动作开始时支付一次性资源；引导脉冲的额外消耗仍在每个脉冲结算时处理。
        if (chargeResources) this.payTemplateCost(template, actor);

        // The coordinated encounter opens reactions when the action enters
        // STARTUP (the declaration boundary), before the first active Tick.
        // Legacy eager engine callers retain the historical startup-time hook.
        if (!this.autoProcess) {
            if (this.deferCoordinatedReactionOpen) this.pendingReactionOpenEvents.push(evt);
            else if (this.generateSystemHooks(evt)) this.preOpenedReactionActions.add(evt.eventId);
        }

        // 广播 ACTION_SCHEDULED
        const castPayload: ActionScheduledPayload = {
            entityId: intent.actorId,
            actionId: template.id,
            actionName: template.id,
            executionId: intent.payload.actionId ?? evt.eventId,
            targetIds: [...(intent.payload.targetIds ?? [])],
            targetCoords: intent.payload.targetCoords ? { ...intent.payload.targetCoords } : undefined,
            priority: intent.payload.priority,
            effectiveTick: intent.payload.effectiveTick,
            causationId: intent.payload.causationId,
            timeline: {
                ...castTimeline,
                ...(castPhaseSegments === undefined ? {} : { phaseSegments: castPhaseSegments }),
            },
            tags: template.tags
        };
        this.scheduledActions.push(castPayload);
        this.emit('ACTION_SCHEDULED', castPayload);

        if (!this._batchMode && this.autoProcess) this.processQueue();
    }

    private handleInteractIntent(actor: Entity, intent: ClientIntent): void {
        const targetId = intent.payload.targetIds?.[0];
        const target = targetId ? this.entities.get(targetId) : undefined;

        if (!target) {
            this.logger.warn(`交互目标不存在或未提供`, { actorId: actor.id, targetId }, this.logCtx());
            return;
        }

        this.logger.game(
            `🔎 [Interact] Tick ${this.currentTick}: ${actor.id} ↔ ${target.id}`,
            { actorId: actor.id, targetId: target.id },
            LogVisibility.PLAYER,
            this.logCtx()
        );

        this.emit('VISUAL_FX', {
            tick: this.currentTick,
            events: [{
                eventId: generateId(),
                eventType: 'UI_FLOATING_TEXT',
                sourceId: actor.id,
                targetId: target.id,
                fxTemplateId: 'interact',
                durationMs: 800,
                text: 'INTERACT'
            }]
        });
    }

    // ============================================================
    //  防御（招架）
    // ============================================================

    private handleDefendIntent(actor: Entity, intent: ClientIntent): void {
        this.cancelCurrentAction(actor);

        const template = this.actionCatalog.getAction('PARRY');
        if (!template) return;

        const ct = this.currentTick;
        const startupTicks = template.timeCost.startupTicks;

        const evt: ActionExecutionEvent = {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: ct + startupTicks,
            status: 'PENDING',
            actorId: actor.id,
            actionTemplateId: 'PARRY',
            phase: 'STARTUP'
        };

        this.eventQueue.push(evt);

        actor.currentActionContext = {
            type: 'CASTING',
            actionId: evt.eventId,
            actionTemplateId: 'PARRY',
            phase: 'DELAY',
            resolveTick: evt.targetTick,
            pulseCount: 0
        };

        // Deduct resource cost
        this.payTemplateCost(template, actor);

        this.logger.game(`🛡️ [Parry] Tick ${this.currentTick}: ${actor.id} 进入招架姿态 (startup=${startupTicks})`, null, LogVisibility.PLAYER, this.logCtx());

        const parryPayload: ActionScheduledPayload = {
            entityId: actor.id,
            actionId: 'PARRY',
            actionName: '招架',
            // Keep repeated defensive actions distinct in the authoritative
            // encounter timeline. Older producers may omit this field, but
            // the combat engine can provide the event identity here.
            executionId: evt.eventId,
            timeline: {
                start: ct,
                startupEnd: ct + startupTicks,
                recoveryStart: ct + startupTicks + 1,
                end: ct + startupTicks + 1 + template.timeCost.recoveryTicks,
                pulseTicks: [],
                phaseSegments: [
                    ...(startupTicks > 0 ? [{ phase: 'STARTUP' as const, start: ct, end: ct + startupTicks }] : []),
                    { phase: 'ACTIVE' as const, start: ct + startupTicks, end: ct + startupTicks + 1 },
                    ...(template.timeCost.recoveryTicks > 0 ? [{
                        phase: 'RECOVERY' as const,
                        start: ct + startupTicks + 1,
                        end: ct + startupTicks + 1 + template.timeCost.recoveryTicks,
                    }] : []),
                ]
            },
            tags: ['DEFENSE']
        };
        this.scheduledActions.push(parryPayload);
        this.emit('ACTION_SCHEDULED', parryPayload);

        if (!this._batchMode && this.autoProcess) this.processQueue();
    }

    // ============================================================
    //  闪避
    // ============================================================

    private handleDodgeIntent(actor: Entity, targetCoords: { x: number; y: number; z: number }): void {
        this.cancelCurrentAction(actor);

        const template = this.actionCatalog.getAction('DODGE');
        if (!template) return;

        // Calculate dodge distance
        const dist = VectorMath.distance(actor.transform.coords, targetCoords);
        const MAX_DODGE_DIST = 2.0;
        if (dist > MAX_DODGE_DIST) {
            const dir = VectorMath.normalize(VectorMath.subtract(targetCoords, actor.transform.coords));
            targetCoords = {
                x: actor.transform.coords.x + dir.x * MAX_DODGE_DIST,
                y: actor.transform.coords.y + dir.y * MAX_DODGE_DIST,
                z: actor.transform.coords.z + (dir.z ?? 0) * MAX_DODGE_DIST
            };
        }

        const ct = this.currentTick;

        // Move immediately (DODGE has almost no startup)
        actor.transform.coords = { ...targetCoords };
        this.recordMutation(actor.id, {
            'transform.coords.x': targetCoords.x,
            'transform.coords.y': targetCoords.y,
            'transform.coords.z': targetCoords.z
        });
        this.notifyPositionChanged(actor.id);

        // Mark actor as dodging (flag for whiff detection)
        actor.currentActionContext = {
            type: 'CASTING',
            actionId: generateId(),
            actionTemplateId: 'DODGE',
            phase: 'ACTIVE',
            resolveTick: ct + 2,
            pulseCount: 0
        };

        // Deduct FP cost
        this.payTemplateCost(template, actor);

        // Push recovery
        const recoveryEvt: ActionExecutionEvent = {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: ct + 1 + template.timeCost.recoveryTicks,
            status: 'PENDING',
            actorId: actor.id,
            actionTemplateId: 'DODGE',
            phase: 'RECOVERY'
        };
        actor.currentActionContext.actionId = recoveryEvt.eventId;
        actor.currentActionContext.resolveTick = recoveryEvt.targetTick;
        this.recordMutation(actor.id, { currentActionContext: actor.currentActionContext });
        this.eventQueue.push(recoveryEvt);

        this.logger.game(`💨 [Dodge] Tick ${this.currentTick}: ${actor.id} 闪避到 (${targetCoords.x.toFixed(1)},${targetCoords.y.toFixed(1)})`, null, LogVisibility.PLAYER, this.logCtx());

        if (!this._batchMode && this.autoProcess) this.processQueue();
    }

    // ============================================================
    //  玩家优先级切换与 Hook 预设
    // ============================================================

    private handleToggleIntent(actor: Entity, intent: ClientIntent): void {
        const mode = intent.payload.toggleMode;
        if (!mode) return;

        this.playerToggles.set(actor.id, mode);
        this.logger.game(
            `🔘 [Toggle] ${actor.id} 切换优先级模式: ${mode}`,
            { actorId: actor.id, mode },
            LogVisibility.PLAYER,
            this.logCtx()
        );
    }

    private handleHookIntent(actor: Entity, intent: ClientIntent): void {
        const preset = intent.payload.hookPreset;
        if (!preset) return;

        // Register via HookRegistry
        this.hookRegistry.register(actor.id, preset, 'MANUAL', this.currentTick, 0);

        // 广播 hook 同步给场景内所有客户端
        this.emit('HOOK_SYNC', {
            action: preset.enabled ? 'register' : 'remove',
            hook: {
                id: preset.id,
                entityId: preset.entityId,
                label: preset.label,
                trigger: preset.trigger,
                enabled: preset.enabled
            }
        });

        this.logger.game(
            `🪝 [Hook] ${actor.id} ${preset.enabled ? '启用' : '禁用'} Hook '${preset.label}' (${preset.id})`,
            { actorId: actor.id, hookId: preset.id, enabled: preset.enabled },
            LogVisibility.PLAYER,
            this.logCtx()
        );

        // TICK_REACHED 钩子：targetTick === currentTick 时立即触发（不推进时间）
        if (preset.enabled && preset.trigger.type === 'TICK_REACHED' && preset.trigger.targetTick === this.currentTick) {
            this.evaluateHooks(this.currentTick);
        }
        // 否则完全被动触发，由 processQueue 中的 injectHookBreakpoints 确保精确 tick 断点
    }

    /**
     * 在每个 Tick 评估所有 Hook 预设条件。
     * 委托给 HookRegistry.evaluate()，对触发钩子发出 DECISION_POLL。
     */
    /**
     * 评估所有 Hook，返回是否触发了手动钩子（已发出 DECISION_POLL）。
     * 返回 true 表示调用方应暂停 processQueue 等待玩家决策。
     */
    private evaluateHooks(tick: Tick): boolean {
        const firedHooks = this.hookRegistry.evaluate(tick, this.entities);

        // 按 entity 分组触发的 manual hook，同一角色同 tick 合并为一个决策窗口
        const manualByEntity = new Map<string, UnifiedHook[]>();

        for (const hook of firedHooks) {
            // 发送 hook 触发通知给前端以便自动清理
            this.emit('HOOK_FIRED', { id: hook.id, entityId: hook.entityId, source: hook.source, label: hook.label });

            if (hook.source === 'SYSTEM') continue;
            const group = manualByEntity.get(hook.entityId) ?? [];
            group.push(hook);
            manualByEntity.set(hook.entityId, group);
        }

        if (manualByEntity.size === 0) return false;

        for (const [entityId, hooks] of manualByEntity) {
            const windowId = generateId();
            const labels = hooks.map(h => h.label).join(' · ');
            const payload: DecisionPollPayload = {
                windowId,
                windowType: 'REACTION',
                actorId: entityId,
                sourceAction: {
                    actorId: 'SYSTEM',
                    actionName: labels,
                    startupRemainingTicks: 0
                },
                countdownMs: 5000,
                availableOptions: [],
                tick
            };

            this.logger.game(
                `🪝 [Hook] Tick ${tick}: ${entityId} 触发 ${hooks.length} 个钩子: ${labels}`,
                { hookIds: hooks.map(h => h.id), entityId, tick },
                LogVisibility.PLAYER,
                this.logCtx()
            );

            this.activeDecisionPolls.set(windowId, payload);
            this.pendingDecisionCount++;
            this.systemDecisionPending = true;
            this.emit('DECISION_POLL', payload);
        }

        return true;
    }

    // ============================================================
    //  反应窗口过滤与广播
    // ============================================================

    /**
     * 获取对指定动作有效的反应者列表。
     * 过滤条件:
     *   - ACTOR 类型
     *   - 排除 source 自己
     *   - RECOVERY 阶段跳过
     *   - FP <= 0 && PP <= 0 跳过
     *   - 空间: isTarget OR distance <= 15
     *   - MTG 开关: PASS_ALL 跳过; TARGET_ONLY 且 !isTarget 跳过
     */
    private getValidReactors(sourceAction: ActionExecutionEvent): Entity[] {
        const source = this.entities.get(sourceAction.actorId);
        if (!source) return [];

        const allEntities = Array.from(this.entities.values());
        const targetIds = new Set(sourceAction.targetIds ?? []);

        return allEntities.filter(e => {
            if (e.id === sourceAction.actorId) return false;
            if (e.type !== 'ACTOR') return false;

            // Ordinary reactions consume the main action slot and are only
            // available while the reactor is IDLE.  ACTIVE effects are
            // already irreversible and recovery cannot be skipped.
            if (e.currentActionContext) return false;

            // 资源检查: FP <= 0 && PP <= 0 跳过
            const fp = e.resources.current['focus'] ?? e.resources.current['fp'] ?? 1;
            const pp = e.resources.current['poise'] ?? e.resources.current['pp'] ?? 1;
            if (fp <= 0 && pp <= 0) return false;

            const isTarget = targetIds.has(e.id);
            const dist = VectorMath.distance(source.transform.coords, e.transform.coords);

            // 空间条件: 是目标 OR 距离 <= 15
            if (!isTarget && dist > 15) return false;

            // MTG 开关检查
            const toggle = this.playerToggles.get(e.id);
            if (toggle === 'PASS_ALL') return false;
            if (toggle === 'TARGET_ONLY' && !isTarget) return false;

            return true;
        });
    }

    /**
     * 从动作模板构建可用反应选项列表。
     */
    private buildReactionOptions(action: ActionExecutionEvent, reactorOverride?: Entity): DecisionOption[] {
        const actor = reactorOverride ?? this.entities.get(action.actorId);
        if (!actor) return [];

        const options: DecisionOption[] = [];

        // 基础选项: 忽略 (放弃反应)
        options.push({
            id: 'DO_NOTHING',
            label: '放弃',
            resourceCost: {},
            canAfford: true
        });

        // 检查是否有可用的反应技能
        const reactionSkills = ['PARRY', 'DODGE', 'INTERRUPT'];
        for (const skillId of reactionSkills) {
            const template = this.actionCatalog.getAction(skillId);
            if (!template) continue;

            const costs: Record<string, number> = {};
            let canAfford = true;

            if (template.resourceCost) {
                for (const [resKey, expr] of Object.entries(template.resourceCost)) {
                    const cost = Math.abs(RuleEvaluator.evaluate(expr, { actor }).total);
                    const cur = actor.resources.current[resKey] ?? 0;
                    costs[resKey] = cost;
                    if (cur < cost) canAfford = false;
                }
            }

            options.push({
                id: skillId,
                label: skillId === 'PARRY' ? '招架' : skillId === 'DODGE' ? '闪避' : '打断施法',
                resourceCost: costs,
                canAfford
            });
        }

        return options;
    }

    /**
     * 为有效反应者生成系统钩子，注册到 HookRegistry 并通过 DECISION_POLL 告知客户端。
     * TTL 到期后由 HookRegistry.cleanup() 自动清理。
     */
    private generateSystemHooks(sourceAction: ActionExecutionEvent): boolean {
        const source = this.entities.get(sourceAction.actorId);
        if (!source) return false;

        const template = this.actionCatalog.getAction(sourceAction.actionTemplateId);
        if (!template) return false;
        if (template.spatial && !template.effects.some(effect => effect.type === 'DAMAGE' || effect.type === 'INTERRUPT')) return false;

        // 仅当初始化了 playerControlledEntities 后才过滤 NPC 反应者
        const validReactors = this.getValidReactors(sourceAction)
            .filter(r => !this._playerControlInitialized || this.playerControlledEntities.has(r.id));
        if (validReactors.length === 0) return false;

        const countdownMs = 3000;
        const hookTtl = 15; // ticks

        for (const reactor of validReactors) {
            const options = this.buildReactionOptions(sourceAction, reactor);
            const windowId = generateId();
            const hookPreset: HookPreset = {
                id: generateId(),
                entityId: reactor.id,
                label: `Reaction to ${template.id}`,
                trigger: { type: 'TICK_REACHED', targetTick: this.currentTick },
                enabled: true
            };

            const hook = this.hookRegistry.register(reactor.id, hookPreset, 'SYSTEM', this.currentTick, hookTtl);
            if (sourceAction.causationId) {
                const hookIds = this.coordinatedHookIds.get(sourceAction.causationId) ?? new Set<string>();
                hookIds.add(hook.id);
                this.coordinatedHookIds.set(sourceAction.causationId, hookIds);
            }
            this.decisionTargets.set(windowId, {
                reactorId: reactor.id,
                sourceId: source.id,
                causationId: sourceAction.causationId,
            });

            const payload: DecisionPollPayload = {
                windowId,
                windowType: 'REACTION',
                actorId: reactor.id,
                sourceAction: {
                    actorId: source.id,
                    actionName: template.id,
                    startupRemainingTicks: 0
                },
                countdownMs,
                availableOptions: options,
                tick: this.currentTick,
                causationId: sourceAction.causationId,
                sourceActionId: sourceAction.eventId,
            };

            this.activeDecisionPolls.set(windowId, payload);
            this.pendingDecisionCount++;
            this.systemDecisionPending = true;
            this.emit('DECISION_POLL', payload);
        }

        this.logger.game(
            `⚡ [SystemHook] Tick ${this.currentTick}: ${source.id}/${template.id} 生成 ${validReactors.length} 个系统钩子`,
            null, LogVisibility.PLAYER, this.logCtx()
        );
        return validReactors.length > 0;
    }

    /**
     * 玩家按下空格进入主动决策，标记窗口以防止倒计时过期自动跳过。
     */
    public handleDecisionEngage(windowId: string, socketId: string): void {
        if (!this.activeDecisionPolls.has(windowId) || this.engagedWindows.has(windowId)) return;
        this.engagedWindows.set(windowId, socketId);
        this.logger.info(`[DecisionEngage] 窗口 ${windowId} 已由 socket=${socketId} 进入主动决策`, null, this.logCtx());
    }

    /** GM 强制中断所有决策窗口，恢复队列推进 */
    public handleGmForceResolve(): void {
        if (this.pendingDecisionCount <= 0) return;
        this.logger.game(
            `⏭️ [GM] 强制中断决策（${this.pendingDecisionCount} 个待决窗口），恢复队列推进`,
            null, LogVisibility.PLAYER, this.logCtx()
        );
        this.pendingDecisionCount = 0;
        this.engagedWindows.clear();
        this.activeDecisionPolls.clear();

        this.emit('DECISION_ALL_RESOLVED', { windowCount: this.decisionTargets.size });
        this.decisionTargets.clear();
        if (!this.tickLoop.isEmpty()) {
            if (this.autoProcess) this.processQueue();
        }
    }

    /**
     * 处理客户端对决策窗口的响应。
     * 查找对应实体，执行选中的反应动作。
     * 使用 pendingDecisionCount 追踪所有待决窗口，仅当全部决策完毕时才恢复队列。
     */
    public handleDecisionResponse(payload: DecisionResponsePayload, socketId: string): void {
        this.resolveDecisionResponse(payload, socketId, false);
    }

    /**
     * Resolve a decision from a trusted server authority.
     *
     * A timeout or a GM override is not a client socket response.  Routing it
     * through a made-up socket id would be incorrect when another socket has
     * engaged the window: the normal ownership guard must continue to reject
     * an unrelated automatic PASS.  This entry point deliberately bypasses
     * that guard while retaining the same one-response, resource-payment and
     * queue-resume bookkeeping as a normal response.
     */
    public handleServerDecisionResponse(payload: DecisionResponsePayload): boolean {
        return this.resolveDecisionResponse(payload, 'server-authority', true);
    }

    /** Resolve an expired window without pretending that a client responded. */
    public expireDecisionWindow(windowId: string): boolean {
        return this.handleServerDecisionResponse({ windowId, chosenOptionId: null });
    }

    /** A disconnected connection cannot keep its engaged windows paused. */
    public releaseSocketDecisionWindows(socketId: string): number {
        const windowIds = Array.from(this.engagedWindows.entries())
            .filter(([, owner]) => owner === socketId)
            .map(([windowId]) => windowId);
        let released = 0;
        for (const windowId of windowIds) {
            if (this.expireDecisionWindow(windowId)) released++;
        }
        return released;
    }

    /** Drop connection ownership while a coordinator preserves the window for reconnect. */
    public releaseSocketDecisionEngagement(socketId: string): number {
        let released = 0;
        for (const [windowId, owner] of this.engagedWindows) {
            if (owner !== socketId) continue;
            this.engagedWindows.delete(windowId);
            released++;
        }
        return released;
    }

    private resolveDecisionResponse(
        payload: DecisionResponsePayload,
        socketId: string,
        serverAuthority: boolean,
    ): boolean {
        // 防重复：同一窗口忽略二次响应
        if (this.respondedWindows.has(payload.windowId)) {
            this.logger.warn(`DecisionResponse: 窗口 ${payload.windowId} 已响应，忽略重复`, null, this.logCtx());
            return false;
        }
        if (!this.activeDecisionPolls.has(payload.windowId) && !this.decisionTargets.has(payload.windowId)) {
            this.logger.warn(`DecisionResponse: 未找到窗口 ${payload.windowId}`, null, this.logCtx());
            return false;
        }
        const engagedSocketId = this.engagedWindows.get(payload.windowId);

        // Engagement belongs to one connection, including explicit selections.
        if (!serverAuthority && engagedSocketId && socketId !== engagedSocketId) {
            this.logger.info(
                `DecisionResponse: 窗口 ${payload.windowId} 已被其他连接接战，忽略响应`,
                null, this.logCtx()
            );
            return false;
        }
        this.respondedWindows.add(payload.windowId);
        this.engagedWindows.delete(payload.windowId);
        this.activeDecisionPolls.delete(payload.windowId);

        this.pendingDecisionCount = Math.max(0, this.pendingDecisionCount - 1);

        // 如果选择忽略或明确放弃，仅清理映射，不创建动作
        if (!payload.chosenOptionId || payload.chosenOptionId === 'DO_NOTHING') {
            this.decisionTargets.delete(payload.windowId);
            this.tryResumeAfterDecision();
            return true;
        }

        // 通过 windowId 查找对应的 reactor entity
        const target = this.decisionTargets.get(payload.windowId);
        if (!target) {
            this.logger.warn(`DecisionResponse: 未找到窗口 ${payload.windowId} 对应的实体`, null, this.logCtx());
            this.tryResumeAfterDecision();
            return false;
        }

        const reactor = this.entities.get(target.reactorId);
        if (!reactor) {
            this.logger.warn(`DecisionResponse: 实体 ${target.reactorId} 不存在`, null, this.logCtx());
            this.decisionTargets.delete(payload.windowId);
            this.tryResumeAfterDecision();
            return false;
        }

        // 清理 decision 映射
        this.decisionTargets.delete(payload.windowId);

        // 执行选中的反应动作
        const reactionTemplate = this.actionCatalog.getAction(payload.chosenOptionId);
        if (!reactionTemplate) {
            this.logger.warn(`DecisionResponse: 动作模板 ${payload.chosenOptionId} 不存在`, null, this.logCtx());
            this.tryResumeAfterDecision();
            return false;
        }

        // 取消当前动作并创建反应动作事件
        this.cancelCurrentAction(reactor);

        // Responses are authorized outside the normal intent path, so pay
        // their RulePack cost here exactly once.
        this.payTemplateCost(reactionTemplate, reactor);

        const ct = this.currentTick;
        const reactionStrikeCount = strikeCount(reactionTemplate);
        const reactionFirstStartup = strikeStartupTicks(reactionTemplate);
        const reactionWindowTicks = strikeWindowTicks(reactionTemplate);
        const targetsPrimary = reactionTemplate.effects.some(effect => effect.targetSelector === 'PRIMARY' || effect.targetSelector === 'ALL_IN_AOE');
        const evt: ActionExecutionEvent = {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: ct + reactionTemplate.timeCost.startupTicks + reactionFirstStartup,
            status: 'PENDING',
            actorId: reactor.id,
            // SELF reactions must not be range-checked against their source;
            // PRIMARY/area reactions still use the triggering source as the
            // normal target selected by the decision window.
            targetIds: targetsPrimary ? [target.sourceId] : [],
            actionTemplateId: reactionTemplate.id,
            phase: 'STARTUP',
            causationId: target.causationId,
            strikeIndex: 0,
            strikeCount: reactionStrikeCount,
            activeWindowStart: ct + reactionTemplate.timeCost.startupTicks + reactionFirstStartup,
            activeWindowEnd: ct + reactionTemplate.timeCost.startupTicks + reactionFirstStartup + reactionWindowTicks,
        };
        if (!CombatEngine.usesEventDrivenWindows(reactionTemplate)) {
            delete evt.activeWindowStart;
            delete evt.activeWindowEnd;
        }

        this.eventQueue.push(evt);

        reactor.currentActionContext = {
            type: 'CASTING',
            actionId: evt.eventId,
            actionTemplateId: reactionTemplate.id,
            phase: 'STARTUP',
            resolveTick: evt.targetTick,
            pulseCount: 0,
            activeStrikeIndex: 0,
            activeStrikeCount: reactionStrikeCount,
            priorityOverride: undefined,
        };

        // An interrupt is itself a declared action.  Open the next causal
        // reaction window now, while the interrupted source is still in
        // STARTUP, so a reactor that passed on A can still answer B.  Mark the
        // event as pre-opened because a lone reaction event is resolved by
        // resolveActionPulse at its effective Tick (a multi-event Tick may go
        // through ClashPool instead).
        if (!this.autoProcess && reactionTemplate.tags.includes('INTERRUPT')) {
            if (this.generateSystemHooks(evt)) this.preOpenedReactionActions.add(evt.eventId);
        }

        this.logger.game(
            `🎯 [DecisionResponse] Tick ${this.currentTick}: ${reactor.id} 选择反应: ${payload.chosenOptionId}`,
            { windowId: payload.windowId, reactorId: reactor.id, chosenOptionId: payload.chosenOptionId },
            LogVisibility.PLAYER,
            this.logCtx()
        );

        this.tryResumeAfterDecision();
        return true;
    }

    /**
     * 当 pendingDecisionCount 归零时，唤醒引擎继续推进队列。
     * 所有决策者的反应动作已在 handleDecisionResponse 中排队。
     */
    private tryResumeAfterDecision(): void {
        if (this.pendingDecisionCount > 0) {
            this.logger.info(
                `[Decision] 等待 ${this.pendingDecisionCount} 个决策窗口完成`,
                null, this.logCtx()
            );
            return;
        }
        this.activeDecisionPolls.clear();
        this.emit('DECISION_ALL_RESOLVED', { remainingTargets: this.decisionTargets.size });
        if (!this.tickLoop.isEmpty()) {
            if (this.autoProcess) this.processQueue();
        }
    }


    // ============================================================
    //  微闪避
    // ============================================================

    private handleMicroEvade(actor: Entity, intent: ClientIntent): void {
        const evadeType = intent.payload.evadeSubType;
        if (!evadeType || !['DUCK', 'HOP', 'SLIP'].includes(evadeType)) return;

        this.cancelCurrentAction(actor);

        const ct = this.currentTick;

        // Very fast startup, long recovery
        const startupTicks = 2;
        const recoveryTicks = 10;

        actor.currentActionContext = {
            type: 'CASTING',
            actionId: generateId(),
            actionTemplateId: `MICRO_EVADE_${evadeType}`,
            phase: 'ACTIVE',
            resolveTick: ct + startupTicks,
            pulseCount: 0
        };

        // Deduct FP cost
        const fp = actor.resources.current['focus'] ?? actor.resources.current['fp'] ?? 0;
        if (fp >= 5) {
            const key = actor.resources.current['focus'] !== undefined ? 'focus' : 'fp';
            actor.resources.current[key] = Math.max(0, fp - 5);
            this.recordMutation(actor.id, { [`resources.current.${key}`]: actor.resources.current[key] });
        }

        // Push recovery
        const recoveryEvt: ActionExecutionEvent = {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: ct + startupTicks + 1 + recoveryTicks,
            status: 'PENDING',
            actorId: actor.id,
            actionTemplateId: `MICRO_EVADE_${evadeType}`,
            phase: 'RECOVERY'
        };
        actor.currentActionContext.actionId = recoveryEvt.eventId;
        actor.currentActionContext.resolveTick = recoveryEvt.targetTick;
        this.recordMutation(actor.id, { currentActionContext: actor.currentActionContext });
        this.eventQueue.push(recoveryEvt);

        this.logger.game(`🔄 [MicroEvade] Tick ${this.currentTick}: ${actor.id} 尝试 ${evadeType} 微避`, null, LogVisibility.PLAYER, this.logCtx());

        if (!this._batchMode && this.autoProcess) this.processQueue();
    }

    // ============================================================
    //  取消 / 打断
    // ============================================================

    public cancelCurrentAction(actor: Entity): void {
        for (const event of this.eventQueue.getAllEvents()) {
            if (event.status !== 'PENDING') continue;
            if ((event as ActionExecutionEvent).actorId === actor.id ||
                (event as MovementStepEvent).actorId === actor.id) {
                event.status = 'CANCELLED';
            }
        }
        actor.currentActionContext = undefined;
        this.pendingStances.delete(actor.id);
        this.pendingRotations.delete(actor.id);
        this.logger.debug(`${actor.id} 动作/移动已取消`, null, this.logCtx());
    }

    private triggerInterrupt(entity: Entity): void {
        const ctx = entity.currentActionContext;
        if (!ctx || (ctx.phase !== 'DELAY' && ctx.phase !== 'STARTUP' && ctx.phase !== 'CHANNELING')) return;

        const template = ctx.actionTemplateId ? this.actionCatalog.getAction(ctx.actionTemplateId) : undefined;

        const isAlive = (entity.resources.current['hp'] ?? 0) > 0;

        this.cancelCurrentAction(entity);

        const recoveryTicks = ctx.type === 'MOVING'
            ? this.movementTiming.get(entity.id)?.recovery ?? MOVE_RECOVERY_TICKS
            : template?.timeCost.recoveryTicks
                ?? (ctx.actionTemplateId === '__BUILTIN_STANCE__' || ctx.actionTemplateId === '__BUILTIN_ROTATE__' ? 0 : undefined);
        if (isAlive && recoveryTicks !== undefined) {
            const recoveryEvt: ActionExecutionEvent = {
                eventId: generateId(),
                eventType: 'ACTION_PHASE',
                targetTick: this.currentTick + 1 + recoveryTicks,
                status: 'PENDING',
                actorId: entity.id,
                actionTemplateId: ctx.type === 'MOVING' ? '__BUILTIN_MOVE__' : ctx.actionTemplateId!,
                phase: 'RECOVERY'
            };
            this.eventQueue.push(recoveryEvt);

            entity.currentActionContext = {
                ...ctx,
                actionId: recoveryEvt.eventId,
                phase: 'RECOVERY',
                resolveTick: recoveryEvt.targetTick
            };
            this.truncateScheduledActionForRecovery(
                entity,
                recoveryEvt.actionTemplateId,
                ctx.timelineStart,
                this.currentTick,
                recoveryEvt.targetTick,
            );
            this.recordMutation(entity.id, { 'currentActionContext': entity.currentActionContext });
        } else {
            this.recordMutation(entity.id, { 'currentActionContext': null });
        }

        this.emit('VISUAL_FX', {
            tick: this.currentTick,
            events: [{
                eventId: generateId(),
                eventType: 'INTERRUPTED',
                sourceId: entity.id,
                targetId: entity.id,
                fxTemplateId: 'interrupted',
                durationMs: 1200,
                text: '💥 INTERRUPTED!'
            }]
        });

        this.logger.game(
            `💥 [Interrupt] Tick ${this.currentTick}: ${entity.id} 的 ${template?.id ?? 'action'} 被打断!`,
            { entityId: entity.id, phase: ctx.phase },
            LogVisibility.PLAYER, this.logCtx()
        );
    }

    private checkSustainAfterMutations(mutatedEntityIds: EntityId[]): void {
        for (const entityId of mutatedEntityIds) {
            const entity = this.entities.get(entityId);
            if (!entity) continue;

            const ctx = entity.currentActionContext;
            if (!ctx || (ctx.phase !== 'STARTUP' && ctx.phase !== 'CHANNELING')) continue;
            if (ctx.type !== 'CASTING' && ctx.type !== 'MOVING') continue;

            const template = ctx.actionTemplateId ? this.actionCatalog.getAction(ctx.actionTemplateId) : undefined;
            const sustainResources = template?.sustainResources;

            const hp = entity.resources.current['hp'] ?? 999;

            let shouldInterrupt = false;
            if (sustainResources && sustainResources.length > 0) {
                for (const resKey of sustainResources) {
                    // The first STARTUP hit is retained at exactly zero.  A
                    // negative resource interrupts the startup.  Once a
                    // channel has emitted a pulse, zero focus/concentration
                    // stops future pulses as well.
                    const current = entity.resources.current[resKey] ?? 999;
                    const isChannelPulse = ctx.phase === 'CHANNELING' ||
                        (template?.channelOptions !== undefined && (ctx.pulseCount ?? 0) > 0);
                    if (current < 0 || (isChannelPulse && current <= 0)) {
                        shouldInterrupt = true;
                        break;
                    }
                }
            }
            if (hp <= 0) shouldInterrupt = true;

            if (shouldInterrupt) {
                this.triggerInterrupt(entity);
            }
        }
    }

    // ============================================================
    //  核心队列处理 — TickLoop 驱动
    // ============================================================

    /**
     * 在 processQueue 每次 step 前注入 hook 断点事件。
     * 如果活跃 TICK_REACHED hook 的 targetTick 在 (currentTick, nextEventTick) 之间，
     * 则推入一个断点事件让引擎精确在该 tick 停下触发 hook，而非跳到下一个事件才触发。
     */
    private injectHookBreakpoints(): void {
        const nextTick = this.tickLoop.peekNextTick();
        if (nextTick === null) return;
        const breakTick = this.hookRegistry.findEarliestTargetTickInRange(this.currentTick, nextTick);
        if (breakTick !== null) {
            this.logger.info(`[HookBreak] 注入断点: currentTick=${this.currentTick}, nextTick=${nextTick}, breakTick=${breakTick}`, null, this.logCtx());
            this.eventQueue.push({
                eventId: `__hook_break_${breakTick}`,
                targetTick: breakTick,
                status: 'PENDING'
            });
        }
    }

    private processQueue(maxSteps?: number): void {
        if (this.pendingDecisionCount > 0 || this.processingQueue) return;

        this.processingQueue = true;

        try {
            let steps = 0;
            while (!this.tickLoop.isEmpty()) {
            // 广播上一轮的 accumulation
            if (this.pendingMutations.mutations.length > 0 || (this.pendingMutations.actionPatches?.length ?? 0) > 0) {
                this.broadcastMutations();
            }

            // 注入 hook 断点：确保 TICK_REACHED hook 在目标 tick 精确触发
            this.injectHookBreakpoints();

            const step = this.tickLoop.step()!;
            this.pendingMutations.tick = step.tick;

            // 先结算事件，再评估 hook：防止 hook 目标 tick 与真实事件 tick 重叠时事件丢失
            const events = step.events.filter(e => e.status !== 'CANCELLED');
            if (events.length > 0) {
                if (events.some(event => (event as Partial<PositionChangeWakeEvent>).eventType === 'POSITION_CHANGE')) {
                    this.pendingPositionWakeTick = undefined;
                }

                const orderedEvents = [...events].sort((a, b) =>
                    this.eventPhaseOrder(a) - this.eventPhaseOrder(b));
                const movementEvents = orderedEvents.filter(event =>
                    (event as Partial<BlockZoneExpiryEvent>).eventType === 'BLOCK_ZONE_EXPIRE'
                    ||
                    (event as Partial<PositionChangeWakeEvent>).eventType === 'POSITION_CHANGE'
                    || (event as MovementStepEvent).eventType === 'MOVEMENT_STEP'
                    || ((event as ActionExecutionEvent).eventType === 'ACTION_PHASE'
                        && (event as ActionExecutionEvent).actionTemplateId === '__BUILTIN_MOVE__')
                );

                // Movement is committed before the action snapshot for this
                // Tick.  This removes heap/packet arrival order from the
                // source and target coordinates.  Position-triggered ACTIVE
                // windows are flushed only after all ordinary action/clash
                // groups commit, so they cannot mutate a sibling's deep
                // snapshot halfway through the same priority group.
                for (const event of movementEvents) {
                    if (event.status === 'CANCELLED') continue;
                    if ((event as Partial<PositionChangeWakeEvent>).eventType === 'POSITION_CHANGE') {
                        for (const entityId of this.pendingPositionChanges) this.applyPositionTactics(entityId);
                        continue;
                    }
                    this.resolveSingleEvent(event);
                }

                const actionEvents = orderedEvents.filter(event => !movementEvents.includes(event));
                // A movement/GM position update can open an existing ACTIVE
                // window.  Materialize those checks as synthetic STARTUP
                // events and feed them into the same ClashPool batch as
                // ordinary actions.  This keeps strict priority and the
                // immutable same-Tick snapshot intact.
                const positionTriggeredEvents = this.collectPositionTriggeredEvents();
                const eventsWithPositionTriggers = [...actionEvents, ...positionTriggeredEvents];
                const clashCandidates = TickLoop.filterClashable(eventsWithPositionTriggers)
                    .filter(e => e.actionTemplateId !== '__BUILTIN_MOVE__'
                        && e.actionTemplateId !== '__BUILTIN_STANCE__'
                        && e.actionTemplateId !== '__BUILTIN_ROTATE__');
                if (clashCandidates.length >= 2 || clashCandidates.some(event => event.positionTriggered)) {
                    this.resolveClash(clashCandidates);
                    const others = eventsWithPositionTriggers.filter(e => !clashCandidates.includes(e as ActionExecutionEvent));
                    for (const e of others) {
                        if (e.status === 'CANCELLED') continue;
                        this.resolveSingleEvent(e);
                    }
                } else {
                    for (const e of eventsWithPositionTriggers) {
                        if (e.status === 'CANCELLED') continue;
                        this.resolveSingleEvent(e);
                    }
                }
                this.ensurePositionChangeWake();
            }

            // 评估 Hook 预设（TICK_REACHED 等条件触发）
            const hookFired = this.evaluateHooks(step.tick);
            this.hookRegistry.cleanup(step.tick);

            // 手动钩子（evaluateHooks）或系统钩子（generateSystemHooks）触发 DECISION_POLL 后暂停队列
            const shouldPause = (hookFired || this.systemDecisionPending)
                && this.pendingDecisionCount > 0;
            this.systemDecisionPending = false;

                if (shouldPause) {
                    if (this.pendingMutations.mutations.length > 0 || (this.pendingMutations.actionPatches?.length ?? 0) > 0) {
                        this.broadcastMutations();
                    }
                    break;
                }

                steps++;
                if (maxSteps !== undefined && steps >= Math.max(1, maxSteps)) break;

                // 不在此处判定战斗结束 — 让队列排空后再判定
            }

            this.broadcastMutations();
            // 强制同步 tick：当后续 tick 无 mutation 时前端仍能获得最新 tick
            this.emit('STATE_MUTATED', { tick: this.currentTick, mutations: [] });

            // 所有事件处理完毕，检查战斗是否应该结束
            this.checkAndEndCombat();
        } finally {
            this.processingQueue = false;
        }
    }

    private eventPhaseOrder(event: TickEvent): number {
        if ((event as Partial<BlockZoneExpiryEvent>).eventType === 'BLOCK_ZONE_EXPIRE') return -1;
        if ((event as ActionExecutionEvent).eventType !== 'ACTION_PHASE') return 2;
        switch ((event as ActionExecutionEvent).phase) {
            case 'STARTUP': return 0;
            case 'ACTIVE': return 1;
            default: return 2;
        }
    }

    /**
     * Turn coalesced position changes into one event per source window.  The
     * returned events are consumed by ClashPool in the current Tick; no
     * effect is applied while this method is collecting candidates.
     */
    private collectPositionTriggeredEvents(): ActionExecutionEvent[] {
        if (this.pendingPositionChanges.size === 0) return [];

        const changedIds = new Set(this.pendingPositionChanges);
        this.pendingPositionChanges.clear();
        const triggered: ActionExecutionEvent[] = [];

        for (const source of this.entities.values()) {
            const context = source.currentActionContext;
            if (source.type !== 'ACTOR' || context?.type !== 'CASTING' || context.phase !== 'ACTIVE') continue;
            if (context.activeWindowStart === undefined || context.activeWindowEnd === undefined) continue;
            if (!isWindowOpen({ start: context.activeWindowStart, end: context.activeWindowEnd }, this.currentTick)) continue;

            const template = context.actionTemplateId ? this.actionCatalog.getAction(context.actionTemplateId) : undefined;
            if (!template) continue;

            const declaredTargetIds = context.activeTargetIds ?? [];
            const unhit = unhitTargets(this.entities, declaredTargetIds, context.activeHitTargetIds ?? []);
            const sourceMoved = changedIds.has(source.id);
            const candidates = unhit
                // Do not range-filter against the live map here.  ClashPool
                // must evaluate this candidate list against the immutable
                // same-Tick snapshot after all movement commits.
                .filter(target => sourceMoved || changedIds.has(target.id));
            if (candidates.length === 0) continue;

            triggered.push({
                eventId: `__position_trigger_${this.currentTick}_${source.id}_${generateId()}`,
                eventType: 'ACTION_PHASE',
                targetTick: this.currentTick,
                status: 'PENDING',
                actorId: source.id,
                targetIds: candidates.map(target => target.id),
                actionTemplateId: template.id,
                phase: 'STARTUP',
                priorityOverride: context.priorityOverride,
                activeWindowStart: context.activeWindowStart,
                activeWindowEnd: context.activeWindowEnd,
                strikeIndex: context.activeStrikeIndex ?? 0,
                strikeCount: context.activeStrikeCount ?? 1,
                positionTriggered: true,
            });
        }

        return triggered;
    }

    private static isTargetInRange(template: ActionTemplate, actor: Entity, target: Entity): boolean {
        if (template.range?.type === 'SELF') return target.id === actor.id;
        const expression = template.range?.distanceExpr;
        if (!expression) return true;
        try {
            const maxRange = Math.abs(RuleEvaluator.evaluate(expression, { actor }).total);
            return SpatialActionSystem.inReach(template, actor, target, maxRange);
        } catch {
            return false;
        }
    }

    private static usesEventDrivenWindows(template: ActionTemplate): boolean {
        return template.activeWindowTicks !== undefined || template.strikeSequence !== undefined;
    }

    private beginActiveWindow(
        actor: Entity,
        sourceEvent: ActionExecutionEvent,
        template: ActionTemplate,
        admittedTargetIds: EntityId[] = [],
    ): void {
        const context = actor.currentActionContext;
        if (!context) return;

        const start = sourceEvent.activeWindowStart ?? this.currentTick;
        const end = sourceEvent.activeWindowEnd ?? start + strikeWindowTicks(template);
        const targetIds = [...new Set(sourceEvent.targetIds ?? [])];
        if (template.effects.some(effect => effect.targetSelector === 'SELF')) {
            targetIds.push(actor.id);
        }
        const hitTargetIds = admittedTargetIds.filter(id => targetIds.includes(id));
        if (!sourceEvent.positionTriggered
            && template.effects.some(effect => effect.targetSelector === 'SELF')) {
            // SELF resolves against the actor regardless of the declared
            // PRIMARY target list and therefore has its own ledger entry.
            hitTargetIds.push(actor.id);
        }

        context.activeWindowStart = start;
        context.activeWindowEnd = end;
        context.activeStrikeIndex = sourceEvent.strikeIndex ?? context.activeStrikeIndex ?? 0;
        context.activeStrikeCount = sourceEvent.strikeCount ?? context.activeStrikeCount ?? 1;
        context.activeTargetIds = [...new Set(targetIds)];
        context.activeHitTargetIds = [...new Set(hitTargetIds)];
        context.priorityOverride = sourceEvent.priorityOverride ?? context.priorityOverride;
        context.phase = 'ACTIVE';
        context.pulseCount = (context.pulseCount ?? 0) + 1;
        if (!context.pulseTickHistory) context.pulseTickHistory = [];
        context.pulseTickHistory.push(this.currentTick);

        const endEvent = buildActiveWindowEndEvent(
            sourceEvent,
            start,
            Math.max(end, this.currentTick + 1),
            context.activeStrikeIndex,
            context.activeStrikeCount,
        );
        this.eventQueue.push(endEvent);
        context.actionId = endEvent.eventId;
        context.resolveTick = endEvent.targetTick;
        this.recordMutation(actor.id, { 'currentActionContext': context });
    }

    private markActiveWindowTargets(actor: Entity, targetIds: EntityId[]): void {
        const context = actor.currentActionContext;
        if (!context?.activeTargetIds || context.activeWindowStart === undefined || context.activeWindowEnd === undefined) return;

        const known = new Set(context.activeTargetIds);
        const next = new Set(context.activeHitTargetIds ?? []);
        for (const targetId of targetIds) {
            if (known.has(targetId)) next.add(targetId);
        }
        context.activeHitTargetIds = [...next];
        this.recordMutation(actor.id, { 'currentActionContext': context });
    }

    /** Queue a second same-Tick pass when an effect moved an entity during a commit. */
    private ensurePositionChangeWake(): void {
        if (this.pendingPositionChanges.size === 0 || this.pendingPositionWakeTick === this.currentTick) return;
        const wake: PositionChangeWakeEvent = {
            eventId: `__position_change_${this.currentTick}_${generateId()}`,
            targetTick: this.currentTick,
            status: 'PENDING',
            eventType: 'POSITION_CHANGE',
            entityId: [...this.pendingPositionChanges][0],
        };
        this.pendingPositionWakeTick = this.currentTick;
        this.eventQueue.push(wake);
    }

    private resolveClash(clashEvents: ActionExecutionEvent[]): void {
        this.logger.game(
            `⚡ [ClashPool] Tick ${this.currentTick}: ${clashEvents.length} 个事件冲突`,
            null, LogVisibility.PLAYER, this.logCtx()
        );

        const result: ClashResult = ClashPool.resolve(
            clashEvents,
            this.entities,
            this.currentTick,
            0,
            (target) => this.triggerInterrupt(target),
            this.actionCatalog,
        );

        for (const mutation of result.mutations) {
            this.recordMutation(mutation.entityId, mutation.changes);
        }

        // Launch is part of an irreversible ACTIVE commit. A same-priority
        // sibling may have killed/interrupted the source during this group;
        // that must not retract a launch already admitted by its snapshot.
        for (const event of clashEvents) {
            if (event.positionTriggered || result.appliedTargetIds?.[event.eventId] === undefined) continue;
            const actor = this.entities.get(event.actorId);
            const template = this.actionCatalog.getAction(event.actionTemplateId);
            if (actor && template?.launchProjectile) this.projectileRuntime.launch(actor, event, template);
        }

        const allMutatedIds = [...new Set(result.mutations.map(m => m.entityId))];
        this.checkSustainAfterMutations(allMutatedIds);

        for (const death of result.deaths) {
            const entity = this.entities.get(death.entityId);
            if (!entity) continue;
            this.logger.game(
                `💀 [Death] Tick ${this.currentTick}: ${death.entityId} 被击杀` +
                (death.wasPoiseBreak ? ' (韧击破)' : ''),
                null, LogVisibility.PLAYER, this.logCtx()
            );
            this.cancelCurrentAction(entity);
            // A dead actor has no recovery boundary to complete. Remove its
            // scheduled rail immediately so a finished action cannot linger
            // in later snapshots as a fresh DELAY/T0 entry.
            this.removeScheduledActionsForEntity(entity.id);
            this.recordMutation(entity.id, { 'currentActionContext': null });
            this.emit('ENTITY_DIED', entity);
        }

        for (const [idA, idB] of result.mutualKillPairs) {
            this.emit('VISUAL_FX', {
                tick: this.currentTick,
                events: [{
                    eventId: generateId(),
                    eventType: 'MUTUAL_KILL',
                    sourceId: idA,
                    targetId: idB,
                    fxTemplateId: 'mutual_kill',
                    durationMs: 1500,
                    text: '⚔️ 相杀!'
                }]
            });
        }

        for (const ce of clashEvents) {
            // A reaction interrupt may have opened its causal window when it
            // was declared.  ClashPool resolves its STARTUP directly, so
            // consume the marker here instead of retaining it indefinitely.
            this.preOpenedReactionActions.delete(ce.eventId);
            const actor = this.entities.get(ce.actorId);
            if (!actor?.currentActionContext || actor.currentActionContext.actionId !== ce.eventId) continue;
            if (ce.positionTriggered) {
                this.markActiveWindowTargets(actor, result.appliedTargetIds?.[ce.eventId] ?? []);
                continue;
            }
            const template = this.actionCatalog.getAction(ce.actionTemplateId);
            if (template && CombatEngine.usesEventDrivenWindows(template)) {
                // ClashPool commits the effect snapshot, while channel pulse
                // costs are lifecycle bookkeeping owned by CombatEngine.
                // Charge this event exactly once before opening its ACTIVE
                // window so a same-Tick clash cannot silently create a free
                // channel pulse.
                const channelMustStop = this.payChannelPulseCost(actor, template);
                if (actor.currentActionContext?.actionId !== ce.eventId) continue;
                actor.currentActionContext.stopAfterActiveWindow = channelMustStop;
                this.beginActiveWindow(actor, ce, template, result.appliedTargetIds?.[ce.eventId] ?? []);
            } else if (template) {
                this.pushNextPhase(actor, ce);
            }
        }

        // Synthetic position events use the source actor's ACTIVE context,
        // whose actionId is the end marker rather than the synthetic id.  The
        // branch above intentionally skips the context-id guard for them.
        for (const ce of clashEvents.filter(event => event.positionTriggered)) {
            const actor = this.entities.get(ce.actorId);
            if (!actor?.currentActionContext) continue;
            this.markActiveWindowTargets(actor, result.appliedTargetIds?.[ce.eventId] ?? []);
        }

        this.checkAndEndCombat();
    }

    private resolveSingleEvent(event: TickEvent): void {
        if ((event as Partial<BlockZoneExpiryEvent>).eventType === 'BLOCK_ZONE_EXPIRE') {
            const expiry = event as BlockZoneExpiryEvent;
            const owner = this.entities.get(expiry.ownerId);
            this.scheduledBlockZones.delete(expiry.zoneId);
            if (owner?.formationContext?.blockZones?.some(zone => zone.id === expiry.zoneId)) {
                owner.formationContext.blockZones = owner.formationContext.blockZones.filter(zone => zone.id !== expiry.zoneId);
                this.recordMutation(owner.id, { formationContext: structuredClone(owner.formationContext) });
                this.logger.game(`🚧 [Blockade] ${owner.id} 的封锁区已到期`, { actorId: owner.id }, LogVisibility.PLAYER, this.logCtx());
            }
        } else if ((event as ActionExecutionEvent).eventType === 'ACTION_PHASE') {
            this.resolveActionEvent(event as ActionExecutionEvent);
        } else if ((event as MovementStepEvent).eventType === 'MOVEMENT_STEP') {
            this.resolveMovementStep(event as MovementStepEvent);
        } else if ((event as ProjectileAdvanceEvent).eventType === 'PROJECTILE_ADVANCE') {
            this.projectileRuntime.resolveAdvance(event as ProjectileAdvanceEvent);
        }

        this.checkAndEndCombat();
    }

    // ============================================================
    //  MovementStep（兼容旧事件）
    // ============================================================

    private resolveMovementStep(moveEvt: MovementStepEvent): void {
        const actor = this.entities.get(moveEvt.actorId);
        if (!actor) return;

        actor.transform.coords.x = moveEvt.currentCoords.x;
        actor.transform.coords.y = moveEvt.currentCoords.y;
        actor.transform.coords.z = moveEvt.currentCoords.z;

        this.recordMutation(actor.id, {
            'transform.coords.x': moveEvt.currentCoords.x,
            'transform.coords.y': moveEvt.currentCoords.y,
            'transform.coords.z': moveEvt.currentCoords.z
        });
        this.notifyPositionChanged(actor.id);

        if (moveEvt.isLastStep) {
            actor.currentActionContext = undefined;
            this.recordMutation(actor.id, { 'currentActionContext': null });
        }
    }

    // ============================================================
    //  ActionEvent 结算 + 递归分叉
    // ============================================================

    private resolveActionEvent(actEvent: ActionExecutionEvent): void {
        const actor = this.entities.get(actEvent.actorId);
        if (!actor || actor.currentActionContext?.actionId !== actEvent.eventId) return;

        if (actor.currentActionContext.type === 'MOVING') {
            this.resolveMovementPulse(actor, actEvent);
        } else {
            this.resolveActionPulse(actor, actEvent);
        }
    }

    private resolveMovementPulse(actor: Entity, actEvent: ActionExecutionEvent): void {
        const ctx = actor.currentActionContext!;

        if (actEvent.phase === 'RECOVERY' || !ctx.waypoints || (ctx.currentWaypointIndex ?? 0) >= (ctx.waypoints?.length ?? 0)) {
            // Movement has its own resolver, so it does not pass through the
            // legacy RECOVERY branch below. Remove the scheduled rail when
            // the authoritative recovery event completes; otherwise every
            // completed move remains visible as a stale timeline entry.
            this.removeScheduledAction(actor.id, '__BUILTIN_MOVE__');
            this.movementTiming.delete(actor.id);
            actor.currentActionContext = undefined;
            this.recordMutation(actor.id, { 'currentActionContext': null });
            return;
        }

        const waypoints = ctx.waypoints;
        const index = ctx.currentWaypointIndex ?? 0;

        let wp = waypoints[index];
        const blocked = FormationService.checkMoveBlocked(actor, wp, this.entities, this.logCtx());
        if (blocked.blocked) {
            wp = blocked.adjustedTarget;
            waypoints[index] = wp;
            waypoints.length = index + 1;
        }
        // 计算朝向：从当前位置指向目标航点
        const newFacing = VectorMath.directionAngleFromOffset(
            actor.transform.coords.x, actor.transform.coords.y,
            wp.x, wp.y,
        );
        actor.transform.coords.x = wp.x;
        actor.transform.coords.y = wp.y;
        actor.transform.coords.z = wp.z;
        actor.transform.facing = newFacing;

        this.recordMutation(actor.id, {
            'transform.coords.x': wp.x,
            'transform.coords.y': wp.y,
            'transform.coords.z': wp.z,
            'transform.facing': newFacing,
        });
        this.notifyPositionChanged(actor.id);

        ctx.pulseCount = (ctx.pulseCount ?? 0) + 1;

        //  记录实际脉冲 tick（增量时间轴修正）
        if (!ctx.pulseTickHistory) ctx.pulseTickHistory = [];
        ctx.pulseTickHistory.push(this.currentTick);

        // Phase 3.4: 更新冲刺状态
        ctx.lastMoveTick = this.currentTick;
        ctx.consecutiveMoves = (ctx.consecutiveMoves ?? 0) + 1;

        // Phase 3.4: 使用冲刺加速后的步间隔
        const sprintInterval = SpatialSystem.sprintTickCost(
            (ctx.consecutiveMoves ?? 0) - 1, // 前一次移动次数作为加速依据
            this.movementTiming.get(actor.id)?.interval ?? MOVE_INTERVAL_TICKS,
            0.1,
            0.5,
            1
        ) * SpatialActionSystem.movementCost(this.battlefield, waypoints[index + 1] ?? wp);

        const nextIndex = index + 1;
        if (nextIndex < waypoints.length) {
            ctx.currentWaypointIndex = nextIndex;
            this.pushNextPulse(actor, actEvent, sprintInterval);
        } else {
            this.logger.game(
                `✅ [Move] Tick ${this.currentTick}: ${actor.id} 到达目的地，进入收招`,
                null, LogVisibility.PLAYER, this.logCtx()
            );
            // 标记所有航点已完成，确保 emitTimelineUpdate 的 remaining=0
            ctx.currentWaypointIndex = waypoints.length;
            const recoveryEvt: ActionExecutionEvent = {
                ...actEvent,
                eventId: generateId(),
                targetTick: this.currentTick + 1 + (this.movementTiming.get(actor.id)?.recovery ?? MOVE_RECOVERY_TICKS),
                status: 'PENDING',
                phase: 'RECOVERY'
            };
            this.eventQueue.push(recoveryEvt);
            actor.currentActionContext = {
                ...actor.currentActionContext!,
                actionId: recoveryEvt.eventId,
                phase: 'RECOVERY',
                resolveTick: recoveryEvt.targetTick
            };
            this.recordMutation(actor.id, { 'currentActionContext': actor.currentActionContext });
        }

        // 增量时间轴修正：推送实际脉冲 + 预计算剩余
        this.emitTimelineUpdate(actor, '__BUILTIN_MOVE__', 'Move');
    }

    /** Resolve a STARTUP event into an event-driven ACTIVE window. */
    private resolveEventDrivenPulse(actor: Entity, actEvent: ActionExecutionEvent, template: ActionTemplate): void {
        const ctx = actor.currentActionContext;
        if (!ctx) return;

        if (actEvent.phase === 'STARTUP') {
            const preOpened = this.preOpenedReactionActions.delete(actEvent.eventId);
            const mayOpenChain = !template.tags.includes('REACTION') || template.tags.includes('INTERRUPT');
            const opened = preOpened || (mayOpenChain && this.generateSystemHooks(actEvent));
            if (opened && this.pendingDecisionCount > 0) {
                // The decision pause does not advance Tick.  Move the actual
                // window with the deferred event so a one-Tick window is not
                // silently closed while clients choose a reaction.
                const deferredStart = this.currentTick + 1;
                const deferredEvent: ActionExecutionEvent = {
                    ...actEvent,
                    eventId: generateId(),
                    targetTick: deferredStart,
                    status: 'PENDING',
                    phase: 'ACTIVE',
                    activeWindowStart: deferredStart,
                    activeWindowEnd: deferredStart + strikeWindowTicks(template),
                };
                this.eventQueue.push(deferredEvent);
                actor.currentActionContext = {
                    ...ctx,
                    actionId: deferredEvent.eventId,
                    phase: 'STARTUP',
                    resolveTick: deferredEvent.targetTick,
                };
                this.recordMutation(actor.id, { 'currentActionContext': actor.currentActionContext });
                return;
            }
            if (actor.currentActionContext?.actionId !== actEvent.eventId
                && actor.currentActionContext?.phase !== 'ACTIVE') return;
        }

        const declaredTargets = (actEvent.targetIds ?? [])
            .map(id => this.entities.get(id))
            .filter((entity): entity is Entity => entity !== undefined);
        // SELF is resolved by EffectSystem from the actor.  Do not inject the
        // actor into this list: an explicitly declared actor target remains a
        // valid PRIMARY target and keeps the established intent semantics.
        const candidates = declaredTargets
            .filter(target => CombatEngine.isTargetInRange(template, actor, target));

        this.logger.game(
            `⚔️ [Action] Tick ${this.currentTick}: ${actor.id}/${template.id} `
            + `strike#${(actEvent.strikeIndex ?? 0) + 1}/${actEvent.strikeCount ?? 1}`,
            null,
            LogVisibility.PLAYER,
            this.logCtx(),
        );

        const launchTemplate = template.launchProjectile ? {
            ...template, effects: template.effects.filter(effect => effect.targetSelector === 'SELF'),
        } : template;
        const consumedTargetIds = this.applyActiveWindowEffects(actor, launchTemplate, actEvent, candidates);
        if (!actEvent.positionTriggered
            && template.effects.some(effect => effect.targetSelector === 'SELF')) {
            // SELF is a separate ledger entry, independent from PRIMARY
            // target selection.  It is consumed even when there are no
            // external candidates at the window boundary.
            consumedTargetIds.push(actor.id);
        }
        const affectedIds = [...new Set(consumedTargetIds)];
        this.checkSustainAfterMutations([...affectedIds, actor.id]);

        // An interrupt, lethal effect, or sustain failure can invalidate the
        // source while the effect callback is running.  The committed effect
        // remains, but no future window may be scheduled from this stale id.
        if (actor.currentActionContext?.actionId !== actEvent.eventId) return;

        if (template.launchProjectile) this.projectileRuntime.launch(actor, actEvent, template);

        const channelMustStop = this.payChannelPulseCost(actor, template);
        actor.currentActionContext!.stopAfterActiveWindow = channelMustStop;

        this.beginActiveWindow(actor, actEvent, template, consumedTargetIds);
        this.emitTimelineUpdate(actor, template.id, template.id);
    }

    /** Pay one explicit channel pulse cost after its effect snapshot commits. */
    private payChannelPulseCost(actor: Entity, template: ActionTemplate): boolean {
        const channel = template.channelOptions;
        if (!channel?.pulseResourceCost) return false;

        for (const [resKey, expr] of Object.entries(channel.pulseResourceCost)) {
            const cost = Math.abs(RuleEvaluator.evaluate(expr, { actor }).total);
            if (cost <= 0) continue;
            const current = actor.resources.current[resKey] ?? 999;
            actor.resources.current[resKey] = Math.max(0, current - cost);
            this.recordMutation(actor.id, { [`resources.current.${resKey}`]: actor.resources.current[resKey] });
        }

        return Boolean(template.sustainResources?.some(resource =>
            (actor.resources.current[resource] ?? 0) <= 0
        ));
    }

    /**
     * Apply one ACTIVE check while preserving the established cover, reach,
     * micro-evasion, sustain and interrupt paths.  The returned ids are the
     * targets consumed by this strike, including a guarded/covered target;
     * each target is checked at most once per window.
     */
    private applyActiveWindowEffects(
        actor: Entity,
        template: ActionTemplate,
        event: ActionExecutionEvent,
        candidates: Entity[],
    ): EntityId[] {
        const hasSelfEffect = template.effects.some(effect => effect.targetSelector === 'SELF');
        const hasAreaEffect = template.effects.some(effect => effect.targetSelector === 'ALL_IN_AOE');
        if (candidates.length === 0 && !hasAreaEffect && !template.spatial && (!hasSelfEffect || event.positionTriggered)) return [];

        const microEvasionMap: Record<string, AttackTag> = {
            MICRO_EVADE_DUCK: 'HIGH',
            MICRO_EVADE_HOP: 'LOW',
            MICRO_EVADE_SLIP: 'LINEAR',
        };
        const eligibleTargets: Entity[] = [];
        for (const target of candidates) {
            const targetAction = target.currentActionContext?.actionTemplateId;
            const evadedTag = targetAction ? microEvasionMap[targetAction] : undefined;
            if (evadedTag && template.attackTags?.includes(evadedTag)) {
                this.emit('VISUAL_FX', {
                    tick: this.currentTick,
                    events: [{
                        eventId: generateId(),
                        eventType: 'WHIFF',
                        sourceId: actor.id,
                        targetId: target.id,
                        fxTemplateId: 'micro_evade',
                        durationMs: 800,
                        text: '🔄 微避成功!',
                    }],
                });
                continue;
            }
            eligibleTargets.push(target);
        }

        const coverDrMap = new Map<string, number>();
        const coverFilteredTargets = eligibleTargets.filter(target => {
            if (template.launchProjectile) return true;
            if (target.type === 'PROJECTILE') return true;
            const cover = CoverService.getCoverBetween(actor.transform.coords, target);
            if (!cover) return true;
            if (target.currentStance === 'BLIND_FIRE') return false;

            const d20 = Math.floor(Math.random() * 20) + 1;
            const stance = actor.currentStance ?? 'NONE';
            const adjustedRoll = Math.max(1, Math.min(20, d20 + CoverService.getAccuracyModifier(stance)));
            const { penetrates } = CoverService.checkCoverPenetration(cover, adjustedRoll);
            if (penetrates) {
                if (cover.coverDr > 0) coverDrMap.set(target.id, cover.coverDr);
                return true;
            }

            this.emit('VISUAL_FX', {
                tick: this.currentTick,
                events: [{
                    eventId: generateId(),
                    eventType: 'COLLISION',
                    sourceId: actor.id,
                    targetId: target.id,
                    fxTemplateId: 'cover_hit',
                    durationMs: 500,
                    text: '🧱 命中掩体!',
                }],
            });
            return false;
        });

        const maxReach = template.range?.distanceExpr
            ? Math.abs(RuleEvaluator.evaluate(template.range.distanceExpr, { actor }).total)
            : Number.POSITIVE_INFINITY;
        const reachFilteredTargets = coverFilteredTargets.filter(target =>
            SpatialSystem.isInReach(
                VectorMath.distance(actor.transform.coords, target.transform.coords),
                maxReach,
                template.spatial?.reach?.minReach ?? 0,
            ),
        );

        // Position rechecks only repeat effects that can target the newly
        // entering entity.  In particular, SELF buffs/heals belong to the
        // original strike and must never be applied once per entering target.
        const effectTemplate = event.positionTriggered
            ? {
                ...template,
                effects: template.effects.filter(effect => effect.targetSelector !== 'SELF'),
            }
            : template;
        const allowNegativeResources = new Set<string>();
        for (const entity of this.entities.values()) {
            const entityContext = entity.currentActionContext;
            if (!entityContext || (entityContext.phase !== 'STARTUP' && entityContext.phase !== 'CHANNELING')) continue;
            const entityTemplate = entityContext.actionTemplateId
                ? this.actionCatalog.getAction(entityContext.actionTemplateId)
                : undefined;
            for (const key of entityTemplate?.sustainResources ?? []) allowNegativeResources.add(key);
        }
        const mutations = EffectSystem.applyAction(
            effectTemplate,
            actor,
            reachFilteredTargets,
            {
                ...this.logCtx(),
                allowNegativeResources: [...allowNegativeResources],
                originCoords: event.targetCoords,
                applySpatial: !event.positionTriggered,
                coverChecked: true,
                actionCatalog: this.actionCatalog,
            },
            target => this.triggerInterrupt(target),
            coverDrMap,
        );
        for (const [entityId, changes] of mutations.entries()) {
            this.recordMutation(entityId, changes);
        }

        // Every candidate was range-checked during this ACTIVE visit.  A
        // covered or micro-evaded target still consumes its once-per-strike
        // opportunity and cannot be hit again by a second position event.
        return candidates.map(target => target.id);
    }

    /** Close a half-open ACTIVE window and schedule the next lifecycle node. */
    private finishActiveWindow(actor: Entity, endEvent: ActionExecutionEvent, template: ActionTemplate): void {
        const context = actor.currentActionContext;
        if (!context) return;
        if (context.actionId !== endEvent.eventId) return;

        context.activeWindowStart = undefined;
        context.activeWindowEnd = undefined;
        context.activeTargetIds = undefined;
        context.activeHitTargetIds = undefined;
        const stopChannel = context.stopAfterActiveWindow === true;
        context.stopAfterActiveWindow = undefined;

        const currentStrike = endEvent.strikeIndex ?? context.activeStrikeIndex ?? 0;
        const totalStrikes = endEvent.strikeCount ?? context.activeStrikeCount ?? 1;
        if (template.strikeSequence && currentStrike + 1 < totalStrikes) {
            const nextIndex = currentStrike + 1;
            const nextStart = this.currentTick + strikeStartupTicks(template);
            const nextEvent: ActionExecutionEvent = {
                ...endEvent,
                eventId: generateId(),
                targetTick: nextStart,
                status: 'PENDING',
                phase: 'STARTUP',
                strikeIndex: nextIndex,
                strikeCount: totalStrikes,
                activeWindowStart: nextStart,
                activeWindowEnd: nextStart + strikeWindowTicks(template),
                activeWindowEndEvent: false,
                positionTriggered: false,
            };
            this.eventQueue.push(nextEvent);
            context.actionId = nextEvent.eventId;
            context.phase = 'STARTUP';
            context.activeStrikeIndex = nextIndex;
            context.resolveTick = nextEvent.targetTick;
            this.recordMutation(actor.id, { 'currentActionContext': context });
            return;
        }

        const channel = template.channelOptions;
        const pulseCount = context.pulseCount ?? 0;
        if (!stopChannel && channel && (!channel.maxPulses || pulseCount < channel.maxPulses)) {
            // Existing channel intervals describe pulse-start to pulse-start.
            // The next startup therefore waits only for the interval remainder
            // after this window's exclusive end.
            const interval = Math.max(1, Math.floor(channel.intervalTicks));
            const nextStart = this.currentTick + Math.max(0, interval - activeWindowTicks(template));
            const nextEvent: ActionExecutionEvent = {
                ...endEvent,
                eventId: generateId(),
                targetTick: nextStart,
                status: 'PENDING',
                phase: 'STARTUP',
                strikeIndex: currentStrike + 1,
                strikeCount: totalStrikes,
                activeWindowStart: nextStart,
                activeWindowEnd: nextStart + activeWindowTicks(template),
                activeWindowEndEvent: false,
                positionTriggered: false,
            };
            this.eventQueue.push(nextEvent);
            context.actionId = nextEvent.eventId;
            context.phase = 'CHANNELING';
            context.resolveTick = nextEvent.targetTick;
            this.recordMutation(actor.id, { 'currentActionContext': context });
            this.emitTimelineUpdate(actor, template.id, template.id);
            return;
        }

        const recoveryEvent: ActionExecutionEvent = {
            ...endEvent,
            eventId: generateId(),
            targetTick: this.currentTick + template.timeCost.recoveryTicks,
            status: 'PENDING',
            phase: 'RECOVERY',
            activeWindowStart: undefined,
            activeWindowEnd: undefined,
            activeWindowEndEvent: false,
            positionTriggered: false,
        };
        this.eventQueue.push(recoveryEvent);
        context.actionId = recoveryEvent.eventId;
        context.phase = 'RECOVERY';
        context.resolveTick = recoveryEvent.targetTick;
        this.recordMutation(actor.id, { 'currentActionContext': context });
        this.emitTimelineUpdate(actor, template.id, template.id);
    }

    private resolveActionPulse(actor: Entity, actEvent: ActionExecutionEvent): void {
        const ctx = actor.currentActionContext!;

        if (actEvent.activeWindowEndEvent) {
            const template = this.actionCatalog.getAction(actEvent.actionTemplateId);
            if (template) this.finishActiveWindow(actor, actEvent, template);
            return;
        }

        // Events produced by the current action path carry an explicit
        // window.  Legacy/internal actions without the optional metadata keep
        // the historical resolver below (including their bespoke recovery).
        if (actEvent.activeWindowStart !== undefined || actEvent.activeWindowEnd !== undefined) {
            const template = this.actionCatalog.getAction(actEvent.actionTemplateId);
            if (template) this.resolveEventDrivenPulse(actor, actEvent, template);
            return;
        }

        // === RECOVERY phase: 动作已完成，清除上下文 ===
        if (actEvent.phase === 'RECOVERY') {
            this.removeScheduledAction(actor.id, actEvent.actionTemplateId);
            if (actEvent.actionTemplateId === 'DODGE') {
                this.logger.game(
                    `💨 [Dodge] Tick ${this.currentTick}: ${actor.id} 闪避收招完成.`,
                    null, LogVisibility.PLAYER, this.logCtx()
                );
            } else {
                this.logger.game(
                    `🛡️ [Action] Tick ${this.currentTick}: ${actor.id} 收招完成.`,
                    null, LogVisibility.PLAYER, this.logCtx()
                );
            }
            actor.currentActionContext = undefined;
            this.recordMutation(actor.id, { 'currentActionContext': null });
            return;
        }

        // === 内置动作: 姿态切换 ===
        if (actEvent.actionTemplateId === '__BUILTIN_ROTATE__') {
            const facing = this.pendingRotations.get(actor.id);
            if (facing !== undefined) {
                actor.transform.facing = facing;
                this.pendingRotations.delete(actor.id);
                this.recordMutation(actor.id, { 'transform.facing': facing });
                for (const [id, changes] of SpatialActionSystem.refreshCover(actor, this.entities)) this.recordMutation(id, changes);
            }
            actor.currentActionContext = undefined;
            this.recordMutation(actor.id, { currentActionContext: null });
            return;
        }

        if (actEvent.actionTemplateId === '__BUILTIN_STANCE__') {
            const pendingStance = this.pendingStances.get(actor.id);
            if (pendingStance) {
                actor.currentStance = pendingStance;
                this.pendingStances.delete(actor.id);
                this.recordMutation(actor.id, { 'currentStance': pendingStance });
                this.logger.game(
                    `🔄 [Stance] Tick ${this.currentTick}: ${actor.id} 姿态切换完成 → ${pendingStance}`,
                    { actorId: actor.id, stance: pendingStance },
                    LogVisibility.PLAYER, this.logCtx()
                );
            }
            actor.currentActionContext = undefined;
            this.recordMutation(actor.id, { 'currentActionContext': null });
            return;
        }

        // === STARTUP (第一个或递归脉冲): 执行效果 + 决定后续 ===
        const template = this.actionCatalog.getAction(actEvent.actionTemplateId);
        if (!template) return;

        // Open system reactions at the source action's startup boundary.  The
        // actual ACTIVE effect is held for one tick while asynchronous clients
        // choose.  Synchronous legacy test listeners may answer from inside
        // DECISION_POLL; in that case there is no need to defer the effect.
        if (actEvent.phase === 'STARTUP') {
            const preOpened = this.preOpenedReactionActions.delete(actEvent.eventId);
            const mayOpenChain = !template.tags.includes('REACTION') || template.tags.includes('INTERRUPT');
            const opened = preOpened || (mayOpenChain && this.generateSystemHooks(actEvent));
            if (opened && this.pendingDecisionCount > 0) {
                const deferredEvent: ActionExecutionEvent = {
                    ...actEvent,
                    eventId: generateId(),
                    targetTick: this.currentTick + 1,
                    status: 'PENDING',
                    phase: 'ACTIVE'
                };
                this.eventQueue.push(deferredEvent);
                actor.currentActionContext = {
                    ...ctx,
                    actionId: deferredEvent.eventId,
                    // Keep the source in STARTUP until the held ACTIVE event
                    // resolves, allowing an INTERRUPT reaction to cancel it.
                    phase: 'STARTUP',
                    resolveTick: deferredEvent.targetTick
                };
                this.recordMutation(actor.id, { 'currentActionContext': actor.currentActionContext });
                return;
            }
            if (actor.currentActionContext?.actionId !== actEvent.eventId &&
                actor.currentActionContext?.phase !== 'ACTIVE') {
                return;
            }
        }

        const targets = (actEvent.targetIds || [])
            .map(id => this.entities.get(id))
            .filter(e => e) as Entity[];

        const pulseNum = (ctx.pulseCount ?? 0) + 1;

        this.logger.game(
            `⚔️ [Action] Tick ${this.currentTick}: ${actor.id}/${template.id} pulse#${pulseNum}`,
            null, LogVisibility.PLAYER, this.logCtx()
        );

        // === 微闪避检测: 检查目标是否正在进行微闪避 ===
        const microEvasionMap: Record<string, string> = {
            'MICRO_EVADE_DUCK': 'HIGH',
            'MICRO_EVADE_HOP': 'LOW',
            'MICRO_EVADE_SLIP': 'LINEAR'
        };

        let microEvasionTriggered = false;
        for (const target of targets) {
            const targetCtx = target.currentActionContext;
            if (!targetCtx?.actionTemplateId || !microEvasionMap[targetCtx.actionTemplateId]) continue;

            const evadedTag = microEvasionMap[targetCtx.actionTemplateId];
            const attackHasTag = template.attackTags?.includes(evadedTag as any);

            if (attackHasTag) {
                microEvasionTriggered = true;
                this.logger.game(`🔄 [MicroEvade] ${target.id} 的 ${targetCtx.actionTemplateId} 成功闪避了 ${template.id} (Tag: ${evadedTag}匹配)`, null, LogVisibility.PLAYER, this.logCtx());

                actEvent.whiffed = true;
                const extendedRecovery = Math.ceil(template.timeCost.recoveryTicks * 1.5);

                const recoveryEvt: ActionExecutionEvent = {
                    ...actEvent,
                    eventId: generateId(),
                    targetTick: this.currentTick + extendedRecovery,
                    status: 'PENDING',
                    phase: 'RECOVERY'
                };
                this.eventQueue.push(recoveryEvt);
                actor.currentActionContext = {
                    ...actor.currentActionContext!,
                    actionId: recoveryEvt.eventId,
                    phase: 'RECOVERY',
                    resolveTick: recoveryEvt.targetTick
                };

                this.emit('VISUAL_FX', {
                    tick: this.currentTick,
                    events: [{
                        eventId: generateId(),
                        eventType: 'WHIFF',
                        sourceId: actor.id,
                        targetId: target.id,
                        fxTemplateId: 'micro_evade',
                        durationMs: 800,
                        text: '🔄 微避成功!'
                    }]
                });
                break;
            } else {
                this.logger.game(`💥 [MicroEvade] ${target.id} 的 ${targetCtx.actionTemplateId} 未能闪避 ${template.id} (Tag不匹配)`, null, LogVisibility.PLAYER, this.logCtx());
            }
        }

        if (microEvasionTriggered) return;

        // === 挥空检测: Check range for whiff ===
        let allTargetsInRange = true;
        if (template.range && template.range.distanceExpr && targets.length > 0) {
            for (const target of targets) {
                const dist = VectorMath.distance(actor.transform.coords, target.transform.coords);
                const maxRange = Math.abs(RuleEvaluator.evaluate(template.range.distanceExpr, { actor }).total);
                if (dist > maxRange + 0.1) {
                    allTargetsInRange = false;
                    break;
                }
            }

            if (!allTargetsInRange) {
                for (const target of targets) {
                    if (target.currentActionContext?.actionTemplateId === 'DODGE' &&
                        target.currentActionContext?.phase === 'ACTIVE') {
                        allTargetsInRange = false;
                    }
                }
            }
        }

        if (!allTargetsInRange && targets.length > 0) {
            actEvent.whiffed = true;
            const extendedRecovery = Math.ceil(template.timeCost.recoveryTicks * 1.5);

            this.logger.game(`💨 [Whiff] Tick ${this.currentTick}: ${actor.id} 的 ${template.id} 未命中! 收招延长至 ${extendedRecovery}`, null, LogVisibility.PLAYER, this.logCtx());

            this.emit('VISUAL_FX', {
                tick: this.currentTick,
                events: [{
                    eventId: generateId(),
                    eventType: 'WHIFF',
                    sourceId: actor.id,
                    fxTemplateId: 'whiff',
                    durationMs: 500,
                    text: '💨 挥空!'
                }]
            });

            const recoveryEvt: ActionExecutionEvent = {
                ...actEvent,
                eventId: generateId(),
                targetTick: this.currentTick + extendedRecovery,
                status: 'PENDING',
                phase: 'RECOVERY'
            };
            this.eventQueue.push(recoveryEvt);
            actor.currentActionContext = {
                ...actor.currentActionContext!,
                actionId: recoveryEvt.eventId,
                phase: 'RECOVERY',
                resolveTick: recoveryEvt.targetTick
            };
            return;
        }

        // === 掩体判定 (Phase 3.3): 命中前检查目标掩体状态 ===
        const coverDrMap = new Map<string, number>();
        const filteredTargets = targets.filter(target => {
            if (template.launchProjectile) return true;
            // 跳过弹道实体（弹道系统自己处理碰撞）
            if (target.type === 'PROJECTILE') return true;

            const cover = CoverService.getCoverBetween(actor.transform.coords, target);
            if (!cover) return true; // 无掩体
            if (target.currentStance === 'BLIND_FIRE') return false;

            // 掷 d20 判定掩体碰撞
            const d20 = Math.floor(Math.random() * 20) + 1;
            const stance = actor.currentStance ?? 'NONE';
            const accuracyMod = CoverService.getAccuracyModifier(stance);
            const adjustedRoll = Math.max(1, Math.min(20, d20 + accuracyMod));

            const { penetrates, hitsCover } = CoverService.checkCoverPenetration(cover, adjustedRoll);

            if (penetrates) {
                // 穿透掩体：应用掩体 DR
                if (cover.coverDr > 0) {
                    coverDrMap.set(target.id, cover.coverDr);
                }

                // ADS 姿态：通过过滤部位命中表来限制暴露部位
                if (stance === 'ADS') {
                    const exposed = CoverService.getExposedParts('ADS');
                    this.logger.game(
                        `🎯 [Cover] Tick ${this.currentTick}: ${target.id} ADS姿态, 暴露部位: [${exposed.join(', ')}]`,
                        { targetId: target.id, stance, exposedParts: exposed },
                        LogVisibility.PLAYER, this.logCtx()
                    );
                }

                this.logger.game(
                    `🎯 [Cover] Tick ${this.currentTick}: ${actor.id} 的攻击穿透 ${target.id} 的${cover.coverType === 'FULL' ? '全' : '半'}掩体 (d20=${d20}, adj=${adjustedRoll}, thr=${cover.coverThreshold})`,
                    { actorId: actor.id, targetId: target.id, d20, adjustedRoll, threshold: cover.coverThreshold },
                    LogVisibility.PLAYER, this.logCtx()
                );
                return true;
            } else {
                // 命中掩体
                this.logger.game(
                    `🧱 [Cover] Tick ${this.currentTick}: ${actor.id} 的攻击命中 ${target.id} 的${cover.coverType === 'FULL' ? '全' : '半'}掩体 (d20=${d20}, adj=${adjustedRoll}, thr=${cover.coverThreshold})`,
                    { actorId: actor.id, targetId: target.id, d20, adjustedRoll, threshold: cover.coverThreshold },
                    LogVisibility.PLAYER, this.logCtx()
                );

                this.emit('VISUAL_FX', {
                    tick: this.currentTick,
                    events: [{
                        eventId: generateId(),
                        eventType: 'COLLISION',
                        sourceId: actor.id,
                        targetId: target.id,
                        fxTemplateId: 'cover_hit',
                        durationMs: 500,
                        text: '🧱 命中掩体!'
                    }]
                });
                return false; // 从目标列表中移除
            }
        });

        // === 触及/死角判定 (Phase 3.4): 排除超出触及范围的目标 ===
        // 覆盖 whiff 检测，提供更细粒度的死角/贴太近惩罚
        const maxReachFromTemplate = template.range?.distanceExpr
            ? Math.abs(RuleEvaluator.evaluate(template.range.distanceExpr, { actor }).total)
            : 999;
        const minReach = template.spatial?.reach?.minReach ?? template.launchProjectile?.minRange ?? 0;
        const outOfReachTargets: EntityId[] = [];
        for (const target of filteredTargets) {
            const dist = VectorMath.distance(actor.transform.coords, target.transform.coords);
            if (!SpatialSystem.isInReach(dist, maxReachFromTemplate, minReach)) {
                outOfReachTargets.push(target.id);
                this.logger.game(
                    `💨 [Reach] Tick ${this.currentTick}: ${target.id} 超出 ${actor.id} 的触及范围 (距离=${dist.toFixed(1)}, 最大=${maxReachFromTemplate})`,
                    { actorId: actor.id, targetId: target.id, dist, maxReach: maxReachFromTemplate },
                    LogVisibility.PLAYER, this.logCtx()
                );
            }
        }

        // === 背刺判定 (Phase 3.4): 检查攻击者是否在目标背后 ===
        let isBackstabAttack = false;
        for (const target of filteredTargets) {
            if (outOfReachTargets.includes(target.id)) continue;
            if (SpatialSystem.isBackstab(actor, target)) {
                isBackstabAttack = true;
                this.logger.game(
                    `🗡️ [Backstab] Tick ${this.currentTick}: ${actor.id} 在 ${target.id} 背后攻击!`,
                    { actorId: actor.id, targetId: target.id },
                    LogVisibility.PLAYER, this.logCtx()
                );
            }
        }

        // 从目标列表中移除超出触及范围的目标
        const reachFilteredTargets = filteredTargets.filter(
            t => !outOfReachTargets.includes(t.id)
        );

        const allowNegativeResources = new Set<string>();
        for (const entity of this.entities.values()) {
            const entityContext = entity.currentActionContext;
            if (!entityContext || (entityContext.phase !== 'STARTUP' && entityContext.phase !== 'CHANNELING')) continue;
            const entityTemplate = entityContext.actionTemplateId
                ? this.actionCatalog.getAction(entityContext.actionTemplateId)
                : undefined;
            for (const key of entityTemplate?.sustainResources ?? []) allowNegativeResources.add(key);
        }
        const mutations = EffectSystem.applyAction(
            template.launchProjectile ? { ...template, effects: template.effects.filter(effect => effect.targetSelector === 'SELF') } : template,
            actor,
            reachFilteredTargets,
            { ...this.logCtx(), allowNegativeResources: [...allowNegativeResources], originCoords: actEvent.targetCoords,
                coverChecked: true, actionCatalog: this.actionCatalog },
            (target) => this.triggerInterrupt(target),
            coverDrMap
        );

        const affectedIds: EntityId[] = [];
        for (const [targetId, changes] of mutations.entries()) {
            this.recordMutation(targetId, changes);
            affectedIds.push(targetId);
        }

        ctx.pulseCount = pulseNum;

        // 记录实际脉冲 tick（增量时间轴修正）
        if (!ctx.pulseTickHistory) ctx.pulseTickHistory = [];
        ctx.pulseTickHistory.push(this.currentTick);

        this.checkSustainAfterMutations([...affectedIds, actor.id]);

        // sustain/死亡/其它同步回调可能已经取消了当前动作；不能让本次旧事件
        // 在上下文已失效后继续压入下一脉冲或收招事件。
        if (actor.currentActionContext?.actionId !== actEvent.eventId) {
            this.logger.debug(
                `[Action] Tick ${this.currentTick}: ${actor.id}/${template.id} 上下文已失效，停止后续调度`,
                null,
                this.logCtx()
            );
            return;
        }

        // === 实体弹道发射 (Phase 3.2): 如果技能配置了弹道，创建并调度投射物 ===
        if (template.launchProjectile) {
            this.projectileRuntime.launch(actor, actEvent, template);
        }

        const channel = template.channelOptions;

        if (channel && (!channel.maxPulses || pulseNum < channel.maxPulses)) {
            if (channel.pulseResourceCost) {
                for (const [resKey, expr] of Object.entries(channel.pulseResourceCost)) {
                    const cost = Math.abs(RuleEvaluator.evaluate(expr, { actor }).total);
                    if (cost > 0) {
                        const cur = actor.resources.current[resKey] ?? 999;
                        actor.resources.current[resKey] = Math.max(0, cur - cost);
                        this.recordMutation(actor.id, { [`resources.current.${resKey}`]: actor.resources.current[resKey] });
                    }
                }
            }

            this.pushNextPulse(actor, actEvent, channel.intervalTicks);
            this.logger.game(
                `⏳ [Channel] Tick ${this.currentTick}: ${actor.id} 引导等待 (pulse ${pulseNum}/${channel.maxPulses ?? '∞'})`,
                null, LogVisibility.PLAYER, this.logCtx()
            );
            // 增量时间轴修正
            this.emitTimelineUpdate(actor, template.id, template.id);
        } else {
            this.pushRecovery(actor, actEvent, template);
            // 增量时间轴修正
            this.emitTimelineUpdate(actor, template.id, template.id);
        }
    }

    /**
     * 增量时间轴修正 — 在每个脉冲结算后，用实际 tick + 预计算剩余脉冲
     * 累积到 pendingMutations.actionPatches，随 STATE_MUTATED 统一广播
     */
    private emitTimelineUpdate(actor: Entity, actionId: string, actionName: string): void {
        const timing = this.movementTiming.get(actor.id);
        const patch = buildActionTimelinePatch(actor, actionId, actionName, this.currentTick, {
            intervalTicks: timing?.interval ?? MOVE_INTERVAL_TICKS,
            recoveryTicks: timing?.recovery ?? MOVE_RECOVERY_TICKS,
            costForWaypoint: waypoint => SpatialActionSystem.movementCost(this.battlefield, waypoint),
        }, this.actionCatalog);
        if (!patch) return;

        // STATE_MUTATED patches keep connected stores current, while the
        // scheduled-action list is the source used to build the next full
        // encounter snapshot. Update both representations together so a
        // refresh cannot restore the original predicted windows.
        const timelineStart = actor.currentActionContext?.timelineStart;
        for (let index = this.scheduledActions.length - 1; index >= 0; index -= 1) {
            const scheduled = this.scheduledActions[index];
            if (scheduled.entityId !== actor.id) continue;
            if (scheduled.actionId !== actionId && scheduled.actionName !== actionName) continue;
            if (timelineStart !== undefined && scheduled.timeline.start !== timelineStart) continue;
            scheduled.timeline = structuredClone(patch.timeline);
            break;
        }

        if (!this.pendingMutations.actionPatches) {
            this.pendingMutations.actionPatches = [];
        }
        this.pendingMutations.actionPatches.push(patch);
    }

    private removeScheduledAction(entityId: EntityId, actionTemplateId: string): void {
        this.scheduledActions = this.scheduledActions.filter(action =>
            !(action.entityId === entityId && (action.actionId === actionTemplateId || action.actionName === actionTemplateId)),
        );
    }

    private removeScheduledActionByExecutionId(executionId: string): void {
        this.scheduledActions = this.scheduledActions.filter(action => action.executionId !== executionId);
    }

    private removeScheduledActionsForEntity(entityId: EntityId): void {
        this.scheduledActions = this.scheduledActions.filter(action => action.entityId !== entityId);
    }

    /**
     * Cut an action's uncommitted future out of its displayed rail when an
     * interrupt or cancellation sends it directly to recovery. The effect
     * already committed at the current Tick remains represented; later
     * predicted ACTIVE windows do not.
     */
    private truncateScheduledActionForRecovery(
        actor: Entity,
        actionTemplateId: string,
        timelineStart: Tick | undefined,
        recoveryStart: Tick,
        recoveryEnd: Tick,
    ): void {
        for (let index = this.scheduledActions.length - 1; index >= 0; index -= 1) {
            const scheduled = this.scheduledActions[index];
            if (scheduled.entityId !== actor.id) continue;
            if (scheduled.actionId !== actionTemplateId && scheduled.actionName !== actionTemplateId) continue;
            if (timelineStart !== undefined && scheduled.timeline.start !== timelineStart) continue;

            const timeline = structuredClone(scheduled.timeline);
            timeline.startupEnd = Math.min(timeline.startupEnd, recoveryStart);
            timeline.recoveryStart = recoveryStart;
            timeline.end = Math.max(recoveryEnd, recoveryStart);
            if (timeline.pulseTicks) {
                timeline.pulseTicks = timeline.pulseTicks.filter(tick => tick < recoveryStart);
            }
            if (timeline.activeWindows) {
                timeline.activeWindows = timeline.activeWindows
                    .filter(window => window.start < recoveryStart)
                    .map(window => ({ ...window, end: Math.min(window.end, recoveryStart) }))
                    .filter(window => window.end > window.start);
            }
            if (timeline.phaseSegments) {
                timeline.phaseSegments = timeline.phaseSegments
                    .filter(segment => segment.start < recoveryStart)
                    .map(segment => ({ ...segment, end: Math.min(segment.end, recoveryStart) }))
                    .filter(segment => segment.end > segment.start);
                timeline.phaseSegments.push({ phase: 'RECOVERY', start: recoveryStart, end: timeline.end });
            }
            scheduled.timeline = timeline;
            return;
        }
    }

    private pushNextPulse(actor: Entity, prevEvent: ActionExecutionEvent, intervalTicks: number): void {
        const newEvt: ActionExecutionEvent = {
            ...prevEvent,
            eventId: generateId(),
            targetTick: this.currentTick + intervalTicks,
            status: 'PENDING',
            phase: 'STARTUP'
        };

        this.eventQueue.push(newEvt);

        actor.currentActionContext = {
            ...actor.currentActionContext!,
            actionId: newEvt.eventId,
            phase: 'CHANNELING',
            resolveTick: newEvt.targetTick
        };
    }

    private pushRecovery(actor: Entity, prevEvent: ActionExecutionEvent, template: { timeCost: { recoveryTicks: number } }): void {
        const recoveryEvt: ActionExecutionEvent = {
            ...prevEvent,
            eventId: generateId(),
            targetTick: this.currentTick + 1 + template.timeCost.recoveryTicks,
            status: 'PENDING',
            phase: 'RECOVERY'
        };

        this.eventQueue.push(recoveryEvt);

        actor.currentActionContext = {
            ...actor.currentActionContext!,
            actionId: recoveryEvt.eventId,
            // The effect has entered ACTIVE for the remainder of this
            // action's active boundary.  Keep that phase visible until the
            // separately scheduled recovery event resolves; otherwise GM
            // edits/cancellation at the effect Tick would incorrectly treat
            // an already ACTIVE action as RECOVERY and allow the wrong rules.
            phase: 'ACTIVE',
            resolveTick: recoveryEvt.targetTick
        };
    }

    private pushNextPhase(actor: Entity, prevEvent: ActionExecutionEvent): void {
        const template = this.actionCatalog.getAction(prevEvent.actionTemplateId);
        if (!template) {
            actor.currentActionContext = undefined;
            this.recordMutation(actor.id, { 'currentActionContext': null });
            return;
        }

        const channel = template.channelOptions;
        const pulseNum = (actor.currentActionContext?.pulseCount ?? 0);

        if (channel && (!channel.maxPulses || pulseNum < channel.maxPulses)) {
            this.pushNextPulse(actor, prevEvent, channel.intervalTicks);
        } else {
            this.pushRecovery(actor, prevEvent, template);
        }
    }

    // ============================================================
    //  战术姿态切换 (Phase 3.3)
    // ============================================================

    private handleRotateIntent(actor: Entity, rotationDelta: number): void {
        if (actor.currentActionContext || !Number.isFinite(rotationDelta)) return;
        const facing = ((actor.transform.facing + rotationDelta) % 360 + 360) % 360;
        const cost = SpatialSystem.turnTime(SpatialSystem.turnAngle(actor.transform.facing, facing));
        if (cost === 0) return;
        const event: ActionExecutionEvent = {
            eventId: generateId(), eventType: 'ACTION_PHASE', status: 'PENDING',
            actorId: actor.id, actionTemplateId: '__BUILTIN_ROTATE__', phase: 'STARTUP',
            targetTick: this.currentTick + cost,
        };
        this.eventQueue.push(event);
        actor.currentActionContext = {
            type: 'CASTING', actionId: event.eventId, actionTemplateId: event.actionTemplateId,
            phase: 'STARTUP', resolveTick: event.targetTick,
        };
        this.pendingRotations.set(actor.id, facing);
        this.recordMutation(actor.id, { currentActionContext: actor.currentActionContext });
        if (!this._batchMode && this.autoProcess) this.processQueue();
    }

    private handleStanceIntent(actor: Entity, targetStance: TacticalStance): void {
        if (actor.currentActionContext) return;
        const cost = CoverService.getSwitchCost(targetStance);

        this.logger.game(
            `🔄 [Stance] Tick ${this.currentTick}: ${actor.id} 切换姿态 ${actor.currentStance ?? 'NONE'} → ${targetStance} (消耗 ${cost} Tick)`,
            { actorId: actor.id, from: actor.currentStance ?? 'NONE', to: targetStance, cost },
            LogVisibility.PLAYER, this.logCtx()
        );

        // 姿态切换消耗 Tick（通过推入一个 STARTUP 事件模拟延迟）
        if (cost > 0) {
            const evt: ActionExecutionEvent = {
                eventId: generateId(),
                eventType: 'ACTION_PHASE',
                targetTick: this.currentTick + cost,
                status: 'PENDING',
                actorId: actor.id,
                actionTemplateId: '__BUILTIN_STANCE__',
                phase: 'STARTUP'
            };
            this.eventQueue.push(evt);

            actor.currentActionContext = {
                type: 'CASTING',
                actionId: evt.eventId,
                actionTemplateId: '__BUILTIN_STANCE__',
                phase: 'STARTUP',
                resolveTick: evt.targetTick
            };

            // 存储目标姿态，在事件结算时应用
            this.pendingStances.set(actor.id, targetStance);
            this.recordMutation(actor.id, { currentActionContext: actor.currentActionContext });
        } else {
            actor.currentStance = targetStance;
            this.recordMutation(actor.id, { 'currentStance': targetStance });
        }
        if (!this._batchMode && this.autoProcess) this.processQueue();
    }

    /** 设置障碍物列表（用于弹道碰撞检测） */
    public setObstacles(obstacles: Vector3D[]): void {
        this.projectileRuntime.setObstacles(obstacles);
    }

    /** Configure terrain for movement and the shared projectile collision map. */
    public setBattlefield(map: MapData): void {
        this.battlefield = structuredClone(map);
        // Props use the projectile entity collision path so their own HP and
        // destruction remain authoritative, rather than becoming fixed walls.
        this.setObstacles(SpatialActionSystem.mapObstacles(map));
        for (const entity of this.entities.values()) {
            for (const [id, changes] of SpatialActionSystem.refreshCover(entity, this.entities)) this.recordMutation(id, changes);
        }
    }

    private applyPositionTactics(entityId: EntityId): void {
        const entity = this.entities.get(entityId);
        if (!entity || entity.type !== 'ACTOR') return;
        const previous = this.previousPositions.get(entityId) ?? entity.transform.coords;
        this.previousPositions.set(entityId, { ...entity.transform.coords });
        for (const [id, changes] of SpatialActionSystem.onMovement(entity, previous, this.entities, this.currentTick)) {
            this.recordMutation(id, changes);
        }
        for (const [id, changes] of SpatialActionSystem.refreshCover(entity, this.entities)) this.recordMutation(id, changes);
    }

    // ============================================================
    //  工具方法
    // ============================================================

    private recordMutation(entityId: EntityId, changes: Record<string, any>) {
        let mutation = this.pendingMutations.mutations.find(m => m.entityId === entityId);
        if (!mutation) {
            mutation = { entityId, changes: {} };
            this.pendingMutations.mutations.push(mutation);
        }
        Object.assign(mutation.changes, changes);
        if ('resources.current.hp' in changes && this.entities.get(entityId)?.type === 'PROP') {
            for (const entity of this.entities.values()) {
                for (const [id, coverChanges] of SpatialActionSystem.refreshCover(entity, this.entities)) this.recordMutation(id, coverChanges);
            }
        }
        if ('formationContext' in changes) {
            const entity = this.entities.get(entityId);
            for (const zone of entity?.formationContext?.blockZones ?? []) {
                if (this.scheduledBlockZones.has(zone.id)) continue;
                this.scheduledBlockZones.add(zone.id);
                const event: BlockZoneExpiryEvent = { eventId: `expire:${zone.id}`, eventType: 'BLOCK_ZONE_EXPIRE',
                    ownerId: entityId, zoneId: zone.id, targetTick: this.currentTick + zone.durationTicks, status: 'PENDING' };
                this.eventQueue.push(event);
            }
        }
        if (Object.keys(changes).some(path =>
            path === 'transform' || path === 'transform.coords' || path.startsWith('transform.coords.'))) {
            this.notifyPositionChanged(entityId);
        }
    }

    private payTemplateCost(template: ActionTemplate, actor: Entity): void {
        for (const [resource, expression] of Object.entries(template.resourceCost ?? {})) {
            const cost = Math.abs(RuleEvaluator.evaluate(expression, { actor }).total);
            if (cost <= 0 || actor.resources.current[resource] === undefined) continue;
            actor.resources.current[resource] = Math.max(0, actor.resources.current[resource] - cost);
            this.recordMutation(actor.id, { [`resources.current.${resource}`]: actor.resources.current[resource] });
        }
    }

    private broadcastMutations() {
        const hasMutations = this.pendingMutations.mutations.length > 0;
        const hasPatches = (this.pendingMutations.actionPatches?.length ?? 0) > 0;
        if (hasMutations || hasPatches) {
            this.emit('STATE_MUTATED', this.pendingMutations);
            this.pendingMutations = { tick: this.currentTick, mutations: [], actionPatches: [] };
        }
    }

    private checkAndEndCombat(): boolean {
        if (this.combatEnded) return true;

        const actors = Array.from(this.entities.values()).filter(entity => entity.type === 'ACTOR');
        // 至少需要 2 个 ACTOR 才能判定战斗结束（last man standing）
        // 单 ACTOR 场景（如移动测试）不应提前结束
        if (actors.length <= 1) return false;

        const livingActors = actors.filter(entity => (entity.resources.current['hp'] ?? 0) > 0);
        if (livingActors.length > 1) {
            return false;
        }

        this.combatEnded = true;
        this.combatResult = {
            sceneId: this.engineId,
            tick: this.currentTick,
            survivors: livingActors.map(entity => entity.id),
            casualties: actors.filter(entity => (entity.resources.current['hp'] ?? 0) <= 0).map(entity => entity.id),
        };
        this.emit('COMBAT_END', {
            ...this.combatResult,
            entities: this.getAllEntities()
        });

        return true;
    }
}
