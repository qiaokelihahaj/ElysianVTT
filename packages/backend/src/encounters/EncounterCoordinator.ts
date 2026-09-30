import { EventEmitter } from 'node:events';
import type {
    ActionTemplate,
    ClientIntent,
    CommandResult,
    DecisionPollPayload,
    EncounterActionPlan,
    EncounterActionPhase,
    EncounterActionRelation,
    DemoActionPreview,
    DemoActionPreviewCell,
    DemoActionPreviewEntity,
    EncounterCommand,
    EncounterCommandBase,
    EncounterControl,
    EncounterEntity,
    EncounterIncrement,
    EncounterLogEntry,
    EncounterPlanState,
    EncounterPrincipal,
    EncounterReadySlot,
    EncounterResult,
    EncounterRulePack,
    EncounterSnapshot,
    EncounterSideRelation,
    EncounterStatus,
    EncounterVictoryCondition,
    EntityId,
    ActionScheduledPayload,
    Vector3D,
} from '@hard-vtt/shared';
import { getEntityFaction, LogLevel, LogVisibility } from '@hard-vtt/shared';
import { CombatEngine } from '../campaigns/engines/CombatEngine.js';
import { InMemoryActionCatalog } from '../rules/ActionCatalog.js';
import { RuleEvaluator } from '../core/systems/RuleEvaluator.js';
import { generateId } from '../utils/IdGenerator.js';
import { VectorMath } from '../utils/VectorMath.js';
import { EncounterGameLogBridge } from './EncounterGameLogBridge.js';
import { ActionPlanService } from './ActionPlanService.js';
import { DecisionWindowService } from './DecisionWindowService.js';
import { GmCommandService } from './GmCommandService.js';
import { EncounterOutcomeService } from './EncounterOutcomeService.js';
import { SpatialActionSystem } from '../core/systems/SpatialActionSystem.js';

export interface EncounterCoordinatorOptions {
    encounterId?: string;
    engine?: CombatEngine;
    content?: EncounterRulePack;
    /** Alias used by the HTTP demo server. */
    rulePack?: EncounterRulePack;
    entities?: EncounterEntity[];
    /** Optional persisted snapshot; its entity list is used as the start state. */
    initialSnapshot?: Partial<EncounterSnapshot>;
    relations?: EncounterSideRelation[];
    victoryCondition?: EncounterVictoryCondition;
    now?: () => number;
    reactionJoinMs?: number;
    reactionSelectMs?: number;
}

type CommandPrincipal = EncounterPrincipal;
type CommandBase = EncounterCommandBase;

interface StoredCommand {
    result: CommandResult;
    principalKey: string;
    fingerprint: string;
}

interface LocatedActionPlan {
    plan: EncounterActionPlan;
    committed: boolean;
}

/**
 * Server-authoritative coordination for the LAN playable encounter.
 *
 * CombatEngine remains the only rules/event implementation.  This class
 * owns admission, barrier collection, decision deadlines and GM mutations;
 * accepted actions are translated back into normal ClientIntents so they use
 * the existing PriorityQueue, ClashPool and EffectSystem paths.
 */
export class EncounterCoordinator extends EventEmitter {
    public readonly encounterId: string;
    public readonly engine: CombatEngine;
    public readonly content: EncounterRulePack;

    private readonly now: () => number;
    private readonly reactionJoinMs: number;
    private readonly reactionSelectMs: number;
    private deadlineTimer?: ReturnType<typeof setTimeout>;
    private readonly baselineEntities: EncounterEntity[];
    private readonly slots = new Map<EntityId, EncounterReadySlot>();
    private readonly controls = new Map<EntityId, EncounterControl>();
    private readonly actionPlans: ActionPlanService;
    private readonly decisionWindows: DecisionWindowService;
    private readonly gmCommands: GmCommandService;
    private readonly outcomes: EncounterOutcomeService;
    private readonly connections = new Map<string, CommandPrincipal>();
    private readonly commandCache = new Map<string, StoredCommand>();
    private readonly logs: EncounterLogEntry[] = [];
    private readonly gameLogBridge: EncounterGameLogBridge;
    private revision = 0;
    private barrierVersion = 0;
    private status: EncounterStatus = 'LOBBY';
    private paused = false;
    private pauseStartedAt?: number;
    private result?: EncounterResult;
    private pendingTickBreak = false;
    private closed = false;
    private draining = false;

    public constructor(options: EncounterCoordinatorOptions) {
        super();
        this.encounterId = options.encounterId ?? `encounter-${generateId()}`;
        const content = options.content ?? options.rulePack;
        if (!content) throw new Error('EncounterCoordinator requires content');
        this.content = structuredClone(content);
        this.now = options.now ?? (() => Date.now());
        this.reactionJoinMs = options.reactionJoinMs ?? this.content.reactionJoinMs ?? 10_000;
        this.reactionSelectMs = options.reactionSelectMs ?? this.content.reactionSelectMs ?? 60_000;
        const actionCatalog = new InMemoryActionCatalog(this.content.actionTemplates);
        this.engine = options.engine ?? new CombatEngine(this.encounterId, undefined, actionCatalog);
        if (options.engine) this.engine.bindActionCatalog(actionCatalog);
        this.actionPlans = new ActionPlanService({
            content: this.content,
            engine: this.engine,
            getEntity: entityId => this.getEntity(entityId),
            getControl: entityId => this.controls.get(entityId),
            getSlot: entityId => this.slots.get(entityId),
            canControl: (principal, entityId) => this.canControl(principal, entityId),
            isActionWindowOpen: command => this.ensureActionWindow(command),
            getBarrierVersion: () => this.barrierVersion,
            getAction: actionTemplateId => this.getAction(actionTemplateId),
        });
        this.decisionWindows = new DecisionWindowService({
            content: this.content,
            engine: this.engine,
            reactionJoinMs: this.reactionJoinMs,
            reactionSelectMs: this.reactionSelectMs,
            now: () => this.now(),
            getEntity: entityId => this.getEntity(entityId),
            getControl: entityId => this.controls.get(entityId),
            getSlot: entityId => this.slots.get(entityId),
            canControl: (principal, entityId) => this.canControl(principal, entityId),
            getAction: actionTemplateId => this.getAction(actionTemplateId),
            getRevision: () => this.revision,
            historyValues: () => this.actionPlans.historyValues(),
            bumpDecisionRevision: () => this.bumpRevision('DECISION'),
            addLog: (message, actorId, actionId, causationId) => this.addLog(
                message,
                LogVisibility.PLAYER,
                undefined,
                actorId,
                actionId,
                causationId,
            ),
            emitDecision: window => this.emit('DECISION', structuredClone(window)),
            armDeadlineTimer: () => this.armDeadlineTimer(),
            processAfterDecision: () => this.processAfterDecision(),
        });
        this.gmCommands = new GmCommandService({
            content: this.content,
            engine: this.engine,
            currentTick: () => this.engine.currentTick,
            getEntity: entityId => this.getEntity(entityId),
            getControl: entityId => this.controls.get(entityId),
            getSlot: entityId => this.slots.get(entityId),
            connectedSocketsForUser: userId => Array.from(this.connections.values())
                .filter(connection => connection.userId === userId)
                .map(connection => connection.socketId),
            syncEnginePlayerControls: () => this.syncEnginePlayerControls(),
            registerEntity: entity => this.registerEntity(entity),
            clearEntityDecisionState: entityId => this.decisionWindows.clearEntity(entityId),
            removeEntityRegistries: entityId => {
                this.slots.delete(entityId);
                this.controls.delete(entityId);
                this.actionPlans.deletePending(entityId);
            },
            actionPlans: this.actionPlans,
            bumpState: () => this.bumpRevision('STATE'),
            addLog: (message, userId, entityId, actionId, audit) => this.addLog(
                message,
                LogVisibility.GM,
                userId,
                entityId,
                actionId,
                undefined,
                audit,
            ),
            isActiveAndRunning: () => this.status === 'ACTIVE' && !this.paused,
            schedulePump: () => this.schedulePump(),
            refreshTerminalState: () => this.refreshTerminalState(),
        });
        this.gameLogBridge = new EncounterGameLogBridge(this.engine, {
            sceneId: this.encounterId,
            currentTick: () => this.engine.currentTick,
            append: entry => {
                this.logs.push(entry);
                if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
            },
        });
        this.engine.setAutoProcess(false);

        const initial = options.entities ?? options.initialSnapshot?.entities ?? [];
        this.outcomes = new EncounterOutcomeService(
            initial,
            options.relations !== undefined ? options.relations
                : options.initialSnapshot?.relations !== undefined ? options.initialSnapshot.relations : this.content.relations,
            options.victoryCondition !== undefined ? options.victoryCondition
                : options.initialSnapshot?.victoryCondition !== undefined ? options.initialSnapshot.victoryCondition : this.content.victoryCondition,
        );
        this.baselineEntities = initial.map(entity => structuredClone(entity));
        this.engine.mountEntities(initial);
        this.engine.setBattlefield(this.content.map);
        for (const entity of initial) this.registerEntity(entity);
        this.syncEnginePlayerControls();

        this.engine.on('STATE_MUTATED', payload => {
            this.bumpRevision('STATE');
        });
        this.engine.on('ACTION_SCHEDULED', payload => {
            this.bumpRevision('PLAN', { actions: this.getActionPlansFromEngine(payload) });
        });
        this.engine.on('DECISION_POLL', poll => this.openDecision(poll));
        this.engine.on('DECISION_ALL_RESOLVED', () => {
            this.decisionWindows.cleanupResolved();
            this.processAfterDecision();
        });
        // Only the caller of processPending may settle a Tick. Individual
        // death/mutation callbacks can run while a same-Tick group is active.
        this.addLog('遭遇已创建，等待 GM 开始。', LogVisibility.GM);
        this.armDeadlineTimer();
    }


    public getSnapshot(): EncounterSnapshot {
        this.refreshDecisionDeadlines();
        this.refreshSlots();
        const entityById = new Map(this.engine.getAllEntities().map(entity => [entity.id, entity]));
        const entities: EncounterEntity[] = Array.from(entityById.values()).map(entity => {
            const existing = entity as EncounterEntity;
            if (entity.type === 'PROJECTILE') {
                const source = 'sourceEntityId' in entity && typeof entity.sourceEntityId === 'string'
                    ? entityById.get(entity.sourceEntityId) as EncounterEntity | undefined : undefined;
                const hiddenSource = source?.visibility === 'GM' || source?.tags?.some(tag => tag === 'HIDDEN' || tag === 'INVISIBLE');
                // Projectiles carry server-only targets and precomputed future
                // paths. Network snapshots expose a common Entity DTO only.
                return {
                    id: entity.id, templateId: 'projectile', displayName: '投射物', type: 'PROJECTILE',
                    transform: structuredClone(entity.transform), physics: structuredClone(entity.physics),
                    resources: structuredClone(entity.resources), activeEffects: structuredClone(entity.activeEffects),
                    visibility: hiddenSource ? 'GM' : 'PUBLIC',
                };
            }
            return structuredClone(existing);
        });
        // The engine emits ACTION_SCHEDULED synchronously while a barrier is
        // being committed.  During that small interval the declaration plan
        // and the authoritative scheduled action have the same coordinator
        // id. Merge by action id so a client never sees two rails for one
        // action (or allows a stale declaration to win over its timeline).
        const actionsById = new Map<string, EncounterActionPlan>();
        for (const plan of this.actionPlans.values()) {
            actionsById.set(plan.actionId, structuredClone(plan));
        }
        for (const scheduled of this.engine.getScheduledActions()) {
            const plan = this.scheduledActionToPlan(scheduled);
            if (plan.phase === 'RESOLVED' || plan.cancelled) continue;
            actionsById.set(plan.actionId, plan);
        }
        const actions = Array.from(actionsById.values());
        const plan: EncounterPlanState = {
            windowTick: this.engine.currentTick,
            slots: Array.from(this.slots.values()).map(slot => structuredClone(slot)),
            committed: this.actionPlans.size > 0 && this.allSlotsReady(),
            actions: Array.from(this.actionPlans.values()).map(action => structuredClone(action)),
            barrierVersion: this.barrierVersion,
        };
        return {
            encounterId: this.encounterId,
            revision: this.revision,
            tick: this.engine.currentTick,
            status: this.status,
            paused: this.paused,
            entities,
            ...this.outcomes.configuration(),
            actions: actions.map(action => structuredClone(action)),
            plan,
            decisions: Array.from(this.decisionWindows.values()).map(decision => structuredClone(decision)),
            controls: Array.from(this.controls.values()).map(control => structuredClone(control)),
            logs: this.logs.map(log => structuredClone(log)),
            result: this.result ? structuredClone(this.result) : undefined,
            tickBreakPending: this.pendingTickBreak,
            serverTime: this.now(),
        };
    }

    /** Alias kept short for socket adapters. */
    public snapshot(): EncounterSnapshot {
        return this.getSnapshot();
    }

    public getCatalog(): EncounterRulePack {
        return structuredClone(this.content);
    }

    /**
     * Produce a read-only target preview for the action picker.
     *
     * This deliberately mirrors the admission checks in acceptMainAction,
     * but never creates a plan, reserves a resource, opens a decision window,
     * or advances the engine. The ACTION command remains authoritative and
     * repeats these checks when the user finally clicks a target.
     */
    public previewAction(
        principal: CommandPrincipal,
        entityId: EntityId,
        actionTemplateId: string,
    ): DemoActionPreview {
        const template = this.content.actionTemplates.find(candidate => candidate.id === actionTemplateId);
        const targetKind = this.previewTargetKind(template);
        const empty = (): DemoActionPreview => ({
            revision: this.revision,
            actorId: entityId,
            actionTemplateId,
            targetKind,
            available: false,
            entities: [],
            cells: [],
        });
        const failed = (reason: string, actor?: EncounterEntity): DemoActionPreview => {
            const result = empty();
            result.reason = reason;
            if (targetKind === 'entity' && actor) {
                result.entities = this.previewEntityCandidates(principal, actor, template, reason);
                result.cells = this.previewRangeCellCandidates(actor, template, reason);
            } else if (targetKind === 'cell') {
                result.cells = this.previewCellCandidates(reason);
            }
            return result;
        };

        if (!principal || !principal.userId || !principal.socketId) return failed('需要有效会话');
        if (!template) return failed(`动作模板不存在: ${actionTemplateId}`);
        if (!this.getAction(actionTemplateId)) return failed(`动作模板不存在: ${actionTemplateId}`);
        if (!this.content.actionTemplates.some(candidate => candidate.id === actionTemplateId)) {
            return failed('动作不属于当前遭遇规则包');
        }
        if (template.tags.includes('REACTION')) return failed('反应动作只能在反应窗口中选择');

        const actor = this.getEntity(entityId);
        if (!actor || actor.type !== 'ACTOR') return failed('实体不存在');
        if (!this.canControl(principal, entityId)) return failed('没有该实体的控制权', actor);

        const slot = this.slots.get(entityId);
        const unavailableReason = this.previewMainActionReason(actor, slot);
        if (unavailableReason) return failed(unavailableReason, actor);

        // RuleEvaluator intentionally rolls dice while evaluating expressions.
        // A preview must never consume or sample a random value because that
        // would make the target list differ from the eventual ACTION result.
        const randomExpressionReason = this.previewRandomExpressionReason(template);
        if (randomExpressionReason) return failed(randomExpressionReason, actor);

        const paidResources = this.resourceCost(template, actor);
        if (template.spatial?.requiredWeaponId && actor.equippedWeaponId !== template.spatial.requiredWeaponId) {
            return failed(`需要先装备 ${template.spatial.requiredWeaponId}`, actor);
        }
        if (!this.canAfford(actor, paidResources)) return failed('资源不足', actor);

        const result = empty();
        if (targetKind === 'none') {
            result.available = true;
            return result;
        }
        if (targetKind === 'entity') {
            result.entities = this.previewEntityCandidates(principal, actor, template);
            result.cells = this.previewRangeCellCandidates(actor, template);
            // The action itself is admissible even when every visible target
            // is currently illegal. Keep the picker open so the client can
            // explain the candidate reasons or wait for the board to change.
            result.available = true;
            if (!result.entities.some(candidate => candidate.allowed)) result.reason = '没有合法目标';
            return result;
        }

        result.cells = this.previewRangeCellCandidates(actor, template);
        result.available = true;
        if (!result.cells.some(candidate => candidate.allowed)) result.reason = '没有合法落点';
        return result;
    }

    public getCorrections() {
        return this.gmCommands.getCorrections();
    }

    public connect(principal: CommandPrincipal): EncounterSnapshot {
        this.connections.set(principal.socketId, structuredClone(principal));
        for (const control of this.controls.values()) {
            if (control.userId === principal.userId) {
                if (!control.connectedSocketIds.includes(principal.socketId)) control.connectedSocketIds.push(principal.socketId);
                const slot = this.slots.get(control.entityId);
                if (slot) slot.connected = true;
            }
        }
        this.bumpRevision('STATE');
        return this.getSnapshot();
    }

    public disconnect(socketId: string): EncounterSnapshot {
        this.connections.delete(socketId);
        for (const control of this.controls.values()) {
            control.connectedSocketIds = control.connectedSocketIds.filter(id => id !== socketId);
            const slot = this.slots.get(control.entityId);
            if (slot) slot.connected = control.connectedSocketIds.length > 0;
        }
        this.decisionWindows.releaseSocketDecisionEngagement(socketId);
        this.bumpRevision('STATE');
        return this.getSnapshot();
    }

    /** Main command entry point. Every accepted/rejected request gets a stable ACK. */
    public handleCommand(command: EncounterCommand, principal: CommandPrincipal): CommandResult;
    /** Backwards-compatible overload for the original coordinator adapter. */
    public handleCommand(principal: CommandPrincipal, command: EncounterCommand): CommandResult;
    public handleCommand(
        first: EncounterCommand | CommandPrincipal,
        second: EncounterCommand | CommandPrincipal,
    ): CommandResult {
        const command = this.isCommand(first) ? first : second as EncounterCommand;
        const principal = this.isCommand(first) ? second as CommandPrincipal : first as CommandPrincipal;
        if (this.closed) return this.reject(command, 'ENCOUNTER_CLOSED', '遭遇已关闭');
        if (!principal || !principal.userId || !principal.socketId) return this.reject(command, 'UNAUTHENTICATED', '缺少有效会话');
        const cacheKey = `${principal.userId}:${command.requestId}`;
        const cached = this.commandCache.get(cacheKey);
        if (cached) {
            const fingerprint = this.commandFingerprint(command);
            if (cached.principalKey !== principal.userId || cached.fingerprint !== fingerprint) {
                return this.reject(command, 'REQUEST_ID_REUSE', 'requestId 已被另一条请求使用');
            }
            return structuredClone(cached.result);
        }
        const result = this.dispatchCommand(principal, command);
        this.commandCache.set(cacheKey, {
            result: structuredClone(result),
            principalKey: principal.userId,
            fingerprint: this.commandFingerprint(command),
        });
        return result;
    }

    public dispatch(command: EncounterCommand, principal: CommandPrincipal): CommandResult;
    public dispatch(principal: CommandPrincipal, command: EncounterCommand): CommandResult;
    public dispatch(first: EncounterCommand | CommandPrincipal, second: EncounterCommand | CommandPrincipal): CommandResult {
        return this.handleCommand(first as EncounterCommand, second as CommandPrincipal);
    }

    public submit(command: EncounterCommand, principal: CommandPrincipal): CommandResult;
    public submit(principal: CommandPrincipal, command: EncounterCommand): CommandResult;
    public submit(first: EncounterCommand | CommandPrincipal, second: EncounterCommand | CommandPrincipal): CommandResult {
        return this.handleCommand(first as EncounterCommand, second as CommandPrincipal);
    }

    /** Advance injected/server time and resolve expired decision windows. */
    public advanceDeadlines(at = this.now()): void {
        if (this.paused) return;
        this.decisionWindows.expireDeadlines(at, false);
        this.armDeadlineTimer();
    }

    public tickDeadlines(at = this.now()): void {
        this.advanceDeadlines(at);
    }

    /** Arm one timer for the nearest live decision deadline. */
    private armDeadlineTimer(): void {
        if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
        this.deadlineTimer = undefined;
        if (this.closed || this.paused || this.decisionWindows.size === 0) return;

        const now = this.now();
        let nextDeadline = Number.POSITIVE_INFINITY;
        for (const window of this.decisionWindows.values()) {
            if (window.resolved) continue;
            const deadline = window.stage === 'REACTION_JOIN'
                ? window.joinDeadlineAt
                : window.selectDeadlineAt;
            if (deadline !== undefined && deadline < nextDeadline) nextDeadline = deadline;
        }
        if (!Number.isFinite(nextDeadline)) return;

        const delay = Math.max(1, Math.min(250, nextDeadline - now));
        this.deadlineTimer = setTimeout(() => {
            this.deadlineTimer = undefined;
            this.advanceDeadlines();
            this.armDeadlineTimer();
        }, delay);
        if (typeof this.deadlineTimer.unref === 'function') this.deadlineTimer.unref();
    }

    public close(): void {
        this.closed = true;
        if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
        this.deadlineTimer = undefined;
        this.actionPlans.clear();
        this.decisionWindows.clear();
        this.removeAllListeners();
        this.gameLogBridge.close(this.engine);
        this.engine.removeAllListeners();
    }

    public dispose(): void {
        this.close();
    }

    private dispatchCommand(principal: CommandPrincipal, command: EncounterCommand): CommandResult {
        const base = command as CommandBase;
        const payload = base.payload;
        if (!principal || !principal.userId || !principal.socketId) return this.reject(command, 'UNAUTHENTICATED', '缺少有效会话');
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return this.reject(command, 'INVALID_PAYLOAD', 'payload 必须是对象');
        if (['ACTION', 'WAIT', 'RECOVER'].includes(command.type) && this.isTerminalCandidate()) {
            return this.reject(command, 'ENCOUNTER_ENDING', '正在完成已承诺效果，等待遭遇结算');
        }
        if (base.expectedRevision !== undefined && base.expectedRevision !== this.revision && !this.isMainAction(command.type)) {
            return this.reject(command, 'STALE_REVISION', `客户端版本 ${base.expectedRevision} 已过期`);
        }

        switch (command.type) {
            case 'START':
                if (!this.requireGm(principal, command)) return this.reject(command, 'FORBIDDEN', '只有 GM 可以开始遭遇');
                if (this.status !== 'LOBBY') return this.reject(command, 'INVALID_STATE', '遭遇已经开始');
                // The lobby is editable: GM placement, factions, visibility
                // and pre-start spawns form the opening snapshot used by a
                // later restart.  Capture it at the actual START boundary,
                // while preserving the control map separately.
                this.baselineEntities.splice(
                    0,
                    this.baselineEntities.length,
                    ...this.engine.getAllEntities().map(entity => structuredClone(entity) as EncounterEntity),
                );
                this.outcomes.start(this.baselineEntities);
                this.status = 'ACTIVE';
                this.paused = false;
                this.addLog('GM 开始遭遇。', LogVisibility.PLAYER, principal.userId);
                this.bumpRevision('STATE');
                return this.accept(command, '遭遇开始');
            case 'ACTION':
                return this.acceptMainAction(principal, command, payload, false);
            case 'RECOVER':
                return this.acceptMainAction(principal, command, {
                    ...payload,
                    actionTemplateId: typeof payload.actionTemplateId === 'string'
                        ? payload.actionTemplateId
                        : this.defaultRecoveryActionTemplateId() ?? '',
                }, false);
            case 'WAIT':
                return this.acceptWait(principal, command, payload);
            case 'REACTION_JOIN':
                return this.handleReactionJoin(principal, command, payload);
            case 'REACTION_SELECT':
                return this.handleReactionSelect(principal, command, payload, false);
            case 'REACTION_PASS':
                return this.handleReactionSelect(principal, command, payload, true);
            case 'GM_PAUSE':
                return this.handlePause(principal, command, payload);
            case 'GM_RESUME':
                return this.handleResume(principal, command);
            case 'GM_STEP':
                return this.handleStep(principal, command, false);
            case 'GM_TICK_BREAK':
                return this.handleStep(principal, command, true);
            case 'GM_TAKEOVER':
                return this.handleTakeover(principal, command, payload, true);
            case 'GM_RELEASE':
                return this.handleTakeover(principal, command, payload, false);
            case 'GM_ASSIGN_ENTITY':
                return this.handleAssignment(principal, command, payload);
            case 'GM_EDIT_ACTION':
                return this.handleEditAction(principal, command, payload);
            case 'CANCEL_ACTION':
                return this.handleCancelAction(principal, command, payload, false);
            case 'GM_CANCEL_ACTION':
                return this.handleCancelAction(principal, command, payload, true);
            case 'GM_ADJUST_ENTITY':
                return this.handleAdjustEntity(principal, command, payload);
            case 'GM_SPAWN':
                return this.handleSpawn(principal, command, payload);
            case 'GM_REMOVE':
                return this.handleRemove(principal, command, payload);
            case 'GM_SET_FACTION':
                return this.handleFaction(principal, command, payload);
            case 'GM_SET_RELATION':
                return this.handleRelation(principal, command, payload);
            case 'GM_SET_VICTORY_CONDITION':
                return this.handleVictoryCondition(principal, command, payload);
            case 'GM_CORRECT':
                return this.handleCorrection(principal, command, payload);
            case 'GM_PASS':
                return this.handleReactionSelect(principal, command, payload, true);
            case 'GM_PASS_ALL':
                return this.handlePassAll(principal, command);
            case 'GM_END':
                return this.handleEnd(principal, command, payload);
            case 'GM_RESTART':
                return this.handleRestart(principal, command);
            default:
                return this.reject(command, 'UNKNOWN_COMMAND', '未知遭遇命令');
        }
    }

    private acceptMainAction(
        principal: CommandPrincipal,
        command: EncounterCommand,
        payload: Record<string, unknown>,
        _fromGm: boolean,
    ): CommandResult {
        const declared = this.actionPlans.declare(principal, command, payload);
        if (!declared.ok) return this.reject(command, declared.code, declared.reason);
        const { entity, plan } = declared;
        this.bumpRevision('PLAN');
        this.addLog(`${entity.displayName ?? entity.id} 已提交 ${plan.actionTemplateId}。`, LogVisibility.PLAYER, principal.userId, entity.id, plan.actionId, plan.causationId);
        this.commitBarrierIfReady();
        return this.accept(command, '行动已提交');
    }

    private acceptWait(principal: CommandPrincipal, command: EncounterCommand, payload: Record<string, unknown>): CommandResult {
        if (!this.ensureActionWindow(command)) return this.reject(command, 'INVALID_STATE', '当前没有可提交的行动窗口');
        const entityId = this.stringValue(payload.entityId);
        const entity = entityId ? this.getEntity(entityId) : undefined;
        if (!entityId || !entity) return this.reject(command, 'UNKNOWN_ENTITY', '实体不存在');
        if (!this.canControl(principal, entityId)) return this.reject(command, 'FORBIDDEN', '没有该实体的控制权');
        const control = this.controls.get(entityId)!;
        if (command.controlEpoch !== undefined && command.controlEpoch !== control.controlEpoch) return this.reject(command, 'STALE_CONTROL', '控制权版本已变化');
        if (command.expectedBarrierVersion !== undefined && command.expectedBarrierVersion !== this.barrierVersion) return this.reject(command, 'STALE_BARRIER', '行动屏障版本已变化');
        const slot = this.slots.get(entityId)!;
        if (slot.ready) return this.reject(command, 'ALREADY_READY', '该实体已经提交本窗口行动');
        if (entity.currentActionContext) return this.reject(command, 'IN_RECOVERY', '实体仍在动作或收招中');
        if (slot.readyAtTick !== undefined && this.engine.currentTick < slot.readyAtTick) {
            return this.reject(command, 'ALREADY_WAITING', `该实体已等待至 Tick ${slot.readyAtTick}`);
        }
        slot.ready = true;
        slot.waiting = true;
        slot.readyAtTick = this.engine.currentTick + 5;
        slot.blockedReason = undefined;
        this.bumpRevision('PLAN');
        this.addLog(`${entityId} 等待，下次行动推迟 5 Tick。`, LogVisibility.PLAYER, principal.userId, entityId);
        this.commitBarrierIfReady();
        return this.accept(command, '等待已提交');
    }

    private commitBarrierIfReady(): void {
        const ready = this.allSlotsReady();
        if (!ready || this.paused || this.decisionWindows.size > 0) {
            // Waiting slots may have a wake marker in the heap.  Once every
            // currently eligible actor has submitted, let that marker advance
            // time even though the next barrier is not complete yet.
            if (!this.paused && this.decisionWindows.size === 0 && !this.hasUnsubmittedActionSlot()) this.schedulePump();
            return;
        }
        this.barrierVersion++;
        this.actionPlans.commit(this.slots.values());
        for (const slot of this.slots.values()) {
            // A WAIT marker survives a later barrier until its wake Tick.  A
            // slot's `waiting` flag describes only the barrier in which the
            // WAIT was submitted; clearing it after commit must not erase the
            // deferred eligibility boundary.  Reaction selection explicitly
            // clears readyAtTick when it spends that waiting slot.
            const waitUntil = slot.readyAtTick !== undefined && slot.readyAtTick > this.engine.currentTick
                ? slot.readyAtTick
                : undefined;
            slot.ready = false;
            slot.waiting = false;
            // Preserve the defer boundary across the commit.  It is cleared
            // when the authoritative Tick reaches it by refreshSlots().
            slot.readyAtTick = waitUntil;
            slot.blockedReason = waitUntil !== undefined
                ? `等待至 Tick ${waitUntil}`
                : undefined;
        }
        this.bumpRevision('PLAN');
        if (!this.paused) this.schedulePump();
        this.refreshTerminalState();
    }

    /** Schedule exactly one event-heap step, yielding between every step. */
    private schedulePump(): void {
        if (this.draining || this.paused || this.closed || this.result || this.decisionWindows.size > 0) return;
        this.draining = true;
        const runOne = (): void => {
            if (this.paused || this.closed || this.result || this.decisionWindows.size > 0) {
                this.draining = false;
                return;
            }
            const nextEventTick = this.engine.getNextEventTick();
            if (this.pendingTickBreak && nextEventTick !== null && nextEventTick > this.engine.currentTick) {
                this.pendingTickBreak = false;
                this.paused = true;
                this.status = this.result ? this.status : 'PAUSED';
                this.pauseStartedAt = this.now();
                this.draining = false;
                this.addLog(`GM 断点：下一结算 Tick ${nextEventTick} 前暂停。`, LogVisibility.GM);
                this.bumpRevision('STATE');
                return;
            }
            // A recovery boundary opens the next simultaneous action window.
            // Stop before jumping over it so a newly idle actor can submit;
            // deferred WAIT slots remain eligible only at their wake Tick.
            if (this.hasUnsubmittedActionSlot()) {
                this.draining = false;
                return;
            }
            this.engine.processPending(1);
            this.refreshSlots();
            this.refreshTerminalState();
            if (this.engine.hasPendingEvents() && !this.result && !this.paused && this.decisionWindows.size === 0 && !this.hasUnsubmittedActionSlot()) {
                setImmediate(runOne);
            } else {
                this.draining = false;
                this.refreshSlots();
            }
        };
        setImmediate(runOne);
    }

    /** Kept as a private alias while older call sites are migrated. */
    private scheduleDrain(): void {
        this.schedulePump();
    }

    private handleReactionJoin(principal: CommandPrincipal, command: EncounterCommand, payload: Record<string, unknown>): CommandResult {
        const outcome = this.decisionWindows.join(principal, command, payload);
        if (!outcome.ok) return this.reject(command, outcome.code, outcome.reason);
        return this.accept(command, '已接战，请选择反应');
    }

    private handleReactionSelect(principal: CommandPrincipal, command: EncounterCommand, payload: Record<string, unknown>, pass: boolean): CommandResult {
        const outcome = this.decisionWindows.select(principal, command, payload, pass);
        if (!outcome.ok) return this.reject(command, outcome.code, outcome.reason);
        const optionId = pass ? null : this.stringValue(payload.optionId);
        return this.accept(command, optionId ? `已选择 ${optionId}` : '已放弃反应');
    }

    /** Commit a complete reaction batch in a deterministic actor order. */
    private flushReactionSelections(): void {
        this.decisionWindows.flush();
    }

    private processAfterDecision(): void {
        this.refreshDecisionDeadlines();
        if (this.decisionWindows.size > 0 || this.paused || this.closed) return;
        this.schedulePump();
    }

    private handlePause(principal: CommandPrincipal, command: EncounterCommand, payload: Record<string, unknown>): CommandResult {
        if (!this.requireGm(principal, command)) return this.reject(command, 'FORBIDDEN', '只有 GM 可以暂停');
        if (this.paused) return this.accept(command, '遭遇已经暂停');
        this.refreshDecisionDeadlines();
        this.paused = true;
        this.status = this.result ? this.status : 'PAUSED';
        this.pauseStartedAt = this.now();
        this.decisionWindows.pauseDeadlines();
        this.addLog(this.stringValue(payload.reason) ?? 'GM 暂停遭遇。', LogVisibility.GM, principal.userId);
        this.bumpRevision('STATE');
        return this.accept(command, '已暂停');
    }

    private handleResume(principal: CommandPrincipal, command: EncounterCommand): CommandResult {
        if (!this.requireGm(principal, command)) return this.reject(command, 'FORBIDDEN', '只有 GM 可以继续');
        if (!this.paused) return this.accept(command, '遭遇已经在运行');
        const now = this.now();
        this.decisionWindows.resumeDeadlines(now);
        this.paused = false;
        this.status = this.result ? this.status : 'ACTIVE';
        this.pauseStartedAt = undefined;
        this.armDeadlineTimer();
        this.addLog('GM 继续遭遇。', LogVisibility.GM, principal.userId);
        this.bumpRevision('STATE');
        this.processAfterDecision();
        return this.accept(command, '已继续');
    }

    private handleStep(principal: CommandPrincipal, command: EncounterCommand, setBreak: boolean): CommandResult {
        if (!this.requireGm(principal, command)) return this.reject(command, 'FORBIDDEN', '只有 GM 可以单步');
        if (setBreak) {
            this.pendingTickBreak = true;
            this.bumpRevision('STATE');
            if (!this.paused) this.schedulePump();
            return this.accept(command, '已设置下一 Tick 前断点');
        }
        if (!this.paused) return this.reject(command, 'INVALID_STATE', '单步前必须暂停');
        if (this.hasUnsubmittedActionSlot()) return this.reject(command, 'ACTION_PENDING', '仍有角色未提交行动');
        this.pendingTickBreak = false;
        const count = Math.max(1, Math.floor(this.numberValue(command.payload.count) ?? 1));
        for (let i = 0; i < count; i++) {
            if (this.hasUnsubmittedActionSlot()) break;
            this.engine.processPending(1);
            this.refreshSlots();
            if (this.decisionWindows.size > 0 || this.engine.getNextEventTick() === null) break;
        }
        this.bumpRevision('STATE');
        this.refreshTerminalState();
        return this.accept(command, setBreak ? '已在下一 Tick 前断点' : '已单步结算');
    }

    private handleTakeover(principal: CommandPrincipal, command: EncounterCommand, payload: Record<string, unknown>, take: boolean): CommandResult {
        const outcome = this.gmCommands.takeover(principal, command, payload, take);
        if (!outcome.ok) return this.reject(command, outcome.code, outcome.reason);
        return this.accept(command, outcome.message);
    }

    private handleAssignment(principal: CommandPrincipal, command: EncounterCommand, payload: Record<string, unknown>): CommandResult {
        const outcome = this.gmCommands.assign(principal, command, payload);
        if (!outcome.ok) return this.reject(command, outcome.code, outcome.reason);
        return this.accept(command, outcome.message);
    }

    private handleEditAction(principal: CommandPrincipal, command: EncounterCommand, payload: Record<string, unknown>): CommandResult {
        if (!this.requireGm(principal, command)) return this.reject(command, 'FORBIDDEN', '只有 GM 可以编辑行动');
        const actionId = this.stringValue(payload.actionId);
        const located = actionId ? this.locateActionPlan(actionId) : undefined;
        if (!located) return this.reject(command, 'UNKNOWN_ACTION', '行动已提交或不存在');
        if (payload.cancel === true) return this.handleCancelAction(principal, command, payload, true);

        const currentPlan = located.plan;
        const entity = this.getEntity(currentPlan.actorId);
        const currentTemplate = this.getAction(currentPlan.actionTemplateId);
        if (!entity || !currentTemplate) return this.reject(command, 'UNKNOWN_ACTION', '行动模板不存在或实体已移除');

        const hasTemplate = Object.prototype.hasOwnProperty.call(payload, 'actionTemplateId');
        const actionTemplateId = hasTemplate ? this.stringValue(payload.actionTemplateId) : currentPlan.actionTemplateId;
        if (!actionTemplateId) return this.reject(command, 'INVALID_PAYLOAD', 'actionTemplateId 必须是非空字符串');
        const replacement = this.getAction(actionTemplateId);
        if (!replacement) return this.reject(command, 'UNKNOWN_ACTION', '替换动作模板不存在');
        if (!this.content.actionTemplates.some(candidate => candidate.id === replacement.id)) {
            return this.reject(command, 'ACTION_NOT_ALLOWED', '替换动作不属于当前遭遇规则包');
        }
        if (replacement.tags.includes('REACTION')) {
            return this.reject(command, 'ACTION_NOT_ALLOWED', '反应动作只能在反应窗口中选择');
        }

        const hasTargets = Object.prototype.hasOwnProperty.call(payload, 'targetIds');
        let targetIds = [...currentPlan.targetIds];
        if (hasTargets) {
            if (!Array.isArray(payload.targetIds)) return this.reject(command, 'INVALID_PAYLOAD', 'targetIds 必须是数组');
            targetIds = this.entityIds(payload.targetIds);
            if (targetIds.length !== payload.targetIds.length) {
                return this.reject(command, 'INVALID_PAYLOAD', 'targetIds 必须只包含实体 ID');
            }
        }
        const hasTargetCoords = Object.prototype.hasOwnProperty.call(payload, 'targetCoords');
        let targetCoords = currentPlan.targetCoords ? structuredClone(currentPlan.targetCoords) : undefined;
        if (hasTargetCoords) {
            targetCoords = this.vectorValue(payload.targetCoords);
            if (!targetCoords) return this.reject(command, 'INVALID_PAYLOAD', 'targetCoords 必须是完整坐标');
        }
        if (targetIds.some(targetId => !this.getEntity(targetId))) {
            return this.reject(command, 'UNKNOWN_TARGET', '目标不存在');
        }
        const targetError = this.actionPlans.validateActionTargets(principal, entity, replacement, targetIds, targetCoords);
        if (!targetError.ok) return this.reject(command, targetError.code, targetError.reason);

        let effectiveTick = currentPlan.effectiveTick;
        if (Object.prototype.hasOwnProperty.call(payload, 'effectiveTick')) {
            const tick = this.numberValue(payload.effectiveTick);
            if (tick === undefined || !Number.isInteger(tick) || tick < 0) {
                return this.reject(command, 'INVALID_PAYLOAD', 'effectiveTick 必须是非负整数 Tick');
            }
            if (tick < this.engine.currentTick) return this.reject(command, 'TIME_IN_PAST', '生效 Tick 不能早于当前 Tick');
            effectiveTick = tick;
        }
        let priority = currentPlan.priority;
        if (Object.prototype.hasOwnProperty.call(payload, 'priority')) {
            const nextPriority = this.numberValue(payload.priority);
            if (nextPriority === undefined) return this.reject(command, 'INVALID_PAYLOAD', 'priority 必须是有限数字');
            priority = nextPriority;
        }

        const nextPlan: EncounterActionPlan = {
            ...currentPlan,
            actionTemplateId: replacement.id,
            targetIds,
            targetCoords,
            effectiveTick,
            priority,
            phase: located.committed ? 'DELAY' : 'DECLARED',
            paidResources: located.committed ? { ...currentPlan.paidResources } : this.resourceCost(replacement, entity),
            decisionVersion: currentPlan.decisionVersion + 1,
            relation: this.actionRelation(replacement),
            selfTarget: this.actionSelfTargets(replacement),
        };

        if (located.committed) {
            const intent: ClientIntent = {
                actorId: nextPlan.actorId,
                intentType: replacement.tags.includes('MOVEMENT') ? 'MOVE' : 'CAST_ACTION',
                clientTick: this.engine.currentTick,
                payload: {
                    actionId: nextPlan.actionId,
                    actionTemplateId: nextPlan.actionTemplateId,
                    targetIds: nextPlan.targetIds,
                    targetCoords: nextPlan.targetCoords,
                    priority: nextPlan.priority,
                    effectiveTick: nextPlan.effectiveTick,
                    causationId: nextPlan.causationId,
                },
            };
            this.invalidateDecisionWindows(nextPlan);
            const engineResult = this.engine.replaceCoordinatedAction(nextPlan.actionId, intent);
            if (!engineResult.ok) return this.reject(command, engineResult.code, engineResult.reason);
        }

        if (!located.committed) this.actionPlans.setPending(nextPlan);
        this.actionPlans.remember(nextPlan);
        this.barrierVersion++;
        this.bumpRevision('PLAN');
        const auditReason = this.stringValue(payload.reason) ?? 'GM 编辑行动';
        this.addLog(
            `GM 编辑行动 ${nextPlan.actionId}。`,
            LogVisibility.GM,
            principal.userId,
            nextPlan.actorId,
            nextPlan.actionId,
            nextPlan.causationId,
            {
                operation: 'GM_EDIT_ACTION',
                reason: auditReason,
                actionId: nextPlan.actionId,
                tick: this.engine.currentTick,
                before: this.actionPlanAudit(currentPlan),
                after: this.actionPlanAudit(nextPlan),
            },
        );
        return this.accept(command, '行动已编辑');
    }

    private handleCancelAction(principal: CommandPrincipal, command: EncounterCommand, payload: Record<string, unknown>, gm: boolean): CommandResult {
        if (gm && !this.requireGm(principal, command)) return this.reject(command, 'FORBIDDEN', '只有 GM 可以取消');
        const actionId = this.stringValue(payload.actionId);
        const auditReason = this.stringValue(payload.reason) ?? (gm ? 'GM 取消行动' : '玩家取消行动');
        const located = actionId ? this.locateActionPlan(actionId) : undefined;
        if (!located) return this.reject(command, 'UNKNOWN_ACTION', '行动不存在或已结算');
        if (!gm && !this.canControl(principal, located.plan.actorId)) {
            return this.reject(command, 'FORBIDDEN', '没有该行动的控制权');
        }

        if (located.committed) {
            // Once a plan has entered the engine, every cancellation keeps a
            // recovery boundary.  GM authority changes who may request the
            // cancellation; it must not let a started action skip recovery.
            const engineResult = this.engine.cancelCoordinatedAction(located.plan.actionId, true);
            if (!engineResult.ok) return this.reject(command, engineResult.code, engineResult.reason);
            this.invalidateDecisionWindows(located.plan);
        } else {
            this.actionPlans.deletePending(located.plan.actorId);
        }

        const cancelledPlan: EncounterActionPlan = { ...located.plan, cancelled: true };
        this.actionPlans.remember(cancelledPlan);
        const slot = this.slots.get(cancelledPlan.actorId);
        if (slot) {
            slot.ready = false;
            slot.waiting = false;
            slot.blockedReason = gm ? 'GM 取消后等待重新提交' : '行动已取消，进入收招';
        }
        this.barrierVersion++;
        this.bumpRevision('PLAN');
        this.addLog(
            `${gm ? 'GM' : '玩家'} 取消行动 ${cancelledPlan.actionId}。`,
            LogVisibility.GM,
            principal.userId,
            cancelledPlan.actorId,
            cancelledPlan.actionId,
            cancelledPlan.causationId,
            {
                operation: gm ? 'GM_CANCEL_ACTION' : 'CANCEL_ACTION',
                reason: auditReason,
                actionId: cancelledPlan.actionId,
                tick: this.engine.currentTick,
                before: this.actionPlanAudit(located.plan),
                after: this.actionPlanAudit(cancelledPlan),
            },
        );
        return this.accept(command, gm ? '行动已取消' : '行动已取消并进入收招');
    }

    private locateActionPlan(actionId: string): LocatedActionPlan | undefined {
        return this.actionPlans.locate(actionId, action => this.scheduledActionToPlan(action));
    }

    private invalidateDecisionWindows(plan: EncounterActionPlan): void {
        this.decisionWindows.invalidate(plan);
    }

    private actionPlanAudit(plan: EncounterActionPlan): Record<string, unknown> {
        return {
            actionTemplateId: plan.actionTemplateId,
            targetIds: [...plan.targetIds],
            targetCoords: plan.targetCoords ? { ...plan.targetCoords } : undefined,
            effectiveTick: plan.effectiveTick,
            priority: plan.priority,
            phase: plan.phase,
            paidResources: { ...plan.paidResources },
            decisionVersion: plan.decisionVersion,
            cancelled: plan.cancelled ?? false,
        };
    }

    private handleAdjustEntity(principal: CommandPrincipal, command: EncounterCommand, payload: Record<string, unknown>): CommandResult {
        const outcome = this.gmCommands.adjustEntity(principal, command, payload);
        if (!outcome.ok) return this.reject(command, outcome.code, outcome.reason);
        return this.accept(command, outcome.message);
    }

    private handleSpawn(principal: CommandPrincipal, command: EncounterCommand, payload: Record<string, unknown>): CommandResult {
        const outcome = this.gmCommands.spawn(principal, command, payload);
        if (!outcome.ok) return this.reject(command, outcome.code, outcome.reason);
        return this.accept(command, outcome.message);
    }

    private handleRemove(principal: CommandPrincipal, command: EncounterCommand, payload: Record<string, unknown>): CommandResult {
        const outcome = this.gmCommands.remove(principal, command, payload);
        if (!outcome.ok) return this.reject(command, outcome.code, outcome.reason);
        return this.accept(command, outcome.message);
    }

    /**
     * Removing a source or reactor must close every window in its causal
     * chain before unmounting the entity.  Otherwise CombatEngine retains an
     * active decision count and the next barrier can remain blocked forever.
     */
    private handleFaction(principal: CommandPrincipal, command: EncounterCommand, payload: Record<string, unknown>): CommandResult {
        const outcome = this.gmCommands.setFaction(principal, command, payload);
        if (!outcome.ok) return this.reject(command, outcome.code, outcome.reason);
        return this.accept(command, outcome.message);
    }

    private handleRelation(principal: CommandPrincipal, command: EncounterCommand, payload: Record<string, unknown>): CommandResult {
        if (!this.requireGm(principal, command)) return this.reject(command, 'FORBIDDEN', '只有 GM 可以设置阵营关系');
        const outcome = this.outcomes.setRelation(payload, this.engine.getAllEntities());
        if (!outcome.ok) return this.reject(command, outcome.code, outcome.reason);
        this.bumpRevision('STATE', this.outcomes.configuration());
        this.addLog('GM 更新了阵营关系。', LogVisibility.GM, principal.userId);
        this.refreshTerminalState();
        if (this.status === 'ACTIVE' && !this.paused) this.schedulePump();
        return this.accept(command, '阵营关系已设置');
    }

    private handleVictoryCondition(principal: CommandPrincipal, command: EncounterCommand, payload: Record<string, unknown>): CommandResult {
        if (!this.requireGm(principal, command)) return this.reject(command, 'FORBIDDEN', '只有 GM 可以设置结算条件');
        const outcome = this.outcomes.setVictoryCondition(payload.condition);
        if (!outcome.ok) return this.reject(command, outcome.code, outcome.reason);
        this.bumpRevision('STATE', this.outcomes.configuration());
        this.addLog('GM 更新了结算条件。', LogVisibility.GM, principal.userId);
        this.refreshTerminalState();
        if (this.status === 'ACTIVE' && !this.paused) this.schedulePump();
        return this.accept(command, '结算条件已设置');
    }

    private handleCorrection(principal: CommandPrincipal, command: EncounterCommand, payload: Record<string, unknown>): CommandResult {
        const outcome = this.gmCommands.correct(principal, command, payload);
        if (!outcome.ok) return this.reject(command, outcome.code, outcome.reason);
        return this.accept(command, outcome.message);
    }

    private handlePassAll(principal: CommandPrincipal, command: EncounterCommand): CommandResult {
        if (!this.requireGm(principal, command)) return this.reject(command, 'FORBIDDEN', '只有 GM 可以批量代决');
        // Keep choices already collected in this causal batch.  Fill only the
        // still-open windows with authoritative PASS entries, then commit the
        // complete batch.  An INTERRUPT chosen earlier may synchronously open
        // a child window; pass that child as part of the same GM_PASS_ALL
        // operation as well.
        let rounds = 0;
        do {
            this.decisionWindows.collectGmPasses(principal.socketId);
            this.decisionWindows.flush();
            rounds++;
        } while (this.decisionWindows.size > 0 && rounds < 32);
        this.bumpRevision('DECISION');
        this.processAfterDecision();
        return this.accept(command, '已批量放弃反应');
    }

    private handleEnd(principal: CommandPrincipal, command: EncounterCommand, payload: Record<string, unknown>): CommandResult {
        if (!this.requireGm(principal, command)) return this.reject(command, 'FORBIDDEN', '只有 GM 可以结束遭遇');
        const winners = this.outcomes.validateWinners(payload, this.engine.getAllEntities());
        if (!winners.ok) return this.reject(command, winners.code, winners.reason);
        if (this.result) return this.accept(command, '遭遇已经结束');
        if (this.decisionWindows.size > 0) return this.reject(command, 'DECISION_PENDING', '仍有未决反应');
        // Ending cannot silently drain the queue: a GM must wait for already
        // committed effects or pause and step them explicitly first.  Pausing
        // only freezes the queue; it does not make an outstanding effect
        // eligible for settlement.
        if (this.engine.hasPendingActionEvents()) {
            return this.reject(command, 'EFFECT_PENDING', '仍有已承诺效果待结算，请等待或暂停后单步');
        }
        this.result = this.outcomes.buildResult(this.engine.getAllEntities(), this.engine.currentTick, 'GM', this.stringValue(payload.reason), winners.value);
        this.status = this.result.status;
        this.paused = false;
        this.addLog(`GM 结束遭遇：${this.result.status}。`, LogVisibility.PLAYER, principal.userId);
        this.bumpRevision('RESULT', { result: structuredClone(this.result), status: this.status, paused: this.paused });
        this.emit('SETTLED', structuredClone(this.result));
        return this.accept(command, '遭遇已结束');
    }

    private handleRestart(principal: CommandPrincipal, command: EncounterCommand): CommandResult {
        if (!this.requireGm(principal, command)) return this.reject(command, 'FORBIDDEN', '只有 GM 可以重开');
        if (!this.result) return this.reject(command, 'INVALID_STATE', '遭遇尚未结算');
        const previousControls = new Map(
            Array.from(this.controls.entries()).map(([entityId, control]) => [entityId, structuredClone(control)] as const),
        );
        this.engine.reset();
        const fresh = this.baselineEntities.map(entity => structuredClone(entity));
        this.outcomes.restart(fresh);
        this.engine.mountEntities(fresh);
        this.engine.setBattlefield(this.content.map);
        this.slots.clear();
        this.controls.clear();
        this.actionPlans.clear();
        this.decisionWindows.clear();
        for (const entity of fresh) {
            this.registerEntity(entity);
            const previous = previousControls.get(entity.id);
            const control = this.controls.get(entity.id);
            const slot = this.slots.get(entity.id);
            if (!previous || !control || !slot) continue;
            // A restart is a new control epoch, while the lobby assignment is
            // retained so the connected PL pages can submit immediately after
            // START.  A temporary GM takeover ends with the old encounter.
            control.userId = previous.userId;
            control.role = previous.role;
            control.takenOverByGm = false;
            control.controlEpoch = previous.controlEpoch + 1;
            control.connectedSocketIds = previous.userId
                ? Array.from(this.connections.values())
                    .filter(connection => connection.userId === previous.userId)
                    .map(connection => connection.socketId)
                : [];
            slot.controllerUserId = control.userId;
            slot.controlEpoch = control.controlEpoch;
            slot.connected = control.connectedSocketIds.length > 0;
        }
        this.syncEnginePlayerControls();
        this.result = undefined;
        this.status = 'LOBBY';
        this.paused = false;
        this.pauseStartedAt = undefined;
        this.pendingTickBreak = false;
        this.draining = false;
        this.barrierVersion = 0;
        this.armDeadlineTimer();
        this.addLog('遭遇已按开局快照重开。', LogVisibility.GM, principal.userId);
        this.bumpRevision('RESULT');
        return this.accept(command, '遭遇已重开');
    }

    private openDecision(poll: DecisionPollPayload): void {
        this.decisionWindows.open(poll);
    }

    private refreshDecisionDeadlines(): void {
        this.decisionWindows.refreshDeadlines(this.now(), this.paused);
    }

    private ensureActionWindow(command: EncounterCommand): boolean {
        if (this.status !== 'ACTIVE' || this.paused || this.result !== undefined || this.decisionWindows.size > 0) return false;
        if (command.expectedBarrierVersion !== undefined && command.expectedBarrierVersion !== this.barrierVersion) return false;
        return true;
    }

    private allSlotsReady(): boolean {
        this.refreshSlots();
        const living = Array.from(this.engine.getAllEntities()).filter(entity =>
            entity.type === 'ACTOR' &&
            (entity.resources.current.hp ?? 0) > 0 &&
            !entity.currentActionContext &&
            (() => {
                const slot = this.slots.get(entity.id);
                return !slot || slot.ready || slot.readyAtTick === undefined || this.engine.currentTick >= slot.readyAtTick;
            })(),
        );
        if (living.length === 0) return false;
        for (const entity of living) {
            const slot = this.slots.get(entity.id);
            if (!slot || !slot.ready) {
                if (slot) slot.blockedReason = slot.connected ? '等待该玩家提交行动' : '玩家断线，等待 GM 代决';
                return false;
            }
        }
        return true;
    }

    private hasUnsubmittedActionSlot(): boolean {
        if (this.isTerminalCandidate()) return false;
        this.refreshSlots();
        for (const entity of this.engine.getAllEntities()) {
            if (entity.type !== 'ACTOR' || (entity.resources.current.hp ?? 0) <= 0) continue;
            if (entity.currentActionContext) continue;
            const slot = this.slots.get(entity.id);
            if (!slot || slot.ready) continue;
            if (slot.readyAtTick !== undefined && this.engine.currentTick < slot.readyAtTick) continue;
            return true;
        }
        return false;
    }

    private canControl(principal: CommandPrincipal, entityId: EntityId): boolean {
        if (principal.role === 'GM') return true;
        const control = this.controls.get(entityId);
        return Boolean(control && control.role === 'PL' && control.userId === principal.userId && !control.takenOverByGm);
    }

    private requireGm(principal: CommandPrincipal, _command: EncounterCommand): boolean {
        return principal.role === 'GM';
    }

    private isMainAction(type: EncounterCommand['type']): boolean {
        return type === 'ACTION' || type === 'WAIT' || type === 'RECOVER' || type === 'START';
    }

    private accept(command: EncounterCommand, message?: string): CommandResult {
        return { ok: true, success: true, requestId: command.requestId, revision: this.revision, snapshot: this.getSnapshot(), message };
    }

    private reject(command: EncounterCommand | EncounterCommandBase, code: string, reason: string): CommandResult {
        return { ok: false, success: false, requestId: command.requestId, revision: this.revision, code, reason, snapshot: this.getSnapshot() };
    }

    private registerEntity(entity: EncounterEntity): void {
        const faction = getEntityFaction(entity);
        entity.faction = faction;
        const control: EncounterControl = {
            entityId: entity.id,
            userId: undefined,
            role: 'GM',
            controlEpoch: 0,
            connectedSocketIds: [],
            takenOverByGm: false,
        };
        this.controls.set(entity.id, control);
        this.slots.set(entity.id, {
            entityId: entity.id,
            faction,
            controllerUserId: undefined,
            connected: false,
            ready: false,
            waiting: false,
            controlEpoch: 0,
        });
        if (this.status !== 'LOBBY') this.outcomes.observe(this.engine.getAllEntities());
    }

    private syncEnginePlayerControls(): void {
        // The core engine does not carry session roles.  The coordinator
        // filters who may answer each poll at the network boundary, while the
        // engine must still emit polls for GM-controlled monsters so the GM
        // can manually adjudicate them.
        this.engine.setPlayerControlledEntities(Array.from(this.controls.keys()));
    }

    private refreshSlots(): void {
        const currentTick = this.engine.currentTick;
        const gmConnected = Array.from(this.connections.values()).some(connection => connection.role === 'GM');
        for (const [entityId, slot] of this.slots) {
            const control = this.controls.get(entityId);
            if (control) {
                slot.controlEpoch = control.controlEpoch;
                slot.controllerUserId = control.userId;
                slot.connected = control.connectedSocketIds.length > 0
                    || (gmConnected && (control.role === 'GM' || control.takenOverByGm));
            }
            if (slot.readyAtTick !== undefined && currentTick >= slot.readyAtTick) {
                slot.readyAtTick = undefined;
                slot.blockedReason = undefined;
            }
            const entity = this.getEntity(entityId);
            if (entity?.currentActionContext && !slot.ready) {
                slot.blockedReason = entity.currentActionContext.phase === 'RECOVERY'
                    ? `收招至 Tick ${entity.currentActionContext.resolveTick}`
                    : '动作进行中';
            } else if (entity && !slot.ready && slot.readyAtTick === undefined) {
                slot.blockedReason = slot.connected ? '等待该玩家提交行动' : '玩家断线，等待 GM 代决';
            }
        }
    }

    private getEntity(id: EntityId): EncounterEntity | undefined {
        return this.engine.getAllEntities().find(entity => entity.id === id) as EncounterEntity | undefined;
    }

    private getAction(id: string): ActionTemplate | undefined {
        return this.engine.getActionCatalog().getAction(id);
    }

    private resourceCost(template: ActionTemplate, entity: EncounterEntity): Record<string, number> {
        const result: Record<string, number> = {};
        for (const [key, expression] of Object.entries(template.resourceCost ?? {})) {
            const value = Math.abs(RuleEvaluator.evaluate(expression, { actor: entity }).total);
            if (value > 0) result[key] = value;
        }
        return result;
    }

    /** Derive a display hint from rule data without moving effect semantics into the UI. */
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

    private defaultRecoveryActionTemplateId(): string | undefined {
        const resourceRecovery = this.content.actionTemplates.find(template =>
            template.tags.includes('RECOVERY') && template.tags.includes('RESOURCE'),
        );
        return resourceRecovery?.id
            ?? this.content.actionTemplates.find(template => template.tags.includes('RECOVERY'))?.id;
    }

    private isMovementActionTemplateId(actionTemplateId: string | undefined): boolean {
        return actionTemplateId !== undefined
            && this.content.actionTemplates.some(template =>
                template.id === actionTemplateId && template.tags.includes('MOVEMENT'),
            );
    }

    private canAfford(entity: EncounterEntity, cost: Record<string, number>): boolean {
        return Object.entries(cost).every(([key, value]) => (entity.resources.current[key] ?? 0) >= value);
    }

    private validateTargets(
        principal: CommandPrincipal,
        actor: EncounterEntity,
        template: ActionTemplate,
        targetIds: EntityId[],
        checkCurrentRange = template.activeWindowTicks === undefined && template.strikeSequence === undefined,
    ): { code: string; reason: string } | undefined {
        const maxRange = template.range?.distanceExpr
            ? Math.abs(RuleEvaluator.evaluate(template.range.distanceExpr, { actor }).total)
            : Number.POSITIVE_INFINITY;
        for (const targetId of targetIds) {
            const target = this.getEntity(targetId);
            if (!target) return { code: 'UNKNOWN_TARGET', reason: `目标不存在: ${targetId}` };
            if (principal.role !== 'GM' && (target as EncounterEntity).visibility === 'GM') {
                return { code: 'FORBIDDEN_TARGET', reason: '目标不可见' };
            }
            const distance = VectorMath.distance(actor.transform.coords, target.transform.coords);
            if (checkCurrentRange && !SpatialActionSystem.inReach(template, actor, target, maxRange)) {
                return { code: 'OUT_OF_RANGE', reason: `目标超出动作范围（${distance.toFixed(2)} > ${maxRange}）` };
            }
        }
        return undefined;
    }

    private previewTargetKind(template?: ActionTemplate): DemoActionPreview['targetKind'] {
        if (!template) return 'none';
        if (template.targetKind) return template.targetKind;
        if (template.tags.includes('MOVEMENT')) return 'cell';
        if (template.effects.some(effect => effect.targetSelector === 'PRIMARY' || effect.targetSelector === 'ALL_IN_AOE')) {
            return 'entity';
        }
        return 'none';
    }

    private previewRandomExpressionReason(template: ActionTemplate): string | undefined {
        const expressions = [
            ...Object.values(template.resourceCost ?? {}),
            template.range?.distanceExpr,
            template.range?.radiusExpr,
        ].filter((expression): expression is string => typeof expression === 'string');
        if (expressions.some(expression => /\d+\s*d\s*\d+/i.test(expression))) {
            return '动作包含随机资源或范围表达式，暂不支持此动作的目标预览';
        }
        if (expressions.some(expression => /\b(?:random|randomInt|pickRandom|rand|roll|dice)\s*\(/i.test(expression))) {
            return '动作包含随机资源或范围表达式，暂不支持此动作的目标预览';
        }
        return undefined;
    }

    private previewMainActionReason(
        actor: EncounterEntity,
        slot: EncounterReadySlot | undefined,
    ): string | undefined {
        if (this.status !== 'ACTIVE' || this.paused || this.result !== undefined || this.decisionWindows.size > 0) {
            return '当前没有可提交的行动窗口';
        }
        if ((actor.resources.current.hp ?? 0) <= 0) return '已倒地实体不能行动';
        if (actor.currentActionContext) {
            return actor.currentActionContext.phase === 'RECOVERY'
                ? `实体仍在收招至 Tick ${actor.currentActionContext.resolveTick}`
                : '实体仍在动作或收招中';
        }
        if (!slot) return '实体没有可用的行动槽';
        if (slot.ready) return '该实体已经提交本窗口行动';
        if (slot.readyAtTick !== undefined && this.engine.currentTick < slot.readyAtTick) {
            return `该实体已等待至 Tick ${slot.readyAtTick}`;
        }
        return undefined;
    }

    private previewEntityCandidates(
        principal: CommandPrincipal,
        actor: EncounterEntity,
        template: ActionTemplate | undefined,
        blockedReason?: string,
    ): DemoActionPreviewEntity[] {
        const candidates: DemoActionPreviewEntity[] = [];
        for (const target of this.engine.getAllEntities() as EncounterEntity[]) {
            if (!this.isPreviewEntityVisible(principal, target)) continue;
            const targetError = blockedReason || !template
                ? { reason: blockedReason ?? '动作模板不存在' }
                : this.validateTargets(principal, actor, template, [target.id]);
            candidates.push({
                entityId: target.id,
                allowed: targetError === undefined,
                ...(!blockedReason && template ? {
                    inRange: this.validateTargets(principal, actor, template, [target.id], true) === undefined,
                } : {}),
                ...(targetError ? { reason: targetError.reason } : {}),
            });
        }
        return candidates;
    }

    private previewCellCandidates(blockedReason?: string): DemoActionPreviewCell[] {
        const width = Number.isInteger(this.content.map.width) ? Math.max(0, this.content.map.width) : 0;
        const height = Number.isInteger(this.content.map.height) ? Math.max(0, this.content.map.height) : 0;
        const cells: DemoActionPreviewCell[] = [];
        for (let x = 0; x < width; x += 1) {
            for (let y = 0; y < height; y += 1) {
                const error = blockedReason ? { reason: blockedReason } : this.validateMoveTarget({ x, y, z: 0 });
                cells.push({
                    x,
                    y,
                    allowed: error === undefined,
                    ...(error ? { reason: error.reason } : {}),
                });
            }
        }
        return cells;
    }

    /**
     * Draw the same coordinate distance envelope used by validateTargets.
     * This is a read-only visual hint; target admission still happens against
     * actual entity coordinates when ACTION is submitted.
     */
    private previewRangeCellCandidates(
        actor: EncounterEntity,
        template: ActionTemplate | undefined,
        blockedReason?: string,
    ): DemoActionPreviewCell[] {
        const width = Number.isInteger(this.content.map.width) ? Math.max(0, this.content.map.width) : 0;
        const height = Number.isInteger(this.content.map.height) ? Math.max(0, this.content.map.height) : 0;
        const maxRange = blockedReason
            ? Number.POSITIVE_INFINITY
            : template?.range?.distanceExpr
                ? Math.abs(RuleEvaluator.evaluate(template.range.distanceExpr, { actor }).total)
                : Number.POSITIVE_INFINITY;
        const cells: DemoActionPreviewCell[] = [];
        for (let x = 0; x < width; x += 1) {
            for (let y = 0; y < height; y += 1) {
                const positionError = this.validateMoveTarget({ x, y, z: actor.transform.coords.z }, template?.tags.includes('MOVEMENT') === true, actor);
                const distance = VectorMath.distance(actor.transform.coords, { x, y, z: actor.transform.coords.z });
                const minRange = template?.launchProjectile?.minRange ?? template?.spatial?.reach?.minReach ?? 0;
                const rangeError = distance > maxRange || distance < minRange
                    ? { reason: `超出动作范围（${distance.toFixed(2)} > ${maxRange}）` }
                    : undefined;
                const error = blockedReason
                    ? { reason: blockedReason }
                    : positionError ?? rangeError;
                cells.push({
                    x,
                    y,
                    allowed: error === undefined,
                    ...(error ? { reason: error.reason } : {}),
                });
            }
        }
        return cells;
    }

    private isPreviewEntityVisible(principal: CommandPrincipal, entity: EncounterEntity): boolean {
        if (principal.role === 'GM') return true;
        return entity.visibility !== 'GM'
            && !entity.tags?.includes('HIDDEN')
            && !entity.tags?.includes('INVISIBLE');
    }

    private scheduledActionToPlan(action: ActionScheduledPayload): EncounterActionPlan {
        // Legacy producers omitted executionId. A stable per-entity/start
        // fallback keeps repeated uses of the same template from colliding in
        // the timeline while preserving the original id whenever available.
        const actionId = action.executionId
            ?? `legacy:${action.entityId}:${action.actionId}:${action.timeline.start}`;
        const history = this.actionPlans.historyFor(actionId);
        const templateId = action.actionId === '__BUILTIN_MOVE__'
            ? history?.actionTemplateId ?? action.actionId
            : action.actionId;
        const isMovement = action.tags?.includes('MOVEMENT') === true
            || this.isMovementActionTemplateId(history?.actionTemplateId ?? templateId);
        const pulseTicks = action.timeline.pulseTicks ?? [];
        const arrivalTick = isMovement
            ? pulseTicks[pulseTicks.length - 1] ?? action.timeline.startupEnd
            : undefined;
        return {
            actionId,
            actorId: action.entityId,
            actionTemplateId: templateId,
            targetIds: [...(action.targetIds ?? [])],
            targetCoords: action.targetCoords ? { ...action.targetCoords } : undefined,
            phase: this.phaseFromTimeline(action.timeline),
            declaredTick: action.timeline.start,
            effectiveTick: action.effectiveTick,
            priority: action.priority ?? 0,
            paidResources: history ? { ...history.paidResources } : {},
            decisionVersion: history?.decisionVersion ?? 1,
            controlEpoch: history?.controlEpoch ?? this.controls.get(action.entityId)?.controlEpoch ?? 0,
            causationId: history?.causationId ?? action.causationId ?? action.executionId ?? action.actionId,
            relation: history?.relation ?? this.actionRelation(this.getAction(templateId)),
            selfTarget: history?.selfTarget ?? this.actionSelfTargets(this.getAction(templateId)),
            ...(arrivalTick === undefined ? {} : { arrivalTick }),
            timeline: structuredClone(action.timeline),
            source: history?.source ?? 'SYSTEM',
            cancelled: history?.cancelled,
        };
    }

    /**
     * Derive the displayed phase from the engine's explicit boundaries. This
     * prevents an old action entry from being relabelled as a fresh DELAY
     * merely because its actor has already cleared currentActionContext.
     * Gaps between active windows are the small STARTUP/CHANNELING portions
     * of a multi-strike or channel action.
     */
    private phaseFromTimeline(timeline: ActionScheduledPayload['timeline']): EncounterActionPhase {
        const tick = this.engine.currentTick;
        if (tick >= timeline.end) return 'RESOLVED';

        const segment = timeline.phaseSegments?.find(candidate =>
            tick >= candidate.start && tick < candidate.end,
        );
        if (segment) {
            // EncounterActionPhase intentionally keeps the engine's public
            // lifecycle vocabulary. SMALL_STARTUP is a display-only split,
            // while MOVING is represented by the existing CHANNELING state.
            if (segment.phase === 'SMALL_STARTUP') return 'STARTUP';
            if (segment.phase === 'MOVING') return 'CHANNELING';
            return segment.phase;
        }

        if (tick < timeline.start) return 'DELAY';
        if (tick >= timeline.recoveryStart) return 'RECOVERY';

        const activeWindows = timeline.activeWindows ?? [];
        if (activeWindows.some(window => tick >= window.start && tick < window.end)) return 'ACTIVE';
        if ((timeline.pulseTicks?.length ?? 0) > 1 && tick >= timeline.startupEnd) return 'CHANNELING';
        return 'STARTUP';
    }

    private getActionPlansFromEngine(_payload: unknown): EncounterActionPlan[] {
        return this.engine.getScheduledActions().map(action => this.scheduledActionToPlan(action));
    }

    private isTerminalCandidate(): boolean {
        if (this.status === 'LOBBY') return false;
        return this.outcomes.isTerminalCandidate(this.engine.getAllEntities());
    }

    private refreshTerminalState(): void {
        if (this.result || this.status === 'LOBBY') return;
        // A death notification can arrive in the middle of a Tick while the
        // same committed batch still has recovery, channel, movement, or
        // projectile events in the heap.  Wait for the authoritative effect
        // queue to finish that committed work before deriving the encounter
        // result; otherwise a later same-Tick effect would be lost behind an
        // already persisted VICTORY/DEFEAT.
        if (this.engine.hasPendingActionEvents()) return;
        if (!this.isTerminalCandidate()) return;
        this.result = this.outcomes.buildResult(this.engine.getAllEntities(), this.engine.currentTick, 'RULES', '只剩一方或相互同盟的参战方存活');
        this.status = this.result.status;
        this.paused = false;
        this.addLog(`遭遇结算：${this.result.status}。`, LogVisibility.PLAYER);
        this.bumpRevision('RESULT', { result: structuredClone(this.result), status: this.status, paused: this.paused });
        this.emit('SETTLED', structuredClone(this.result));
    }

    private addLog(message: string, visibility: LogVisibility, userId?: string, actorId?: EntityId, actionId?: string, causationId?: string, audit?: Record<string, unknown>): void {
        this.logs.push({
            id: generateId(),
            tick: this.engine.currentTick,
            message,
            level: visibility === LogVisibility.GM ? LogLevel.INFO : LogLevel.GAME,
            visibility,
            actorId,
            actionId,
            causationId,
            meta: audit ? { ...audit, userId } : userId ? { userId } : undefined,
        });
        if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    }

    private bumpRevision(type: EncounterIncrement['type'], payload: Partial<EncounterSnapshot> = {}): void {
        this.revision++;
        const increment: EncounterIncrement = {
            encounterId: this.encounterId,
            revision: this.revision,
            tick: this.engine.currentTick,
            type,
            payload,
        };
        this.emit('INCREMENT', structuredClone(increment));
        this.emit('SNAPSHOT', this.getSnapshot());
    }

    private stringValue(value: unknown): string | undefined {
        return typeof value === 'string' && value.length > 0 ? value : undefined;
    }

    private isCommand(value: EncounterCommand | CommandPrincipal): value is EncounterCommand {
        return Boolean(value && typeof value === 'object' && 'requestId' in value && 'type' in value);
    }

    private commandFingerprint(command: EncounterCommand): string {
        return JSON.stringify(this.canonicalValue(command));
    }

    private canonicalValue(value: unknown): unknown {
        if (Array.isArray(value)) return value.map(item => this.canonicalValue(item));
        if (!value || typeof value !== 'object') return value;
        const record = value as Record<string, unknown>;
        return Object.fromEntries(
            Object.keys(record).sort().map(key => [key, this.canonicalValue(record[key])]),
        );
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

    private validateMoveTarget(target: Vector3D, movement = true, actor?: EncounterEntity): { code: string; reason: string } | undefined {
        const width = this.content.map.width;
        const height = this.content.map.height;
        if (target.x < 0 || target.x > width - 1 || target.y < 0 || target.y > height - 1) {
            return { code: 'INVALID_POSITION', reason: '移动目标不在战场范围内' };
        }
        if (movement && SpatialActionSystem.mapObstacles(this.content.map).some(obstacle =>
            Math.hypot(obstacle.x - target.x, obstacle.y - target.y) < 0.7)) {
            return { code: 'BLOCKED_POSITION', reason: '移动目标被墙体或障碍物占据' };
        }
        if (movement && SpatialActionSystem.isOccupiedDestination(target, this.engine.getAllEntities(), actor)) {
            return { code: 'BLOCKED_POSITION', reason: '移动目标被实体占据' };
        }
        return undefined;
    }

    private entityIds(value: unknown): EntityId[] {
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    }

}

export default EncounterCoordinator;
