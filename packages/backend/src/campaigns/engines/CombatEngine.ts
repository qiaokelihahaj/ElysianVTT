// packages/backend/src/campaigns/engines/CombatEngine.ts
import { EventEmitter } from 'events';
import {
    IEngineInstance, Tick, ClientIntent, Entity, EntityId,
    TickEvent, ActionExecutionEvent, MovementStepEvent, StateMutationPayload,
    ActionScheduledPayload, DecisionPollPayload, DecisionResponsePayload, DecisionOption,
    PlayerPriorityToggle, HookPreset, HookTrigger, LogVisibility, UnifiedHook
} from '@hard-vtt/shared';
import { PriorityQueue } from '../../core/engine/PriorityQueue.js';
import { TickLoop } from '../../core/engine/TickLoop.js';
import { ClashPool } from '../../core/engine/ClashPool.js';
import type { ClashResult } from '../../core/engine/ClashPool.js';
import { generateId } from '../../utils/IdGenerator.js';
import { Dictionary } from '../../db/Dictionary.js';
import { RulePackLoader } from '../../db/RulePackLoader.js';
import { EffectSystem } from '../../core/systems/EffectSystem.js';
import { SpatialSystem } from '../../core/systems/SpatialSystem.js';
import { RuleEvaluator } from '../../core/systems/RuleEvaluator.js';
import { VectorMath } from '../../utils/VectorMath.js';
import { Logger } from '../../utils/Logger.js';
import { HookRegistry } from './HookRegistry.js';
import type { RulePackDefs } from '@hard-vtt/shared';

const MOVE_INTERVAL_TICKS = 10;
const MOVE_STEP_SIZE = 1.0;
const MOVE_RECOVERY_TICKS = 5;

export class CombatEngine extends EventEmitter implements IEngineInstance {
    public engineId: string;
    public engineType: 'COMBAT' | 'EXPLORE' = 'COMBAT';
    public get currentTick(): Tick { return this.tickLoop.getCurrentTick(); }

    private eventQueue = new PriorityQueue();
    private tickLoop = new TickLoop(this.eventQueue);
    private entities = new Map<EntityId, Entity>();
    private combatEnded = false;
    
    private pendingMutations: StateMutationPayload = { tick: 0, mutations: [] };

    private hookRegistry: HookRegistry;
    private decisionTargets: Map<string, { reactorId: EntityId; sourceId: EntityId }> = new Map();

    private playerToggles: Map<EntityId, PlayerPriorityToggle> = new Map();

    private rulePackDefs: RulePackDefs | null = null;

    private logger: Logger;

    constructor(engineId: string, rulePackId?: string) {
        super();
        this.engineId = engineId;
        this.logger = Logger.create(`Engine:Combat`);
        this.logger.info(`Engine created`, null, { sceneId: this.engineId });
        this.hookRegistry = new HookRegistry();

        if (rulePackId) {
            RulePackLoader.load(rulePackId).then(defs => {
                this.rulePackDefs = defs;
                this.logger.info(`RulePack '${rulePackId}' bound to engine`, null, { sceneId: this.engineId });
            });
        }
    }

    private logCtx() {
        return { tick: this.tickLoop.getCurrentTick(), sceneId: this.engineId };
    }

    public getAllEntities(): Entity[] {
        return Array.from(this.entities.values());
    }

    public getRulePackDefs(): RulePackDefs | null {
        return this.rulePackDefs;
    }

    public mountEntities(entities: Entity[]): void {
        for (const entity of entities) {
            this.entities.set(entity.id, entity);
        }
    }

    public unmountEntities(entityIds: EntityId[]): Entity[] {
        const removed: Entity[] = [];
        for (const id of entityIds) {
            const ent = this.entities.get(id);
            if (ent) {
                removed.push(ent);
                this.entities.delete(id);
            }
        }
        return removed;
    }

    private _batchMode = false;

    public receiveIntent(intent: ClientIntent): void {
        // BATCH_CAST 不依赖单个 actor
        if (intent.intentType === 'BATCH_CAST' && intent.payload.batchIntents?.length) {
            this.handleBatchCast(intent.payload.batchIntents);
            return;
        }

        const actor = this.entities.get(intent.actorId);
        if (!actor) return;

        if (intent.intentType === 'MOVE' && intent.payload.targetCoords) {
            this.handleMoveIntent(actor, intent.payload.targetCoords);
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
        this.processQueue();
    }

    // ============================================================
    //  移动
    // ============================================================

    private handleMoveIntent(actor: Entity, targetCoords: { x: number; y: number; z: number }): void {
        this.cancelCurrentAction(actor);

        const waypoints = SpatialSystem.planWaypoints(actor, targetCoords, MOVE_STEP_SIZE);
        
        if (waypoints.length === 0) {
            this.logger.warn(`${actor.id} 已在目标位置`, null, this.logCtx());
            return;
        }

        this.logger.game(
            `🏃 [Move] Tick ${this.currentTick}: ${actor.id} → (${targetCoords.x.toFixed(1)},${targetCoords.y.toFixed(1)}) 共 ${waypoints.length} 步`,
            null, LogVisibility.PLAYER, this.logCtx()
        );

        const ct = this.currentTick;
        const evt: ActionExecutionEvent = {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: ct + MOVE_INTERVAL_TICKS,
            status: 'PENDING',
            actorId: actor.id,
            actionTemplateId: '__BUILTIN_MOVE__',
            phase: 'STARTUP'
        };

        this.eventQueue.push(evt);

        actor.currentActionContext = {
            type: 'MOVING',
            actionId: evt.eventId,
            phase: 'STARTUP',
            resolveTick: evt.targetTick,
            pulseCount: 0,
            waypoints,
            currentWaypointIndex: 0
        };

        // 广播时间轴数据
        const moveActiveTicks: number[] = [];
        let moveTick = evt.targetTick;
        for (let i = 0; i < waypoints.length; i++) {
            moveActiveTicks.push(moveTick + i * MOVE_INTERVAL_TICKS);
        }
        const moveEndTick = evt.targetTick + (waypoints.length - 1) * MOVE_INTERVAL_TICKS + 1 + MOVE_RECOVERY_TICKS;
        this.emit('ACTION_SCHEDULED', {
            entityId: actor.id,
            actionId: '__BUILTIN_MOVE__',
            actionName: 'Move',
            timeline: {
                start: ct,
                startupEnd: evt.targetTick,
                recoveryStart: moveActiveTicks[moveActiveTicks.length - 1] + 1,
                end: moveEndTick,
                pulseTicks: moveActiveTicks
            },
            tags: ['MOVEMENT']
        } as ActionScheduledPayload);

        if (!this._batchMode) this.processQueue();
    }

    // ============================================================
    //  技能意图
    // ============================================================

    private handleActionIntent(actor: Entity, intent: ClientIntent): void {
        const template = Dictionary.getAction(intent.payload.actionTemplateId!);
        if (!template) {
            this.logger.warn(`技能 ${intent.payload.actionTemplateId} 不存在`);
            return;
        }

        this.cancelCurrentAction(actor);

        const ct = this.currentTick;
        const startupTicks = template.timeCost.startupTicks;
        const recoveryTicks = template.timeCost.recoveryTicks;

        const evt: ActionExecutionEvent = {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: ct + startupTicks,
            status: 'PENDING',
            actorId: intent.actorId,
            targetIds: intent.payload.targetIds,
            actionTemplateId: template.id,
            phase: 'STARTUP'
        };

        this.eventQueue.push(evt);

        // 计算 channel 持续时长和脉冲节点
        // 引擎行为：第一个脉冲在 activeTick，之后每 intervalTicks 一个脉冲
        // pushRecovery 在最后一个脉冲 tick + 1 + recoveryTicks 触发
        const activeTick = ct + startupTicks;
        const pulseTicks: number[] = [activeTick];
        if (template.channelOptions) {
            const pulses = template.channelOptions.maxPulses ?? 1;
            const interval = template.channelOptions.intervalTicks;
            for (let i = 1; i < pulses; i++) {
                pulseTicks.push(activeTick + i * interval);
            }
        }
        const lastPulseTick = pulseTicks[pulseTicks.length - 1];
        const endTick = lastPulseTick + 1 + recoveryTicks;

        actor.currentActionContext = {
            type: 'CASTING',
            actionId: evt.eventId,
            actionTemplateId: template.id,
            phase: 'STARTUP',
            resolveTick: evt.targetTick,
            pulseCount: 0
        };

        // 广播 ACTION_SCHEDULED
        this.emit('ACTION_SCHEDULED', {
            entityId: intent.actorId,
            actionId: template.id,
            actionName: template.id,
            timeline: {
                start: ct,
                startupEnd: activeTick,
                recoveryStart: pulseTicks[pulseTicks.length - 1] + 1,
                end: endTick,
                pulseTicks
            },
            tags: template.tags
        } as ActionScheduledPayload);

        if (!this._batchMode) this.processQueue();
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

        const template = Dictionary.getAction('PARRY');
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
        if (template.resourceCost) {
            for (const [resKey, expr] of Object.entries(template.resourceCost)) {
                const cost = Math.abs(RuleEvaluator.evaluate(expr, { actor }).total);
                if (cost > 0 && actor.resources.current[resKey] !== undefined) {
                    actor.resources.current[resKey] = Math.max(0, (actor.resources.current[resKey] ?? 0) - cost);
                    this.recordMutation(actor.id, { [`resources.current.${resKey}`]: actor.resources.current[resKey] });
                }
            }
        }

        this.logger.game(`🛡️ [Parry] Tick ${this.currentTick}: ${actor.id} 进入招架姿态 (startup=${startupTicks})`, null, LogVisibility.PLAYER, this.logCtx());

        this.emit('ACTION_SCHEDULED', {
            entityId: actor.id,
            actionId: 'PARRY',
            actionName: '招架',
            timeline: {
                start: ct,
                startupEnd: ct + startupTicks,
                recoveryStart: ct + startupTicks + 1,
                end: ct + startupTicks + 1 + template.timeCost.recoveryTicks,
                pulseTicks: []
            },
            tags: ['DEFENSE']
        } as ActionScheduledPayload);

        if (!this._batchMode) this.processQueue();
    }

    // ============================================================
    //  闪避
    // ============================================================

    private handleDodgeIntent(actor: Entity, targetCoords: { x: number; y: number; z: number }): void {
        this.cancelCurrentAction(actor);

        const template = Dictionary.getAction('DODGE');
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
        if (template.resourceCost) {
            for (const [resKey, expr] of Object.entries(template.resourceCost)) {
                const cost = Math.abs(RuleEvaluator.evaluate(expr, { actor }).total);
                if (cost > 0 && actor.resources.current[resKey] !== undefined) {
                    actor.resources.current[resKey] = Math.max(0, (actor.resources.current[resKey] ?? 0) - cost);
                    this.recordMutation(actor.id, { [`resources.current.${resKey}`]: actor.resources.current[resKey] });
                }
            }
        }

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
        this.eventQueue.push(recoveryEvt);

        this.logger.game(`💨 [Dodge] Tick ${this.currentTick}: ${actor.id} 闪避到 (${targetCoords.x.toFixed(1)},${targetCoords.y.toFixed(1)})`, null, LogVisibility.PLAYER, this.logCtx());

        if (!this._batchMode) this.processQueue();
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
        let manualFired = false;

        for (const hook of firedHooks) {
            // 跳过系统钩子的 DECISION_POLL（仅手动钩子需要决策触发）
            if (hook.source === 'SYSTEM') continue;

            manualFired = true;

            const windowId = generateId();
            const payload: DecisionPollPayload = {
                windowId,
                windowType: 'REACTION',
                actorId: hook.entityId,
                sourceAction: {
                    actorId: 'SYSTEM',
                    actionName: hook.label,
                    startupRemainingTicks: 0
                },
                countdownMs: 5000,
                availableOptions: [],
                tick
            };

            this.logger.game(
                `🪝 [Hook] Tick ${tick}: '${hook.label}' 触发，强制决策窗口`,
                { hookId: hook.id, entityId: hook.entityId, tick },
                LogVisibility.PLAYER,
                this.logCtx()
            );

            this.emit('DECISION_POLL', payload);
        }

        return manualFired;
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

            // RECOVERY 阶段跳过
            if (e.currentActionContext?.phase === 'RECOVERY') return false;

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
    private buildReactionOptions(action: ActionExecutionEvent): DecisionOption[] {
        const actor = this.entities.get(action.actorId);
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
            const template = Dictionary.getAction(skillId);
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
    private generateSystemHooks(sourceAction: ActionExecutionEvent): void {
        const source = this.entities.get(sourceAction.actorId);
        if (!source) return;

        const template = Dictionary.getAction(sourceAction.actionTemplateId);
        if (!template) return;

        const validReactors = this.getValidReactors(sourceAction);
        if (validReactors.length === 0) return;

        const countdownMs = 3000;
        const options = this.buildReactionOptions(sourceAction);
        const hookTtl = 15; // ticks

        for (const reactor of validReactors) {
            const windowId = generateId();
            const hookPreset: HookPreset = {
                id: generateId(),
                entityId: reactor.id,
                label: `Reaction to ${template.id}`,
                trigger: { type: 'TICK_REACHED', targetTick: this.currentTick },
                enabled: true
            };

            this.hookRegistry.register(reactor.id, hookPreset, 'SYSTEM', this.currentTick, hookTtl);
            this.decisionTargets.set(windowId, { reactorId: reactor.id, sourceId: source.id });

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
                tick: this.currentTick
            };

            this.emit('DECISION_POLL', payload);
        }

        this.logger.game(
            `⚡ [SystemHook] Tick ${this.currentTick}: ${source.id}/${template.id} 生成 ${validReactors.length} 个系统钩子`,
            null, LogVisibility.PLAYER, this.logCtx()
        );
    }

    /**
     * 处理客户端对决策窗口的响应。
     * 查找对应实体，执行选中的反应动作。
     */
    public handleDecisionResponse(payload: DecisionResponsePayload): void {
        // 如果选择忽略或超时不做反应，恢复队列继续推进
        if (!payload.chosenOptionId || payload.chosenOptionId === 'DO_NOTHING') {
            if (!this.tickLoop.isEmpty()) {
                this.processQueue();
            }
            return;
        }

        // 通过 windowId 查找对应的 reactor entity
        const target = this.decisionTargets.get(payload.windowId);
        if (!target) {
            this.logger.warn(`DecisionResponse: 未找到窗口 ${payload.windowId} 对应的实体`, null, this.logCtx());
            return;
        }

        const reactor = this.entities.get(target.reactorId);
        if (!reactor) {
            this.logger.warn(`DecisionResponse: 实体 ${target.reactorId} 不存在`, null, this.logCtx());
            this.decisionTargets.delete(payload.windowId);
            return;
        }

        // 清理 decision 映射
        this.decisionTargets.delete(payload.windowId);

        // 执行选中的反应动作
        const reactionTemplate = Dictionary.getAction(payload.chosenOptionId);
        if (!reactionTemplate) {
            this.logger.warn(`DecisionResponse: 动作模板 ${payload.chosenOptionId} 不存在`, null, this.logCtx());
            return;
        }

        // 取消当前动作并创建反应动作事件
        this.cancelCurrentAction(reactor);

        const ct = this.currentTick;
        const evt: ActionExecutionEvent = {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: ct + reactionTemplate.timeCost.startupTicks,
            status: 'PENDING',
            actorId: reactor.id,
            targetIds: [target.sourceId],
            actionTemplateId: reactionTemplate.id,
            phase: 'STARTUP'
        };

        this.eventQueue.push(evt);

        reactor.currentActionContext = {
            type: 'CASTING',
            actionId: evt.eventId,
            actionTemplateId: reactionTemplate.id,
            phase: 'STARTUP',
            resolveTick: evt.targetTick,
            pulseCount: 0
        };

        this.logger.game(
            `🎯 [DecisionResponse] Tick ${this.currentTick}: ${reactor.id} 选择反应: ${payload.chosenOptionId}`,
            { windowId: payload.windowId, reactorId: reactor.id, chosenOptionId: payload.chosenOptionId },
            LogVisibility.PLAYER,
            this.logCtx()
        );

        this.processQueue();
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
        this.eventQueue.push(recoveryEvt);

        this.logger.game(`🔄 [MicroEvade] Tick ${this.currentTick}: ${actor.id} 尝试 ${evadeType} 微避`, null, LogVisibility.PLAYER, this.logCtx());

        if (!this._batchMode) this.processQueue();
    }

    // ============================================================
    //  取消 / 打断
    // ============================================================

    public cancelCurrentAction(actor: Entity): void {
        for (const event of (this.eventQueue as any).heap) {
            if (event.status !== 'PENDING') continue;
            if ((event as ActionExecutionEvent).actorId === actor.id ||
                (event as MovementStepEvent).actorId === actor.id) {
                event.status = 'CANCELLED';
            }
        }
        actor.currentActionContext = undefined;
        this.logger.debug(`${actor.id} 动作/移动已取消`, null, this.logCtx());
    }

    private triggerInterrupt(entity: Entity): void {
        const ctx = entity.currentActionContext;
        if (!ctx || (ctx.phase !== 'STARTUP' && ctx.phase !== 'CHANNELING')) return;

        const template = ctx.actionTemplateId ? Dictionary.getAction(ctx.actionTemplateId) : undefined;

        this.cancelCurrentAction(entity);

        if (template?.sustainResources) {
            for (const resKey of template.sustainResources) {
                if (entity.resources.current[resKey] !== undefined) {
                    entity.resources.current[resKey] = 0;
                    this.recordMutation(entity.id, { [`resources.current.${resKey}`]: 0 });
                }
            }
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

            const template = ctx.actionTemplateId ? Dictionary.getAction(ctx.actionTemplateId) : undefined;
            const sustainResources = template?.sustainResources;

            const hp = entity.resources.current['hp'] ?? 999;

            let shouldInterrupt = false;
            if (sustainResources && sustainResources.length > 0) {
                for (const resKey of sustainResources) {
                    if ((entity.resources.current[resKey] ?? 999) <= 0) {
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

    private processQueue(): void {
        while (!this.tickLoop.isEmpty()) {
            // 广播上一轮的 accumulation
            if (this.pendingMutations.mutations.length > 0) {
                this.broadcastMutations();
            }

            // 注入 hook 断点：确保 TICK_REACHED hook 在目标 tick 精确触发
            this.injectHookBreakpoints();

            const step = this.tickLoop.step()!;
            this.pendingMutations.tick = step.tick;

            // 先结算事件，再评估 hook：防止 hook 目标 tick 与真实事件 tick 重叠时事件丢失
            const events = step.events.filter(e => e.status !== 'CANCELLED');
            if (events.length > 0) {
                const clashCandidates = TickLoop.filterClashable(events)
                    .filter(e => e.actionTemplateId !== '__BUILTIN_MOVE__');

                if (clashCandidates.length >= 2) {
                    this.resolveClash(clashCandidates);
                    const others = events.filter(e => !clashCandidates.includes(e as any));
                    for (const e of others) {
                        this.resolveSingleEvent(e);
                    }
                } else {
                    for (const e of events) {
                        this.resolveSingleEvent(e);
                    }
                }
            }

            // 评估 Hook 预设（TICK_REACHED 等条件触发）
            const hookFired = this.evaluateHooks(step.tick);
            this.hookRegistry.cleanup(step.tick);

            // 手动钩子触发后：先广播当前 tick 的 mutations，再暂停队列让 DECISION_POLL 送达前端
            if (hookFired) {
                if (this.pendingMutations.mutations.length > 0) {
                    this.broadcastMutations();
                }
                break;
            }

            // 不在此处判定战斗结束 — 让队列排空后再判定
        }

        this.broadcastMutations();

        // 所有事件处理完毕，检查战斗是否应该结束
        this.checkAndEndCombat();
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
            2.0,
            (target) => this.cancelCurrentAction(target)
        );

        for (const mutation of result.mutations) {
            this.recordMutation(mutation.entityId, mutation.changes);
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
            const actor = this.entities.get(ce.actorId);
            if (!actor?.currentActionContext) continue;
            this.pushNextPhase(actor, ce);
        }

        this.checkAndEndCombat();
    }

    private resolveSingleEvent(event: TickEvent): void {
        if ((event as ActionExecutionEvent).eventType === 'ACTION_PHASE') {
            this.resolveActionEvent(event as ActionExecutionEvent);
        } else if ((event as MovementStepEvent).eventType === 'MOVEMENT_STEP') {
            this.resolveMovementStep(event as MovementStepEvent);
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
            actor.currentActionContext = undefined;
            this.recordMutation(actor.id, { 'currentActionContext': null });
            return;
        }

        const waypoints = ctx.waypoints;
        const index = ctx.currentWaypointIndex ?? 0;

        const wp = waypoints[index];
        actor.transform.coords.x = wp.x;
        actor.transform.coords.y = wp.y;
        actor.transform.coords.z = wp.z;

        this.recordMutation(actor.id, {
            'transform.coords.x': wp.x,
            'transform.coords.y': wp.y,
            'transform.coords.z': wp.z
        });

        ctx.pulseCount = (ctx.pulseCount ?? 0) + 1;

        const nextIndex = index + 1;
        if (nextIndex < waypoints.length) {
            ctx.currentWaypointIndex = nextIndex;
            this.pushNextPulse(actor, actEvent, MOVE_INTERVAL_TICKS);
        } else {
            this.logger.game(
                `✅ [Move] Tick ${this.currentTick}: ${actor.id} 到达目的地，进入收招`,
                null, LogVisibility.PLAYER, this.logCtx()
            );
            const recoveryEvt: ActionExecutionEvent = {
                ...actEvent,
                eventId: generateId(),
                targetTick: this.currentTick + 1 + MOVE_RECOVERY_TICKS,
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
    }

    private resolveActionPulse(actor: Entity, actEvent: ActionExecutionEvent): void {
        const ctx = actor.currentActionContext!;

        // === RECOVERY phase: 动作已完成，清除上下文 ===
        if (actEvent.phase === 'RECOVERY') {
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

        // === STARTUP (第一个或递归脉冲): 执行效果 + 决定后续 ===
        const template = Dictionary.getAction(actEvent.actionTemplateId);
        if (!template) return;

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

                actor.currentActionContext = {
                    ...actor.currentActionContext!,
                    phase: 'RECOVERY',
                    resolveTick: this.currentTick + extendedRecovery
                };

                const recoveryEvt: ActionExecutionEvent = {
                    ...actEvent,
                    eventId: generateId(),
                    targetTick: this.currentTick + extendedRecovery,
                    status: 'PENDING',
                    phase: 'RECOVERY'
                };
                this.eventQueue.push(recoveryEvt);

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

            actor.currentActionContext = {
                ...actor.currentActionContext!,
                phase: 'RECOVERY',
                resolveTick: this.currentTick + extendedRecovery
            };

            const recoveryEvt: ActionExecutionEvent = {
                ...actEvent,
                eventId: generateId(),
                targetTick: this.currentTick + extendedRecovery,
                status: 'PENDING',
                phase: 'RECOVERY'
            };
            this.eventQueue.push(recoveryEvt);
            return;
        }

        const mutations = EffectSystem.applyAction(template, actor, targets, this.logCtx(), (target) => {
            this.cancelCurrentAction(target);
        });

        const affectedIds: EntityId[] = [];
        for (const [targetId, changes] of mutations.entries()) {
            this.recordMutation(targetId, changes);
            affectedIds.push(targetId);
        }

        ctx.pulseCount = pulseNum;
        this.checkSustainAfterMutations([...affectedIds, actor.id]);

        // === 系统钩子: 为有效反应者注册系统钩子 ===
        this.generateSystemHooks(actEvent);

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
        } else {
            this.pushRecovery(actor, actEvent, template);
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
            phase: 'RECOVERY',
            resolveTick: recoveryEvt.targetTick
        };
    }

    private pushNextPhase(actor: Entity, prevEvent: ActionExecutionEvent): void {
        const template = Dictionary.getAction(prevEvent.actionTemplateId);
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
    //  工具方法
    // ============================================================

    private recordMutation(entityId: EntityId, changes: Record<string, any>) {
        let mutation = this.pendingMutations.mutations.find(m => m.entityId === entityId);
        if (!mutation) {
            mutation = { entityId, changes: {} };
            this.pendingMutations.mutations.push(mutation);
        }
        Object.assign(mutation.changes, changes);
    }

    private broadcastMutations() {
        if (this.pendingMutations.mutations.length > 0) {
            this.emit('STATE_MUTATED', this.pendingMutations);
            this.pendingMutations = { tick: this.currentTick, mutations: [] };
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
        this.emit('COMBAT_END', {
            sceneId: this.engineId,
            tick: this.currentTick,
            survivors: livingActors.map(entity => entity.id),
            casualties: actors.filter(entity => (entity.resources.current['hp'] ?? 0) <= 0).map(entity => entity.id),
            entities: this.getAllEntities()
        });

        return true;
    }
}
