import React, { lazy, Suspense, useState, useEffect } from 'react';
import { useGameStore } from '../store/gameStore';
import { useExploreStore } from '../store/exploreStore';
import { IntentDispatcher } from '../network/IntentDispatcher';
import { socketClient } from '../network/socketClient';
import { TickMeter } from './components/TickMeter';
import { EntityList } from './components/EntityList';
import { resourcePercent } from '../utils/resourceDisplay';
import { ActionBar } from './components/ActionBar';
import { ReactionCountdown } from './components/ReactionCountdown';
import { TacticalDecisionPanel } from './components/TacticalDecisionPanel';
import { PriorityToggles } from './components/PriorityToggles';
import { HookEditor } from './components/HookEditor';

const TestToolbox = lazy(() => import('./TestToolbox').then(module => ({ default: module.TestToolbox })));

export const HUD: React.FC = () => {
    const combatResult = useGameStore(state => state.combatResult);
    const selectedEntity = useGameStore(state => state.selectedEntityId ? state.entities[state.selectedEntityId] : null);
    const tick = useGameStore(state => state.tick);
    const frozenTick = useGameStore(state => state.tactical.frozenTick);
    const displayTick = frozenTick ?? tick;
    const selectedEntityId = useGameStore(state => state.selectedEntityId);
    const uiState = useGameStore(state => state.uiState);
    const permission = useGameStore(state => state.permission);
    const activeWindow = useGameStore(state => state.tactical.activeWindow);
    const reactionTriggered = useGameStore(state => state.tactical.reactionTriggered);
    const triggerReaction = useGameStore(state => state.triggerReaction);
    const sendDecisionResponse = useGameStore(state => state.sendDecisionResponse);
    const { resetUiState } = useGameStore.getState();

    const canAct = !!selectedEntity && !combatResult && permission.role !== 'OB' && (
        permission.role === 'GM' ||
        (!!selectedEntityId && permission.controlledEntityIds.includes(selectedEntityId))
    );
    const [showToolbox, setShowToolbox] = useState(false);
    const [showHookEditor, setShowHookEditor] = useState(false);
    const roleBadgeClass = permission.role === 'GM'
        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
        : permission.role === 'PL'
            ? 'bg-sky-500/15 text-sky-300 border-sky-500/30'
            : 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30';

    // Global keyboard listener for reaction controls
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.repeat || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
            // 保留表单、按钮及富文本编辑区域自身的键盘交互。
            if (e.target instanceof Element && e.target.closest(
                'input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"]), [role="textbox"]'
            )) return;
            if (e.code === 'Space') {
                if (activeWindow && !reactionTriggered) {
                    const isUserTarget = permission.role === 'GM' || permission.controlledEntityIds.includes(activeWindow.actorId);
                    if (isUserTarget) {
                        e.preventDefault();
                        triggerReaction();
                        socketClient.sendDecisionEngage(activeWindow.windowId);
                    }
                }
            }
            if (e.code === 'Escape') {
                if (reactionTriggered) {
                    sendDecisionResponse(null);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activeWindow, reactionTriggered, triggerReaction, sendDecisionResponse, permission]);

    const handleConfirmMove = () => {
        if (selectedEntity && uiState.pendingMoveCoords) {
            IntentDispatcher.dispatchMove(selectedEntity.id, uiState.pendingMoveCoords);
            useGameStore.getState().setMovementTarget(selectedEntity.id, uiState.pendingMoveCoords);
            resetUiState();
        }
    };

    return (
        <div className="absolute inset-0 pointer-events-none flex flex-col">
            {/* Tick Timeline - spans full top */}
            <TickMeter />

            {combatResult && (
                <div role="status" className="mx-auto mt-3 rounded-xl border border-emerald-500/40 bg-zinc-950/95 px-6 py-3 text-center shadow-xl">
                    <h2 className="font-bold text-emerald-300">战斗结束 · 已结算</h2>
                    <p className="mt-1 text-sm text-zinc-300">
                        Tick {combatResult.tick} · 存活 {combatResult.survivors.length} · 倒下 {combatResult.casualties.length}
                    </p>
                </div>
            )}

            {/* 决策状态栏 — 所有人可见谁在决策，GM 可强制跳过 */}
            {activeWindow && (
                <div className="flex items-center justify-between px-4 py-1 bg-zinc-900/80 border-b border-zinc-700/50 pointer-events-auto">
                    <span className="text-xs text-red-300 font-mono">
                        ⏳ 决策中: {activeWindow.sourceAction?.actorId ?? activeWindow.actorId} → {activeWindow.sourceAction?.actionName ?? 'Unknown'}
                    </span>
                    {permission.role === 'GM' && (
                        <button
                            onClick={() => socketClient.sendGmForceResolve()}
                            className="text-[10px] px-2.5 py-1 rounded bg-red-700/50 hover:bg-red-600/70 text-red-200 border border-red-500/40 font-medium transition-colors"
                        >
                            ⏭ 强制跳过
                        </button>
                    )}
                </div>
            )}

            {/* Test Toolbox overlay */}
            {showToolbox && (
                <Suspense fallback={<div role="status" className="absolute bottom-20 left-3 rounded-lg bg-zinc-900 p-3 text-sm text-zinc-300">正在加载工具箱…</div>}>
                    <TestToolbox onClose={() => setShowToolbox(false)} />
                </Suspense>
            )}

            {/* Hook Editor overlay */}
            <HookEditor show={showHookEditor} onClose={() => setShowHookEditor(false)} />

            {/* Reaction Countdown */}
            <ReactionCountdown />

            {/* Tactical Decision Panel */}
            <TacticalDecisionPanel />

            {/* Main HUD content */}
            <div className="flex-1 flex flex-col justify-between p-3">
                {/* Top-left: Entity info */}
                <div className="flex justify-between">
                    <div className="flex flex-col gap-2">
                        <div className="bg-zinc-900/80 border border-zinc-800 p-3 rounded-lg pointer-events-auto backdrop-blur-sm min-w-56">
                            <h2 className="text-lg font-bold text-white mb-1">ElysianVTT</h2>
                            <div className="text-xs text-zinc-400">
                                Tick: <span className="text-amber-400 font-mono">{displayTick}</span>
                            </div>
                            <div className={`mt-2 inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${roleBadgeClass}`}>
                                <span>{permission.role}</span>
                                <span className="text-[9px] opacity-70">{permission.source}</span>
                            </div>

                            {selectedEntity ? (
                                <div className="mt-2 pt-2 border-t border-zinc-800">
                                    <div className="flex items-center justify-between gap-2 mb-1">
                                        <div className="font-bold text-zinc-200 text-sm">{selectedEntity.templateId}</div>
                                        <div className="flex items-center gap-2">
                                            {selectedEntity.currentActionContext && (
                                                <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                                                    {selectedEntity.currentActionContext.phase}
                                                </span>
                                            )}
                                            <div className="text-[9px] uppercase tracking-[0.2em] text-amber-400">
                                                Selected
                                            </div>
                                        </div>
                                    </div>
                                    {/* HP bar */}
                                    <div className="h-3 bg-zinc-950 rounded overflow-hidden flex relative">
                                        <div
                                            className="h-full bg-red-600 transition-all duration-300"
                                            style={{ width: `${resourcePercent(selectedEntity.resources.current.hp, selectedEntity.resources.max.hp)}%` }}
                                        />
                                        <div className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-white">
                                            {selectedEntity.resources.current.hp ?? 0} / {selectedEntity.resources.max.hp ?? 0}
                                        </div>
                                    </div>
                                    {/* Poise (PP) bar */}
                                    {selectedEntity.resources.current.poise !== undefined && (
                                        <div className="h-2 bg-zinc-950 rounded overflow-hidden flex relative mt-1">
                                            <div
                                                className="h-full bg-amber-600 transition-all duration-300"
                                                style={{ width: `${resourcePercent(selectedEntity.resources.current.poise, selectedEntity.resources.max.poise)}%` }}
                                            />
                                            <div className="absolute inset-0 flex items-center justify-center text-[8px] font-bold text-white">
                                                PP {selectedEntity.resources.current.poise ?? 0}/{selectedEntity.resources.max.poise ?? 0}
                                            </div>
                                        </div>
                                    )}
                                    {/* Focus (FP) bar */}
                                    {selectedEntity.resources.current.focus !== undefined && (
                                        <div className="h-2 bg-zinc-950 rounded overflow-hidden flex relative mt-1">
                                            <div
                                                className="h-full bg-sky-600 transition-all duration-300"
                                                style={{ width: `${resourcePercent(selectedEntity.resources.current.focus, selectedEntity.resources.max.focus)}%` }}
                                            />
                                            <div className="absolute inset-0 flex items-center justify-center text-[8px] font-bold text-white">
                                                FP {selectedEntity.resources.current.focus ?? 0}/{selectedEntity.resources.max.focus ?? 0}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="mt-2 pt-2 border-t border-zinc-800 text-xs text-zinc-500">
                                    Click entity to select
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="flex flex-col items-end gap-2">
                        <ViewEntitySelector />
                        <EntityList />
                    </div>
                </div>

                {uiState.mode === 'SELECT_ACTION_TARGET' && (
                    <div className="mx-auto rounded-xl border border-amber-500/50 bg-zinc-950/95 p-3 text-sm text-amber-200 pointer-events-auto">
                        点击画布或实体列表选择 {uiState.activeActionId} 的目标
                        <button className="ml-4 rounded bg-zinc-800 px-3 py-1 text-white" onClick={resetUiState}>取消选目标</button>
                    </div>
                )}
                {/* Middle: Move overlay */}
                {uiState.mode === 'SELECT_MOVE_TARGET' && (
                    <div className="flex-1 flex justify-center items-end pb-8">
                        <div className="bg-zinc-900/90 border border-amber-500/50 p-3 rounded-xl pointer-events-auto backdrop-blur-md flex items-center justify-between gap-4 shadow-lg shadow-amber-500/10">
                            <div className="text-zinc-200">
                                <h3 className="font-bold text-amber-400 text-sm">Select Move Target</h3>
                                <p className="text-xs">Click map to set path</p>
                            </div>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => resetUiState()}
                                    className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-medium transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleConfirmMove}
                                    disabled={!uiState.pendingMoveCoords}
                                    className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors"
                                >
                                    Confirm
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Bottom Tools */}
                <div className="flex justify-between items-end pb-2">
                    {/* Test Toolbox toggle */}
                    <div className="pointer-events-auto">
                        <button
                            onClick={() => setShowToolbox(!showToolbox)}
                            className={`flex items-center justify-center p-3 rounded-full transition-all shadow-lg ${
                                showToolbox
                                ? 'bg-rose-600 text-white shadow-rose-600/30'
                                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                            }`}
                            title="测试工具箱"
                            aria-label="测试工具箱"
                            aria-expanded={showToolbox}
                        >
                            {/* Wrench icon */}
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                            </svg>
                        </button>
                    </div>

                    {/* Action buttons (extracted to ActionBar) */}
                    <ActionBar
                        selectedEntity={selectedEntity}
                        canAct={canAct}
                        uiState={uiState}
                        onOpenHookEditor={() => setShowHookEditor(true)}
                    />

                    {/* Right side: Priority toggles + Camera */}
                    <div className="flex items-end gap-2">
                        <PriorityToggles />
                        <CameraControl />
                    </div>
                </div>
            </div>
        </div>
    );
};

/** 探索模式视角实体选择器 — 切换以哪个实体的视野渲染战争迷雾 */
const ViewEntitySelector: React.FC = () => {
    const exploreMode = useExploreStore(s => s.exploreMode);
    const exploreEntities = useExploreStore(s => s.exploreEntities);
    const viewingEntityId = useExploreStore(s => s.viewingEntityId);
    const permission = useGameStore(s => s.permission);
    const isGM = permission.role === 'GM';
    const { setViewingEntityId } = useExploreStore.getState();

    if (!exploreMode) return null;

    const entities = Object.values(exploreEntities);

    return (
        <div className="bg-zinc-900/80 border border-zinc-800 p-2 rounded-lg pointer-events-auto backdrop-blur-sm">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">视角</div>
            <div className="flex gap-1 flex-wrap">
                {/* GM 可取消选择 → 全图无迷雾 */}
                {isGM && (
                    <button
                        onClick={() => setViewingEntityId(null)}
                        className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                            !viewingEntityId
                                ? 'bg-emerald-600 text-white'
                                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                        }`}
                        title="GM 全局视野（无迷雾）"
                    >
                        全图
                    </button>
                )}
                {entities.map(e => (
                    <button
                        key={e.id}
                        onClick={() => setViewingEntityId(e.id)}
                        className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                            viewingEntityId === e.id
                                ? 'bg-sky-600 text-white'
                                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                        }`}
                        title={`以 ${e.templateId ?? e.id} 的视角查看`}
                    >
                        {e.templateId ?? e.id.slice(0, 6)}
                    </button>
                ))}
            </div>
        </div>
    );
};

const CameraControl: React.FC = () => {
    const cameraMode = useGameStore(state => state.cameraMode);
    const { setCameraMode } = useGameStore.getState();

    return (
        <div className="pointer-events-auto">
            <button
                onClick={() => setCameraMode(!cameraMode)}
                className={`flex items-center justify-center p-3 rounded-full transition-all shadow-lg ${
                    cameraMode 
                    ? 'bg-amber-600 text-white shadow-amber-600/30' 
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                }`}
                title={cameraMode ? 'Exit Camera Mode' : 'Enter Camera Mode'}
                aria-label="相机模式"
                aria-pressed={cameraMode}
            >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                    <line x1="12" y1="22.08" x2="12" y2="12"></line>
                </svg>
            </button>
        </div>
    );
};
