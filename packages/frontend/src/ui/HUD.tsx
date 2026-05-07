import React, { useState, useEffect } from 'react';
import { useGameStore } from '../store/gameStore';
import { IntentDispatcher } from '../network/IntentDispatcher';
import { TickMeter } from './components/TickMeter';
import { EntityList } from './components/EntityList';
import { TestToolbox } from './TestToolbox';
import { ActionBar } from './components/ActionBar';
import { ReactionCountdown } from './components/ReactionCountdown';
import { TacticalDecisionPanel } from './components/TacticalDecisionPanel';
import { PriorityToggles } from './components/PriorityToggles';
import { HookEditor } from './components/HookEditor';

export const HUD: React.FC = () => {
    const entities = useGameStore(state => state.entities);
    const tick = useGameStore(state => state.tick);
    const selectedEntityId = useGameStore(state => state.selectedEntityId);
    const uiState = useGameStore(state => state.uiState);
    const permission = useGameStore(state => state.permission);
    const activeWindow = useGameStore(state => state.tactical.activeWindow);
    const reactionTriggered = useGameStore(state => state.tactical.reactionTriggered);
    const triggerReaction = useGameStore(state => state.triggerReaction);
    const resetReaction = useGameStore(state => state.resetReaction);
    const { setUiMode, resetUiState } = useGameStore.getState();

    const selectedEntity = selectedEntityId ? entities[selectedEntityId] : null;
    const canAct = permission.role !== 'OB' && (
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
            if (e.code === 'Space') {
                // Don't trigger if typing in an input
                if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
                e.preventDefault();
                if (activeWindow && !reactionTriggered) {
                    triggerReaction();
                }
            }
            if (e.code === 'Escape') {
                if (reactionTriggered) {
                    resetReaction();
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activeWindow, reactionTriggered, triggerReaction, resetReaction]);

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

            {/* Test Toolbox overlay */}
            {showToolbox && <TestToolbox onClose={() => setShowToolbox(false)} />}

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
                                Tick: <span className="text-amber-400 font-mono">{tick}</span>
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
                                            style={{ width: `${((selectedEntity.resources.current.hp || 0) / (selectedEntity.resources.max.hp || 1)) * 100}%` }}
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
                                                style={{ width: `${((selectedEntity.resources.current.poise || 0) / (selectedEntity.resources.max.poise || 1)) * 100}%` }}
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
                                                style={{ width: `${((selectedEntity.resources.current.focus || 0) / (selectedEntity.resources.max.focus || 1)) * 100}%` }}
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
                        <EntityList />
                    </div>
                </div>

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