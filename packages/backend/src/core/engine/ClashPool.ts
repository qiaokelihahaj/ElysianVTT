// packages/backend/src/core/engine/ClashPool.ts
import type {
    Entity, EntityId, Tick, ActionExecutionEvent, ActionTemplate,
    TickEvent
} from '@hard-vtt/shared';
import { LogVisibility } from '@hard-vtt/shared';
import { RuleEvaluator } from '../systems/RuleEvaluator.js';
import { EffectSystem } from '../systems/EffectSystem.js';
import { Dictionary } from '../../db/Dictionary.js';
import { Logger } from '../../utils/Logger.js';

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
        tolerance: number = 2.0,
        onInterrupt?: (target: Entity) => void
    ): ClashResult {
        const result: ClashResult = {
            mutations: [],
            deaths: [],
            mutualKillPairs: [],
            newRecoveryEvents: []
        };

        // ==== Step 1: Evaluate & Decorate ====
        const decorated = ClashPool.decorateEvents(events, entities, currentTick);
        if (decorated.length === 0) return result;

        // ==== Step 2: Group & Sort ====
        const groups = ClashPool.groupByPriority(decorated, tolerance);

        // ==== Step 3 & 4: Resolve by group, highest priority first ====
        for (const group of groups) {
            ClashPool.resolveGroup(group, entities, currentTick, result, onInterrupt);
        }

        return result;
    }

    /**
     * Step 1: 为每个事件求值 priorityExpr，赋予 calculatedPriority
     */
    private static decorateEvents(
        events: ActionExecutionEvent[],
        entities: Map<EntityId, Entity>,
        currentTick: Tick
    ): ClashEvent[] {
        const decorated: ClashEvent[] = [];

        for (const evt of events) {
            const actor = entities.get(evt.actorId);
            if (!actor) continue;

            const template = Dictionary.getAction(evt.actionTemplateId);
            if (!template) continue;

            // 动态求值优先级表达式
            let calculatedPriority = 0;
            if (template.priorityExpr) {
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
        onInterrupt?: (target: Entity) => void
    ): void {
        const isMutual = group.events.length >= 2;

        // 收集组内所有涉及的实体 ID
        const involvedIds = new Set<EntityId>();
        const actorIds: EntityId[] = [];

        for (const ce of group.events) {
            involvedIds.add(ce.event.actorId);
            actorIds.push(ce.event.actorId);
            if (ce.event.targetIds) {
                ce.event.targetIds.forEach(id => involvedIds.add(id));
            }
        }

        // ==== Phase 1: 创建快照 + 预计算（不修改真实内存）====
        const snapshot = ClashPool.createSnapshot(entities, involvedIds);
        const pendingDiffs = new Map<EntityId, Record<string, any>>();
        const phase1Deaths = new Map<EntityId, string[]>();

        for (const ce of group.events) {
            const actor = snapshot.get(ce.event.actorId);
            if (!actor) continue;

            const targets = (ce.event.targetIds || [])
                .map(id => snapshot.get(id))
                .filter(e => e) as Entity[];

            // 在快照上运行 EffectSystem
            const mutations = EffectSystem.applyAction(ce.template, actor, targets, { tick: currentTick }, onInterrupt);

            // 记录差分
            for (const [entityId, changes] of mutations.entries()) {
                const existing = pendingDiffs.get(entityId) || {};
                pendingDiffs.set(entityId, { ...existing, ...changes });
            }
        }

        // 检查快照中的死亡（HP/poise降到0）
        for (const [id, snapshotEntity] of snapshot) {
            const hp = snapshotEntity.resources.current['hp'] ?? 999;
            const poise = snapshotEntity.resources.current['poise'] ?? 999;
            if (hp <= 0 || poise <= 0) {
                // 找出哪些actor在这个group中对它造成了伤害
                const killers: string[] = [];
                for (const ce of group.events) {
                    if (ce.event.targetIds?.includes(id)) {
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

            snapshot.set(id, {
                ...original,
                resources: {
                    current: { ...original.resources.current },
                    max: { ...original.resources.max }
                }
            });
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
}
