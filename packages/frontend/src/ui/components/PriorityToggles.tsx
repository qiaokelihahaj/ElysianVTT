import React from 'react';
import { useGameStore, type PlayerToggleMode } from '../../store/gameStore';

const MODES: { value: PlayerToggleMode; icon: string; label: string }[] = [
    { value: 'PASS_ALL', icon: '○', label: '全自动跳过' },
    { value: 'TARGET_ONLY', icon: '●', label: '仅受击响应' },
    { value: 'FULL_CONTROL', icon: '◎', label: '全盘监控' },
];

export const PriorityToggles: React.FC = () => {
    const playerToggle = useGameStore(state => state.tactical.playerToggle);
    const setPlayerToggle = useGameStore(state => state.setPlayerToggle);

    return (
        <div className="bg-zinc-900/80 border border-zinc-700 rounded-lg p-2 pointer-events-auto backdrop-blur-sm">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">响应模式</div>
            <div className="flex flex-col gap-0.5">
                {MODES.map(mode => {
                    const isActive = playerToggle === mode.value;
                    return (
                        <button
                            key={mode.value}
                            onClick={() => setPlayerToggle(mode.value)}
                            className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors text-left ${
                                isActive
                                    ? 'bg-amber-600/20 text-amber-400'
                                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
                            }`}
                        >
                            <span className="text-sm">{mode.icon}</span>
                            <span>{mode.label}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
};
