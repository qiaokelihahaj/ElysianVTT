import React, { useState, useEffect } from 'react';
import { useGameStore } from '../store/gameStore';
import { IntentDispatcher } from '../network/IntentDispatcher';

export const HUD: React.FC = () => {
    // For now, we just subscribe to the first actor's component as an example
    const entities = useGameStore(state => state.entities);
    const tick = useGameStore(state => state.tick);
    
    // Find first ACTOR representing player
    const hero = Object.values(entities).find(e => e.type === 'ACTOR');

    // Chaos Mode State
    const [isChaos, setIsChaos] = useState(false);

    useEffect(() => {
        if (!isChaos) return;

        // Spawn mock enemies once when chaos starts if they don't exist
        const store = useGameStore.getState();
        const currentCount = Object.keys(store.entities).length;
        if (currentCount < 5) {
            for(let i = 0; i < 5 - currentCount; i++) {
                store.addEntity({
                    id: `enemy-mock-${Math.random()}`,
                    templateId: 'goblin',
                    type: 'ACTOR',
                    transform: {
                        coords: { x: Math.random() * window.innerWidth, y: Math.random() * window.innerHeight, z: 0 },
                        facing: Math.random() * 360,
                        planeId: 'ground'
                    },
                    physics: { scaleClass: 1, collisionRadius: 15, mass: 50, movementModes: ['WALK'] },
                    resources: { current: { hp: 50 }, max: { hp: 50 } },
                    activeEffects: []
                });
            }
        }

        // Simulate continuous backend ticks streaming in
        // Updating all entities simultaneously and across massive distances!
        const interval = setInterval(() => {
            const currentState = useGameStore.getState();
            const mutations = Object.values(currentState.entities).map(ent => {
                const hpChange = Math.floor(Math.random() * 21 - 10); // -10 to +10

                // Trigger a mock VISUAL_FX floating text matching the HP change
                if (hpChange !== 0) {
                    import('../canvas/RendererManager').then(({ RendererManager }) => {
                        const evtType = hpChange < 0 ? 'damage' : 'heal';
                        const textStr = hpChange < 0 ? `${hpChange}` : `+${hpChange}`;

                        RendererManager.getInstance().handleVisualFx({
                            tick: currentState.tick + 15,
                            events: [
                                {
                                    eventId: `mock-fx-${Date.now()}-${ent.id}`,
                                    eventType: 'UI_FLOATING_TEXT',
                                    sourceId: ent.id,
                                    targetId: ent.id,
                                    fxTemplateId: evtType,
                                    text: textStr,
                                    durationMs: 1500
                                }
                            ]
                        });
                    });
                }

                return {
                    entityId: ent.id,
                    changes: {
                        // Huge distance jumps simulating continuous multi-turn/tick movement
                        "transform.coords.x": Math.max(50, Math.min(window.innerWidth - 50, ent.transform.coords.x + (Math.random() * 400 - 200))),
                        "transform.coords.y": Math.max(50, Math.min(window.innerHeight - 50, ent.transform.coords.y + (Math.random() * 400 - 200))),
                        "transform.facing": Math.random() * 360,
                        // Simulate combat damage ticks modifying UI resources simultaneously
                        "resources.current.hp": Math.max(1, Math.min(ent.resources.max?.hp || 100, ent.resources.current.hp + hpChange))
                    }
                };
            });

            currentState.applyStateMutation({
                tick: currentState.tick + 15,
                mutations
            });
        }, 800); // Trigger a massive state diff every 800ms

        return () => clearInterval(interval);
    }, [isChaos]);

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
                    <button 
                        onClick={() => hero && IntentDispatcher.dispatchCastAction(hero.id, 'heroic_strike')}
                        className="w-12 h-12 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 transition-colors flex items-center justify-center text-white font-bold group relative"
                    >
                        1
                        <span className="absolute -top-8 bg-black/80 px-2 py-1 rounded text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap">Heroic Strike</span>
                    </button>
                    <button 
                        onClick={() => hero && IntentDispatcher.dispatchMove(hero.id, { x: hero.transform.coords.x + 50, y: hero.transform.coords.y, z: 0 })}
                        className="w-12 h-12 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 transition-colors flex items-center justify-center text-white font-bold group relative"
                    >
                        2
                        <span className="absolute -top-8 bg-black/80 px-2 py-1 rounded text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap">Move +50x</span>
                    </button>
                    <button 
                        onClick={() => hero && IntentDispatcher.dispatchInteract(hero.id, 'mock-chest-id')}
                        className="w-12 h-12 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 transition-colors flex items-center justify-center text-white font-bold group relative"
                    >
                        3
                        <span className="absolute -top-8 bg-black/80 px-2 py-1 rounded text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap">Interact</span>
                    </button>
                    {/* Mock move button for testing interpolation */}
                    <button 
                        onClick={() => {
                            if (!hero) return;
                            useGameStore.getState().applyStateMutation({
                                tick: tick + 20,
                                mutations: [{
                                    entityId: hero.id,
                                    changes: {
                                        "transform.coords.x": hero.transform.coords.x + (Math.random() * 100 - 50),
                                        "transform.coords.y": hero.transform.coords.y + (Math.random() * 100 - 50),
                                        "transform.facing": Math.random() * 360
                                    }
                                }]
                            });
                        }}
                        className="w-12 h-12 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 transition-colors flex items-center justify-center text-white font-bold group relative ml-4"
                    >
                        ?
                        <span className="absolute -top-8 bg-black/80 px-2 py-1 rounded text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap">Test Random Move</span>
                    </button>
                    {/* Chaos simulation mode */}
                    <button 
                        onClick={() => setIsChaos(prev => !prev)}
                        className={`w-12 h-12 rounded-lg ${isChaos ? 'bg-red-600 border-red-400' : 'bg-zinc-800 border-zinc-600 hover:bg-zinc-700'} transition-colors flex items-center justify-center text-white font-bold group relative ml-2`}
                    >
                        🔥
                        <span className="absolute -top-8 bg-black/80 px-2 py-1 rounded text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap">Toggle Chaos Mode</span>
                    </button>
                </div>
            </div>
        </div>
    );
};
