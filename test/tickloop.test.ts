// test/tickloop.test.ts
// TickLoop 步进器单元测试

interface TickEvent {
    eventId: string;
    targetTick: number;
    status: 'PENDING' | 'RESOLVED' | 'CANCELLED';
    [key: string]: any;
}

class PriorityQueue {
    heap: TickEvent[] = [];
    get size() { return this.heap.length; }
    push(e: TickEvent) { this.heap.push(e); this.heap.sort((a, b) => a.targetTick - b.targetTick); }
    pop(): TickEvent | undefined { return this.heap.shift(); }
    peek(): TickEvent | undefined { return this.heap[0]; }
}

class TickLoop {
    currentTick = 0;
    constructor(private queue: PriorityQueue) {}

    isEmpty() { return this.queue.size === 0; }

    step(): { tick: number; events: TickEvent[] } | null {
        if (this.queue.size === 0) return null;
        const next = this.queue.peek()!;
        if (next.targetTick > this.currentTick) this.currentTick = next.targetTick;
        const batch: TickEvent[] = [];
        while (this.queue.size > 0 && this.queue.peek()!.targetTick === this.currentTick) {
            batch.push(this.queue.pop()!);
        }
        return { tick: this.currentTick, events: batch };
    }
}

let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
    testCount++;
    if (cond) { passCount++; console.log(`  ✅ ${label}`); }
    else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}

console.log('=== TickLoop 步进器测试 ===\n');

// ---- Test 1: 单事件推进 ----
console.log('[Test 1] 单事件步进');
{
    const q = new PriorityQueue();
    q.push({ eventId: 'e1', targetTick: 5, status: 'PENDING' });
    const loop = new TickLoop(q);
    const s = loop.step()!;
    assert(s.tick === 5, '跃迁到 Tick 5');
    assert(s.events.length === 1, '收集 1 个事件');
}

// ---- Test 2: 跳过空闲 Tick ----
console.log('\n[Test 2] 时间跃迁（跳过空闲）');
{
    const q = new PriorityQueue();
    q.push({ eventId: 'e1', targetTick: 100, status: 'PENDING' });
    const loop = new TickLoop(q);
    const s = loop.step()!;
    assert(s.tick === 100, '直接从 0 跃迁到 100');
}

// ---- Test 3: 同 Tick 批量收集 ----
console.log('\n[Test 3] 同 Tick 批量收集');
{
    const q = new PriorityQueue();
    q.push({ eventId: 'a', targetTick: 10, status: 'PENDING' });
    q.push({ eventId: 'b', targetTick: 10, status: 'PENDING' });
    q.push({ eventId: 'c', targetTick: 10, status: 'PENDING' });
    const loop = new TickLoop(q);
    loop.currentTick = 9;
    const s = loop.step()!;
    assert(s.tick === 10, '跃迁到 Tick 10');
    assert(s.events.length === 3, '同 Tick 3 个事件一批收集');
}

// ---- Test 4: 跨 Tick 分步 ----
console.log('\n[Test 4] 跨 Tick 分步');
{
    const q = new PriorityQueue();
    q.push({ eventId: 'a', targetTick: 10, status: 'PENDING' });
    q.push({ eventId: 'b', targetTick: 20, status: 'PENDING' });
    q.push({ eventId: 'c', targetTick: 30, status: 'PENDING' });
    const loop = new TickLoop(q);
    const s1 = loop.step()!;
    assert(s1.tick === 10 && s1.events.length === 1, 'Step 1: Tick 10, 1 event');
    const s2 = loop.step()!;
    assert(s2.tick === 20 && s2.events.length === 1, 'Step 2: Tick 20, 1 event');
    const s3 = loop.step()!;
    assert(s3.tick === 30 && s3.events.length === 1, 'Step 3: Tick 30, 1 event');
    assert(loop.isEmpty(), '队列为空');
}

// ---- Test 5: CANCELLED 事件可通过 status 过滤 ----
console.log('\n[Test 5] CANCELLED 事件应在消费后丢弃');
{
    const q = new PriorityQueue();
    q.push({ eventId: 'valid', targetTick: 10, status: 'PENDING', eventType: 'ACTION_PHASE' });
    q.push({ eventId: 'cancelled', targetTick: 10, status: 'CANCELLED', eventType: 'ACTION_PHASE' });
    const loop = new TickLoop(q);
    const s = loop.step()!;
    const active = s.events.filter(e => e.status !== 'CANCELLED');
    assert(active.length === 1, '只有 1 个有效事件');
}

// ---- Test 6: 隔 Tick 批量 + 单事件混合 ----
console.log('\n[Test 6] 混合批量/单事件');
{
    const q = new PriorityQueue();
    q.push({ eventId: 'a1', targetTick: 10, status: 'PENDING' });
    q.push({ eventId: 'a2', targetTick: 10, status: 'PENDING' });
    q.push({ eventId: 'b1', targetTick: 20, status: 'PENDING' });
    const loop = new TickLoop(q);
    const s1 = loop.step()!;
    assert(s1.tick === 10 && s1.events.length === 2, 'T10: 2 events');
    const s2 = loop.step()!;
    assert(s2.tick === 20 && s2.events.length === 1, 'T20: 1 event');
    assert(loop.isEmpty(), 'Queue empty');
}

console.log(`\n${'='.repeat(40)}`);
console.log(`结果: ${passCount}/${testCount} 通过`);
if (passCount === testCount) console.log('✅ 所有 TickLoop 测试通过!');
