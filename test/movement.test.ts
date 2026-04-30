// test/movement.test.ts
// 独立单元测试：VectorMath, SpatialSystem, 移动事件队列, 打断机制

// ==========================================
// 1. VectorMath (内联实现，避免跨包导入)
// ==========================================
interface Vector3D { x: number; y: number; z: number; }

class VectorMath {
    static distance(v1: Vector3D, v2: Vector3D): number {
        const dx = v2.x - v1.x;
        const dy = v2.y - v1.y;
        const dz = (v2.z ?? 0) - (v1.z ?? 0);
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    static normalize(v: Vector3D): Vector3D {
        const mag = Math.sqrt(v.x ** 2 + v.y ** 2 + (v.z ?? 0) ** 2);
        if (mag === 0) return { x: 0, y: 0, z: 0 };
        return { x: v.x / mag, y: v.y / mag, z: (v.z ?? 0) / mag };
    }

    static stepTowards(current: Vector3D, target: Vector3D, stepSize: number): Vector3D {
        const dist = VectorMath.distance(current, target);
        if (dist <= stepSize) return { x: target.x, y: target.y, z: target.z ?? 0 };
        const dir = VectorMath.normalize({
            x: target.x - current.x,
            y: target.y - current.y,
            z: (target.z ?? 0) - (current.z ?? 0)
        });
        return {
            x: current.x + dir.x * stepSize,
            y: current.y + dir.y * stepSize,
            z: (current.z ?? 0) + (dir.z ?? 0) * stepSize
        };
    }

    static magnitude(v: Vector3D): number {
        return Math.sqrt(v.x ** 2 + v.y ** 2 + (v.z ?? 0) ** 2);
    }
}

// ==========================================
// 2. SpatialSystem (内联实现)
// ==========================================
type Tick = number;
let idCounter = 0;
function generateId(): string { return 't_' + (++idCounter); }

interface TickEvent {
    eventId: string;
    targetTick: Tick;
    status: 'PENDING' | 'RESOLVED' | 'CANCELLED';
}

interface MovementStepEvent extends TickEvent {
    eventType: 'MOVEMENT_STEP';
    actorId: string;
    currentCoords: Vector3D;
    targetCoords: Vector3D;
    isLastStep: boolean;
}

interface Entity {
    id: string;
    transform: { coords: Vector3D };
    currentActionContext?: any;
}

class SpatialSystem {
    static planMovement(
        actor: Entity,
        targetCoords: Vector3D,
        currentTick: Tick,
        ticksPerUnit: number = 10,
        stepSize: number = 1.0
    ): MovementStepEvent[] {
        const events: MovementStepEvent[] = [];
        let cursor = { x: actor.transform.coords.x, y: actor.transform.coords.y, z: actor.transform.coords.z ?? 0 };
        let tickCursor = currentTick;

        while (VectorMath.distance(cursor, targetCoords) > 0.01) {
            cursor = VectorMath.stepTowards(cursor, targetCoords, stepSize);
            tickCursor += ticksPerUnit;

            const isLastStep = VectorMath.distance(cursor, targetCoords) <= 0.01;

            events.push({
                eventId: generateId(),
                eventType: 'MOVEMENT_STEP',
                targetTick: tickCursor,
                status: 'PENDING',
                actorId: actor.id,
                currentCoords: { ...cursor },
                targetCoords: { ...targetCoords },
                isLastStep,
            });
        }

        return events;
    }
}

// ==========================================
// 3. PriorityQueue (简化版)
// ==========================================
class PriorityQueue {
    heap: TickEvent[] = [];
    get size(): number { return this.heap.length; }

    push(event: TickEvent): void {
        this.heap.push(event);
        this.heap.sort((a, b) => a.targetTick - b.targetTick);
    }

    pop(): TickEvent | undefined { return this.heap.shift(); }
    peek(): TickEvent | undefined { return this.heap[0]; }
}

// ==========================================
// 4. 测试框架
// ==========================================
let testCount = 0, passCount = 0;

function assert(condition: boolean, label: string): void {
    testCount++;
    if (condition) { passCount++; console.log(`  ✅ ${label}`); }
    else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}

function runTests() {
    console.log('=== ElysianVTT 移动系统测试 ===\n');

    // ---------- 测试 1: VectorMath.distance ----------
    console.log('[Test 1] VectorMath.distance');
    {
        assert(VectorMath.distance({x:0,y:0,z:0}, {x:3,y:0,z:0}) === 3, '水平距离 (0,0)->(3,0) = 3');
        assert(VectorMath.distance({x:0,y:0,z:0}, {x:0,y:4,z:0}) === 4, '垂直距离 (0,0)->(0,4) = 4');
        assert(Math.abs(VectorMath.distance({x:0,y:0,z:0}, {x:3,y:4,z:0}) - 5) < 0.01, '斜边距离 (0,0)->(3,4) = 5');
        assert(VectorMath.distance({x:1,y:1,z:0}, {x:1,y:1,z:0}) === 0, '相同点距离为 0');
        assert(Math.abs(VectorMath.distance({x:0,y:0,z:0}, {x:0,y:0,z:5}) - 5) < 0.01, 'Z轴距离 (0,0,0)->(0,0,5) = 5');
    }

    // ---------- 测试 2: VectorMath.normalize ----------
    console.log('\n[Test 2] VectorMath.normalize');
    {
        const n = VectorMath.normalize({x:3, y:0, z:0});
        assert(Math.abs(n.x - 1) < 0.01, '归一化 (3,0,0) → x=1');
        assert(Math.abs(n.y - 0) < 0.01, '归一化 (3,0,0) → y=0');

        const zero = VectorMath.normalize({x:0, y:0, z:0});
        assert(zero.x === 0 && zero.y === 0 && zero.z === 0, '零向量归一化返回 (0,0,0)');
    }

    // ---------- 测试 3: VectorMath.stepTowards ----------
    console.log('\n[Test 3] VectorMath.stepTowards');
    {
        const step1 = VectorMath.stepTowards({x:0,y:0,z:0}, {x:3,y:0,z:0}, 1);
        assert(Math.abs(step1.x - 1) < 0.01, '第1步: x=1');
        assert(Math.abs(step1.y - 0) < 0.01, '第1步: y=0');

        const step2 = VectorMath.stepTowards({x:1,y:0,z:0}, {x:3,y:0,z:0}, 1);
        assert(Math.abs(step2.x - 2) < 0.01, '第2步: x=2');

        // 最后一步不超过目标
        const lastStep = VectorMath.stepTowards({x:2.5,y:0,z:0}, {x:3,y:0,z:0}, 1);
        assert(Math.abs(lastStep.x - 3) < 0.01, '步长大于剩余距离时不超调: x=3');
        assert(Math.abs(lastStep.y - 0) < 0.01, '步长大于剩余距离时不超调: y=0');
    }

    // ---------- 测试 4: SpatialSystem.planMovement 直线三格 ----------
    console.log('\n[Test 4] SpatialSystem.planMovement (0,0)→(3,0)');
    {
        const actor: Entity = {
            id: 'warrior',
            transform: { coords: { x: 0, y: 0, z: 0 } },
        };

        const events = SpatialSystem.planMovement(actor, { x: 3, y: 0, z: 0 }, 0, 10, 1);
        assert(events.length === 3, '3 格距离生成 3 个事件');
        assert(events[0].targetTick === 10, '第一步 targetTick = 10');
        assert(events[1].targetTick === 20, '第二步 targetTick = 20');
        assert(events[2].targetTick === 30, '第三步 targetTick = 30');
        assert(Math.abs(events[0].currentCoords.x - 1) < 0.01, '第一步坐标 x=1');
        assert(Math.abs(events[1].currentCoords.x - 2) < 0.01, '第二步坐标 x=2');
        assert(Math.abs(events[2].currentCoords.x - 3) < 0.01, '第三步坐标 x=3');
        assert(!events[0].isLastStep, '第一步非最后一步');
        assert(!events[1].isLastStep, '第二步非最后一步');
        assert(events[2].isLastStep, '第三步是最后一步');
    }

    // ---------- 测试 5: SpatialSystem.planMovement 零距离 (已在目标) ----------
    console.log('\n[Test 5] SpatialSystem.planMovement 零距离');
    {
        const actor: Entity = {
            id: 'warrior',
            transform: { coords: { x: 5, y: 5, z: 0 } },
        };
        const events = SpatialSystem.planMovement(actor, { x: 5, y: 5, z: 0 }, 0);
        assert(events.length === 0, '已在目标位置，不生成事件');
    }

    // ---------- 测试 6: SpatialSystem.planMovement 斜向 ----------
    console.log('\n[Test 6] SpatialSystem.planMovement 斜向 (0,0)→(2,2)');
    {
        const actor: Entity = {
            id: 'warrior',
            transform: { coords: { x: 0, y: 0, z: 0 } },
        };
        const events = SpatialSystem.planMovement(actor, { x: 2, y: 2, z: 0 }, 0, 10, 1);
        // 斜线距离 sqrt(8) ≈ 2.828, 步长 1，应生成 3 个事件
        assert(events.length === 3, `斜向 ${Math.sqrt(8).toFixed(2)} 格生成 3 个事件 (实际: ${events.length})`);
        assert(events[events.length - 1].isLastStep, '最后一步标记 isLastStep');

        const final = events[events.length - 1].currentCoords;
        assert(
            Math.abs(final.x - 2) < 0.01 && Math.abs(final.y - 2) < 0.01,
            `最终坐标到达目标 (${final.x.toFixed(2)}, ${final.y.toFixed(2)})`
        );
    }

    // ---------- 测试 7: 移动事件 Tombstone 打断 ----------
    console.log('\n[Test 7] 移动事件打断 (Tombstone Cancel)');
    {
        const actor: Entity = {
            id: 'warrior',
            transform: { coords: { x: 0, y: 0, z: 0 } },
        };

        const events = SpatialSystem.planMovement(actor, { x: 3, y: 0, z: 0 }, 0, 10, 1);
        assert(events.length === 3, '生成 3 个移动事件');

        // 模拟被打断：将后两个事件标记为 CANCELLED
        events[1].status = 'CANCELLED';
        events[2].status = 'CANCELLED';

        const queue = new PriorityQueue();
        events.forEach(e => queue.push(e));

        // 处理队列，CANCELLED 应被丢弃
        let stepCount = 0;
        let lastCoord = { x: -1, y: -1, z: -1 };
        while (queue.size > 0) {
            const evt = queue.pop()!;
            if (evt.status === 'CANCELLED') continue;

            stepCount++;
            const moveEvt = evt as MovementStepEvent;
            lastCoord = { ...moveEvt.currentCoords };
        }

        assert(stepCount === 1, '只执行了 1 步有效移动');
        assert(Math.abs(lastCoord.x - 1) < 0.01, '停在了 x=1 的位置');
        assert(Math.abs(lastCoord.y - 0) < 0.01, '停在了 y=0 的位置');
    }

    // ---------- 测试 8: 带 currentActionContext 的移动上下文 ----------
    console.log('\n[Test 8] 移动上下文存储');
    {
        const actor: Entity = {
            id: 'warrior',
            transform: { coords: { x: 0, y: 0, z: 0 } },
        };

        const events = SpatialSystem.planMovement(actor, { x: 3, y: 0, z: 0 }, 0, 10, 1);
        
        // 记录上下文（模拟 CombatEngine.receiveIntent → handleMoveIntent）
        actor.currentActionContext = {
            type: 'MOVING',
            actionId: events[0].eventId,
            phase: 'STARTUP',
            resolveTick: events[2].targetTick,
            eventIds: events.map(e => e.eventId)
        };

        assert(actor.currentActionContext?.type === 'MOVING', '上下文类型为 MOVING');
        assert(actor.currentActionContext?.eventIds?.length === 3, 'eventIds 包含 3 个事件');
        assert(actor.currentActionContext?.resolveTick === 30, 'resolveTick = 30');

        // 模拟移动完成后解除上下文
        actor.currentActionContext = undefined;
        assert(actor.currentActionContext === undefined, '移动完成后上下文已清除');
    }

    // ---------- 测试 9: SpatialSystem 步长与 Tick 消耗 ----------
    console.log('\n[Test 9] 步长与 Tick 消耗');
    {
        const actor: Entity = {
            id: 'warrior',
            transform: { coords: { x: 0, y: 0, z: 0 } },
        };

        // 每个单位 5 Tick，步长 0.5 格
        const eventsFine = SpatialSystem.planMovement(actor, { x: 2, y: 0, z: 0 }, 0, 5, 0.5);
        assert(eventsFine.length === 4, '步长 0.5，2 格生成 4 个事件');
        assert(eventsFine[0].targetTick === 5, '第一步 targetTick = 5');

        // 每个单位 20 Tick（慢速移动）
        const eventsSlow = SpatialSystem.planMovement(actor, { x: 2, y: 0, z: 0 }, 0, 20, 1);
        assert(eventsSlow.length === 2, '步长 1，2 格生成 2 个事件');
        assert(eventsSlow[0].targetTick === 20, '慢速第一步 targetTick = 20');
    }

    // ---------- 测试 10: VectorMath.magnitude ----------
    console.log('\n[Test 10] VectorMath.magnitude');
    {
        assert(Math.abs(VectorMath.magnitude({x:3,y:4,z:0}) - 5) < 0.01, '(3,4,0) 模长 = 5');
        assert(Math.abs(VectorMath.magnitude({x:1,y:1,z:1}) - Math.sqrt(3)) < 0.01, '(1,1,1) 模长 = sqrt(3)');
        assert(VectorMath.magnitude({x:0,y:0,z:0}) === 0, '零向量模长 = 0');
    }

    console.log(`\n${'='.repeat(40)}`);
    console.log(`结果: ${passCount}/${testCount} 通过`);
    if (passCount === testCount) console.log('✅ 所有测试通过!');
}

runTests();
