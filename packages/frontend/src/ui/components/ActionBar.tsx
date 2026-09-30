import React from 'react';
import { useGameStore, type UiState } from '../../store/gameStore';
import { IntentDispatcher } from '../../network/IntentDispatcher';
import type { Entity } from '@hard-vtt/shared';

interface Props {
    selectedEntity: Entity | null;
    canAct: boolean;
    uiState: UiState;
    onOpenHookEditor: () => void;
}

export const ActionBar: React.FC<Props> = ({ selectedEntity, canAct, uiState, onOpenHookEditor }) => {
    const setUiMode = useGameStore(state => state.setUiMode);
    const setActiveActionId = useGameStore(state => state.setActiveActionId);
    const selectTarget = (actionId: string) => {
        if (!selectedEntity || !canAct) return;
        setActiveActionId(actionId);
        setUiMode('SELECT_ACTION_TARGET');
    };

    return (
        <div className="flex items-center gap-2">
            <div className={`bg-zinc-900/90 border border-zinc-700 p-1.5 rounded-xl pointer-events-auto backdrop-blur-md flex gap-1.5 ${uiState.mode !== 'IDLE' ? 'opacity-30 pointer-events-none' : ''}`}>
                <button
                    onClick={() => selectTarget('HEAVY_STRIKE')}
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
                    onClick={() => selectedEntity && IntentDispatcher.dispatchRotate(selectedEntity.id, -60)}
                    disabled={!canAct}
                    className="w-10 h-10 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 transition-colors flex items-center justify-center text-zinc-400 text-sm font-bold group relative disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Rotate Left 60°"
                >
                    ↺
                    <span className="absolute -top-7 bg-black/80 px-2 py-0.5 rounded text-[10px] opacity-0 group-hover:opacity-100 whitespace-nowrap text-white">Rotate ↺</span>
                </button>
                <button
                    onClick={() => selectedEntity && IntentDispatcher.dispatchRotate(selectedEntity.id, 60)}
                    disabled={!canAct}
                    className="w-10 h-10 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 transition-colors flex items-center justify-center text-zinc-400 text-sm font-bold group relative disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Rotate Right 60°"
                >
                    ↻
                    <span className="absolute -top-7 bg-black/80 px-2 py-0.5 rounded text-[10px] opacity-0 group-hover:opacity-100 whitespace-nowrap text-white">Rotate ↻</span>
                </button>
                <button
                    onClick={() => selectTarget('FIRE_STORM')}
                    disabled={!canAct}
                    className="w-10 h-10 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 transition-colors flex items-center justify-center text-orange-400 text-sm font-bold group relative disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Fire Storm"
                >
                    3
                    <span className="absolute -top-7 bg-black/80 px-2 py-0.5 rounded text-[10px] opacity-0 group-hover:opacity-100 whitespace-nowrap text-white">Fire Storm</span>
                </button>
                {selectedEntity?.currentActionContext && (
                    <button
                        onClick={() => IntentDispatcher.dispatchCancelAction(selectedEntity.id)}
                        className="w-10 h-10 rounded-lg bg-red-900/50 hover:bg-red-800/70 border border-red-500/50 transition-colors flex items-center justify-center text-red-400 text-sm font-bold group relative"
                        title="Cancel current action"
                    >
                        ✕
                        <span className="absolute -top-7 bg-black/80 px-2 py-0.5 rounded text-[10px] opacity-0 group-hover:opacity-100 whitespace-nowrap text-white">Cancel</span>
                    </button>
                )}
            </div>
            <button
                onClick={onOpenHookEditor}
                className="w-10 h-10 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 transition-colors flex items-center justify-center text-zinc-400 hover:text-zinc-200 text-sm group relative pointer-events-auto"
                title="Event Hooks"
            >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6z" />
                    <path d="M12 2v4" />
                    <path d="M12 18v4" />
                    <path d="M8 14h.01" />
                    <path d="M16 14h.01" />
                    <path d="M12 10h.01" />
                    <path d="M8 18h.01" />
                    <path d="M16 18h.01" />
                </svg>
            </button>
        </div>
    );
};
