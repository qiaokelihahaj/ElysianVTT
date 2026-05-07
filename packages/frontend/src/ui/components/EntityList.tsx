import React, { useState } from 'react';
import { useGameStore } from '../../store/gameStore';
import { RendererManager } from '../../canvas/RendererManager';
import type { Entity } from '@hard-vtt/shared';

export const EntityList: React.FC = () => {
    const entities = useGameStore(state => state.entities);
    const selectedEntityId = useGameStore(state => state.selectedEntityId);
    const setSelectedEntityId = useGameStore(state => state.setSelectedEntityId);
    const centerOnEntity = useGameStore(state => state.centerOnEntity);
    const setCenterOnEntity = useGameStore(state => state.setCenterOnEntity);
    const [isCollapsed, setIsCollapsed] = useState(false);

    // 分类实体
    const actors = Object.values(entities).filter(e => e.type === 'ACTOR');
    const projectiles = Object.values(entities).filter(e => e.type === 'PROJECTILE');

    const renderEntityItem = (entity: Entity, isSelected: boolean) => {
        const hpPercent = ((entity.resources.current.hp || 0) / (entity.resources.max.hp || 1)) * 100;
        const hpColor = hpPercent > 50 ? 'bg-green-600' : hpPercent > 25 ? 'bg-yellow-600' : 'bg-red-600';

        return (
            <button
                key={entity.id}
                onClick={() => {
                    setSelectedEntityId(entity.id);
                    if (centerOnEntity) {
                        RendererManager.getInstance().centerOnEntity(entity.id);
                    }
                }}
                className={`w-full text-left p-2 rounded transition-all ${
                    isSelected
                        ? 'bg-amber-900/60 border border-amber-500/50'
                        : 'bg-zinc-800/40 border border-zinc-700/50 hover:bg-zinc-800/60'
                }`}
            >
                <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="font-bold text-xs text-zinc-200 truncate flex-1">
                        {entity.templateId}
                    </div>
                    <div className="text-[10px] text-zinc-500">{entity.id.slice(0, 6)}</div>
                </div>

                {/* HP Bar */}
                <div className="h-3 bg-zinc-950/60 rounded overflow-hidden flex relative">
                    <div
                        className={`h-full ${hpColor} transition-all duration-200`}
                        style={{ width: `${hpPercent}%` }}
                    />
                    <div className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-white opacity-75">
                        {entity.resources.current.hp ?? 0}/{entity.resources.max.hp ?? 0}
                    </div>
                </div>

                {/* Position */}
                <div className="text-[9px] text-zinc-500 mt-1">
                    ({entity.transform.coords.x.toFixed(1)}, {entity.transform.coords.y.toFixed(1)}, {entity.transform.coords.z.toFixed(1)})
                </div>
            </button>
        );
    };

    if (isCollapsed) {
        return (
            <button
                onClick={() => setIsCollapsed(false)}
                className="bg-zinc-900/80 border border-zinc-800 px-3 py-2 rounded-lg pointer-events-auto backdrop-blur-sm hover:border-zinc-700 transition-colors"
                title="Expand entity list"
            >
                <div className="text-xs font-bold text-zinc-400">
                    {actors.length + projectiles.length} entities
                </div>
            </button>
        );
    }

    return (
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-lg pointer-events-auto backdrop-blur-sm overflow-hidden max-w-72">
            {/* Header */}
            <div className="flex items-center justify-between p-3 border-b border-zinc-800 bg-zinc-950/60">
                <h3 className="text-sm font-bold text-zinc-300">
                    Scene Entities
                </h3>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setCenterOnEntity(!centerOnEntity)}
                        className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                            centerOnEntity
                                ? 'bg-amber-600/20 border-amber-500/50 text-amber-400'
                                : 'bg-zinc-800/40 border-zinc-700/50 text-zinc-500 hover:text-zinc-300'
                        }`}
                        title={centerOnEntity ? 'Center on click: ON' : 'Center on click: OFF'}
                    >
                        <span className="mr-1">{centerOnEntity ? '●' : '○'}</span>
                        Focus
                    </button>
                    <button
                        onClick={() => setIsCollapsed(true)}
                        className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                        title="Collapse"
                    >
                        −
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="max-h-96 overflow-y-auto">
                {/* Actors Section */}
                {actors.length > 0 && (
                    <div className="p-2">
                        <div className="text-xs font-bold text-amber-400 mb-2 px-1">
                            ACTORS ({actors.length})
                        </div>
                        <div className="space-y-1">
                            {actors.map(actor =>
                                renderEntityItem(actor, actor.id === selectedEntityId)
                            )}
                        </div>
                    </div>
                )}

                {/* Projectiles Section */}
                {projectiles.length > 0 && (
                    <div className="p-2 border-t border-zinc-800/50">
                        <div className="text-xs font-bold text-cyan-400 mb-2 px-1">
                            PROJECTILES ({projectiles.length})
                        </div>
                        <div className="space-y-1">
                            {projectiles.map(projectile =>
                                renderEntityItem(projectile, projectile.id === selectedEntityId)
                            )}
                        </div>
                    </div>
                )}

                {/* Empty State */}
                {actors.length === 0 && projectiles.length === 0 && (
                    <div className="p-4 text-center text-xs text-zinc-500">
                        No entities in scene
                    </div>
                )}
            </div>
        </div>
    );
};
