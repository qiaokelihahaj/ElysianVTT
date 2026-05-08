import React, { useEffect, useState, useRef } from 'react';
import { useGameStore } from '../../store/gameStore';

export const ReactionCountdown: React.FC = () => {
    const activeWindow = useGameStore(state => state.tactical.activeWindow);
    const countdownEnd = useGameStore(state => state.tactical.countdownEnd);
    const reactionTriggered = useGameStore(state => state.tactical.reactionTriggered);
    const controlledEntityIds = useGameStore(state => state.permission.controlledEntityIds);
    const playerRole = useGameStore(state => state.permission.role);
    const sendDecisionResponse = useGameStore(state => state.sendDecisionResponse);
    const [remaining, setRemaining] = useState(0);
    const frozenRef = useRef<number | null>(null);
    const rafRef = useRef<number | null>(null);
    // 防御层 3: 本地 ref 追踪用户是否已按空格，防止浏览器事件竞态
    const hasEngagedRef = useRef(false);
    const engagedWindowIdRef = useRef<string | null>(null);

    // 是否当前用户有权决策此窗口
    const isDecisionTarget = activeWindow
        ? (playerRole === 'GM' || controlledEntityIds.includes(activeWindow.actorId))
        : false;

    // 防御层 3: 同步本地 ref —— 用户按空格后标记窗口为已接战
    // 新窗口到达时自动重置
    useEffect(() => {
        if (!activeWindow) {
            hasEngagedRef.current = false;
            engagedWindowIdRef.current = null;
            return;
        }
        if (reactionTriggered) {
            hasEngagedRef.current = true;
            engagedWindowIdRef.current = activeWindow.windowId;
        }
        // 新窗口（windowId 变化）→ 重置接战标记
        if (engagedWindowIdRef.current !== null && engagedWindowIdRef.current !== activeWindow.windowId) {
            hasEngagedRef.current = false;
            engagedWindowIdRef.current = null;
        }
    }, [activeWindow, reactionTriggered]);

    // Effect 1: 自动跳过定时器
    // 倒计时结束且未按空格 → 自动跳过
    // 按空格后 cleanup 取消定时器 → 不会跳过
    // 防御措施：setTimeout 回调中从 store 直接读取 reactionTriggered，
    // 防止因 effect 生命周期竞态导致已按空格仍执行跳过
    useEffect(() => {
        const EFFECT_ID = Math.random().toString(36).slice(2, 6);
        console.log(`[E1:${EFFECT_ID}] MOUNT activeWindow=${!!activeWindow}, ` +
            `countdownEnd=${countdownEnd}, reactionTriggered=${reactionTriggered}`);

        if (!activeWindow || countdownEnd === null) {
            console.log(`[E1:${EFFECT_ID}] SKIP: no window or countdownEnd`);
            return;
        }
        if (reactionTriggered) {
            console.log(`[E1:${EFFECT_ID}] SKIP: reactionTriggered=true`);
            return;
        }

        const remainingMs = countdownEnd - Date.now();
        console.log(`[E1:${EFFECT_ID}] remainingMs=${remainingMs}`);

        if (remainingMs <= 0) {
            // 防御层: store + 本地 ref 双重确认
            const liveTriggered = useGameStore.getState().tactical.reactionTriggered;
            const refEngaged = hasEngagedRef.current;
            console.log(`[E1:${EFFECT_ID}] EXPIRED, liveTriggered=${liveTriggered}, refEngaged=${refEngaged}`);
            if (!liveTriggered && !refEngaged) {
                console.log(`[E1:${EFFECT_ID}] → sendDecisionResponse(null)`);
                sendDecisionResponse(null);
            }
            return () => {};
        }

        const timer = setTimeout(() => {
            const liveTriggered = useGameStore.getState().tactical.reactionTriggered;
            const refEngaged = hasEngagedRef.current;
            console.log(`[E1:${EFFECT_ID}] TIMEOUT FIRED, liveTriggered=${liveTriggered}, refEngaged=${refEngaged}`);
            if (!liveTriggered && !refEngaged) {
                console.log(`[E1:${EFFECT_ID}] → sendDecisionResponse(null)`);
                sendDecisionResponse(null);
            } else {
                console.log(`[E1:${EFFECT_ID}] GUARD: skip prevented (reactionTriggered=${liveTriggered}, refEngaged=${refEngaged})`);
            }
        }, remainingMs);

        console.log(`[E1:${EFFECT_ID}] timer scheduled, remainingMs=${remainingMs}`);

        return () => {
            console.log(`[E1:${EFFECT_ID}] CLEANUP: clearing timer`);
            clearTimeout(timer);
        };
    }, [activeWindow, countdownEnd, reactionTriggered, sendDecisionResponse]);

    // Effect 2: RAF 视觉倒计时（纯显示，不含决策逻辑）
    useEffect(() => {
        if (!activeWindow || countdownEnd === null) return;
        if (reactionTriggered) return;

        const update = () => {
            const now = Date.now();
            const rem = (countdownEnd - now) / 1000;
            setRemaining(Math.max(0, rem));
            rafRef.current = requestAnimationFrame(update);
        };

        rafRef.current = requestAnimationFrame(update);

        return () => {
            if (rafRef.current !== null) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
        };
    }, [activeWindow, countdownEnd, reactionTriggered]);

    // 只有决策目标才显示组件（所有 hooks 之后才允许条件返回）
    if (!activeWindow || countdownEnd === null || !isDecisionTarget) return null;

    // 玩家按空格打开面板后：冻结倒计时
    if (reactionTriggered && frozenRef.current === null) {
        frozenRef.current = remaining;
    } else if (!reactionTriggered) {
        frozenRef.current = null;
    }
    const displayRemaining = frozenRef.current ?? remaining;

    const totalSec = activeWindow.countdownMs / 1000;
    const percent = Math.max(0, (displayRemaining / totalSec) * 100);
    const isUrgent = displayRemaining < 1.0;
    const hasExpired = remaining <= 0 && !reactionTriggered;

    // 倒计时已过期且用户未接战 → 显示等待状态（其他标签页/客户端可能正在决策）
    if (hasExpired) {
        return (
            <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 pointer-events-auto">
                <div className="bg-zinc-900/90 border border-zinc-600/50 rounded-lg p-2 backdrop-blur-md">
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-zinc-500 animate-pulse">⏳</span>
                        <span className="text-xs text-zinc-400">
                            {activeWindow.sourceAction?.actorId ?? activeWindow.actorId} → {activeWindow.sourceAction?.actionName ?? 'Unknown'}
                        </span>
                        <span className="text-[10px] text-zinc-600">等待决策中…</span>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 pointer-events-auto">
            <div className="bg-zinc-900/90 border border-red-500/50 rounded-lg p-2 backdrop-blur-md min-w-80">
                <div className={`h-1.5 bg-zinc-800 rounded-full overflow-hidden ${isUrgent ? 'animate-pulse' : ''}`}>
                    <div
                        className="h-full bg-red-500 transition-all duration-100"
                        style={{ width: `${percent}%` }}
                    />
                </div>
                <div className="flex items-center justify-between mt-1.5">
                    <span className="text-xs text-red-300">
                        {activeWindow.sourceAction?.actorId ?? activeWindow.actorId} → {activeWindow.sourceAction?.actionName ?? 'Unknown'}
                    </span>
                    <span className="text-xs text-zinc-400 flex items-center gap-2">
                        {reactionTriggered
                            ? <span className="text-yellow-400">决策中</span>
                            : <><span>按 <kbd className="px-1 py-0.5 bg-zinc-800 rounded text-red-400 font-mono">空格</kbd> 反应</span></>}
                        {!reactionTriggered && (
                            <button
                                onClick={() => {
                                    // 防御：读取 live store + ref，防止浏览器键盘合成点击竞态
                                    if (useGameStore.getState().tactical.reactionTriggered) return;
                                    if (hasEngagedRef.current) return;
                                    sendDecisionResponse(null);
                                }}
                                className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 border border-zinc-700/50 text-[10px] transition-colors"
                            >
                                跳过
                            </button>
                        )}
                    </span>
                </div>
            </div>
        </div>
    );
};
