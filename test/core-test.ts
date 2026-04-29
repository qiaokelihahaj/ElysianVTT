import { EventEmitter } from 'events';
import { create, all } from 'mathjs';
import { Logger } from '../packages/backend/src/utils/Logger.js';

const logger = Logger.create('Test:Core');

// ==========================================
// 1. Mock: Shared Types (模拟 @hard-vtt/shared)
// ==========================================
type Tick = number;
type EntityId = string;

function generateId(): string {
    return 'test_' + Math.random().toString(36).substring(2, 9);
}

interface Entity {
    id: EntityId;
    resources: { current: Record<string, number>; max: Record<string, number> };
    currentActionContext?: { actionId: string; phase: string; resolveTick: number };
}

interface TickEvent {
    eventId: string;
    targetTick: Tick;
    status: 'PENDING' | 'RESOLVED' | 'CANCELLED';
    [key: string]: any;
}

// Dice types
interface RawDie {
    id: string;
    sides: number;
    faceValue: number;
}

interface DiceRule {
    condition: string;
    actionType: 'ADD_TAG' | 'EXPLODE' | 'REROLL';
    actionPayload?: string;
}

interface ProcessedDie extends RawDie {
    finalValue: number;
    tags: string[];
    isOverridden: boolean;
}

interface DicePoolResult {
    total: number;
    dice: ProcessedDie[];
    poolTags: string[];
}

// ==========================================
// 2. Dice Generator & Processor (数据驱动管道核心)
// ==========================================
class DiceGenerator {
    static generate(count: number, sides: number): RawDie[] {
        const dice: RawDie[] = [];
        for (let i = 0; i < count; i++) {
            dice.push({
                id: generateId(),
                sides,
                faceValue: Math.floor(Math.random() * sides) + 1
            });
        }
        return dice;
    }

    static generateOne(sides: number): RawDie {
        return {
            id: generateId(),
            sides,
            faceValue: Math.floor(Math.random() * sides) + 1
        };
    }
}

function evaluateCondition(condition: string, faceValue: number, sides: number): boolean {
    const resolved = condition.replace(/\bsides\b/g, sides.toString());
    const match = resolved.match(/^\s*faceValue\s*(==|!=|>=|<=|>|<)\s*(\d+)\s*$/);
    if (!match) return false;
    const [, op, valStr] = match;
    const val = Number(valStr);
    switch (op) {
        case '==': return faceValue === val;
        case '!=': return faceValue !== val;
        case '>=': return faceValue >= val;
        case '<=': return faceValue <= val;
        case '>': return faceValue > val;
        case '<': return faceValue < val;
    }
    return false;
}

class DiceProcessor {
    static process(rawDice: RawDie[], rules: DiceRule[], overrides?: Record<string, number>): DicePoolResult {
        const processedDice: ProcessedDie[] = [];
        const queue: RawDie[] = [...rawDice];

        while (queue.length > 0) {
            const raw = queue.shift()!;

            if (overrides && overrides[raw.id] !== undefined) {
                raw.faceValue = overrides[raw.id];
            }

            const tags: string[] = [];
            let exploded = false;
            let rerolled = false;

            for (const rule of rules) {
                if (evaluateCondition(rule.condition, raw.faceValue, raw.sides)) {
                    switch (rule.actionType) {
                        case 'ADD_TAG':
                            if (rule.actionPayload) tags.push(rule.actionPayload);
                            break;
                        case 'EXPLODE':
                            tags.push('EXPLODED');
                            exploded = true;
                            break;
                        case 'REROLL':
                            rerolled = true;
                            break;
                    }
                }
            }

            const processed: ProcessedDie = {
                ...raw,
                finalValue: rerolled ? 0 : raw.faceValue,
                tags,
                isOverridden: overrides ? overrides[raw.id] !== undefined : false
            };

            processedDice.push(processed);

            if (exploded) {
                const newDie = DiceGenerator.generateOne(raw.sides);
                queue.push(newDie);
            }
            if (rerolled) {
                const newDie = DiceGenerator.generateOne(raw.sides);
                queue.push(newDie);
            }
        }

        const total = processedDice.reduce((sum, d) => sum + d.finalValue, 0);
        const poolTags: string[] = [];
        const seen = new Set<string>();
        for (const d of processedDice) {
            for (const tag of d.tags) {
                if (!seen.has(tag)) {
                    seen.add(tag);
                    poolTags.push(tag);
                }
            }
        }

        return { total, dice: processedDice, poolTags };
    }
}

// ==========================================
// 3. RuleEvaluator (使用数据驱动管道)
// ==========================================
const math = create(all);
math.import({
    import: function () { throw new Error('Disabled'); },
}, { override: true });

interface EvaluationResult {
    total: number;
    rolls: DicePoolResult;
}

class RuleEvaluator {
    static evaluate(expr: string, context: {
        actor?: Entity;
        target?: Entity;
        diceRules?: DiceRule[];
        overrides?: Record<string, number>;
    }): EvaluationResult {
        const scope: any = { actor: {}, target: {} };

        if (context.actor) {
            Object.entries(context.actor.resources.current).forEach(([k, v]) => {
                scope.actor[k] = v;
            });
        }
        if (context.target) {
            Object.entries(context.target.resources.current).forEach(([k, v]) => {
                scope.target[k] = v;
            });
        }

        const diceRules = context.diceRules ?? [];
        const overrides = context.overrides;

        const allDice: ProcessedDie[] = [];
        const allPoolTags: string[] = [];
        const tagSeen = new Set<string>();

        const parsedExpr = expr.replace(/(\d+)d(\d+)/g, (match, n, m) => {
            const count = Number(n);
            const sides = Number(m);

            const rawDice = DiceGenerator.generate(count, sides);
            const result = DiceProcessor.process(rawDice, diceRules, overrides);

            for (const die of result.dice) {
                allDice.push(die);
            }
            for (const tag of result.poolTags) {
                if (!tagSeen.has(tag)) {
                    tagSeen.add(tag);
                    allPoolTags.push(tag);
                }
            }

            return result.total.toString();
        });

        const allTags = [...tagSeen];

        scope.total = allDice.reduce((sum: number, d: ProcessedDie) => sum + d.finalValue, 0);
        scope.isCrit = allTags.includes('CRIT_SUCCESS');
        scope.isFumble = allTags.includes('CRIT_FAILURE');
        scope.poolTags = allTags;

        const result = Number(math.evaluate!(parsedExpr, scope));
        const rolls: DicePoolResult = { total: result, dice: allDice, poolTags: allTags };
        return { total: result, rolls };
    }
}

// ==========================================
// 4. PriorityQueue
// ==========================================
class PriorityQueue {
    private heap: TickEvent[] = [];
    get size(): number { return this.heap.length; }

    push(event: TickEvent): void {
        this.heap.push(event);
        this.heap.sort((a, b) => a.targetTick - b.targetTick);
    }

    pop(): TickEvent | undefined { return this.heap.shift(); }
    peek(): TickEvent | undefined { return this.heap[0]; }
}

// ==========================================
// 5. CombatEngine (使用新 RuleEvaluator)
// ==========================================
class CombatEngine extends EventEmitter {
    currentTick: Tick = 0;
    private eventQueue = new PriorityQueue();
    private entities = new Map<EntityId, Entity>();
    private pendingMutations: any = { tick: 0, mutations: [] };

    mountEntities(entities: Entity[]) { entities.forEach(e => this.entities.set(e.id, e)); }
    getEntity(id: EntityId) { return this.entities.get(id); }

    receiveIntent(actorId: EntityId, actionId: string, targetId: EntityId) {
        const startupEvent: TickEvent = {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: this.currentTick + 10,
            status: 'PENDING',
            actorId, targetId, actionId, phase: 'STARTUP'
        };

        const actor = this.entities.get(actorId)!;
        actor.currentActionContext = { actionId: startupEvent.eventId, phase: 'STARTUP', resolveTick: startupEvent.targetTick };

        this.eventQueue.push(startupEvent);
        this.processQueue();
    }

    private processQueue() {
        while (this.eventQueue.size > 0) {
            const event = this.eventQueue.pop()!;
            if (event.status === 'CANCELLED') continue;

            if (event.targetTick > this.currentTick) {
                this.currentTick = event.targetTick;
                this.pendingMutations.tick = this.currentTick;
            }

            this.resolveEvent(event);
        }
        this.broadcastMutations();
    }

    private resolveEvent(event: TickEvent) {
        if (event.eventType === 'ACTION_PHASE') {
            const actor = this.entities.get(event.actorId)!;
            const target = this.entities.get(event.targetId)!;

            if (event.phase === 'STARTUP') {
                logger.game(`⚔️ [Action] ${actor.id} 执行了测试攻击!`, null, 'PLAYER' as any, { tick: this.currentTick, sceneId: 'test-scene' });

                // 测试技能带暴击规则: d20 出 20 时增加暴击标签
                const critRules: DiceRule[] = [
                    { condition: 'faceValue == 20', actionType: 'ADD_TAG', actionPayload: 'CRIT_SUCCESS' }
                ];

                const damageFormula = 'actor.str + 1d20 + (poolTags.includes("CRIT_SUCCESS") ? 10 : 0)';
                const { total: damage, rolls } = RuleEvaluator.evaluate(damageFormula, {
                    actor: {
                        ...actor,
                        resources: { current: { str: 10 }, max: {} }
                    } as any,
                    target,
                    diceRules: critRules
                });

                const critStr = rolls.poolTags.includes('CRIT_SUCCESS') ? ' ⚡暴击!' : '';
                logger.debug(`掷骰明细: ${JSON.stringify(rolls.dice.map(d => `${d.faceValue}${d.tags.length ? '(' + d.tags.join(',') + ')' : ''}`))}`, null, { tick: this.currentTick, sceneId: 'test-scene' });
                logger.debug(`汇总标签: [${rolls.poolTags.join(', ')}], 总伤害: ${damage}`, null, { tick: this.currentTick, sceneId: 'test-scene' });

                target.resources.current['hp'] -= damage;
                logger.game(`💥 造成 ${damage} 点伤害${critStr}。${target.id} 剩余HP: ${target.resources.current['hp']}`, null, 'PLAYER' as any, { tick: this.currentTick, sceneId: 'test-scene' });

                this.recordMutation(target.id, { 'resources.current.hp': target.resources.current['hp'] });

                const recoveryEvent = { ...event, eventId: generateId(), targetTick: this.currentTick + 5, phase: 'RECOVERY' };
                actor.currentActionContext = { actionId: recoveryEvent.eventId, phase: 'RECOVERY', resolveTick: recoveryEvent.targetTick };
                this.eventQueue.push(recoveryEvent);
            }
            else if (event.phase === 'RECOVERY') {
                logger.game(`🛡️ [Action] ${actor.id} 收招完成.`, null, 'PLAYER' as any, { tick: this.currentTick, sceneId: 'test-scene' });
                actor.currentActionContext = undefined;
                this.recordMutation(actor.id, { 'currentActionContext': null });
            }
        }
    }

    private recordMutation(entityId: string, changes: any) {
        let mutation = this.pendingMutations.mutations.find((m: any) => m.entityId === entityId);
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
}

// ==========================================
// 6. 单元测试集 (Test Suite)
// ==========================================
function assert(condition: boolean, label: string): void {
    if (condition) {
        console.log(`  ✅ ${label}`);
    } else {
        console.error(`  ❌ FAIL: ${label}`);
        process.exitCode = 1;
    }
}

async function runTests() {
    console.log('=== ElysianVTT 掷骰系统测试 ===\n');

    // ---------- 测试 1: DiceGenerator 基础生成 ----------
    console.log('[Test 1] DiceGenerator 基础生成');
    {
        const dice = DiceGenerator.generate(3, 6);
        assert(dice.length === 3, '生成 3 颗骰子');
        assert(dice.every(d => d.sides === 6), '所有骰子面数为 6');
        assert(dice.every(d => d.faceValue >= 1 && d.faceValue <= 6), '所有面值在 1-6 范围内');
        assert(dice.every(d => d.id.length > 0), '所有骰子有唯一 ID');
    }

    // ---------- 测试 2: DiceProcessor 无规则 (纯求和) ----------
    console.log('\n[Test 2] DiceProcessor 无规则 (纯求和)');
    {
        const raw: RawDie[] = [
            { id: 'd1', sides: 6, faceValue: 3 },
            { id: 'd2', sides: 6, faceValue: 5 },
            { id: 'd3', sides: 6, faceValue: 2 },
        ];
        const result = DiceProcessor.process(raw, []);
        assert(result.total === 10, '3+5+2 = 10');
        assert(result.dice.length === 3, '处理后的骰子数仍为 3');
        assert(result.poolTags.length === 0, '无规则无标签');
        assert(result.dice.every(d => d.finalValue === d.faceValue), 'finalValue 等于 faceValue');
    }

    // ---------- 测试 3: ADD_TAG 规则 (暴击标签) ----------
    console.log('\n[Test 3] ADD_TAG 规则 (暴击标签)');
    {
        const rules: DiceRule[] = [
            { condition: 'faceValue == 20', actionType: 'ADD_TAG', actionPayload: 'CRIT_SUCCESS' },
            { condition: 'faceValue == 1', actionType: 'ADD_TAG', actionPayload: 'CRIT_FAILURE' }
        ];

        const rawCrit: RawDie[] = [{ id: 'c1', sides: 20, faceValue: 20 }];
        const resultCrit = DiceProcessor.process(rawCrit, rules);
        assert(resultCrit.poolTags.includes('CRIT_SUCCESS'), '出 20 获得 CRIT_SUCCESS 标签');
        assert(!resultCrit.poolTags.includes('CRIT_FAILURE'), '出 20 不应获得 CRIT_FAILURE');
        assert(resultCrit.total === 20, '暴击骰的值仍为 20');

        const rawFail: RawDie[] = [{ id: 'f1', sides: 20, faceValue: 1 }];
        const resultFail = DiceProcessor.process(rawFail, rules);
        assert(resultFail.poolTags.includes('CRIT_FAILURE'), '出 1 获得 CRIT_FAILURE 标签');
        assert(resultFail.total === 1, '失败骰的值仍为 1');

        const rawNormal: RawDie[] = [{ id: 'n1', sides: 20, faceValue: 10 }];
        const resultNormal = DiceProcessor.process(rawNormal, rules);
        assert(resultNormal.poolTags.length === 0, '出 10 无标签');
    }

    // ---------- 测试 4: EXPLODE 规则 (爆炸骰) ----------
    console.log('\n[Test 4] EXPLODE 规则 (爆炸骰: d6 出 6 加掷)');
    {
        const rules: DiceRule[] = [
            { condition: 'faceValue == sides', actionType: 'EXPLODE' }
        ];

        // 固定值测试: 出 6 应该爆炸
        const raw6: RawDie[] = [{ id: 'e1', sides: 6, faceValue: 6 }];
        const result6 = DiceProcessor.process(raw6, rules);
        assert(result6.dice.some(d => d.tags.includes('EXPLODED')), '出 6 的骰子标记为 EXPLODED');
        assert(result6.dice.length >= 2, '爆炸后至少有 2 颗骰子(原骰+新骰)');
        assert(result6.total >= 7, '爆炸后总值 >= 6 + 1(新骰最少为 1)');
        assert(result6.poolTags.includes('EXPLODED'), 'poolTags 包含 EXPLODED');

        // 不出 6 不应该爆炸
        const raw3: RawDie[] = [{ id: 'e2', sides: 6, faceValue: 3 }];
        const result3 = DiceProcessor.process(raw3, rules);
        assert(result3.dice.length === 1, '出 3 不会追加骰子');
        assert(!result3.poolTags.includes('EXPLODED'), '无 EXPLODED 标签');
        assert(result3.total === 3, '总值为原始面值 3');
    }

    // ---------- 测试 5: REROLL 规则 (重骰) ----------
    console.log('\n[Test 5] REROLL 规则 (d20 出 1 重骰)');
    {
        const rules: DiceRule[] = [
            { condition: 'faceValue == 1', actionType: 'REROLL' }
        ];

        const raw1: RawDie[] = [{ id: 'r1', sides: 20, faceValue: 1 }];
        const result1 = DiceProcessor.process(raw1, rules);

        const originalDie = result1.dice.find(d => d.id === 'r1');
        assert(originalDie !== undefined, '原始骰子在结果中');
        assert(originalDie!.finalValue === 0, '重骰的原始骰子 finalValue 为 0');
        assert(result1.dice.length >= 2, '重骰后至少 2 颗骰子(原骰finalValue=0 + 新骰)');

        // 不出 1 不重骰
        const raw10: RawDie[] = [{ id: 'r2', sides: 20, faceValue: 10 }];
        const result10 = DiceProcessor.process(raw10, rules);
        assert(result10.dice.length === 1, '不出1不会追加骰子');
        assert(result10.total === 10, '总值为 10');
    }

    // ---------- 测试 6: 玩家干预覆盖 (Override) ----------
    console.log('\n[Test 6] 玩家干预覆盖 (Override)');
    {
        const rules: DiceRule[] = [
            { condition: 'faceValue == 20', actionType: 'ADD_TAG', actionPayload: 'CRIT_SUCCESS' }
        ];

        const raw: RawDie[] = [{ id: 'over1', sides: 20, faceValue: 3 }];
        const overrides = { 'over1': 20 };

        const result = DiceProcessor.process(raw, rules, overrides);
        assert(result.dice[0].isOverridden, '骰子标记为被干预');
        assert(result.dice[0].faceValue === 20, '面值被覆盖为 20');
        assert(result.dice[0].tags.includes('CRIT_SUCCESS'), '覆盖后的值触发了暴击标签');
        assert(result.total === 20, '总值为覆盖后的值');
    }

    // ---------- 测试 7: RuleEvaluator 表达式含骰子 ----------
    console.log('\n[Test 7] RuleEvaluator 表达式含骰子 "actor.str + 2d6"');
    {
        const actor: Entity = {
            id: 'test_actor',
            resources: { current: { str: 10 }, max: { str: 10 } }
        };

        const { total, rolls } = RuleEvaluator.evaluate('actor.str + 2d6', { actor });
        assert(typeof total === 'number', '返回值为数字');
        assert(total >= 12 && total <= 22, `2d6 + 10 范围 [12,22], 结果: ${total}`);
        assert(rolls.dice.length === 2, '掷了 2 颗 d6');
        assert(rolls.dice.every(d => d.sides === 6), '骰子面数均为 6');
    }

    // ---------- 测试 8: RuleEvaluator 暴击表达式 ----------
    console.log('\n[Test 8] RuleEvaluator 暴击条件表达式');
    {
        const actor: Entity = {
            id: 'crit_actor',
            resources: { current: { str: 10 }, max: { str: 10 } }
        };

        const critRules: DiceRule[] = [
            { condition: 'faceValue == 6', actionType: 'ADD_TAG', actionPayload: 'CRIT_SUCCESS' }
        ];

        // 用 1d6 测试 (1d6 出 6 的概率高)
        // 表达式: 检查 poolTags 来决定是否暴击
        const expr = 'actor.str + 1d6 + (poolTags.includes("CRIT_SUCCESS") ? 10 : 0)';
        const { total, rolls } = RuleEvaluator.evaluate(expr, { actor, diceRules: critRules });

        assert(typeof total === 'number', '返回值为数字');
        const isCrit = rolls.poolTags.includes('CRIT_SUCCESS');
        const expectedMin = isCrit ? 21 : 11; // str(10) + min(1) + bonus(10或0)
        const expectedMax = isCrit ? 26 : 16; // str(10) + max(6) + bonus(10或0)
        assert(total >= expectedMin && total <= expectedMax,
            `暴击=${isCrit}, 伤害范围 [${expectedMin},${expectedMax}], 结果: ${total}`);

        console.log(`  骰子明细: ${rolls.dice.map(d => `${d.faceValue}${d.tags.length ? '(' + d.tags.join(',') + ')' : ''}`).join(', ')}`);
        console.log(`  暴击=${isCrit}, 标签=[${rolls.poolTags.join(', ')}], 伤害=${total}`);
    }

    // ---------- 测试 9: 完整 CombatEngine 流程 ----------
    console.log('\n[Test 9] 完整 CombatEngine Tick 流程');
    {
        const engine = new CombatEngine();

        engine.on('STATE_MUTATED', (payload: any) => {
            logger.info(`📡 广播状态差分 Tick ${payload.tick}: ${payload.mutations.length} 条变更`, null, { tick: payload.tick, sceneId: 'test-scene' });
        });

        const warrior: Entity = {
            id: 'actor_warrior',
            resources: { current: { hp: 100, poise: 50, str: 15 }, max: { hp: 100, poise: 50, str: 15 } }
        };
        const goblin: Entity = {
            id: 'target_goblin',
            resources: { current: { hp: 30, poise: 10 }, max: { hp: 30, poise: 10 } }
        };

        engine.mountEntities([warrior, goblin]);
        engine.receiveIntent('actor_warrior', 'HEAVY_STRIKE', 'target_goblin');

        const goblinHp = engine.getEntity('target_goblin')?.resources.current.hp ?? 0;
        assert(goblinHp < 30, `哥布林受到伤害 (原30, 现${goblinHp})`);
        assert(goblinHp >= 0, 'HP 不低于 0');

        const warriorCtx = engine.getEntity('actor_warrior')?.currentActionContext;
        assert(warriorCtx === undefined, '战士收招后动作上下文为 undefined');
    }
}

runTests().then(() => {
    console.log('\n🎯 所有测试完成!');
});
