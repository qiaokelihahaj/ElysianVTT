// ==========================================
// ReactionCountdown 集成测试 v2
// 使用真的 setTimeout + async/await 模拟完整决策生命周期
// ==========================================

// ==========================================
// 模拟 Zustand store
// ==========================================

interface DecisionPollPayload {
    windowId: string;
    actorId: string;
    countdownMs: number;
    sourceAction?: { actorId: string; actionName: string; startupRemainingTicks: number };
}

interface TacticalState {
    activeWindow: DecisionPollPayload | null;
    countdownEnd: number | null;
    reactionTriggered: boolean;
}

// 模拟最小 state 管理器
class TacticalStore {
    state: TacticalState;

    constructor() {
        this.state = {
            activeWindow: null,
            countdownEnd: null,
            reactionTriggered: false,
        };
    }

    receiveDecisionPoll(payload: DecisionPollPayload): void {
        this.state.activeWindow = payload;
        this.state.countdownEnd = Date.now() + payload.countdownMs;
        // 不重置 reactionTriggered（复刻 handleDecisionPoll）
    }

    triggerReaction(): void {
        this.state.reactionTriggered = true;
    }

    clearActiveWindow(): void {
        this.state.activeWindow = null;
        this.state.countdownEnd = null;
        this.state.reactionTriggered = false;
    }
}

// ==========================================
// 复制 ReactionCountdown Effect 1 的完整逻辑
// （包括防御性 store 读取）
// ==========================================

interface EffectHandle {
    cleanup: () => void;
}

function mountAutoSkipEffect(
    store: TacticalStore,
    onSkip: () => void
): EffectHandle {
    let timerId: ReturnType<typeof setTimeout> | null = null;

    // Effect body (复制自 ReactionCountdown.tsx lines 25-45)
    function effect(): () => void {
        const s = store.state;
        const { activeWindow, countdownEnd, reactionTriggered } = s;

        if (!activeWindow || countdownEnd === null) {
            return () => {};
        }
        if (reactionTriggered) {
            return () => {};
        }

        const remainingMs = countdownEnd - Date.now();
        if (remainingMs <= 0) {
            // 防御: 读取最新 store
            if (!store.state.reactionTriggered) {
                onSkip();
            }
            return () => {};
        }

        const tid = setTimeout(() => {
            // 防御: 读取最新 store
            if (!store.state.reactionTriggered) {
                onSkip();
            }
        }, remainingMs);

        timerId = tid;
        return () => { clearTimeout(tid); timerId = null; };
    }

    const cleanupFn = effect();

    return {
        cleanup: () => {
            cleanupFn();
        },
    };
}

// 模拟 React 的 effect re-run（cleanup + 新 effect）
function reRun(
    oldHandle: EffectHandle | null,
    store: TacticalStore,
    onSkip: () => void
): EffectHandle {
    if (oldHandle) {
        oldHandle.cleanup();
    }
    return mountAutoSkipEffect(store, onSkip);
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

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ==========================================
// Test 1: Bug 1 — 不按空格 → 自动跳过
// ==========================================

(async () => {

section('集成测试: Bug 1 — 不按空格 → 自动跳过');

{
    const store = new TacticalStore();
    let skipCount = 0;

    store.receiveDecisionPoll({
        windowId: 'win-A',
        actorId: 'actor_knight',
        countdownMs: 100,  // 100ms 倒计时
    });

    let handle = mountAutoSkipEffect(store, () => { skipCount++; });

    // 倒计时内不按空格
    await sleep(50);
    assert(skipCount === 0, '倒计时中途不跳过');

    // 等待过期
    await sleep(200);
    assert(skipCount === 1, '倒计时过期触发跳过');

    handle.cleanup();
}

// ==========================================
// Test 2: Bug 2 — 已按空格 → 不自动跳过
// ==========================================

section('集成测试: Bug 2 — 按空格后不自动跳过');

{
    const store = new TacticalStore();
    let skipCount = 0;

    store.receiveDecisionPoll({
        windowId: 'win-A',
        actorId: 'actor_knight',
        countdownMs: 150,  // 150ms 倒计时
    });

    let handle = mountAutoSkipEffect(store, () => { skipCount++; });

    // 50ms 后按空格
    await sleep(50);
    assert(skipCount === 0, '按空格前未跳过');

    store.triggerReaction();
    // 模拟 React: cleanup + re-run
    handle = reRun(handle, store, () => { skipCount++; });

    assert(store.state.reactionTriggered === true, 'reactionTriggered 为 true');

    // 等待到原始倒计时过期后（再等 200ms）
    await sleep(200);
    assert(skipCount === 0, 'BUG 2 验证点: 按空格后不自动跳过');
    assert(store.state.reactionTriggered === true, 'reactionTriggered 仍为 true');

    // 再等长时间确认无残留
    await sleep(500);
    assert(skipCount === 0, '长时间等待仍不跳过');
}

// ==========================================
// Test 3: 按空格后收到第二个 DecisionPoll
// ==========================================

section('集成测试: 按空格后收到第二个 DecisionPoll → 不跳过');

{
    const store = new TacticalStore();
    let skipCount = 0;

    store.receiveDecisionPoll({
        windowId: 'win-A',
        actorId: 'actor_knight',
        countdownMs: 150,
    });

    let handle = mountAutoSkipEffect(store, () => { skipCount++; });

    // 50ms 按空格
    await sleep(50);
    store.triggerReaction();
    handle = reRun(handle, store, () => { skipCount++; });

    // 50ms 后收到第二个 DecisionPoll（activeWindow 改变 → effect 重跑）
    await sleep(50);

    store.receiveDecisionPoll({
        windowId: 'win-B',
        actorId: 'actor_knight',
        countdownMs: 100,
    });

    // activeWindow 和 countdownEnd 改变 → effect 重跑
    handle = reRun(handle, store, () => { skipCount++; });

    // 验证 reactionTriggered 保持 true
    assert(store.state.reactionTriggered === true,
        '第二个 poll 后 reactionTriggered 保持 true');

    // 等待第二个 poll 的倒计时过期
    await sleep(200);

    assert(skipCount === 0,
        '按空格后收到第二个 DecisionPoll，仍不触发跳过');

    handle.cleanup();
}

// ==========================================
// Test 4: 不按空格，但 reactionTriggered 意外为 false
// （模拟 clearActiveWindow 误清除后的情况）
// ==========================================

section('集成测试: clearActiveWindow 误清除 → reactionTriggered=false → 跳过');

{
    const store = new TacticalStore();
    let skipCount = 0;

    store.receiveDecisionPoll({
        windowId: 'win-A',
        actorId: 'actor_knight',
        countdownMs: 150,
    });

    let handle = mountAutoSkipEffect(store, () => { skipCount++; });

    // 50ms 后按空格
    await sleep(50);
    store.triggerReaction();
    handle = reRun(handle, store, () => { skipCount++; });

    // 然后不小心调用了 clearActiveWindow（模拟 DECISION_ALL_RESOLVED）
    // 再恢复 poll...
    store.clearActiveWindow();
    store.receiveDecisionPoll({
        windowId: 'win-A',
        actorId: 'actor_knight',
        countdownMs: 150,
    });

    // effect 重跑: 此时 reactionTriggered = false（已清除）
    handle = reRun(handle, store, () => { skipCount++; });

    // 等待过期
    await sleep(200);

    // 此时应该触发跳过，因为 reactionTriggered 被 clearActiveWindow 重置了
    assert(skipCount === 1,
        'clearActiveWindow 后 reactionTriggered 被重置 → 自动跳过恢复');
    // 这说明: 如果 DECISION_ALL_RESOLVED（或其他途径）清除了 activeWindow，
    // 然后新的 poll 到达，会重新开始倒计时并可能自动跳过
    // 这是个设计问题：reactionTriggered 不会跨 poll 保持
    // 但在 Bug 2 的实际场景中，clearActiveWindow 不应该被调用
}

// ==========================================
// Test 5: 完整复刻 Bug 2 场景
// 用户按空格后，不做任何操作，等待倒计时过期
// ==========================================

section('集成测试: Bug 2 完全复刻');

{
    const store = new TacticalStore();
    let skipCount = 0;
    let skipTriggers: number[] = [];

    store.receiveDecisionPoll({
        windowId: 'win-A',
        actorId: 'actor_knight',
        countdownMs: 200,
    });

    let handle = mountAutoSkipEffect(store, () => {
        skipCount++;
        skipTriggers.push(Date.now());
    });

    // 100ms 后按空格
    await sleep(100);

    store.triggerReaction();
    handle = reRun(handle, store, () => {
        skipCount++;
        skipTriggers.push(Date.now());
    });

    // 等待 200ms（原始倒计时 t=300ms）
    await sleep(200);

    assert(skipCount === 0, '按空格后倒计时过期不跳过');

    // 再等 500ms 确认
    await sleep(500);
    assert(skipCount === 0, '长时间等待确认不跳过');

    handle.cleanup();
}

// ==========================================
// 汇总
// ==========================================

console.log(`\n${'='.repeat(50)}`);
console.log(`✅ 通过: ${passCount}/${testCount}`);
console.log(`❌ 失败: ${testCount - passCount}`);
console.log(`${'='.repeat(50)}\n`);

if ((testCount - passCount) > 0) {
    process.exit(1);
}

})();  // IIFE for async
