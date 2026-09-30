// ==========================================
// 决策倒计时 React Effect 生命周期测试
// 模拟 useEffect 的 mount/cleanup/re-run 行为，
// 验证 setTimeout 定时器在状态变更时正确取消
// ==========================================

// ==========================================
// 模拟时间控制器
// 替代 Date.now() 和 setTimeout，精确控制时间流逝
// ==========================================

interface TimerEntry {
    id: number;
    fireAt: number;
    callback: () => void;
    cancelled: boolean;
}

class SimTime {
    private _now: number;
    private timers: TimerEntry[] = [];
    private nextId = 1;

    constructor(startTime: number) {
        this._now = startTime;
    }

    get now(): number { return this._now; }

    setTimeout(callback: () => void, ms: number): number {
        const id = this.nextId++;
        this.timers.push({ id, fireAt: this._now + ms, callback, cancelled: false });
        this.timers.sort((a, b) => a.fireAt - b.fireAt);
        return id;
    }

    clearTimeout(id: number): void {
        const timer = this.timers.find(t => t.id === id);
        if (timer) timer.cancelled = true;
    }

    /** 推进时间并触发到期定时器 */
    advance(ms: number): void {
        this._now += ms;
        while (this.timers.length > 0 && this.timers[0].fireAt <= this._now) {
            const timer = this.timers.shift()!;
            if (!timer.cancelled) {
                timer.callback();
            }
        }
    }
}

// ==========================================
// 模拟 Effect 1 的自动跳过逻辑
// 精确复制 ReactionCountdown 中 Effect 1 的行为
// ==========================================

interface EffectContext {
    activeWindow: boolean;
    countdownEnd: number | null;
    reactionTriggered: boolean;
}

interface EffectHandle {
    timerId: number | null;
    cleanup: () => void;
}

function runAutoSkipEffect(
    ctx: EffectContext,
    sim: SimTime,
    onSkip: () => void,
    // 模拟 useGameStore.getState().tactical.reactionTriggered（防御性读取）
    getLiveTriggered: () => boolean = () => ctx.reactionTriggered
): EffectHandle {
    const handle: EffectHandle = { timerId: null, cleanup: () => {} };

    if (!ctx.activeWindow || ctx.countdownEnd === null) {
        handle.cleanup = () => {};
        return handle;
    }
    if (ctx.reactionTriggered) {
        handle.cleanup = () => {};
        return handle;
    }

    const remainingMs = ctx.countdownEnd - sim.now;
    if (remainingMs <= 0) {
        // 即时过期：双重确认（对应组件的防御性检查）
        if (!getLiveTriggered()) {
            onSkip();
        }
        handle.cleanup = () => {};
        return handle;
    }

    const timerId = sim.setTimeout(() => {
        // 定时器触发时从 store 读取最新的 reactionTriggered
        if (!getLiveTriggered()) {
            onSkip();
        }
    }, remainingMs);
    handle.timerId = timerId;
    handle.cleanup = () => {
        if (handle.timerId !== null) {
            sim.clearTimeout(handle.timerId);
            handle.timerId = null;
        }
    };
    return handle;
}

// ==========================================
// 测试工具
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
    console.log(`\n📋 ${title}`);
}

// ==========================================
// 测试 1: Bug 1 — 未按空格 → 倒计时结束 → 自动跳过
// ==========================================

section('[生命周期] Bug 1: 未按空格 → 倒计时结束 → 自动跳过');

{
    const START = 1000;
    const sim = new SimTime(START);
    const COUNTDOWN_MS = 5000;
    const countdownEnd = sim.now + COUNTDOWN_MS;

    let skipCalled = false;
    const onSkip = () => { skipCalled = true; };

    // mount: 倒计时尚未结束，不跳过
    let handle = runAutoSkipEffect(
        { activeWindow: true, countdownEnd, reactionTriggered: false },
        sim, onSkip
    );
    assert(!skipCalled, '挂载时不立即跳过');

    // 倒计时未到期：不跳过
    sim.advance(2000);
    assert(!skipCalled, '倒计时中途不跳过');

    // 倒计时到达截止时间
    sim.advance(3000);
    assert(skipCalled, '倒计时到期触发跳过');

    // cleanup (模拟 Effect 卸载)
    handle.cleanup();
}

// ==========================================
// 测试 2: Bug 2 — 已按空格 → 倒计时结束 → 不跳过
// ==========================================

section('[生命周期] Bug 2: 已按空格 → 倒计时结束 → 不跳过');

{
    const START = 1000;
    const sim = new SimTime(START);
    const COUNTDOWN_MS = 5000;
    const countdownEnd = sim.now + COUNTDOWN_MS;
    const SPACE_PRESS_AT_MS = 2000;  // 2秒后按空格

    let skipCalled = false;
    const onSkip = () => { skipCalled = true; };

    // Step 1: 初始 mount
    console.log('  [Step 1] 初始 mount, reactionTriggered=false');
    let handle = runAutoSkipEffect(
        { activeWindow: true, countdownEnd, reactionTriggered: false },
        sim, onSkip
    );
    assert(handle.timerId !== null, '定时器已创建');
    assert(!skipCalled, '未立即跳过');

    // Step 2: 2秒后按空格
    sim.advance(SPACE_PRESS_AT_MS);
    console.log(`  [Step 2] 在 ${SPACE_PRESS_AT_MS}ms 时按空格`);

    // 模拟 Effect cleanup (React 在 re-render 前执行旧 effect 的 cleanup)
    handle.cleanup();
    const oldTimerId = handle.timerId;
    // cleanup 清空了 timerId
    assert(handle.timerId === null, 'cleanup 后 timerId 被清空');

    // 验证旧定时器已被取消（如果不清除，它会触发 onSkip）
    // 先重置 skipCalled，因为我们测试的是 "cleanup 后旧定时器不会触发"
    skipCalled = false;

    // Step 3: Effect 以 reactionTriggered=true 重新运行
    console.log('  [Step 3] effect 以 reactionTriggered=true 重跑');
    handle = runAutoSkipEffect(
        { activeWindow: true, countdownEnd, reactionTriggered: true },
        sim, onSkip
    );
    assert(handle.timerId === null, 'reactionTriggered=true 时不创建定时器');

    // Step 4: 等待原始倒计时过期 (一共 5000ms，已过 2000ms，再过 4000ms)
    console.log('  [Step 4] 等待原始倒计时过期');
    sim.advance(4000);
    assert(!skipCalled, '已按空格的情况下，倒计时过期不触发跳过'); // ← BUG 2 验证点

    // Step 5: 验证旧定时器不会残留
    console.log('  [Step 5] 验证无残留定时器');
    sim.advance(10000);
    assert(!skipCalled, '长时间等待后仍然不触发跳过');
}

// ==========================================
// 测试 3: 边界 — 按空格时倒计时即将到期
// ==========================================

section('[生命周期] 边界: 按空格时倒计时即将到期');

{
    const START = 1000;
    const sim = new SimTime(START);
    const COUNTDOWN_MS = 3000;
    const countdownEnd = sim.now + COUNTDOWN_MS;
    // 在只剩 100ms 时按空格
    const SPACE_PRESS_AT_MS = 2900;

    let skipCalled = false;
    const onSkip = () => { skipCalled = true; };

    // 初始 mount
    let handle = runAutoSkipEffect(
        { activeWindow: true, countdownEnd, reactionTriggered: false },
        sim, onSkip
    );
    assert(!skipCalled, '初始不跳过');

    // 在 2900ms 时按空格
    sim.advance(SPACE_PRESS_AT_MS);
    handle.cleanup();
    skipCalled = false;

    handle = runAutoSkipEffect(
        { activeWindow: true, countdownEnd, reactionTriggered: true },
        sim, onSkip
    );

    // 再等 200ms（原倒计时已到 3100ms > 3000ms）
    sim.advance(200);
    assert(!skipCalled, '按空格且倒计时已到期时不跳过');
}

// ==========================================
// 测试 4: 多次 Effect 重跑（模拟 React 重渲染）
// ==========================================

section('[生命周期] 多次 Effect 重跑');

{
    const START = 1000;
    const sim = new SimTime(START);
    const countdownEnd = sim.now + 10000; // 10s 倒计时

    let skipCalled = false;
    const onSkip = () => { skipCalled = true; };

    // 第一次 mount
    let handle = runAutoSkipEffect(
        { activeWindow: true, countdownEnd, reactionTriggered: false },
        sim, onSkip
    );

    // 一些无关的 state 变化导致 effect 重跑（但依赖不变）
    // 模拟 React 的 effect cleanup + re-run
    sim.advance(1000);
    handle.cleanup();
    handle = runAutoSkipEffect(
        { activeWindow: true, countdownEnd, reactionTriggered: false },
        sim, onSkip
    );
    assert(handle.timerId !== null, '重跑后定时器重新创建');

    sim.advance(2000);
    assert(!skipCalled, '重跑后倒计时中途不跳过');

    // 按空格
    handle.cleanup();
    handle = runAutoSkipEffect(
        { activeWindow: true, countdownEnd, reactionTriggered: true },
        sim, onSkip
    );
    assert(handle.timerId === null, '按空格后不创建新定时器');

    // 等到原始倒计时到期
    sim.advance(7000);
    assert(!skipCalled, '多次重跑 + 按空格后不跳过');
}

// ==========================================
// 测试 5: 倒计时过期后按空格（模拟界面延迟）
// ==========================================

section('[生命周期] 倒计时过期后按空格');

{
    const START = 1000;
    const sim = new SimTime(START);
    const countdownEnd = sim.now + 2000; // 2s 倒计时

    let skipCalled = false;
    const onSkip = () => { skipCalled = true; };

    // mount
    let handle = runAutoSkipEffect(
        { activeWindow: true, countdownEnd, reactionTriggered: false },
        sim, onSkip
    );

    // 倒计时到期 → 触发跳过
    sim.advance(3000);
    assert(skipCalled, '倒计时到期触发跳过（correct for not pressed）');
    skipCalled = false;

    // 此时用户再按空格（late press），effect 重跑
    handle.cleanup();
    handle = runAutoSkipEffect(
        { activeWindow: true, countdownEnd, reactionTriggered: true },
        sim, onSkip
    );
    assert(!skipCalled, '到期后按空格不再触发跳过');
}

// ==========================================
// 测试 6: Effect 多次 mount/unmount（StrictMode 模拟）
// ==========================================

section('[生命周期] StrictMode 双 mount');

{
    const START = 1000;
    const sim = new SimTime(START);
    const countdownEnd = sim.now + 5000;

    let skipCalled = false;
    const onSkip = () => { skipCalled = true; };

    // 第一次 mount + 立即 unmount (StrictMode)
    let handle = runAutoSkipEffect(
        { activeWindow: true, countdownEnd, reactionTriggered: false },
        sim, onSkip
    );
    handle.cleanup();

    // 第二次 mount (StrictMode 重挂载)
    handle = runAutoSkipEffect(
        { activeWindow: true, countdownEnd, reactionTriggered: false },
        sim, onSkip
    );

    // 按空格
    sim.advance(2000);
    handle.cleanup();
    handle = runAutoSkipEffect(
        { activeWindow: true, countdownEnd, reactionTriggered: true },
        sim, onSkip
    );

    // 等待倒计时到期
    sim.advance(4000);
    assert(!skipCalled, 'StrictMode 双 mount + 按空格后不跳过');
}

// ==========================================
// 测试 7: 防御性读取 — 即使 cleanup 失败，定时器回调
// 中也从 store 读取最新的 reactionTriggered
// ==========================================

section('[生命周期] 防御性读取: cleanup 失败但回调检测到按空格');

{
    const START = 1000;
    const sim = new SimTime(START);
    const countdownEnd = sim.now + 5000;

    let skipCalled = false;
    let liveTriggered = false; // 模拟 store 中的 reactionTriggered
    const onSkip = () => { skipCalled = true; };
    const getLive = () => liveTriggered;

    // 初始 mount, reactionTriggered=false
    let handle = runAutoSkipEffect(
        { activeWindow: true, countdownEnd, reactionTriggered: false },
        sim, onSkip, getLive
    );
    assert(handle.timerId !== null, '定时器已创建');
    assert(!skipCalled, '未立即跳过');

    // 用户按空格: 更新 live store
    sim.advance(2000);
    liveTriggered = true;

    // 假设 cleanup 因为某些 React 边缘情况没有执行！
    // 但定时器回调仍然会检查 getLiveTriggered()
    console.log('  [防御] 按空格但不清除定时器，模拟 cleanup 失败');

    // 等待原始倒计时到期
    sim.advance(4000); // 总 6s，已过原始 5s 倒计时
    assert(!skipCalled, '即使 cleanup 失败，回调从 store 读到最新状态不跳过');

    // 再等待验证没有残留定时器
    sim.advance(10000);
    assert(!skipCalled, '长时间等待后仍然不触发跳过');
}

// ==========================================
// 测试 8: 即时过期路径的防御性读取
// ==========================================

section('[生命周期] 防御性读取: 即时过期路径');

{
    const START = 1000;
    const sim = new SimTime(START);
    // countdownEnd 已过期
    const countdownEnd = sim.now - 100;

    let skipCalled = false;
    let liveTriggered = false;

    // 未按空格 → 应该跳过
    const result1 = runAutoSkipEffect(
        { activeWindow: true, countdownEnd, reactionTriggered: false },
        sim, () => { skipCalled = true; }, () => liveTriggered
    );
    // 注意: runAutoSkipEffect 内部在 remainingMs <= 0 时直接检查 getLiveTriggered()
    // 这里 liveTriggered 为 false → 会执行 onSkip
    assert(skipCalled, '过期 + 未按空格 → 跳过');
    result1.cleanup();

    // 已按空格 → 即使过期也不跳过
    skipCalled = false;
    liveTriggered = true;
    const result2 = runAutoSkipEffect(
        { activeWindow: true, countdownEnd, reactionTriggered: false },
        sim, () => { skipCalled = true; }, () => liveTriggered
    );
    assert(!skipCalled, '过期 + 已按空格（live store）→ 不跳过');
    result2.cleanup();
}

// ==========================================
// 测试汇总
// ==========================================
console.log(`\n${'='.repeat(50)}`);
console.log(`✅ 通过: ${passCount}/${testCount}`);
console.log(`❌ 失败: ${testCount - passCount}`);
console.log(`${'='.repeat(50)}\n`);

if ((testCount - passCount) > 0) {
    process.exit(1);
}
