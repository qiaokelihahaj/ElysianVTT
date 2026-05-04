import React from 'react';
import { useGameStore } from '../store/gameStore';
import { IntentDispatcher } from '../network/IntentDispatcher';
import { TickMeter } from './components/TickMeter';
import { EntityList } from './components/EntityList';

export const HUD: React.FC = () => {
    const entities = useGameStore(state => state.entities);
    const tick = useGameStore(state => state.tick);
    const selectedEntityId = useGameStore(state => state.selectedEntityId);
    const uiState = useGameStore(state => state.uiState);
    const permission = useGameStore(state => state.permission);
    const { setUiMode, resetUiState } = useGameStore.getState();
    
    const selectedEntity = selectedEntityId ? entities[selectedEntityId] : null;
    const canAct = permission.role !== 'OB';
    const roleBadgeClass = permission.role === 'GM'
        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
        : permission.role === 'PL'
            ? 'bg-sky-500/15 text-sky-300 border-sky-500/30'
            : 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30';

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
                                        <div className="text-[9px] uppercase tracking-[0.2em] text-amber-400">
                                            Selected
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

                {/* Bottom: Action buttons */}
                <div className={`flex justify-center pb-2 ${uiState.mode !== 'IDLE' ? 'opacity-30 pointer-events-none' : ''}`}>
                    <div className="bg-zinc-900/90 border border-zinc-700 p-1.5 rounded-xl pointer-events-auto backdrop-blur-md flex gap-1.5">
                        <button 
                            onClick={() => selectedEntity && IntentDispatcher.dispatchCastAction(selectedEntity.id, 'HEAVY_STRIKE')}
                            disabled={!canAct}
                            className="w-10 h-10 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 transition-colors flex items-center justify-center text-white text-sm font-bold group relative disabled:opacity-30 disabled:cursor-not-allowed"
                            title="Heavy Strike"
                        >
                            1
                            <span className="absolute -top-7 bg-black/80 px-2 py-0.5 rounded text-[10px] opacity-0 group-hover:opacity-100 whitespace-nowrap">Heavy Strike</span>
                        </button>
                        <button 
                            onClick={() => selectedEntity && setUiMode('SELECT_MOVE_TARGET')}
                            disabled={!canAct}
                            className="w-10 h-10 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-amber-600/50 transition-colors flex items-center justify-center text-amber-400 text-sm font-bold group relative disabled:opacity-30 disabled:cursor-not-allowed"
                            title="Move"
                        >
                            2
                            <span className="absolute -top-7 bg-black/80 px-2 py-0.5 rounded text-[10px] opacity-0 group-hover:opacity-100 whitespace-nowrap text-white">Move</span>
                        </button>
                        <button 
                            onClick={() => selectedEntity && IntentDispatcher.dispatchCastAction(selectedEntity.id, 'FIRE_STORM')}
                            disabled={!canAct}
                            className="w-10 h-10 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 transition-colors flex items-center justify-center text-orange-400 text-sm font-bold group relative disabled:opacity-30 disabled:cursor-not-allowed"
                            title="Fire Storm"
                        >
                            3
                            <span className="absolute -top-7 bg-black/80 px-2 py-0.5 rounded text-[10px] opacity-0 group-hover:opacity-100 whitespace-nowrap text-white">Fire Storm</span>
                        </button>
                        <button 
                            onClick={() => {
                                if (!canAct || permission.role !== 'GM') return;
                                const allActors = Object.entries(entities).filter(([_, e]) => e.type === 'ACTOR');
                                const allIds = allActors.map(([id]) => id);
                                allActors.forEach(([actorId]) => {
                                    IntentDispatcher.dispatchCastAction(actorId, 'SYNC_TEST', allIds.filter(id => id !== actorId));
                                });
                            }}
                            disabled={permission.role !== 'GM'}
                            className="w-10 h-10 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-purple-500/30 transition-colors flex items-center justify-center text-purple-400 text-sm font-bold group relative disabled:opacity-30 disabled:cursor-not-allowed"
                            title="All actors cast SYNC_TEST simultaneously"
                        >
                            S
                            <span className="absolute -top-7 bg-black/80 px-2 py-0.5 rounded text-[10px] opacity-0 group-hover:opacity-100 whitespace-nowrap text-white">Sync Test (All)</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};