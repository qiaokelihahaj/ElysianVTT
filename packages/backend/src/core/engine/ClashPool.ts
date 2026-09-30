// packages/backend/src/core/engine/ClashPool.ts
import type {
    Entity, EntityId, Tick, ActionExecutionEvent, ActionTemplate,
    TickEvent
} from '@hard-vtt/shared';
import { LogVisibility } from '@hard-vtt/shared';
import { RuleEvaluator } from '../systems/RuleEvaluator.js';
import { EffectSystem } from '../systems/EffectSystem.js';
import { DictionaryActionCatalog } from '../../db/Dictionary.js';
import type { ActionCatalog } from '../../rules/ActionCatalog.js';
import { Logger } from '../../utils/Logger.js';
import { VectorMath } from '../../utils/VectorMath.js';
import { SpatialActionSystem } from '../systems/SpatialActionSystem.js';

const logger = Logger.create('Engine:ClashPool');

export interface ClashEvent {
    event: ActionExecutionEvent;
    template: ActionTemplate;
    calculatedPriority: number;
}

export interface ClashGroup {
    priorityRange: [number, number];
    events: ClashEvent[];
}

export interface ClashMutation {
    entityId: EntityId;
    changes: Record<string, any>;
}

export interface ClashDeath {
    entityId: EntityId;
    killedBy: EntityId[];
    wasPoiseBreak: boolean;
}

export interface ClashResult {
    mutations: ClashMutation[];
    deaths: ClashDeath[];
    mutualKillPairs: Array<[EntityId, EntityId]>;
    newRecoveryEvents: ActionExecutionEvent[];
    /** Events cancelled by a higher-priority interrupt before their ACTIVE frame. */
    cancelledEventIds?: string[];
    /** Interrupt effects are committed only after the whole priority group snapshots. */
    interruptedEntityIds?: EntityId[];
    /**
     * Targets admitted by each action's range envelope in the immutable
     * group snapshot.  CombatEngine uses this to seed the per-strike ACTIVE
     * ledger without exposing packet/order dependent target state.
     */
    appliedTargetIds?: Record<string, EntityId[]>;
}

export class ClashPool {
    /**
     * 处理同一 Tick 上所有 ACTIVE 判定事件的冲突结算
     * 
     * @param events          - 同 Tick 的 ACTIVE 阶段事件列表
     * @param entities        - 引擎实体注册表（会被原地修改）
     * @param currentTick     - 当前引擎 Tick
     * @param tolerance       - 优先级容差，差值 <= tolerance 视为同级相杀
     * @param onInterrupt     - 打断回调（取消目标实体的动作/移动）
     */
    public static resolve(
        events: ActionExecutionEvent[],
        entities: Map<EntityId, Entity>,
        currentTick: Tick,
        tolerance: number = 0,
        onInterrupt?: (target: Entity) => void,
        actionCatalog: ActionCatalog = new DictionaryActionCatalog(),
    ): ClashResult {
        const result: ClashResult = {
            mutations: [],
            deaths: [],
            mutualKillPairs: [],
            newRecoveryEvents: [],
            cancelledEventIds: [],
            interruptedEntityIds: [],
            appliedTargetIds: {}
        };

        // ==== Step 1: Evaluate & Decorate ====
        const decorated = ClashPool.decorateEvents(events, entities, currentTick, actionCatalog);
        if (decorated.length === 0) return result;

        // ==== Step 2: Group & Sort ====
        const groups = ClashPool.groupByPriority(decorated, tolerance);

        // ==== Step 3 & 4: Resolve by group, highest priority first ====
        for (const group of groups) {
            // A higher-priority group may cancel a lower-priority STARTUP event.
            // Same-priority events remain simultaneous and are never filtered by
            // an interrupt produced by a sibling in this batch.
            const activeEvents = group.events.filter(ce => !result.cancelledEventIds?.includes(ce.event.eventId));
            if (activeEvents.length === 0) continue;
            ClashPool.resolveGroup(
                { ...group, events: activeEvents },
                entities,
                currentTick,
                result,
                onInterrupt,
                actionCatalog,
            );
        }

        return result;
    }

    /**
     * Step 1: 为每个事件求值 priorityExpr，赋予 calculatedPriority
     */
    private static decorateEvents(
        events: ActionExecutionEvent[],
        entities: Map<EntityId, Entity>,
        currentTick: Tick,
        actionCatalog: ActionCatalog,
    ): ClashEvent[] {
        const decorated: ClashEvent[] = [];

        for (const evt of events) {
            const actor = entities.get(evt.actorId);
            if (!actor) continue;

            const template = actionCatalog.getAction(evt.actionTemplateId);
            if (!template) continue;

            // 动态求值优先级表达式
            let calculatedPriority = evt.priorityOverride ?? 0;
            if (evt.priorityOverride === undefined && template.priorityExpr) {
                try {
                    const targets = (evt.targetIds || []).map(id => entities.get(id)).filter(e => e) as Entity[];
                    const primaryTarget = targets[0];
                    const { total } = RuleEvaluator.evaluate(template.priorityExpr, { actor, target: primaryTarget });
                    calculatedPriority = total;
                } catch {
                    calculatedPriority = 0;
                }
            }

            logger.game(
                `📊 [Clash] ${actor.id}:${template.id} → priority=${calculatedPriority}`,
                { actorId: actor.id, actionId: template.id, priority: calculatedPriority },
                LogVisibility.PLAYER,
                { tick: currentTick }
            );

            decorated.push({ event: evt, template, calculatedPriority });
        }

        // 按优先级降序排序
        decorated.sort((a, b) => b.calculatedPriority - a.calculatedPriority);

        return decorated;
    }

    /**
     * Step 2: 按优先级分组（容差合并）
     */
    private static groupByPriority(events: ClashEvent[], tolerance: number): ClashGroup[] {
        if (events.length === 0) return [];

        const groups: ClashGroup[] = [];
        let currentGroup: ClashEvent[] = [events[0]];
        let groupMin = events[0].calculatedPriority;
        let groupMax = events[0].calculatedPriority;

        for (let i = 1; i < events.length; i++) {
            const evt = events[i];
            const rangeDelta = groupMax - evt.calculatedPriority;

            if (rangeDelta <= tolerance) {
                // 继续归入当前组
                currentGroup.push(evt);
                groupMin = Math.min(groupMin, evt.calculatedPriority);
                groupMax = Math.max(groupMax, evt.calculatedPriority);
            } else {
                // 开辟新组
                groups.push({ priorityRange: [groupMin, groupMax], events: currentGroup });
                currentGroup = [evt];
                groupMin = evt.calculatedPriority;
                groupMax = evt.calculatedPriority;
            }
        }

        // 最后一个组
        groups.push({ priorityRange: [groupMin, groupMax], events: currentGroup });

        return groups;
    }

    /**
     * Step 3 & 4: 按组结算（两阶段提交 + 死亡检测）
     */
    private static resolveGroup(
        group: ClashGroup,
        entities: Map<EntityId, Entity>,
        currentTick: Tick,
        result: ClashResult,
        onInterrupt: ((target: Entity) => void) | undefined,
        actionCatalog: ActionCatalog,
    ): void {
        const isMutual = group.events.length >= 2;

        // 收集组内所有涉及的实体 ID
        const involvedIds = new Set<EntityId>();
        // Area effects, blast shadows and guardians can mutate undeclared
        // entities. Every event uses a private copy of the whole battlefield.
        for (const id of entities.keys()) involvedIds.add(id);
        for (const ce of group.events) {
            involvedIds.add(ce.event.actorId);
            if (ce.event.targetIds) {
                ce.event.targetIds.forEach(id => involvedIds.add(id));
            }
        }

        // ==== Phase 1: independent deep snapshots + pure pre-calculation ====
        // Every event sees exactly the same group-start state.  Running the
        // effects on one shared snapshot would make the result depend on the
        // order in which packets happened to be inserted into the heap.
        const baseline = ClashPool.createSnapshot(entities, involvedIds);
        const pendingDiffs = new Map<EntityId, Record<string, any>>();
        const phase1Deaths = new Map<EntityId, string[]>();
        const pendingDeltas = new Map<EntityId, Record<string, number>>();
        const pendingValues = new Map<EntityId, Record<string, any>>();
        const interruptTargets = new Set<EntityId>();
        const allowNegativeResources = ClashPool.findSustainResources(baseline, actionCatalog);

        for (const ce of group.events) {
            const snapshot = ClashPool.createSnapshot(baseline, involvedIds);
            const actor = snapshot.get(ce.event.actorId);
            if (!actor) continue;

            const targets = (ce.event.targetIds || [])
                .map(id => snapshot.get(id))
                .filter(e => e) as Entity[];

            // Range is evaluated against the same immutable group snapshot as
            // the effects.  This keeps a same-Tick clash deterministic and
            // prevents a target that left the ACTIVE envelope from receiving
            // an effect merely because its id was declared earlier.
            // Explicit event-driven windows use the same strict envelope as
            // the single-event resolver and the preview endpoint.  Legacy
            // clash events retain the historical 0.1 tolerance for wire
            // compatibility with older templates.
            const strictRange = ce.event.activeWindowStart !== undefined
                || ce.event.activeWindowEnd !== undefined
                || ce.event.positionTriggered === true;
            const inRangeTargets = targets.filter(target =>
                ClashPool.isTargetInRange(ce.template, actor, target, strictRange)
            );
            result.appliedTargetIds![ce.event.eventId] = inRangeTargets.map(target => target.id);

            // Do not invoke callbacks while calculating.  A callback can mutate
            // real state and would violate the two-phase contract.
            // A position-triggered event is a recheck for newly eligible
            // external targets.  SELF effects belong to the original
            // declaration and must not be repeated when another target walks
            // into the same window.
            const effectTemplate = ce.event.positionTriggered
                ? {
                    ...ce.template,
                    effects: ce.template.effects.filter(effect => effect.targetSelector !== 'SELF')
                }
                : ce.template;
            const launchTemplate = ce.template.launchProjectile ? {
                ...effectTemplate, effects: effectTemplate.effects.filter(effect => effect.targetSelector === 'SELF'),
            } : effectTemplate;
            const mutations = EffectSystem.applyAction(launchTemplate, actor, inRangeTargets, {
                tick: currentTick,
                entities: snapshot,
                originCoords: ce.event.targetCoords,
                applySpatial: !ce.event.positionTriggered,
                actionCatalog,
                allowNegativeResources: [...allowNegativeResources],
            }, target => interruptTargets.add(target.id));

            // Aggregate numeric changes as deltas from the common baseline so
            // two same-tick attacks on one target do not overwrite each other.
            for (const [entityId, changes] of mutations.entries()) {
                const targetDeltas = pendingDeltas.get(entityId) ?? {};
                const targetValues = pendingValues.get(entityId) ?? {};
                const original = baseline.get(entityId);
                for (const [key, value] of Object.entries(changes)) {
                    const baselineValue = original ? ClashPool.getNestedValue(original, key) : undefined;
                    if (typeof value === 'number' && typeof baselineValue === 'number') {
                        targetDeltas[key] = (targetDeltas[key] ?? 0) + (value - baselineValue);
                    } else {
                        targetValues[key] = value;
                    }
                }
                pendingDeltas.set(entityId, targetDeltas);
                pendingValues.set(entityId, targetValues);
            }

            // INTERRUPT is recorded as intent and applied after all effects in
            // this priority group have committed.  Only targets that pass the
            // same range check can be interrupted; SELF remains exactly one
            // actor target even when the event carries no targetIds.
            for (const effect of effectTemplate.effects) {
                if (effect.type !== 'INTERRUPT') continue;
                if (effect.targetSelector === 'SELF') {
                    interruptTargets.add(ce.event.actorId);
                } else if (effect.targetSelector === 'PRIMARY') {
                    for (const target of inRangeTargets) interruptTargets.add(target.id);
                } else {
                    // ALL_IN_AOE is resolved by EffectSystem from the pure
                    // snapshot.  Keep the conservative declared target set
                    // but still require the action envelope to contain it.
                    for (const target of inRangeTargets) interruptTargets.add(target.id);
                }
            }
        }

        // Build the final simulated state for death checks and mutations.
        const finalSnapshot = ClashPool.createSnapshot(baseline, involvedIds);
        for (const [entityId, deltas] of pendingDeltas) {
            const entity = finalSnapshot.get(entityId);
            if (!entity) continue;
            const changes = pendingValues.get(entityId) ?? {};
            for (const [key, delta] of Object.entries(deltas)) {
                const startValue = ClashPool.getNestedValue(entity, key);
                const maxValue = key.startsWith('resources.current.')
                    ? entity.resources.max[key.slice('resources.current.'.length)]
                    : undefined;
                const next = typeof startValue === 'number' ? startValue + delta : delta;
                const resourceKey = key.startsWith('resources.current.')
                    ? key.slice('resources.current.'.length)
                    : undefined;
                const min = resourceKey && allowNegativeResources.has(resourceKey) && resourceKey !== 'hp'
                    ? Number.NEGATIVE_INFINITY
                    : 0;
                changes[key] = resourceKey && typeof maxValue === 'number'
                    ? Math.max(min, Math.min(maxValue, next))
                    : resourceKey ? Math.max(min, next) : next;
                ClashPool.setNestedValue(entity, key, changes[key]);
            }
            pendingValues.set(entityId, changes);
        }
        for (const [entityId, changes] of pendingValues) {
            if (Object.keys(changes).length > 0) pendingDiffs.set(entityId, changes);
        }

        // Check the final simulated state (HP/poise <= 0).
        for (const [id, snapshotEntity] of finalSnapshot) {
            const hp = snapshotEntity.resources.current['hp'] ?? 999;
            const poise = snapshotEntity.resources.current['poise'] ?? 999;
            if (hp <= 0 && (baseline.get(id)?.resources.current.hp ?? 1) > 0) {
                // 找出哪些actor在这个group中对它造成了伤害
                const killers: string[] = [];
                for (const ce of group.events) {
                    if (result.appliedTargetIds?.[ce.event.eventId]?.includes(id)) {
                        killers.push(ce.event.actorId);
                    }
                }
                phase1Deaths.set(id, killers);
            }
        }

        // ==== Phase 2: 一次性应用到真实实体 ====
        for (const [entityId, changes] of pendingDiffs) {
            const realEntity = entities.get(entityId);
            if (!realEntity) continue;

            for (const [key, value] of Object.entries(changes)) {
                ClashPool.setNestedValue(realEntity, key, value);
            }

            result.mutations.push({ entityId, changes });
        }

        // ==== Phase 3: 死亡/Poise Break 判定 + 事件取消 ====
        for (const [entityId, killers] of phase1Deaths) {
            const realEntity = entities.get(entityId);
            if (!realEntity) continue;

            const hp = realEntity.resources.current['hp'] ?? 999;
            const poise = realEntity.resources.current['poise'] ?? 999;

            result.deaths.push({
                entityId,
                killedBy: killers,
                wasPoiseBreak: poise <= 0 && hp > 0
            });
        }

        // Interrupts are intentionally delayed until after the group commit.
        // ACTIVE actions are already irreversible; only a pending event whose
        // actor is still in STARTUP/DELAY/CHANNELING can be cancelled.
        for (const targetId of interruptTargets) {
            const target = entities.get(targetId);
            if (!target || target.currentActionContext?.phase === 'ACTIVE') continue;
            if (target.currentActionContext?.actionId) {
                result.cancelledEventIds?.push(target.currentActionContext.actionId);
            }
            result.interruptedEntityIds?.push(targetId);
            onInterrupt?.(target);
        }

        // 检查是否发生了相杀（组内双方互相死亡）
        if (isMutual && group.events.length === 2) {
            const a0 = group.events[0];
            const a1 = group.events[1];
            const bothDied = phase1Deaths.has(a0.event.actorId) && phase1Deaths.has(a1.event.actorId);
            if (bothDied) {
                result.mutualKillPairs.push([a0.event.actorId, a1.event.actorId]);
            }
        }
    }

    /**
     * 创建实体快照（浅克隆，resources.current 做深拷贝）
     */
    private static createSnapshot(
        entities: Map<EntityId, Entity>,
        involvedIds: Set<EntityId>
    ): Map<EntityId, Entity> {
        const snapshot = new Map<EntityId, Entity>();
        for (const id of involvedIds) {
            const original = entities.get(id);
            if (!original) continue;
            // Effects such as a guard append/consume entries in
            // activeEffects during pure phase-one evaluation.  Clone the
            // whole entity so that those writes cannot leak into the real
            // entity (or into a sibling same-priority event's snapshot).
            snapshot.set(id, structuredClone(original));
        }
        return snapshot;
    }

    private static setNestedValue(obj: any, path: string, value: any): void {
        const keys = path.split('.');
        let current = obj;
        for (let i = 0; i < keys.length - 1; i++) {
            if (current[keys[i]] === undefined || current[keys[i]] === null) {
                current[keys[i]] = {};
            }
            current = current[keys[i]];
        }
        current[keys[keys.length - 1]] = value;
    }

    private static getNestedValue(obj: any, path: string): any {
        return path.split('.').reduce((current, key) => current === undefined || current === null ? undefined : current[key], obj);
    }

    private static findSustainResources(entities: Map<EntityId, Entity>, actionCatalog: ActionCatalog): Set<string> {
        const resources = new Set<string>();
        for (const entity of entities.values()) {
            const context = entity.currentActionContext;
            if (!context || (context.phase !== 'STARTUP' && context.phase !== 'CHANNELING')) continue;
            const template = context.actionTemplateId ? actionCatalog.getAction(context.actionTemplateId) : undefined;
            for (const key of template?.sustainResources ?? []) resources.add(key);
        }
        return resources;
    }

    /**
     * Shared range predicate for clash resolution.  `range` expressions are
     * evaluated once per actor snapshot and never sampled from a client.
     * SELF effects do not require a target and therefore are not filtered by
     * this helper.
     */
    private static isTargetInRange(
        template: ActionTemplate,
        actor: Entity,
        target: Entity,
        strict = false,
    ): boolean {
        if (template.range?.type === 'SELF') return target.id === actor.id;
        const expression = template.range?.distanceExpr;
        if (!expression) return true;
        try {
            const maxRange = Math.abs(RuleEvaluator.evaluate(expression, { actor }).total);
            const tolerance = strict ? 0 : 0.1;
            return SpatialActionSystem.inReach(template, actor, target, maxRange + tolerance);
        } catch {
            // A malformed rule must fail closed for an external target while
            // leaving legacy SELF effects usable.
            return false;
        }
    }
}
