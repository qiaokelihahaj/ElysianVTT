import React, { useState } from 'react';
import { useGameStore } from '../../store/gameStore';
import { IntentDispatcher } from '../../network/IntentDispatcher';
import type { DecisionOption } from '@hard-vtt/shared';

export const TacticalDecisionPanel: React.FC = () => {
    const activeWindow = useGameStore(state => state.tactical.activeWindow);
    const reactionTriggered = useGameStore(state => state.tactical.reactionTriggered);
    const entities = useGameStore(state => state.entities);
    const clearActiveWindow = useGameStore(state => state.clearActiveWindow);
    const sendDecisionResponse = useGameStore(state => state.sendDecisionResponse);
    const [optionsWindowId, setOptionsWindowId] = useState<string | null>(null);

    if (!reactionTriggered || !activeWindow) return null;

    const reactingEntity = entities[activeWindow.actorId];
    const showOptions = optionsWindowId === activeWindow.windowId;
    const isIdle = !reactingEntity?.currentActionContext;
    const phase = reactingEntity?.currentActionContext?.phase ?? 'IDLE';

    const resolveResourceCost = (): number => {
        if (!reactingEntity) return 0;
        const poise = reactingEntity.resources.current.poise ?? 0;
        if (phase === 'STARTUP' || phase === 'CHANNELING') return Math.max(1, Math.floor(poise * 0.3));
        return Math.max(1, Math.floor(poise * 0.15));
    };

    const handleConfirmCancel = () => {
        if (reactingEntity) {
            IntentDispatcher.dispatchCancelAction(reactingEntity.id);
        }
        clearActiveWindow();
    };

    const handleSkip = () => {
        sendDecisionResponse(null);
    };

    const handleOptionSelect = (option: DecisionOption) => {
        sendDecisionResponse(option.id);
    };

    if (!isIdle) {
        const cancelCost = resolveResourceCost();
        return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 pointer-events-auto">
                <div className="bg-zinc-900 border border-amber-500/40 rounded-xl p-6 backdrop-blur-xl max-w-sm w-full shadow-2xl">
                    <div className="text-center mb-4">
                        <div className="text-amber-400 text-sm font-bold mb-1">⏸ 时间轴已冻结</div>
                        <div className="text-zinc-300 text-xs">你正在执行动作，处于 {phase} 阶段</div>
                    </div>
                    <div className="text-zinc-400 text-xs text-center mb-4">中断当前行动？</div>
                    <div className="flex gap-3 justify-center">
                        <button
                            onClick={handleConfirmCancel}
                            className="px-6 py-2 bg-red-600/80 hover:bg-red-500 text-white rounded-lg text-sm font-medium transition-colors"
                        >
                            是，取消行动 (-{cancelCost} PP)
                        </button>
                        <button
                            onClick={handleSkip}
                            className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition-colors"
                        >
                            否，继续行动
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 pointer-events-auto">
            <div className="bg-zinc-900 border border-amber-500/40 rounded-xl p-6 backdrop-blur-xl max-w-sm w-full shadow-2xl">
                <div className="text-center mb-4">
                    <div className="text-amber-400 text-sm font-bold mb-1">⚡ 反应行动</div>
                    <div className="text-zinc-300 text-xs">
                        {activeWindow.sourceAction?.actorId ?? activeWindow.actorId} 正在释放 {activeWindow.sourceAction?.actionName ?? 'Unknown'}
                    </div>
                </div>

                {!showOptions ? (
                    <div className="flex gap-3 justify-center">
                        <button
                            onClick={handleSkip}
                            className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm font-medium transition-colors"
                        >
                            跳过
                        </button>
                        <button
                            onClick={() => setOptionsWindowId(activeWindow.windowId)}
                            className="px-6 py-2 bg-amber-600/80 hover:bg-amber-500 text-white rounded-lg text-sm font-medium transition-colors"
                        >
                            决策
                        </button>
                    </div>
                ) : (
                    <div className="grid grid-cols-2 gap-2">
                        {activeWindow.availableOptions.map(option => (
                            <button
                                key={option.id}
                                onClick={() => handleOptionSelect(option)}
                                disabled={!option.canAfford}
                                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left ${
                                    option.canAfford
                                        ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700'
                                        : 'bg-zinc-800/40 text-zinc-600 border border-zinc-800 cursor-not-allowed'
                                }`}
                            >
                                <div className="font-medium">{option.label}</div>
                                <div className="text-[10px] text-zinc-500 mt-0.5">
                                    {Object.entries(option.resourceCost).map(([resource, amount]) => `${amount} ${resource}`).join(' · ')}
                                </div>
                            </button>
                        ))}
                        <button
                            onClick={() => setOptionsWindowId(null)}
                            className="px-3 py-2 rounded-lg text-xs text-zinc-500 hover:text-zinc-300 transition-colors col-span-2 text-center"
                        >
                            返回
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};
