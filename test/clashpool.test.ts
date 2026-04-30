// test/clashpool.test.ts
// ClashPool 单元测试：优先级求值、分组、相杀二阶段提交、打断

// ==========================================
// 1. 内联共享类型（避免跨包依赖）
// ==========================================
type Tick = number;
type EntityId = string;
type ExpressionString = string;

let idCounter = 0;
function generateId(): string { return 'c_' + (++idCounter); }

interface Vector3D { x: number; y: number; z: number; }

interface Entity {
    id: EntityId;
    transform: { coords: Vector3D; planeId?: string; facing?: number };
    resources: { current: Record<string, number>; max: Record<string, number> };
    currentActionContext?: any;
}

interface TickEvent {
    eventId: string;
    targetTick: Tick;
    status: 'PENDING' | 'RESOLVED' | 'CANCELLED';
}

interface ActionExecutionEvent extends TickEvent {
    eventType: 'ACTION_PHASE';
    actorId: EntityId;
    targetIds?: EntityId[];
    actionTemplateId: string;
    phase: 'STARTUP' | 'ACTIVE' | 'RECOVERY';
}

interface ActionTemplate {
    id: string;
    tags: string[];
    timeCost: { startupTicks: number; recoveryTicks: number };
    effects: Array<{ type: string; targetSelector: string; parameters: Record<string, any> }>;
    diceRules?: any[];
    priorityExpr?: ExpressionString;
}

// ==========================================
// 2. RuleEvaluator（简化版，仅计算优先级表达式）
// ==========================================
class RuleEvaluator {
    static evaluate(expression: string, context: { actor?: Entity; target?: Entity }): { total: number } {
        const scope: Record<string, any> = { actor: {}, target: {} };
        if (context.actor?.resources?.current) {
            Object.entries(context.actor.resources.current).forEach(([k, v]) => { scope.actor[k] = v; });
        }
        if (context.target?.resources?.current) {
            Object.entries(context.target.resources.current).forEach(([k, v]) => { scope.target[k] = v; });
        }

        try {
            const fn = new Function(...Object.keys(scope), `return (${expression});`);
            const result = fn(...Object.values(scope));
            return { total: Number(result) };
        } catch {
            return { total: 0 };
        }
    }
}

// ==========================================
// 3. EffectSystem（简化版，仅用于测试 ClashPool）
// ==========================================
class EffectSystem {
    static applyAction(
        template: ActionTemplate,
        actor: Entity,
        targets: Entity[],
    ): Map<string, Record<string, any>> {
        const mutations = new Map<string, Record<string, any>>();

        for (const effect of template.effects) {
            let resolvedTargets: Entity[] = [];
            if (effect.targetSelector === 'SELF') resolvedTargets = [actor];
            else if (effect.targetSelector === 'PRIMARY') resolvedTargets = targets;

            for (const target of resolvedTargets) {
                const resKey = effect.parameters.resource;
                const expr = effect.parameters.amountExpr;

                if (effect.type === 'DAMAGE' && resKey && expr) {
                    const { total: amount } = RuleEvaluator.evaluate(expr, { actor, target });
                    const currentVal = target.resources.current[resKey] || 0;
                    const newVal = Math.max(0, currentVal - amount);
                    target.resources.current[resKey] = newVal;
                    if (!mutations.has(target.id)) mutations.set(target.id, {});
                    mutations.get(target.id)![`resources.current.${resKey}`] = newVal;
                }
            }
        }

        return mutations;
    }
}

// ==========================================
// 4. Dictionary（简化版）
// ==========================================
const actionDict = new Map<string, ActionTemplate>();

// ==========================================
// 5. ClashPool（从 prod copy，适配 test 依赖）
// ==========================================
class ClashPool {
    static resolve(
        events: ActionExecutionEvent[],
        entities: Map<EntityId, Entity>,
        tolerance: number = 2.0,
    ): {
        mutations: Array<{ entityId: EntityId; changes: Record<string, any> }>;
        deaths: Array<{ entityId: EntityId; killedBy: EntityId[]; wasPoiseBreak: boolean }>;
        mutualKillPairs: Array<[EntityId, EntityId]>;
        newRecoveryEvents: ActionExecutionEvent[];
        groups: Array<{ priorityRange: [number, number]; events: Array<{ event: ActionExecutionEvent; template: ActionTemplate; calculatedPriority: number }> }>;
    } {
        const result = {
            mutations: [] as Array<{ entityId: EntityId; changes: Record<string, any> }>,
            deaths: [] as Array<{ entityId: EntityId; killedBy: EntityId[]; wasPoiseBreak: boolean }>,
            mutualKillPairs: [] as Array<[EntityId, EntityId]>,
            newRecoveryEvents: [] as ActionExecutionEvent[],
            groups: [] as Array<any>
        };

        // Step 1: Evaluate
        const decorated: Array<{ event: ActionExecutionEvent; template: ActionTemplate; calculatedPriority: number }> = [];
        for (const evt of events) {
            const template = actionDict.get(evt.actionTemplateId);
            if (!template) continue;

            const actor = entities.get(evt.actorId);
            if (!actor) continue;

            let priority = 0;
            if (template.priorityExpr) {
                try {
                    priority = RuleEvaluator.evaluate(template.priorityExpr, { actor }).total;
                } catch { priority = 0; }
            }
            decorated.push({ event: evt, template, calculatedPriority: priority });
        }

        if (decorated.length === 0) return result;

        // Step 2: Group
        decorated.sort((a, b) => b.calculatedPriority - a.calculatedPriority);

        const groups: Array<{ priorityRange: [number, number]; events: typeof decorated }> = [];
        let current: typeof decorated = [decorated[0]];
        let gMin = decorated[0].calculatedPriority;
        let gMax = decorated[0].calculatedPriority;

        for (let i = 1; i < decorated.length; i++) {
            if (gMax - decorated[i].calculatedPriority <= tolerance) {
                current.push(decorated[i]);
                gMin = Math.min(gMin, decorated[i].calculatedPriority);
                gMax = Math.max(gMax, decorated[i].calculatedPriority);
            } else {
                groups.push({ priorityRange: [gMin, gMax], events: current });
                current = [decorated[i]];
                gMin = decorated[i].calculatedPriority;
                gMax = decorated[i].calculatedPriority;
            }
        }
        groups.push({ priorityRange: [gMin, gMax], events: current });

        result.groups = groups;

        // Step 3: Resolve by group
        for (const group of groups) {
            const involvedIds = new Set<EntityId>();
            for (const ce of group.events) {
                involvedIds.add(ce.event.actorId);
                ce.event.targetIds?.forEach(id => involvedIds.add(id));
            }

            // Snapshot
            const snapshot = new Map<EntityId, Entity>();
            for (const id of involvedIds) {
                const orig = entities.get(id);
                if (!orig) continue;
                snapshot.set(id, {
                    ...orig,
                    resources: { current: { ...orig.resources.current }, max: { ...orig.resources.max } }
                } as Entity);
            }

            // Phase 1: Calculate on snapshot
            const pendingDiffs = new Map<EntityId, Record<string, any>>();
            const phase1Deaths = new Map<EntityId, EntityId[]>();

            for (const ce of group.events) {
                const snapActor = snapshot.get(ce.event.actorId);
                if (!snapActor) continue;

                const snapTargets = (ce.event.targetIds || [])
                    .map(id => snapshot.get(id))
                    .filter(e => e) as Entity[];

                const mutations = EffectSystem.applyAction(ce.template, snapActor, snapTargets);

                for (const [eid, changes] of mutations.entries()) {
                    const existing = pendingDiffs.get(eid) || {};
                    pendingDiffs.set(eid, { ...existing, ...changes });
                }
            }

            for (const [id, snapEntity] of snapshot) {
                const hp = snapEntity.resources.current['hp'] ?? 999;
                const poise = snapEntity.resources.current['poise'] ?? 999;
                if (hp <= 0 || poise <= 0) {
                    const killers: EntityId[] = [];
                    for (const ce of group.events) {
                        if (ce.event.targetIds?.includes(id)) killers.push(ce.event.actorId);
                    }
                    phase1Deaths.set(id, killers);
                }
            }

            // Phase 2: Apply to real
            for (const [eid, changes] of pendingDiffs) {
                const real = entities.get(eid);
                if (!real) continue;
                for (const [key, value] of Object.entries(changes)) {
                    const keys = key.split('.');
                    let cur: any = real;
                    for (let i = 0; i < keys.length - 1; i++) {
                        if (!cur[keys[i]]) cur[keys[i]] = {};
                        cur = cur[keys[i]];
                    }
                    cur[keys[keys.length - 1]] = value;
                }
                result.mutations.push({ entityId: eid, changes });
            }

            // Phase 3: Death check
            for (const [eid, killers] of phase1Deaths) {
                const real = entities.get(eid)!;
                const hp = real.resources.current['hp'] ?? 999;
                const poise = real.resources.current['poise'] ?? 999;
                result.deaths.push({
                    entityId: eid,
                    killedBy: killers,
                    wasPoiseBreak: poise <= 0 && hp > 0
                });
            }

            // Check mutual kill
            if (group.events.length === 2) {
                const a0 = group.events[0];
                const a1 = group.events[1];
                if (phase1Deaths.has(a0.event.actorId) && phase1Deaths.has(a1.event.actorId)) {
                    result.mutualKillPairs.push([a0.event.actorId, a1.event.actorId]);
                }
            }
        }

        return result;
    }
}

// ==========================================
// 6. 测试框架
// ==========================================
let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
    testCount++;
    if (cond) { passCount++; console.log(`  ✅ ${label}`); }
    else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}

function runTests() {
    console.log('=== ElysianVTT ClashPool 冲突结算测试 ===\n');

    // ---- Setup ----
    // 长枪兵（低敏捷，长兵器）
    const spearman: Entity = {
        id: 'spearman',
        transform: { coords: { x: 0, y: 0, z: 0 } },
        resources: { current: { hp: 30, poise: 50, agi: 10, reach: 25, str: 15 }, max: { hp: 30, poise: 50 } }
    };

    // 盗贼（高敏捷，短兵器）
    const thief: Entity = {
        id: 'thief',
        transform: { coords: { x: 2, y: 0, z: 0 } },
        resources: { current: { hp: 20, poise: 30, agi: 30, reach: 5, str: 20 }, max: { hp: 20, poise: 30 } }
    };

    // 弓箭手（远程辅助）
    const archer: Entity = {
        id: 'archer',
        transform: { coords: { x: 10, y: 0, z: 0 } },
        resources: { current: { hp: 25, poise: 20, agi: 20, reach: 30, str: 10 }, max: { hp: 25, poise: 20 } }
    };

    const entities = new Map<string, Entity>();
    entities.set('spearman', spearman);
    entities.set('thief', thief);
    entities.set('archer', archer);

    // 注册技能模板
    actionDict.set('SPEAR_THRUST', {
        id: 'SPEAR_THRUST',
        tags: ['ATTACK', 'MELEE'],
        timeCost: { startupTicks: 10, recoveryTicks: 5 },
        effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: 'actor.str + actor.reach * 0.5' } },
                  { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'poise', amountExpr: '10' } }],
        priorityExpr: 'actor.agi + actor.reach'
    });

    actionDict.set('DAGGER_STAB', {
        id: 'DAGGER_STAB',
        tags: ['ATTACK', 'MELEE'],
        timeCost: { startupTicks: 5, recoveryTicks: 3 },
        effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: 'actor.str + actor.agi * 0.5' } },
                  { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'poise', amountExpr: '10' } }],
        priorityExpr: 'actor.agi + actor.reach'
    });

    actionDict.set('ARROW_SHOT', {
        id: 'ARROW_SHOT',
        tags: ['ATTACK', 'RANGED'],
        timeCost: { startupTicks: 8, recoveryTicks: 4 },
        effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '10' } },
                  { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'poise', amountExpr: '5' } }],
        priorityExpr: 'actor.agi + actor.reach'
    });

    // ---- Test 1: 优先级求值 ----
    console.log('[Test 1] 优先级求值');
    {
        const pSpear = RuleEvaluator.evaluate('actor.agi + actor.reach', { actor: spearman }).total;
        const pThief = RuleEvaluator.evaluate('actor.agi + actor.reach', { actor: thief }).total;
        assert(pSpear === 35, `长枪兵优先级 = ${pSpear} (期望 35)`);
        assert(pThief === 35, `盗贼优先级 = ${pThief} (期望 35)`);
    }

    // ---- Test 2: 同优先级分组（容差 2.0） ----
    console.log('\n[Test 2] 优先级容差分组合并');
    {
        const resetEntities = () => {
            const m = new Map<string, Entity>();
            m.set('spearman', { ...spearman, resources: { current: { ...spearman.resources.current }, max: { ...spearman.resources.max } } });
            m.set('thief', { ...thief, resources: { current: { ...thief.resources.current }, max: { ...thief.resources.max } } });
            return m;
        };

        const e = resetEntities();

        const evt1: ActionExecutionEvent = {
            eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING',
            actorId: 'spearman', targetIds: ['thief'], actionTemplateId: 'SPEAR_THRUST', phase: 'STARTUP'
        };
        const evt2: ActionExecutionEvent = {
            eventId: 'e2', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING',
            actorId: 'thief', targetIds: ['spearman'], actionTemplateId: 'DAGGER_STAB', phase: 'STARTUP'
        };

        const result = ClashPool.resolve([evt1, evt2], e, 2.0);

        assert(result.groups.length === 1, '差值 0 <= 2.0，归入同一组');
        assert(result.groups[0].events.length === 2, '组内包含两个事件');

        const [g1, g2] = result.groups[0].events;
        assert(g1.calculatedPriority === 35, '组内优先级=35');
        assert(g2.calculatedPriority === 35, '组内优先级=35');
    }

    // ---- Test 3: 单一高优先级（差距 > 容忍） ----
    console.log('\n[Test 3] 高优先级独占（差距 > 容差）');
    {
        // 给盗贼加上"疾跑Buff"（虚拟 agi+20）
        const buffedThief: Entity = {
            ...thief,
            resources: { current: { ...thief.resources.current, agi: 50 }, max: { ...thief.resources.max } }
        };

        const e = new Map<string, Entity>();
        e.set('spearman', { ...spearman, resources: { current: { ...spearman.resources.current }, max: { ...spearman.resources.max } } });
        e.set('thief', buffedThief);

        const evt1: ActionExecutionEvent = {
            eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING',
            actorId: 'spearman', targetIds: ['thief'], actionTemplateId: 'SPEAR_THRUST', phase: 'STARTUP'
        };
        const evt2: ActionExecutionEvent = {
            eventId: 'e2', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING',
            actorId: 'thief', targetIds: ['spearman'], actionTemplateId: 'DAGGER_STAB', phase: 'STARTUP'
        };

        const result = ClashPool.resolve([evt1, evt2], e, 2.0);

        // buffed 盗贼: agi=50, reach=5 → priority=55
        // 长枪兵: agi=10, reach=25 → priority=35
        // 差 20 > 2.0，分成两组
        assert(result.groups.length === 2, `差值 20 > 2.0，分成 2 组 (实际 ${result.groups.length})`);
        assert(result.groups[0].priorityRange[0] === 55, '高优先组 range 起始=55');
        assert(result.groups[1].priorityRange[0] === 35, '低优先组 range 起始=35');
    }

    // ---- Test 4: 相杀（双方互相死亡） ----
    console.log('\n[Test 4] 相杀（双方互相死亡）');
    {
        // 使用高伤害技能的双方
        actionDict.set('LETHAL_STRIKE', {
            id: 'LETHAL_STRIKE',
            tags: ['ATTACK'],
            timeCost: { startupTicks: 10, recoveryTicks: 5 },
            effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '100' } }],
            priorityExpr: '10'
        });

        const e = new Map<string, Entity>();
        e.set('spearman', { ...spearman, resources: { current: { ...spearman.resources.current }, max: { ...spearman.resources.max } } });
        e.set('thief', { ...thief, resources: { current: { ...thief.resources.current }, max: { ...thief.resources.max } } });

        const evt1: ActionExecutionEvent = {
            eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING',
            actorId: 'spearman', targetIds: ['thief'], actionTemplateId: 'LETHAL_STRIKE', phase: 'STARTUP'
        };
        const evt2: ActionExecutionEvent = {
            eventId: 'e2', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING',
            actorId: 'thief', targetIds: ['spearman'], actionTemplateId: 'LETHAL_STRIKE', phase: 'STARTUP'
        };

        const result = ClashPool.resolve([evt1, evt2], e, 2.0);

        assert(result.mutualKillPairs.length === 1, '检测到相杀');
        assert(result.mutualKillPairs[0].includes('spearman'), 'spearman 在相杀对中');
        assert(result.mutualKillPairs[0].includes('thief'), 'thief 在相杀对中');
        assert(result.deaths.length === 2, '两人都死亡');
    }

    // ---- Test 5: 三人混战（分组结算、高优先于低优） ----
    console.log('\n[Test 5] 三人混战（高优先于低优）');
    {
        const e = new Map<string, Entity>();
        e.set('spearman', { ...spearman, resources: { current: { ...spearman.resources.current }, max: { ...spearman.resources.max } } });
        e.set('thief', { ...thief, resources: { current: { ...thief.resources.current }, max: { ...thief.resources.max } } });
        e.set('archer', { ...archer, resources: { current: { ...archer.resources.current }, max: { ...archer.resources.max } } });

        // 弓箭手 (agi=20, reach=30 → 50) vs 盗贼 (agi=30, reach=5 → 35) vs 长枪兵 (agi=10, reach=25 → 35)
        const allEvents: ActionExecutionEvent[] = [
            { eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING', actorId: 'archer', targetIds: ['thief'], actionTemplateId: 'ARROW_SHOT', phase: 'STARTUP' },
            { eventId: 'e2', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING', actorId: 'thief', targetIds: ['spearman'], actionTemplateId: 'DAGGER_STAB', phase: 'STARTUP' },
            { eventId: 'e3', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING', actorId: 'spearman', targetIds: ['thief'], actionTemplateId: 'SPEAR_THRUST', phase: 'STARTUP' },
        ];

        const result = ClashPool.resolve(allEvents, e, 2.0);

        // 弓箭手=50, 盗贼=35, 长枪兵=35
        // Group 1: [50] (archer solo)
        // Group 2: [35, 35] (thief + spearman 同级相杀)
        assert(result.groups.length === 2, `三人分成 2 组 (实际 ${result.groups.length})`);
        assert(result.groups[0].events[0].event.actorId === 'archer', '高优先组是弓箭手');
        assert(result.groups[1].events.length === 2, '低优先组有两人');
    }

    // ---- Test 6: 伤害应用顺序正确（Phase 1 在快照上计算后 Phase 2 统一应用） ----
    console.log('\n[Test 6] 二阶段提交（快照隔离）');
    {
        const e = new Map<string, Entity>();
        e.set('spearman', { ...spearman, resources: { current: { ...spearman.resources.current }, max: { ...spearman.resources.max } } });
        e.set('thief', { ...thief, resources: { current: { ...thief.resources.current }, max: { ...thief.resources.max } } });

        // 长枪兵打盗贼：伤害 = str(15) + reach(25)*0.5 = 15 + 12.5 = 27.5
        // 盗贼打长枪兵：伤害 = str(20) + agi(30)*0.5 = 20 + 15 = 35
        const evt1: ActionExecutionEvent = {
            eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING',
            actorId: 'spearman', targetIds: ['thief'], actionTemplateId: 'SPEAR_THRUST', phase: 'STARTUP'
        };
        const evt2: ActionExecutionEvent = {
            eventId: 'e2', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING',
            actorId: 'thief', targetIds: ['spearman'], actionTemplateId: 'DAGGER_STAB', phase: 'STARTUP'
        };

        const result = ClashPool.resolve([evt1, evt2], e, 2.0);

        // 两人都应该在 snapshot 上同时计算，然后一起被扣血
        assert(result.deaths.length === 2, '双方同时死亡（单方面先扣血会导致另一方零伤害）');
    }

    // ---- Test 7: Poise Break（韧击破，不死但被打断） ----
    console.log('\n[Test 7] Poise Break（韧击破）');
    {
        const tank: Entity = {
            id: 'tank',
            transform: { coords: { x: 0, y: 0, z: 0 } },
            resources: { current: { hp: 100, poise: 50, agi: 10, reach: 10, str: 10 }, max: { hp: 100, poise: 50 } }
        };
        const assassin: Entity = {
            id: 'assassin',
            transform: { coords: { x: 2, y: 0, z: 0 } },
            resources: { current: { hp: 30, poise: 5, agi: 40, reach: 5, str: 10 }, max: { hp: 30, poise: 5 } }
        };

        // 高破韧技能
        actionDict.set('POISE_BREAKER', {
            id: 'POISE_BREAKER',
            tags: ['ATTACK'],
            timeCost: { startupTicks: 8, recoveryTicks: 4 },
            effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'poise', amountExpr: '30' } }],
            priorityExpr: 'actor.agi + actor.reach'
        });

        const e = new Map<string, Entity>();
        e.set('tank', tank);
        e.set('assassin', assassin);

        const evt1: ActionExecutionEvent = {
            eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING',
            actorId: 'tank', targetIds: ['assassin'], actionTemplateId: 'POISE_BREAKER', phase: 'STARTUP'
        };

        const result = ClashPool.resolve([evt1], e, 2.0);

        assert(result.deaths.length === 1, '刺客被韧击破');
        assert(result.deaths[0].wasPoiseBreak === true, '标记为 poise break');
        const a = e.get('assassin')!;
        assert(a.resources.current.poise <= 0, `刺客 poise=${a.resources.current.poise} <= 0`);
    }

    // ---- Test 8: 单事件无冲突 ----
    console.log('\n[Test 8] 单事件无冲突');
    {
        const e = new Map<string, Entity>();
        e.set('spearman', { ...spearman, resources: { current: { ...spearman.resources.current }, max: { ...spearman.resources.max } } });
        e.set('thief', { ...thief, resources: { current: { ...thief.resources.current }, max: { ...thief.resources.max } } });

        const evt: ActionExecutionEvent = {
            eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING',
            actorId: 'spearman', targetIds: ['thief'], actionTemplateId: 'SPEAR_THRUST', phase: 'STARTUP'
        };

        const result = ClashPool.resolve([evt], e, 2.0);
        assert(result.groups.length === 1, '单事件一组');
        assert(result.mutualKillPairs.length === 0, '无相杀');
        assert(result.mutations.length > 0, '产生了状态变更');
    }

    // ---- Test 9: 无 priorityExpr 的技能默认优先级为 0 ----
    console.log('\n[Test 9] 无可选优先级公式（默认 0）');
    {
        actionDict.set('NO_PRIORITY', {
            id: 'NO_PRIORITY',
            tags: [],
            timeCost: { startupTicks: 5, recoveryTicks: 3 },
            effects: [],
            priorityExpr: undefined
        });

        const e = new Map<string, Entity>();
        e.set('spearman', { ...spearman, resources: { current: { ...spearman.resources.current }, max: { ...spearman.resources.max } } });

        const evt: ActionExecutionEvent = {
            eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING',
            actorId: 'spearman', targetIds: ['thief'], actionTemplateId: 'NO_PRIORITY', phase: 'STARTUP'
        };

        const result = ClashPool.resolve([evt], e, 2.0);
        assert(result.groups[0].events[0].calculatedPriority === 0, '无 priorityExpr → priority=0');
    }

    // ---- Test 10: Poise Break 不死，HP 完好 ----
    console.log('\n[Test 10] Poise Break 不会导致 HP 归零时误判死亡');
    {
        const sturdy: Entity = {
            id: 'sturdy',
            transform: { coords: { x: 0, y: 0, z: 0 } },
            resources: { current: { hp: 80, poise: 10, agi: 5, reach: 5, str: 5 }, max: { hp: 80, poise: 10 } }
        };

        const e = new Map<string, Entity>();
        e.set('sturdy', sturdy);

        const evt: ActionExecutionEvent = {
            eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING',
            actorId: 'sturdy', targetIds: [], actionTemplateId: 'POISE_BREAKER', phase: 'STARTUP'
        };

        // 没有目标实体可打，所以不管
        const result = ClashPool.resolve([evt], e, 2.0);
        const s = e.get('sturdy')!;
        assert(s.resources.current.hp === 80, 'HP 未变化（没有目标）');
    }

    console.log(`\n${'='.repeat(40)}`);
    console.log(`结果: ${passCount}/${testCount} 通过`);
    if (passCount === testCount) console.log('✅ 所有 ClashPool 测试通过!');
}

runTests();
