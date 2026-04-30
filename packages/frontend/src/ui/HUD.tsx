import React from 'react';
import { useGameStore } from '../store/gameStore';
import { IntentDispatcher } from '../network/IntentDispatcher';

export const HUD: React.FC = () => {
    // For now, we just subscribe to the first actor's component as an example
    const entities = useGameStore(state => state.entities);
    const tick = useGameStore(state => state.tick);
    const selectedEntityId = useGameStore(state => state.selectedEntityId);
    const uiState = useGameStore(state => state.uiState);
    const { setUiMode, resetUiState } = useGameStore.getState();
    
    const selectedEntity = selectedEntityId ? entities[selectedEntityId] : null;

    const handleConfirmMove = () => {
        if (selectedEntity && uiState.pendingMoveCoords) {
            IntentDispatcher.dispatchMove(selectedEntity.id, uiState.pendingMoveCoords);
            // 盲区推测：通知渲染器直接向目标点平滑动画
            useGameStore.getState().setMovementTarget(selectedEntity.id, uiState.pendingMoveCoords);
            resetUiState();
        }
    };

    return (
        <div className="absolute inset-0 pointer-events-none flex flex-col justify-between p-4">
            {/* Top Bar: Game Info and Hero Status */}
            <div className="flex justify-between">
                <div className="flex flex-col gap-2">
                    <div className="bg-zinc-900/80 border border-zinc-800 p-4 rounded-lg pointer-events-auto backdrop-blur-sm min-w-64">
                        <h2 className="text-xl font-bold text-white mb-2">ElysianVTT</h2>
                        <div className="text-sm text-zinc-400">Current Tick: <span className="text-amber-400 font-mono">{tick}</span></div>
                        
                        {selectedEntity ? (
                            <div className="mt-4 pt-4 border-t border-zinc-800">
                                <div className="flex items-center justify-between gap-2 mb-1">
                                    <div className="font-bold text-zinc-200">{selectedEntity.templateId}</div>
                                    <div className="text-[10px] uppercase tracking-[0.2em] text-amber-400">
                                        Selected
                                    </div>
                                </div>
                                <div className="h-4 bg-zinc-950 rounded overflow-hidden flex relative">
                                    <div 
                                        className="h-full bg-red-600 transition-all duration-300"
                                        style={{ width: `${((selectedEntity.resources.current.hp || 0) / (selectedEntity.resources.max.hp || 1)) * 100}%` }}
                                    />
                                    <div className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white shadow-sm">
                                        {selectedEntity.resources.current.hp ?? 0} / {selectedEntity.resources.max.hp ?? 0} HP
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="mt-4 pt-4 border-t border-zinc-800 text-sm text-zinc-500">
                                No target selected
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex flex-col items-end gap-2">
                    <div className="bg-zinc-900/80 border border-zinc-800 py-2 px-4 rounded-lg pointer-events-auto text-sm text-zinc-300">
                        Status: Connected
                    </div>
                </div>
            </div>

            {/* Middle: Overlay Modals when active */}
            {uiState.mode === 'SELECT_MOVE_TARGET' && (
                <div className="flex-1 flex justify-center items-end pb-8">
                    <div className="bg-zinc-900/90 border border-amber-500/50 p-4 rounded-xl pointer-events-auto backdrop-blur-md flex items-center justify-between gap-6 shadow-lg shadow-amber-500/10">
                        <div className="text-zinc-200">
                            <h3 className="font-bold text-amber-400">Select Move Target</h3>
                            <p className="text-sm">Click on the map to set a path, then confirm.</p>
                        </div>
                        <div className="flex gap-2">
                            <button 
                                onClick={() => resetUiState()}
                                className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-white font-medium transition-colors"
                            >
                                Cancel
                            </button>
                            <button 
                                onClick={handleConfirmMove}
                                disabled={!uiState.pendingMoveCoords}
                                className="px-4 py-2 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium transition-colors"
                            >
                                Confirm Move
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Bottom Bar: Action bar */}
            <div className={`flex justify-center pb-4 ${uiState.mode !== 'IDLE' ? 'opacity-30 pointer-events-none' : ''}`}>
                <div className="bg-zinc-900/90 border border-zinc-700 p-2 rounded-xl pointer-events-auto backdrop-blur-md flex gap-2">
                    <button 
                        onClick={() => selectedEntity && IntentDispatcher.dispatchCastAction(selectedEntity.id, 'heroic_strike')}
                        className="w-12 h-12 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 transition-colors flex items-center justify-center text-white font-bold group relative"
                    >
                        1
                        <span className="absolute -top-8 bg-black/80 px-2 py-1 rounded text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap">Heroic Strike</span>
                    </button>
                    <button 
                        onClick={() => selectedEntity && setUiMode('SELECT_MOVE_TARGET')}
                        className="w-12 h-12 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-amber-600/50 transition-colors flex items-center justify-center text-amber-400 font-bold group relative shadow-inner"
                    >
                        2
                        <span className="absolute -top-8 bg-black/80 px-2 py-1 rounded text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap text-white">Toggle Move Mode</span>
                    </button>
                    <button 
                        onClick={() => selectedEntity && IntentDispatcher.dispatchInteract(selectedEntity.id, 'mock-chest-id')}
                        className="w-12 h-12 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 transition-colors flex items-center justify-center text-white font-bold group relative"
                    >
                        3
                        <span className="absolute -top-8 bg-black/80 px-2 py-1 rounded text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap">Interact</span>
                    </button>
                </div>
            </div>
        </div>
    );
};
