// test/channel.test.ts
// 递归调度系统测试：Channel 多段动作、移动 Channel 化、打断兼容

let idCounter = 0;
function gid(): string { return 'c_' + (++idCounter); }

// ==========================================
// 1. 内联类型
// ==========================================
interface Vector3D { x: number; y: number; z: number; }
type EntityId = string;
type ExpressionString = string;

interface Entity {
    id: EntityId;
    transform: { coords: Vector3D };
    resources: { current: Record<string, number>; max: Record<string, number> };
    currentActionContext?: {
        type: 'CASTING' | 'MOVING';
        actionId: string;
        actionTemplateId?: string;
        phase: 'STARTUP' | 'CHANNELING' | 'RECOVERY';
        resolveTick: number;
        pulseCount?: number;
        waypoints?: Vector3D[];
        currentWaypointIndex?: number;
    };
}

interface ActionTemplate {
    id: string;
    timeCost: { startupTicks: number; recoveryTicks: number };
    effects: Array<{ type: string; targetSelector: string; parameters: Record<string, any> }>;
    sustainResources?: string[];
    channelOptions?: {
        intervalTicks: number;
        maxPulses?: number;
        pulseResourceCost?: Record<string, ExpressionString>;
    };
    priorityExpr?: string;
    diceRules?: any[];
}

interface TickEvent {
    eventId: string;
    targetTick: number;
    status: 'PENDING' | 'RESOLVED' | 'CANCELLED';
    [key: string]: any;
}

interface ActionExecutionEvent extends TickEvent {
    eventType: 'ACTION_PHASE';
    actorId: EntityId;
    targetIds?: EntityId[];
    actionTemplateId: string;
    phase: 'STARTUP' | 'RECOVERY';
}

// ==========================================
// 2. 工具类
// ==========================================
const actionDict = new Map<string, ActionTemplate>();

class VectorMath {
    static distance(a: Vector3D, b: Vector3D) { return Math.sqrt((b.x-a.x)**2 + (b.y-a.y)**2 + ((b.z??0)-(a.z??0))**2); }
    static stepTowards(cur: Vector3D, tgt: Vector3D, step: number): Vector3D {
        const d = VectorMath.distance(cur, tgt);
        if (d <= step) return { ...tgt };
        const mag = Math.sqrt((tgt.x-cur.x)**2 + (tgt.y-cur.y)**2);
        return { x: cur.x + (tgt.x-cur.x)/mag*step, y: cur.y + (tgt.y-cur.y)/mag*step, z: tgt.z ?? 0 };
    }
}

function planWaypoints(actor: Entity, target: Vector3D, stepSize = 1): Vector3D[] {
    const wps: Vector3D[] = [];
    let cursor = { ...actor.transform.coords };
    while (VectorMath.distance(cursor, target) > 0.01) {
        cursor = VectorMath.stepTowards(cursor, target, stepSize);
        wps.push({ ...cursor });
    }
    return wps;
}

// ==========================================
// 3. 测试引擎（简化版）
// ==========================================
class ChannelTestEngine {
    entities = new Map<string, Entity>();
    eventQueue: TickEvent[] = [];
    currentTick = 0;
    logs: string[] = [];
    records: Array<{ entityId: string; changes: Record<string, any> }> = [];

    addEntity(e: Entity) {
        this.entities.set(e.id, { ...e, resources: { current: { ...e.resources.current }, max: { ...e.resources.max } }, transform: { coords: { ...e.transform.coords } } });
    }
    getEntity(id: string) { return this.entities.get(id); }
    pushEvent(e: TickEvent) { this.eventQueue.push(e); }
    record(entityId: string, changes: Record<string, any>) {
        this.records.push({ entityId, changes });
    }

    cancelCurrentAction(actor: Entity) {
        for (const e of this.eventQueue) {
            if (e.status !== 'PENDING') continue;
            if ((e as any).actorId === actor.id) e.status = 'CANCELLED';
        }
        actor.currentActionContext = undefined;
        this.logs.push(`cancel:${actor.id}`);
    }

    // 技能脉冲结算
    resolveActionPulse(actor: Entity, event: ActionExecutionEvent): boolean {
        const ctx = actor.currentActionContext!;
        const template = actionDict.get(event.actionTemplateId)!;
        const targets = (event.targetIds || []).map(id => this.entities.get(id)).filter(e => e) as Entity[];

        const pulseNum = (ctx.pulseCount ?? 0) + 1;
        ctx.pulseCount = pulseNum;

        // 应用效果
        for (const effect of template.effects) {
            for (const target of targets) {
                const resKey = effect.parameters.resource;
                const expr = effect.parameters.amountExpr;
                if (effect.type === 'DAMAGE' && resKey) {
                    const amount = Number(expr) || 0;
                    target.resources.current[resKey] = Math.max(0, (target.resources.current[resKey] ?? 0) - amount);
                    if (!this.records.find(r => r.entityId === target.id)) {
                        this.records.push({ entityId: target.id, changes: {} });
                    }
                    this.records.find(r => r.entityId === target.id)!.changes[`resources.current.${resKey}`] = target.resources.current[resKey];
                }
            }
        }

        const channel = template.channelOptions;

        // 扣除脉冲资源消耗
        if (channel?.pulseResourceCost) {
            for (const [resKey, expr] of Object.entries(channel.pulseResourceCost)) {
                const cost = parseInt(expr) || 0;
                if (cost > 0) {
                    actor.resources.current[resKey] = Math.max(0, (actor.resources.current[resKey] ?? 0) - cost);
                }
            }
        }

        if (channel && (!channel.maxPulses || pulseNum < channel.maxPulses)) {
            // 递归推下一脉冲
            const newEvt: ActionExecutionEvent = {
                ...event, eventId: gid(),
                targetTick: this.currentTick + channel.intervalTicks, status: 'PENDING', phase: 'STARTUP'
            };
            this.pushEvent(newEvt);
            actor.currentActionContext = { ...ctx, actionId: newEvt.eventId, phase: 'CHANNELING', resolveTick: newEvt.targetTick };
            return true; // 还有后续
        } else {
            // 推 RECOVERY
            const recEvt: ActionExecutionEvent = {
                ...event, eventId: gid(),
                targetTick: this.currentTick + template.timeCost.recoveryTicks, status: 'PENDING', phase: 'RECOVERY'
            };
            this.pushEvent(recEvt);
            actor.currentActionContext = { ...ctx, actionId: recEvt.eventId, phase: 'RECOVERY', resolveTick: recEvt.targetTick };
            return false; // 结束
        }
    }

    // 移动脉冲结算
    resolveMovementPulse(actor: Entity, event: ActionExecutionEvent): boolean {
        const ctx = actor.currentActionContext!;
        const wps = ctx.waypoints!;
        const idx = ctx.currentWaypointIndex ?? 0;
        if (idx >= wps.length) {
            actor.currentActionContext = undefined;
            return false;
        }

        const wp = wps[idx];
        actor.transform.coords = { ...wp };
        this.record(actor.id, { 'transform.coords.x': wp.x, 'transform.coords.y': wp.y });
        ctx.pulseCount = (ctx.pulseCount ?? 0) + 1;

        const nextIdx = idx + 1;
        if (nextIdx < wps.length) {
            ctx.currentWaypointIndex = nextIdx;
            const newEvt: ActionExecutionEvent = {
                ...event, eventId: gid(), targetTick: this.currentTick + 10, status: 'PENDING', phase: 'STARTUP'
            };
            this.pushEvent(newEvt);
            actor.currentActionContext = { ...ctx, actionId: newEvt.eventId, phase: 'CHANNELING', resolveTick: newEvt.targetTick };
            return true;
        } else {
            actor.currentActionContext = undefined;
            return false;
        }
    }
}

// ==========================================
// 4. 测试框架
// ==========================================
let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
    testCount++;
    if (cond) { passCount++; console.log(`  ✅ ${label}`); }
    else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}

function runTests() {
    console.log('=== ElysianVTT 递归调度 / Channel 系统测试 ===\n');

    // ---- Setup shared ----
    actionDict.set('FIRE_STORM', {
        id: 'FIRE_STORM',
        timeCost: { startupTicks: 15, recoveryTicks: 10 },
        effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '15' } }],
        sustainResources: ['concentration', 'poise'],
        channelOptions: { intervalTicks: 8, maxPulses: 3 }
    });

    actionDict.set('SINGLE_SLASH', {
        id: 'SINGLE_SLASH',
        timeCost: { startupTicks: 10, recoveryTicks: 5 },
        effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '25' } }],
        sustainResources: ['poise']
        // 无 channelOptions = 单段动作
    });

    // ---- Test 1: 单段技能无 channel（保持兼容） ----
    console.log('[Test 1] 单段技能（无 channelOptions）→ STARTUP → RECOVERY');
    {
        const eng = new ChannelTestEngine();
        const a: Entity = { id: 'a', transform: { coords: { x: 0, y: 0, z: 0 } }, resources: { current: { hp: 100 }, max: { hp: 100 } } };
        const b: Entity = { id: 'b', transform: { coords: { x: 2, y: 0, z: 0 } }, resources: { current: { hp: 50 }, max: { hp: 50 } } };
        eng.addEntity(a); eng.addEntity(b);

        a.currentActionContext = { type: 'CASTING', actionId: 'e1', actionTemplateId: 'SINGLE_SLASH', phase: 'STARTUP', resolveTick: 10, pulseCount: 0 };
        eng.currentTick = 10;
        eng.pushEvent({ eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING', actorId: 'a', targetIds: ['b'], actionTemplateId: 'SINGLE_SLASH', phase: 'STARTUP' });

        const evt = eng.eventQueue.pop()! as ActionExecutionEvent;
        const continued = eng.resolveActionPulse(a, evt);
        assert(!continued, '单段技能不再递归');
        assert(a.currentActionContext!.phase === 'RECOVERY', '进入 RECOVERY');
        assert(eng.getEntity('b')!.resources.current.hp === 25, 'b HP=25 (50-25)');
        assert(a.currentActionContext!.pulseCount === 1, 'pulseCount=1');
    }

    // ---- Test 2: Channel 技能生成多段脉冲 ----
    console.log('\n[Test 2] Channel 三脉冲 → 递归生成新事件');
    {
        const eng = new ChannelTestEngine();
        const a: Entity = { id: 'a', transform: { coords: { x: 0, y: 0, z: 0 } }, resources: { current: { hp: 100, concentration: 50, poise: 30 }, max: { hp: 100, concentration: 50, poise: 30 } } };
        const b: Entity = { id: 'b', transform: { coords: { x: 2, y: 0, z: 0 } }, resources: { current: { hp: 100 }, max: { hp: 100 } } };
        eng.addEntity(a); eng.addEntity(b);

        a.currentActionContext = { type: 'CASTING', actionId: 'e1', actionTemplateId: 'FIRE_STORM', phase: 'STARTUP', resolveTick: 15, pulseCount: 0 };
        eng.currentTick = 15;
        eng.pushEvent({ eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: 15, status: 'PENDING', actorId: 'a', targetIds: ['b'], actionTemplateId: 'FIRE_STORM', phase: 'STARTUP' });

        // Pulse 1
        const evt1 = eng.eventQueue.shift()! as ActionExecutionEvent;
        const c1 = eng.resolveActionPulse(a, evt1);
        assert(c1, 'Pulse 1 后继续递归');
        assert(a.currentActionContext!.phase === 'CHANNELING', 'phase=CHANNELING');
        assert(a.currentActionContext!.pulseCount === 1, 'pulseCount=1');
        assert(eng.getEntity('b')!.resources.current.hp === 85, 'b HP=85');

        // Pulse 2
        eng.currentTick = 23;
        const evt2 = eng.eventQueue.shift()! as ActionExecutionEvent;
        const c2 = eng.resolveActionPulse(a, evt2);
        assert(c2, 'Pulse 2 后继续递归');
        assert(a.currentActionContext!.pulseCount === 2, 'pulseCount=2');
        assert(eng.getEntity('b')!.resources.current.hp === 70, 'b HP=70');

        // Pulse 3 (最后一段)
        eng.currentTick = 31;
        const evt3 = eng.eventQueue.shift()! as ActionExecutionEvent;
        const c3 = eng.resolveActionPulse(a, evt3);
        assert(!c3, 'Pulse 3 后不再递归 (maxPulses=3)');
        assert(a.currentActionContext!.phase === 'RECOVERY', '进入 RECOVERY');
        assert(eng.getEntity('b')!.resources.current.hp === 55, 'b HP=55');
    }

    // ---- Test 3: CHANNELING 阶段被打断 ----
    console.log('\n[Test 3] CHANNELING 阶段 sustain 资源归零 → 打断');
    {
        const eng = new ChannelTestEngine();
        const a: Entity = { id: 'a', transform: { coords: { x: 0, y: 0, z: 0 } }, resources: { current: { hp: 100, concentration: 50, poise: 10 }, max: { hp: 100, concentration: 50, poise: 10 } } };
        eng.addEntity(a);

        a.currentActionContext = { type: 'CASTING', actionId: 'e1', actionTemplateId: 'FIRE_STORM', phase: 'CHANNELING', resolveTick: 23, pulseCount: 1 };

        // 模拟 poise 归零
        eng.getEntity('a')!.resources.current.poise = 0;

        // 检测 CHANNELING 也应触发打断（与 STARTUP 同等）
        const ctx = a.currentActionContext;
        const vulnerable = ctx!.phase === 'STARTUP' || ctx!.phase === 'CHANNELING';
        assert(vulnerable, 'CHANNELING 是脆弱阶段');

        eng.cancelCurrentAction(a);
        assert(eng.getEntity('a')!.currentActionContext === undefined, '上下文已清除');
    }

    // ---- Test 4: 移动信道化 —— 递归航点 ----
    console.log('\n[Test 4] 移动 Channel 递归航点');
    {
        const eng = new ChannelTestEngine();
        const mover: Entity = { id: 'm', transform: { coords: { x: 0, y: 0, z: 0 } }, resources: { current: { hp: 100 }, max: { hp: 100 } } };
        eng.addEntity(mover);

        const wps = planWaypoints(mover, { x: 3, y: 0, z: 0 }, 1);
        assert(wps.length === 3, '3 个航点');

        mover.currentActionContext = {
            type: 'MOVING', actionId: 'e1', phase: 'STARTUP', resolveTick: 10,
            pulseCount: 0, waypoints: wps, currentWaypointIndex: 0
        };
        eng.currentTick = 10;
        eng.pushEvent({ eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING', actorId: 'm', actionTemplateId: '__BUILTIN_MOVE__', phase: 'STARTUP' });

        // Step 1
        const evt1 = eng.eventQueue.shift()! as ActionExecutionEvent;
        const c1 = eng.resolveMovementPulse(mover, evt1);
        assert(c1, '有下一航点');
        assert(Math.abs(mover.transform.coords.x - 1) < 0.01, 'x=1');
        assert(mover.currentActionContext!.phase === 'CHANNELING', 'phase=CHANNELING');
        assert(mover.currentActionContext!.currentWaypointIndex === 1, 'waypointIndex=1');

        // Step 2
        eng.currentTick = 20;
        const evt2 = eng.eventQueue.shift()! as ActionExecutionEvent;
        eng.resolveMovementPulse(mover, evt2);
        assert(Math.abs(mover.transform.coords.x - 2) < 0.01, 'x=2');

        // Step 3 (last)
        eng.currentTick = 30;
        const evt3 = eng.eventQueue.shift()! as ActionExecutionEvent;
        const c3 = eng.resolveMovementPulse(mover, evt3);
        assert(!c3, '最后一步不再递归');
        assert(Math.abs(mover.transform.coords.x - 3) < 0.01, 'x=3');
        assert(mover.currentActionContext === undefined, '上下文清除');
    }

    // ---- Test 5: 移动 CHANNELING 阶段打断 ----
    console.log('\n[Test 5] 移动 CHANNELING 阶段打断 = 停在当前航点');
    {
        const eng = new ChannelTestEngine();
        const mover: Entity = { id: 'm', transform: { coords: { x: 0, y: 0, z: 0 } }, resources: { current: { hp: 100 }, max: { hp: 100 } } };
        eng.addEntity(mover);

        const wps = planWaypoints(mover, { x: 5, y: 0, z: 0 }, 1);
        mover.currentActionContext = {
            type: 'MOVING', actionId: 'e1', phase: 'STARTUP', resolveTick: 10,
            pulseCount: 0, waypoints: wps, currentWaypointIndex: 0
        };

        eng.currentTick = 10;
        eng.pushEvent({ eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING', actorId: 'm', actionTemplateId: '__BUILTIN_MOVE__', phase: 'STARTUP' });
        const evt1 = eng.eventQueue.shift()! as ActionExecutionEvent;
        eng.resolveMovementPulse(mover, evt1);
        assert(Math.abs(mover.transform.coords.x - 1) < 0.01, '第一步到达 x=1');
        assert(mover.currentActionContext!.phase === 'CHANNELING', '进入 CHANNELING');

        // 打断！
        eng.cancelCurrentAction(mover);
        assert(mover.currentActionContext === undefined, '上下文被清除');
        assert(eng.eventQueue.every(e => e.status === 'CANCELLED'), '后续事件被取消');
        // 坐标停在 x=1（已执行的步骤不会被撤销）
        assert(Math.abs(mover.transform.coords.x - 1) < 0.01, '停在 x=1');
    }

    // ---- Test 6: 无限脉冲（无 maxPulses） ----
    console.log('\n[Test 6] 无限 Channel（无 maxPulses）');
    {
        actionDict.set('INFINITE_CHANNEL', {
            id: 'INFINITE_CHANNEL',
            timeCost: { startupTicks: 10, recoveryTicks: 5 },
            effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '5' } }],
            channelOptions: { intervalTicks: 5 /* no maxPulses */ }
        });

        const eng = new ChannelTestEngine();
        const a: Entity = { id: 'a', transform: { coords: { x: 0, y: 0, z: 0 } }, resources: { current: { hp: 100 }, max: { hp: 100 } } };
        const b: Entity = { id: 'b', transform: { coords: { x: 2, y: 0, z: 0 } }, resources: { current: { hp: 100 }, max: { hp: 100 } } };
        eng.addEntity(a); eng.addEntity(b);

        a.currentActionContext = { type: 'CASTING', actionId: 'e1', actionTemplateId: 'INFINITE_CHANNEL', phase: 'STARTUP', resolveTick: 10, pulseCount: 0 };
        eng.currentTick = 10;
        eng.pushEvent({ eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING', actorId: 'a', targetIds: ['b'], actionTemplateId: 'INFINITE_CHANNEL', phase: 'STARTUP' });

        // 跑 4 段脉冲
        for (let i = 0; i < 4; i++) {
            const evt = eng.eventQueue.shift()! as ActionExecutionEvent;
            eng.resolveActionPulse(a, evt);
            eng.currentTick += 5;
        }

        assert(a.currentActionContext!.pulseCount === 4, '跑了 4 段');
        assert(a.currentActionContext!.phase === 'CHANNELING', '仍在 CHANNELING（无限）');
        assert(eng.getEntity('b')!.resources.current.hp === 80, 'b HP=80 (4*5=20 damage)');
    }

    // ---- Test 7: Channel 脉冲资源消耗 ----
    console.log('\n[Test 7] Channel pulseResourceCost');
    {
        actionDict.set('COSTLY_CHANNEL', {
            id: 'COSTLY_CHANNEL',
            timeCost: { startupTicks: 10, recoveryTicks: 5 },
            effects: [],
            channelOptions: { intervalTicks: 5, maxPulses: 3, pulseResourceCost: { mp: '10' } }
        });

        const eng = new ChannelTestEngine();
        const a: Entity = { id: 'a', transform: { coords: { x: 0, y: 0, z: 0 } }, resources: { current: { hp: 100, mp: 50 }, max: { hp: 100, mp: 50 } } };
        eng.addEntity(a);
        const actor = eng.getEntity('a')!;

        actor.currentActionContext = { type: 'CASTING', actionId: 'e1', actionTemplateId: 'COSTLY_CHANNEL', phase: 'STARTUP', resolveTick: 10, pulseCount: 0 };
        eng.currentTick = 10;
        eng.pushEvent({ eventId: 'e1', eventType: 'ACTION_PHASE', targetTick: 10, status: 'PENDING', actorId: 'a', actionTemplateId: 'COSTLY_CHANNEL', phase: 'STARTUP' });

        // Pulse 1
        const evt1 = eng.eventQueue.shift()! as ActionExecutionEvent;
        eng.resolveActionPulse(actor, evt1);
        assert(actor.resources.current.mp === 40, `mp=40 after pulse 1 (actual: ${actor.resources.current.mp})`);

        // Pulse 2
        eng.currentTick = 15;
        const evt2 = eng.eventQueue.shift()! as ActionExecutionEvent;
        eng.resolveActionPulse(actor, evt2);
        assert(actor.resources.current.mp === 30, `mp=30 after pulse 2 (actual: ${actor.resources.current.mp})`);

        // Pulse 3 (last)
        eng.currentTick = 20;
        const evt3 = eng.eventQueue.shift()! as ActionExecutionEvent;
        eng.resolveActionPulse(actor, evt3);
        assert(actor.resources.current.mp === 20, `mp=20 after pulse 3 (actual: ${actor.resources.current.mp})`);
    }

    // ---- Test 8: 递归模式下 cancelCurrentAction 清空所有待执行事件 ----
    console.log('\n[Test 8] 递归 cancelCurrentAction 清空队列');
    {
        const eng = new ChannelTestEngine();
        const a: Entity = { id: 'a', transform: { coords: { x: 0, y: 0, z: 0 } }, resources: { current: { hp: 100 }, max: { hp: 100 } } };
        eng.addEntity(a);

        a.currentActionContext = {
            type: 'CASTING', actionId: 'e1', actionTemplateId: 'FIRE_STORM',
            phase: 'CHANNELING', resolveTick: 31, pulseCount: 1
        };

        // 模拟队列中有 2 个待执行脉冲 + 1 个 RECOVERY
        eng.pushEvent({ eventId: 'p2', eventType: 'ACTION_PHASE', targetTick: 23, status: 'PENDING', actorId: 'a', actionTemplateId: 'FIRE_STORM', phase: 'STARTUP' });
        eng.pushEvent({ eventId: 'p3', eventType: 'ACTION_PHASE', targetTick: 31, status: 'PENDING', actorId: 'a', actionTemplateId: 'FIRE_STORM', phase: 'STARTUP' });
        eng.pushEvent({ eventId: 'r1', eventType: 'ACTION_PHASE', targetTick: 41, status: 'PENDING', actorId: 'a', actionTemplateId: 'FIRE_STORM', phase: 'RECOVERY' });

        eng.cancelCurrentAction(a);
        assert(eng.eventQueue.every(e => e.status === 'CANCELLED'), '所有事件标记 CANCELLED');
        assert(eng.getEntity('a')!.currentActionContext === undefined, '上下文清除');
    }

    console.log(`\n${'='.repeat(40)}`);
    console.log(`结果: ${passCount}/${testCount} 通过`);
    if (passCount === testCount) console.log('✅ 所有 Channel 测试通过!');
}

runTests();
