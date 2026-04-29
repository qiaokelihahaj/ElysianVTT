import React from 'react';
import { useGameStore } from '../store/gameStore';

export const HUD: React.FC = () => {
    // For now, we just subscribe to the first actor's component as an example
    const entities = useGameStore(state => state.entities);
    const tick = useGameStore(state => state.tick);
    
    // Find first ACTOR representing player
    const hero = Object.values(entities).find(e => e.type === 'ACTOR');

    return (
        <div className="absolute inset-0 pointer-events-none flex flex-col justify-between p-4">
            {/* Top Bar: Game Info and Hero Status */}
            <div className="flex justify-between">
                <div className="flex flex-col gap-2">
                    <div className="bg-zinc-900/80 border border-zinc-800 p-4 rounded-lg pointer-events-auto backdrop-blur-sm min-w-64">
                        <h2 className="text-xl font-bold text-white mb-2">ElysianVTT</h2>
                        <div className="text-sm text-zinc-400">Current Tick: <span className="text-amber-400 font-mono">{tick}</span></div>
                        
                        {hero && (
                            <div className="mt-4 pt-4 border-t border-zinc-800">
                                <div className="font-bold text-zinc-200 mb-1">{hero.templateId}</div>
                                <div className="h-4 bg-zinc-950 rounded overflow-hidden flex relative">
                                    <div 
                                        className="h-full bg-red-600 transition-all duration-300"
                                        style={{ width: `${(hero.resources.current.hp / hero.resources.max.hp) * 100}%` }}
                                    />
                                    <div className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white shadow-sm">
                                        {hero.resources.current.hp} / {hero.resources.max.hp} HP
                                    </div>
                                </div>
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

            {/* Bottom Bar: Action bar */}
            <div className="flex justify-center pb-4">
                <div className="bg-zinc-900/90 border border-zinc-700 p-2 rounded-xl pointer-events-auto backdrop-blur-md flex gap-2">
                    <button className="w-12 h-12 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 transition-colors flex items-center justify-center text-white font-bold group relative">
                        1
                        <span className="absolute -top-8 bg-black/80 px-2 py-1 rounded text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap">Heroic Strike</span>
                    </button>
                    <button className="w-12 h-12 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 transition-colors flex items-center justify-center text-white font-bold group relative">
                        2
                        <span className="absolute -top-8 bg-black/80 px-2 py-1 rounded text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap">Move</span>
                    </button>
                    <button className="w-12 h-12 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 transition-colors flex items-center justify-center text-white font-bold group relative">
                        3
                        <span className="absolute -top-8 bg-black/80 px-2 py-1 rounded text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap">Pass</span>
                    </button>
                </div>
            </div>
        </div>
    );
};
