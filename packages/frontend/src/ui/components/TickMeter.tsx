import React, { useRef, useEffect, useState } from 'react';
import { useGameStore } from '../../store/gameStore';

const LANE_COLORS = [
    { bar: '#ff6b35', dot: '#ff6b35', text: '#fff' },
    { bar: '#6366f1', dot: '#818cf8', text: '#fff' },
    { bar: '#22c55e', dot: '#4ade80', text: '#fff' },
    { bar: '#ec4899', dot: '#f472b6', text: '#fff' },
    { bar: '#06b6d4', dot: '#22d3ee', text: '#fff' },
    { bar: '#eab308', dot: '#facc15', text: '#000' },
];

const PX_PER_TICK = 24;
const LANE_HEIGHT = 28;
const RULER_HEIGHT = 28;
const BADGE_WIDTH = 80;

export const TickMeter: React.FC = () => {
    const currentTick = useGameStore(s => s.tick);
    const actions = useGameStore(s => s.scheduledActions);
    const entities = useGameStore(s => s.entities);
    const [collapsed, setCollapsed] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const timelineRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to keep playhead in view on tick change
    useEffect(() => {
        if (scrollRef.current && !collapsed && actions.length > 0) {
            const allStart = Math.min(...actions.map(a => a.timeline.start));
            const headOffset = (currentTick - allStart) * PX_PER_TICK;
            const viewWidth = scrollRef.current.clientWidth;
            const targetScroll = headOffset - viewWidth / 2 + 100;
            scrollRef.current.scrollLeft = Math.max(0, targetScroll);
        }
    }, [currentTick, collapsed, actions]);

    if (collapsed) {
        return (
            <div className="pointer-events-auto flex items-center justify-center">
                <button
                    onClick={() => setCollapsed(false)}
                    className="bg-zinc-900/90 border border-zinc-700 text-zinc-400 text-xs px-3 py-1 rounded-b-lg hover:text-white transition-colors flex items-center gap-1.5"
                >
                    <span className="text-amber-400">⏱</span>
                    Timeline
                    {actions.length > 0 && (
                        <span className="text-zinc-500">{actions.length} action{actions.length > 1 ? 's' : ''}</span>
                    )}
                    <span className="text-zinc-600">▼</span>
                </button>
            </div>
        );
    }

    if (actions.length === 0) {
        return (
            <div className="pointer-events-auto flex items-center justify-center">
                <button
                    onClick={() => setCollapsed(true)}
                    className="bg-zinc-900/80 border border-zinc-800 text-zinc-500 text-xs px-3 py-1 rounded-b-lg hover:text-zinc-400 transition-colors flex items-center gap-1.5"
                >
                    <span className="text-amber-400/60">⏱</span>
                    No actions
                    <span className="text-zinc-600 ml-1">▲</span>
                </button>
            </div>
        );
    }

    // Compute time range
    const allStart = Math.min(...actions.map(a => a.timeline.start));
    const allEnd = Math.max(...actions.map(a => a.timeline.end));
    const globalStart = Math.min(currentTick, allStart);
    const globalEnd = Math.max(currentTick + 30, allEnd + 10);
    const totalWidth = (globalEnd - globalStart) * PX_PER_TICK;

    // Sort entity order: entities with actions, then by first action start time
    const entityIds = [...new Set(actions.map(a => a.entityId))];
    const entityOrder = entityIds
        .map(eid => ({
            entityId: eid,
            name: entities[eid]?.templateId ?? eid.slice(0, 6),
            firstTick: Math.min(...actions.filter(a => a.entityId === eid).map(a => a.timeline.start)),
            color: LANE_COLORS[entityIds.indexOf(eid) % LANE_COLORS.length],
        }))
        .sort((a, b) => a.firstTick - b.firstTick);

    const tickOffset = (t: number) => (t - globalStart) * PX_PER_TICK;

    // Ruler ticks — adaptive step
    const span = globalEnd - globalStart;
    const tickStep = span < 8 ? 1 : span < 20 ? 2 : span < 40 ? 5 : span < 80 ? 10 : 20;
    const rulerTicks: number[] = [];
    for (let t = Math.floor(globalStart / tickStep) * tickStep; t <= globalEnd; t += tickStep) {
        rulerTicks.push(t);
    }

    const renderLane = (entityId: string, color: typeof LANE_COLORS[number]) => {
        const entityActions = actions.filter(a => a.entityId === entityId);
        return entityActions.map((action, ai) => {
            const t = action.timeline;
            const left = tickOffset(t.start);
            let width = tickOffset(t.end) - left;
            if (width < 8) width = 8; // minimum visible width

            const startupWidth = tickOffset(t.startupEnd) - left;

            const lastPulse = t.pulseTicks?.[t.pulseTicks.length - 1] ?? t.startupEnd;
            const recoveryLeft = tickOffset(lastPulse + 1);
            const recoveryEnd = tickOffset(t.end);

            return (
                <div key={`${action.actionId}-${ai}`} className="absolute inset-y-0" style={{ left, width }}>
                    {/* STARTUP segment (green) — full height */}
                    {startupWidth > 2 && (
                        <div
                            className="absolute inset-y-1.5 left-0 rounded-l flex items-center justify-start pl-1 overflow-hidden"
                            style={{
                                width: startupWidth,
                                background: 'linear-gradient(90deg, #059669 0%, #10b981 100%)',
                                opacity: 0.85,
                            }}
                        >
                            <span className="text-[9px] font-mono text-emerald-100 font-bold leading-none">
                                {t.startupEnd - t.start}
                            </span>
                        </div>
                    )}

                    {/* ACTIVE pulse markers — full lane height, bright red */}
                    {t.pulseTicks?.map((pt, pi) => {
                        const activeLeft = tickOffset(pt) - left;
                        const isSingle = (t.pulseTicks?.length ?? 0) <= 1;
                        return (
                            <div
                                key={`a-${pi}`}
                                className="absolute top-0 flex items-center justify-center z-10"
                                style={{
                                    left: activeLeft,
                                    width: PX_PER_TICK,
                                    height: LANE_HEIGHT,
                                }}
                            >
                                <div
                                    className="w-full h-full rounded-sm flex items-center justify-center"
                                    style={{
                                        background: 'linear-gradient(180deg, #ef4444 0%, #dc2626 100%)',
                                        boxShadow: '0 0 8px rgba(239,68,68,0.4)',
                                    }}
                                >
                                    {isSingle ? (
                                        <span className="text-[9px] leading-none">⚡</span>
                                    ) : (
                                        <span className="text-[9px] font-mono text-white font-bold leading-none">{pi + 1}</span>
                                    )}
                                </div>
                            </div>
                        );
                    })}

                    {/* CHANNELING gaps (indigo, between ACTIVE pulses) */}
                    {t.pulseTicks && t.pulseTicks.length > 1 && t.pulseTicks.slice(1).map((pt, pi) => {
                        const prevPulse = t.pulseTicks![pi];
                        const gapLeft = tickOffset(prevPulse + 1) - left;
                        const gapWidth = tickOffset(pt) - tickOffset(prevPulse + 1);
                        if (gapWidth < 2) return null;
                        return (
                            <div
                                key={`gap-${pi}`}
                                className="absolute inset-y-1.5 flex items-center justify-center overflow-hidden"
                                style={{
                                    left: gapLeft,
                                    width: gapWidth,
                                    background: 'linear-gradient(90deg, #4338ca 0%, #6366f1 100%)',
                                    opacity: 0.5,
                                    borderRadius: gapWidth > 8 ? '2px' : '0',
                                }}
                            >
                                {gapWidth > 20 && (
                                    <span className="text-[8px] font-mono text-indigo-200 font-bold leading-none">
                                        {pt - prevPulse - 1}
                                    </span>
                                )}
                            </div>
                        );
                    })}

                    {/* RECOVERY segment (blue) */}
                    {recoveryEnd - recoveryLeft > 2 && (
                        <div
                            className="absolute inset-y-1.5 rounded-r flex items-center justify-start pl-1 overflow-hidden"
                            style={{
                                left: recoveryLeft - left,
                                width: recoveryEnd - recoveryLeft,
                                background: 'linear-gradient(90deg, #2563eb 0%, #3b82f6 100%)',
                                opacity: 0.7,
                            }}
                        >
                            <span className="text-[9px] font-mono text-blue-100 font-bold leading-none">
                                {t.end - lastPulse - 1}
                            </span>
                        </div>
                    )}

                    {/* Action name label — badge固定在动作条左侧，覆盖在各段之上 */}
                    <div
                        className="absolute inset-y-0 left-0 flex items-center z-20 pointer-events-auto"
                        style={{ width: Math.min(width, BADGE_WIDTH) }}
                        title={action.actionName}
                    >
                        <span
                            className="text-[11px] font-bold truncate px-1.5 py-0.5 rounded-xs leading-tight"
                            style={{
                                color: '#fff',
                                backgroundColor: 'rgba(0,0,0,0.65)',
                                textShadow: '0 1px 4px rgba(0,0,0,0.8)',
                                borderLeft: `3px solid ${color.dot}`,
                                maxWidth: '100%',
                            }}
                        >
                            {action.actionName}
                        </span>
                    </div>
                </div>
            );
        });
    };

    return (
        <div className="pointer-events-auto flex justify-center">
            <div
                ref={timelineRef}
                className="bg-zinc-950/95 border-b border-x border-zinc-700/80 rounded-b-lg shadow-2xl backdrop-blur-sm"
                style={{ width: '88vw', minWidth: 700 }}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900/90 border-b border-zinc-700/80 rounded-b-lg">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-zinc-100">⏱ Timeline</span>
                        <span className="text-[11px] text-zinc-500 font-mono bg-zinc-800/50 px-2 py-0.5 rounded">
                            T{globalStart}–{globalEnd}
                        </span>
                    </div>
                    <button
                        onClick={() => setCollapsed(true)}
                        className="text-[10px] px-2 py-1 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700 transition-all"
                        title="Collapse"
                    >
                        ▲
                    </button>
                </div>

                {/* Scrollable container */}
                <div className="overflow-x-auto overflow-y-hidden" ref={scrollRef}>
                    <div className="relative" style={{ width: totalWidth + BADGE_WIDTH, minWidth: '100%' }}>
                        {/* Ruler */}
                        <div
                            className="relative border-b border-zinc-700/60"
                            style={{ height: RULER_HEIGHT, marginLeft: BADGE_WIDTH }}
                        >
                            {rulerTicks.map(tick => (
                                <div
                                    key={tick}
                                    className="absolute top-0 flex flex-col items-center"
                                    style={{ left: tickOffset(tick), transform: 'translateX(-50%)' }}
                                >
                                    <div
                                        className="w-px"
                                        style={{
                                            height: tick % (tickStep * 5) === 0 ? 10 : 5,
                                            backgroundColor: tick === currentTick ? '#fbbf24' : tick % (tickStep * 5) === 0 ? '#a1a1aa' : '#52525b',
                                        }}
                                    />
                                    <div
                                        className="text-[10px] font-mono font-bold leading-none mt-0.5"
                                        style={{ color: tick === currentTick ? '#fbbf24' : '#a1a1aa' }}
                                    >
                                        {tick}
                                    </div>
                                </div>
                            ))}
                            {/* Playhead in ruler */}
                            <div
                                className="absolute top-0 w-px bg-amber-400 z-20"
                                style={{
                                    left: tickOffset(currentTick),
                                    height: RULER_HEIGHT,
                                    boxShadow: '0 0 6px rgba(251,191,36,0.6)',
                                }}
                            />
                        </div>

                        {/* Lanes */}
                        <div style={{ minHeight: 80 }}>
                            {entityOrder.map((ent, li) => (
                                <div
                                    key={ent.entityId}
                                    className="relative flex"
                                    style={{ height: LANE_HEIGHT }}
                                >
                                    {/* Entity badge — fixed left */}
                                    <div
                                        className="flex-none flex items-center gap-1.5 px-2.5 border-r border-zinc-700/60"
                                        style={{
                                            width: BADGE_WIDTH,
                                            backgroundColor: li % 2 === 0 ? 'rgba(0,0,0,0.3)' : 'rgba(39,39,42,0.3)',
                                        }}
                                    >
                                        <div
                                            className="w-2 h-2 rounded-full flex-none"
                                            style={{ backgroundColor: ent.color.dot }}
                                        />
                                        <span
                                            className="text-[11px] font-bold truncate leading-none"
                                            style={{ color: ent.color.dot }}
                                        >
                                            {ent.name}
                                        </span>
                                    </div>

                                    {/* Lane content */}
                                    <div
                                        className="relative flex-1"
                                        style={{
                                            backgroundColor: li % 2 === 0 ? 'transparent' : 'rgba(39,39,42,0.2)',
                                        }}
                                    >
                                        {renderLane(ent.entityId, ent.color)}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Full-height playhead */}
                        <div
                            className="absolute top-0 w-px bg-amber-400/80 z-20 pointer-events-none"
                            style={{
                                left: BADGE_WIDTH + tickOffset(currentTick),
                                height: entityOrder.length * LANE_HEIGHT + RULER_HEIGHT,
                                boxShadow: '0 0 8px rgba(251,191,36,0.5)',
                            }}
                        >
                            <div
                                className="absolute -left-1 top-0 w-2 h-2 bg-amber-400 rotate-45"
                                style={{ top: RULER_HEIGHT - 6 }}
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
