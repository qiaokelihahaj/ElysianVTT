import React, { useMemo } from 'react';
import { useGameStore } from '../../store/gameStore';

interface FrameMeterProps {
    entityId: string;
}

const PX_PER_TICK = 4; // 每 Tick = 4px 像素宽度

export const FrameMeter: React.FC<FrameMeterProps> = ({ entityId }) => {
    const currentTick = useGameStore(s => s.tick);
    const scheduledActions = useGameStore(s => s.scheduledActions);

    const actions = useMemo(
        () => scheduledActions.filter(a => a.entityId === entityId),
        [scheduledActions, entityId]
    );

    const hasActions = actions.length > 0;

    if (!hasActions) {
        return (
            <div className="text-xs text-zinc-600 italic">
                No actions scheduled
            </div>
        );
    }

    return (
        <div className="frame-meter-container flex flex-col gap-2">
            {actions.map((action, idx) => {
                const t = action.timeline;

                // 前摇段 (绿色): start → active
                const startupFrames = Math.max(t.active - t.start, 0);
                // 判定段 (红色): 1 Tick
                const activeFrames = 1;
                // 收招段 (蓝色): active+1 → end
                const recoveryFrames = Math.max(t.end - t.active - 1, 0);

                const startupWidth = startupFrames * PX_PER_TICK;
                const activeWidth = activeFrames * PX_PER_TICK;
                const recoveryWidth = recoveryFrames * PX_PER_TICK;
                const totalWidth = (startupFrames + activeFrames + recoveryFrames) * PX_PER_TICK;

                // 游标位置 (当前帧相对于起始帧的偏移)
                const playheadOffset = Math.min(
                    Math.max((currentTick - t.start) * PX_PER_TICK, 0),
                    totalWidth
                );

                // 判断当前阶段
                const isBefore = currentTick < t.start;
                const isStartup = currentTick >= t.start && currentTick < t.active;
                const isActive = currentTick === t.active;
                const isRecovery = currentTick > t.active && currentTick <= t.end;
                const isDone = currentTick > t.end;

                return (
                    <div className="action-track" key={`${action.actionId}-${idx}`}>
                        {/* Label */}
                        <div className="flex items-center gap-2 mb-0.5">
                            <div className="text-xs font-bold text-zinc-200 truncate max-w-28">
                                {action.actionName}
                            </div>
                            {action.tags?.map(tag => (
                                <span
                                    key={tag}
                                    className="text-[10px] px-1 rounded bg-zinc-800 text-zinc-400 uppercase tracking-[0.1em]"
                                >
                                    {tag}
                                </span>
                            ))}
                            <div className="text-[10px] text-zinc-500 ml-auto">
                                T{t.start}-{t.end}
                            </div>
                        </div>

                        {/* 色块进度条 */}
                        <div className="relative h-6 bg-zinc-900/80 rounded overflow-hidden border border-zinc-800/50"
                             style={{ width: totalWidth + 2 }}>
                            {/* 前摇绿色 */}
                            {startupFrames > 0 && (
                                <div
                                    className="absolute top-0 left-0 h-full bg-emerald-600/70 border-r border-emerald-500/30 flex items-center justify-center"
                                    style={{ width: startupWidth }}
                                >
                                    <span className="text-[9px] font-mono text-emerald-200 drop-shadow-sm">
                                        {startupFrames}F
                                    </span>
                                </div>
                            )}

                            {/* 判定红色 */}
                            <div
                                className="absolute top-0 h-full bg-red-600/80 flex items-center justify-center"
                                style={{ left: startupWidth, width: activeWidth }}
                            >
                                <span className="text-[9px] font-mono text-red-200 drop-shadow-sm">
                                    ⚡
                                </span>
                            </div>

                            {/* 收招蓝色 */}
                            {recoveryFrames > 0 && (
                                <div
                                    className="absolute top-0 h-full bg-blue-600/60 border-l border-blue-500/30 flex items-center justify-center"
                                    style={{ left: startupWidth + activeWidth, width: recoveryWidth }}
                                >
                                    {recoveryFrames >= 3 && (
                                        <span className="text-[9px] font-mono text-blue-200 drop-shadow-sm">
                                            {recoveryFrames}F
                                        </span>
                                    )}
                                </div>
                            )}

                            {/* 游标 */}
                            <div
                                className="absolute top-0 h-full w-0.5 bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.6)] transition-all duration-75"
                                style={{ left: playheadOffset }}
                            />
                        </div>

                        {/* 阶段指示器 */}
                        <div className="flex gap-4 text-[10px] mt-0.5">
                            <span className={isStartup ? 'text-emerald-400 font-bold' : 'text-zinc-600'}>
                                {isStartup ? '▶ ' : ''}STARTUP
                            </span>
                            <span className={isActive ? 'text-red-400 font-bold' : 'text-zinc-600'}>
                                {isActive ? '▶ ' : ''}ACTIVE
                            </span>
                            <span className={isRecovery ? 'text-blue-400 font-bold' : 'text-zinc-600'}>
                                {isRecovery ? '▶ ' : ''}RECOVERY
                            </span>
                            {isDone && <span className="text-zinc-500">(done)</span>}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};
