// ==========================================
// ElysianVTT 关键模块单元测试
// 覆盖: PriorityQueue, SafeJsonParser, IdGenerator
// ==========================================

// --- Mock types (matches @hard-vtt/shared) ---
interface TickEvent {
    eventId: string;
    targetTick: number;
    status: 'PENDING' | 'RESOLVED' | 'CANCELLED';
}

// ==========================================
// 1. PriorityQueue (二叉最小堆 — CombatEngine 核心调度器)
//    复制自 packages/backend/src/core/engine/PriorityQueue.ts
// ==========================================
class PriorityQueue {
    private heap: TickEvent[] = [];

    get size(): number { return this.heap.length; }

    push(event: TickEvent): void {
        this.heap.push(event);
        this._siftUp(this.heap.length - 1);
    }

    pop(): TickEvent | undefined {
        if (this.heap.length === 0) return undefined;
        if (this.heap.length === 1) return this.heap.pop();

        const top = this.heap[0];
        this.heap[0] = this.heap.pop() as TickEvent;
        this._siftDown(0);
        return top;
    }

    peek(): TickEvent | undefined {
        return this.heap.length > 0 ? this.heap[0] : undefined;
    }

    private _siftUp(index: number): void {
        let currentIndex = index;
        while (currentIndex > 0) {
            const parentIndex = Math.floor((currentIndex - 1) / 2);
            if (this.heap[currentIndex].targetTick >= this.heap[parentIndex].targetTick) break;
            this._swap(currentIndex, parentIndex);
            currentIndex = parentIndex;
        }
    }

    private _siftDown(index: number): void {
        let currentIndex = index;
        const length = this.heap.length;

        while (true) {
            const leftChild = 2 * currentIndex + 1;
            const rightChild = 2 * currentIndex + 2;
            let smallest = currentIndex;

            if (leftChild < length && this.heap[leftChild].targetTick < this.heap[smallest].targetTick) {
                smallest = leftChild;
            }
            if (rightChild < length && this.heap[rightChild].targetTick < this.heap[smallest].targetTick) {
                smallest = rightChild;
            }
            if (smallest === currentIndex) break;

            this._swap(currentIndex, smallest);
            currentIndex = smallest;
        }
    }

    private _swap(i: number, j: number): void {
        const temp = this.heap[i];
        this.heap[i] = this.heap[j];
        this.heap[j] = temp;
    }
}

// ==========================================
// 2. SafeJsonParser (安全 JSON 解析器)
//    复制自 packages/backend/src/utils/SafeJsonParser.ts
// ==========================================
function safeParse<T>(json: string, fallback: T, context?: string): T {
    try {
        if (!json || json.trim().length === 0) return fallback;
        return JSON.parse(json) as T;
    } catch (e) {
        console.warn(`[SafeParser] JSON 解析失败 (${context || 'unknown'}):`, (e as Error).message);
        return fallback;
    }
}

function safeParseArray<T>(json: string, fallback: T[], context?: string): T[] {
    try {
        if (!json || json.trim().length === 0) return fallback;
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed)) {
            console.warn(`[SafeParser] 期望数组却得到: ${typeof parsed} (${context || 'unknown'})`);
            return fallback;
        }
        return parsed;
    } catch (e) {
        console.warn(`[SafeParser] 数组解析失败 (${context || 'unknown'}):`, (e as Error).message);
        return fallback;
    }
}

function safeParseRecord<T extends Record<string, any>>(json: string, fallback: T, context?: string): T {
    try {
        if (!json || json.trim().length === 0) return fallback;
        const parsed = JSON.parse(json);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            console.warn(`[SafeParser] 期望对象却得到: ${typeof parsed} (${context || 'unknown'})`);
            return fallback;
        }
        return parsed;
    } catch (e) {
        console.warn(`[SafeParser] 对象解析失败 (${context || 'unknown'}):`, (e as Error).message);
        return fallback;
    }
}

// ==========================================
// 3. IdGenerator (UUID 生成器)
//    复制自 packages/backend/src/utils/IdGenerator.ts
// ==========================================
function generateId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function generatePrefixedId(prefix: string): string {
    return `${prefix}_${generateId()}`;
}

// ==========================================
// 4. 测试工具
// ==========================================
let testCount = 0;
let passCount = 0;

function assert(condition: boolean, label: string): void {
    testCount++;
    if (condition) {
        passCount++;
        console.log(`  ✅ ${label}`);
    } else {
        console.error(`  ❌ FAIL: ${label}`);
        process.exitCode = 1;
    }
}

function section(title: string): void {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${title}`);
    console.log(`${'='.repeat(60)}`);
}

// ==========================================
// 5. 测试: PriorityQueue
// ==========================================
function testPriorityQueue(): void {
    section('PriorityQueue (二叉最小堆)');

    // 5a. 空队列
    {
        const q = new PriorityQueue();
        assert(q.size === 0, '空队列 size 为 0');
        assert(q.pop() === undefined, '空队列 pop 返回 undefined');
        assert(q.peek() === undefined, '空队列 peek 返回 undefined');
    }

    // 5b. 单元素 push/pop
    {
        const q = new PriorityQueue();
        const event: TickEvent = { eventId: 'e1', targetTick: 10, status: 'PENDING' };
        q.push(event);
        assert(q.size === 1, 'push 后 size 为 1');
        assert(q.peek()!.eventId === 'e1', 'peek 返回正确事件');
        assert(q.peek()!.targetTick === 10, 'peek 返回正确 tick');

        const popped = q.pop()!;
        assert(popped.eventId === 'e1', 'pop 返回 push 的事件');
        assert(q.size === 0, 'pop 后 size 为 0');
    }

    // 5c. 多元素有序弹出 (核心场景)
    {
        const q = new PriorityQueue();
        const e10: TickEvent = { eventId: 'e10', targetTick: 10, status: 'PENDING' };
        const e5: TickEvent  = { eventId: 'e5',  targetTick: 5,  status: 'PENDING' };
        const e15: TickEvent = { eventId: 'e15', targetTick: 15, status: 'PENDING' };
        const e1: TickEvent  = { eventId: 'e1',  targetTick: 1,  status: 'PENDING' };

        q.push(e10);
        q.push(e5);
        q.push(e15);
        q.push(e1);

        assert(q.size === 4, 'push 4 个元素后 size 为 4');
        assert(q.pop()!.eventId === 'e1',  '最先弹出 tick=1');
        assert(q.pop()!.eventId === 'e5',  '其次弹出 tick=5');
        assert(q.pop()!.eventId === 'e10', '再弹出 tick=10');
        assert(q.pop()!.eventId === 'e15', '最后弹出 tick=15');
        assert(q.size === 0, '全部弹出后 size 为 0');
    }

    // 5d. 交错 push/pop
    {
        const q = new PriorityQueue();
        q.push({ eventId: 'a', targetTick: 5,  status: 'PENDING' });
        q.push({ eventId: 'b', targetTick: 3,  status: 'PENDING' });

        assert(q.pop()!.targetTick === 3, '交错: 先弹出 tick=3');
        q.push({ eventId: 'c', targetTick: 1,  status: 'PENDING' });
        assert(q.pop()!.targetTick === 1, '交错: 再弹出 tick=1 (新插入最小)');
        assert(q.pop()!.targetTick === 5, '交错: 最后弹出 tick=5');
    }

    // 5e. 相同 tick 顺序 (LIFO vs FIFO 验证)
    {
        const q = new PriorityQueue();
        q.push({ eventId: 'first',  targetTick: 10, status: 'PENDING' });
        q.push({ eventId: 'second', targetTick: 10, status: 'PENDING' });

        const p1 = q.pop()!;
        const p2 = q.pop()!;
        // 二叉堆对相同优先级不保证顺序，只检查 tick 正确 + 两个都被弹出
        assert(p1.targetTick === 10 && p2.targetTick === 10, '相同 tick 元素 tick 正确');
        assert(q.size === 0, '相同 tick 全部弹出');
    }

    // 5f. peek 不改变队列
    {
        const q = new PriorityQueue();
        q.push({ eventId: 'x', targetTick: 7, status: 'PENDING' });
        const before = q.size;
        const peeked = q.peek();
        assert(before === q.size, 'peek 不改变 size');
        assert(peeked!.eventId === 'x', 'peek 返回正确事件');
    }

    // 5g. 大量随机元素排序
    {
        const q = new PriorityQueue();
        const N = 100;
        for (let i = 0; i < N; i++) {
            q.push({ eventId: `e${i}`, targetTick: Math.floor(Math.random() * 1000), status: 'PENDING' });
        }
        assert(q.size === N, `${N} 个随机元素 push 后 size 正确`);

        let prev = -1;
        let allPopped = true;
        for (let i = 0; i < N; i++) {
            const evt = q.pop();
            if (!evt) { allPopped = false; break; }
            if (evt.targetTick < prev) { allPopped = false; break; }
            prev = evt.targetTick;
        }
        assert(allPopped, '100 个随机元素按 tick 升序弹出');
        assert(q.size === 0, '全部弹出后队列为空');
    }

    // 5h. CANCELLED 事件通过惰性删除 (引擎层处理，队列不做过滤)
    {
        const q = new PriorityQueue();
        q.push({ eventId: 'cancel', targetTick: 1, status: 'CANCELLED' });
        const popped = q.pop()!;
        assert(popped.status === 'CANCELLED', '队列保留 CANCELLED 事件（惰性删除由引擎处理）');
        assert(popped.targetTick === 1, 'CANCELLED 事件 tick 正确');
    }
}

// ==========================================
// 6. 测试: SafeJsonParser
// ==========================================
function testSafeJsonParser(): void {
    section('SafeJsonParser (安全 JSON 解析)');

    // 6a. safeParse — 有效 JSON
    {
        const result = safeParse('{"name":"warrior","hp":100}', {} as any, 'test');
        assert(result.name === 'warrior', 'safeParse 正确解析对象');
        assert(result.hp === 100, 'safeParse 正确解析数值');
    }

    // 6b. safeParse — 无效 JSON → fallback
    {
        const fallback = { default: true };
        const result = safeParse('not valid json', fallback, 'test');
        assert(result === fallback, 'safeParse 无效 JSON 返回 fallback (严格引用)');
    }

    // 6c. safeParse — 空字符串 → fallback
    {
        const fallback = { empty: true };
        assert(safeParse('', fallback) === fallback, 'safeParse 空字符串返回 fallback');
        assert(safeParse('   ', fallback) === fallback, 'safeParse 纯空格返回 fallback');
    }

    // 6d. safeParse — null/undefined → fallback
    {
        const fb = { missing: true };
        assert(safeParse(null as any, fb) === fb, 'safeParse null 返回 fallback');
        assert(safeParse(undefined as any, fb) === fb, 'safeParse undefined 返回 fallback');
    }

    // 6e. safeParseArray — 有效数组
    {
        const json = '[{"a":1},{"b":2}]';
        const result = safeParseArray<{ a?: number; b?: number }>(json, [], 'test');
        assert(Array.isArray(result), 'safeParseArray 返回数组');
        assert(result.length === 2, 'safeParseArray 数组长度正确');
    }

    // 6f. safeParseArray — 非数组 JSON → fallback
    {
        const fallback = [{ fallback: true }];
        const result = safeParseArray('{"not":"array"}', fallback, 'test');
        assert(result === fallback, 'safeParseArray 非数组返回 fallback');
    }

    // 6g. safeParseArray — 无效 JSON → fallback
    {
        const fb = [{ invalid: true }];
        assert(safeParseArray('bad', fb) === fb, 'safeParseArray 无效 JSON 返回 fallback');
    }

    // 6h. safeParseRecord — 有效对象
    {
        const json = '{"key":"value","num":42}';
        const result = safeParseRecord(json, {}, 'test');
        assert(result.key === 'value', 'safeParseRecord 正确解析字符串值');
        assert(result.num === 42, 'safeParseRecord 正确解析数值');
    }

    // 6i. safeParseRecord — 数组 → fallback (数组不是 Record)
    {
        const fb = { error: true };
        const result = safeParseRecord('[1,2,3]', fb, 'test');
        assert(result === fb, 'safeParseRecord 数组返回 fallback');
    }

    // 6j. safeParseRecord — null → fallback
    {
        const fb = { error: true };
        const result = safeParseRecord('null', fb, 'test');
        assert(result === fb, 'safeParseRecord null 返回 fallback');
    }

    // 6k. 真实场景: 解析 effectsJson (ActionEffectPayload[])
    {
        const effectsJson = JSON.stringify([
            { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: 'actor.str + 2d6' } },
            { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'poise', amountExpr: '5' } }
        ]);
        const effects = safeParseArray(effectsJson, [], 'effectsJson of HEAVY_STRIKE');
        assert(effects.length === 2, 'effectsJson 解析出 2 个效果');
        assert(effects[0].type === 'DAMAGE', '效果 0 类型为 DAMAGE');
        assert(effects[1].parameters.resource === 'poise', '效果 1 资源为 poise');
    }

    // 6l. 真实场景: 解析 resourcesJson
    {
        const json = JSON.stringify({ current: { hp: 100, mp: 50 }, max: { hp: 100, mp: 50 } });
        const resources = safeParseRecord(json, { current: {}, max: {} }, 'resourcesJson');
        assert(resources.current.hp === 100, 'resourcesJson 正确解析 current.hp');
        assert(resources.max.mp === 50, 'resourcesJson 正确解析 max.mp');
    }
}

// ==========================================
// 7. 测试: IdGenerator
// ==========================================
function testIdGenerator(): void {
    section('IdGenerator (UUID 生成器)');

    // 7a. generateId 返回非空字符串
    {
        const id = generateId();
        assert(typeof id === 'string', 'generateId 返回字符串');
        assert(id.length > 0, 'generateId 返回非空字符串');
    }

    // 7b. generateId 返回 UUID v4 格式
    {
        const id = generateId();
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        assert(uuidRegex.test(id), `generateId 返回合法 UUID v4: ${id}`);
    }

    // 7c. generatePrefixedId 包含前缀
    {
        const id = generatePrefixedId('test');
        assert(id.startsWith('test_'), 'generatePrefixedId 以前缀开头');
        assert(id.length > 'test_'.length, 'generatePrefixedId 前缀后有 UUID');
    }

    // 7d. 批量生成 1000 个 ID 无重复
    {
        const ids = new Set<string>();
        for (let i = 0; i < 1000; i++) {
            ids.add(generateId());
        }
        assert(ids.size === 1000, '1000 个 generateId 调用无重复');
    }
}

// ==========================================
// 8. 运行所有测试
// ==========================================
console.log('=== ElysianVTT 关键模块单元测试 ===');

testPriorityQueue();
testSafeJsonParser();
testIdGenerator();

console.log(`\n${'='.repeat(60)}`);
console.log(`✅ 通过: ${passCount}/${testCount}`);
console.log(`❌ 失败: ${testCount - passCount}`);
console.log(`${'='.repeat(60)}`);

if ((testCount - passCount) > 0) {
    process.exit(1);
}
