import { memo, useState } from 'react';
import { useGameStore } from '../../store/gameStore';
import { RendererManager } from '../../canvas/RendererManager';
import type { Entity } from '@hard-vtt/shared';
import { resourcePercent } from '../../utils/resourceDisplay';
import { IntentDispatcher } from '../../network/IntentDispatcher';

const EntityItem = memo(function EntityItem({ entity, isSelected, centerOnEntity, setSelectedEntityId }: {
    entity: Entity;
    isSelected: boolean;
    centerOnEntity: boolean;
    setSelectedEntityId: (id: string) => void;
}) {
    const hpPercent = resourcePercent(entity.resources.current.hp, entity.resources.max.hp);
    const hpColor = hpPercent > 50 ? 'bg-green-600' : hpPercent > 25 ? 'bg-yellow-600' : 'bg-red-600';

    return (
        <button
            type="button"
            aria-pressed={isSelected}
            onClick={() => {
                setSelectedEntityId(entity.id);
                if (centerOnEntity) {
                    RendererManager.getInstance().centerOnEntity(entity.id);
                }
            }}
            className={`w-full text-left p-2 rounded transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
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
});

export const EntityList = memo(function EntityList() {
    const entities = useGameStore(state => state.entities);
    const selectedEntityId = useGameStore(state => state.selectedEntityId);
    const setSelectedEntityId = IntentDispatcher.selectEntityOrTarget;
    const centerOnEntity = useGameStore(state => state.centerOnEntity);
    const setCenterOnEntity = useGameStore(state => state.setCenterOnEntity);
    const [isCollapsed, setIsCollapsed] = useState(false);

    // 分类实体
    const actors = Object.values(entities).filter(e => e.type === 'ACTOR');
    const projectiles = Object.values(entities).filter(e => e.type === 'PROJECTILE');

    if (isCollapsed) {
        return (
            <button
                onClick={() => setIsCollapsed(false)}
                className="bg-zinc-900/80 border border-zinc-800 px-3 py-2 rounded-lg pointer-events-auto backdrop-blur-sm hover:border-zinc-700 transition-colors"
                title="展开实体列表"
                aria-expanded={false}
            >
                <div className="text-xs font-bold text-zinc-400">
                    {actors.length + projectiles.length} 个实体
                </div>
            </button>
        );
    }

    return (
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-lg pointer-events-auto backdrop-blur-sm overflow-hidden max-w-72">
            {/* Header */}
            <div className="flex items-center justify-between p-3 border-b border-zinc-800 bg-zinc-950/60">
                <h3 className="text-sm font-bold text-zinc-300">
                    场景实体
                </h3>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setCenterOnEntity(!centerOnEntity)}
                        className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                            centerOnEntity
                                ? 'bg-amber-600/20 border-amber-500/50 text-amber-400'
                                : 'bg-zinc-800/40 border-zinc-700/50 text-zinc-500 hover:text-zinc-300'
                        }`}
                        title={centerOnEntity ? '点击后居中：已开启' : '点击后居中：已关闭'}
                        aria-pressed={centerOnEntity}
                    >
                        <span className="mr-1">{centerOnEntity ? '●' : '○'}</span>
                        Focus
                    </button>
                    <button
                        onClick={() => setIsCollapsed(true)}
                        className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                        title="收起实体列表"
                        aria-label="收起实体列表"
                        aria-expanded={true}
                    >
                        −
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="max-h-[min(24rem,45dvh)] overflow-y-auto overscroll-contain">
                {/* Actors Section */}
                {actors.length > 0 && (
                    <div className="p-2">
                        <div className="text-xs font-bold text-amber-400 mb-2 px-1">
                            ACTORS ({actors.length})
                        </div>
                        <div className="space-y-1">
                            {actors.map(actor =>
                                <EntityItem key={actor.id} entity={actor} isSelected={actor.id === selectedEntityId}
                                    centerOnEntity={centerOnEntity} setSelectedEntityId={setSelectedEntityId} />
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
                                <EntityItem key={projectile.id} entity={projectile} isSelected={projectile.id === selectedEntityId}
                                    centerOnEntity={centerOnEntity} setSelectedEntityId={setSelectedEntityId} />
                            )}
                        </div>
                    </div>
                )}

                {/* Empty State */}
                {actors.length === 0 && projectiles.length === 0 && (
                    <div className="p-4 text-center text-xs text-zinc-500">
                        场景中暂无实体
                    </div>
                )}
            </div>
        </div>
    );
});
