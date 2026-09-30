// ==========================================
// 决策倒计时/自动跳过 核心逻辑测试
// 验证: 倒计时结束时根据 reactionTriggered 状态
// 正确决定是否自动跳过
// ==========================================

// ==========================================
// 待测核心逻辑 (纯函数)
// 对应 ReactionCountdown 中的自动跳过逻辑
// ==========================================

interface AutoSkipContext {
    activeWindow: boolean;         // 是否有活跃决策窗口
    countdownEnd: number | null;   // 倒计时截止时间戳
    reactionTriggered: boolean;    // 用户是否已按空格
}

interface AutoSkipResult {
    shouldSkip: boolean;           // 是否应该自动跳过
    remainingMs: number;           // 剩余毫秒数 (<=0 表示已过期)
}

/**
 * 决策倒计时核心逻辑：
 * - activeWindow 为空或 countdownEnd 为空 → 不跳过
 * - 用户已按空格 (reactionTriggered=true) → 不跳过
 * - 倒计时未结束 → 不跳过
 * - 倒计时已结束且用户未按空格 → 跳过
 */
function evaluateAutoSkip(ctx: AutoSkipContext): AutoSkipResult {
    if (!ctx.activeWindow || ctx.countdownEnd === null) {
        return { shouldSkip: false, remainingMs: 0 };
    }

    const remainingMs = ctx.countdownEnd - Date.now();

    if (ctx.reactionTriggered) {
        return { shouldSkip: false, remainingMs: Math.max(0, remainingMs) };
    }

    if (remainingMs <= 0) {
        return { shouldSkip: true, remainingMs: 0 };
    }

    return { shouldSkip: false, remainingMs };
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
// 测试 1: 未按空格 → 倒计时结束 → 自动跳过
// ==========================================

section('未按空格 → 倒计时结束 → 自动跳过');

{
    // 在倒计时截止前：不跳过
    const future = Date.now() + 5000;
    const ctxBefore: AutoSkipContext = {
        activeWindow: true,
        countdownEnd: future,
        reactionTriggered: false,
    };
    const resultBefore = evaluateAutoSkip(ctxBefore);
    assert(resultBefore.shouldSkip === false, '倒计时结束前不跳过');
    assert(resultBefore.remainingMs > 0, '剩余时间为正');
}

{
    // 倒计时已过期：跳过
    const past = Date.now() - 100;
    const ctxExpired: AutoSkipContext = {
        activeWindow: true,
        countdownEnd: past,
        reactionTriggered: false,
    };
    const resultExpired = evaluateAutoSkip(ctxExpired);
    assert(resultExpired.shouldSkip === true, '倒计时过期触发跳过');
    assert(resultExpired.remainingMs === 0, '过期时剩余时间为0');
}

{
    // 无活跃窗口：不跳过
    const ctxNoWindow: AutoSkipContext = {
        activeWindow: false,
        countdownEnd: Date.now() - 100,
        reactionTriggered: false,
    };
    const resultNoWindow = evaluateAutoSkip(ctxNoWindow);
    assert(resultNoWindow.shouldSkip === false, '无活跃窗口不跳过');
}

{
    // countdownEnd 为 null：不跳过
    const ctxNull: AutoSkipContext = {
        activeWindow: true,
        countdownEnd: null,
        reactionTriggered: false,
    };
    const resultNull = evaluateAutoSkip(ctxNull);
    assert(resultNull.shouldSkip === false, 'countdownEnd 为 null 时不跳过');
}

// ==========================================
// 测试 2: 已按空格 → 倒计时结束 → 不跳过
// ==========================================

section('已按空格 → 倒计时结束 → 不跳过');

{
    // 已按空格，倒计时已过期：不跳过
    const past = Date.now() - 100;
    const ctxTriggered: AutoSkipContext = {
        activeWindow: true,
        countdownEnd: past,
        reactionTriggered: true,
    };
    const resultTriggered = evaluateAutoSkip(ctxTriggered);
    assert(resultTriggered.shouldSkip === false, '已按空格时不跳过');
    assert(resultTriggered.remainingMs === 0, '即使按了空格剩余时间仍正常计算');
}

{
    // 已按空格，倒计时未过期：不跳过
    const future = Date.now() + 3000;
    const ctxTriggeredFuture: AutoSkipContext = {
        activeWindow: true,
        countdownEnd: future,
        reactionTriggered: true,
    };
    const resultTriggeredFuture = evaluateAutoSkip(ctxTriggeredFuture);
    assert(resultTriggeredFuture.shouldSkip === false, '已按空格+未过期不跳过');
}

// ==========================================
// 测试 3: 边界情况
// ==========================================

section('边界情况');

{
    // 倒计时刚好到 0：跳过
    const exactNow = Date.now();
    const ctxExact: AutoSkipContext = {
        activeWindow: true,
        countdownEnd: exactNow,
        reactionTriggered: false,
    };
    const resultExact = evaluateAutoSkip(ctxExact);
    assert(resultExact.shouldSkip === true, 'countdownEnd === now 时触发跳过');
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
