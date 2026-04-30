import React, { useRef, useEffect, useState } from 'react';
import { useGameStore } from '../../store/gameStore';

type LayoutMode = 'lanes' | 'overlay' | 'compact';

const LANE_COLORS = [
    { bg: '#ff6b35', fg: '#fff' },  // 更饱和的橙色
    { bg: '#4f46e5', fg: '#fff' },  // 更深的靛蓝
    { bg: '#16a34a', fg: '#fff' },  // 更深的绿色
    { bg: '#db2777', fg: '#fff' },  // 更饱和的粉色
    { bg: '#0891b2', fg: '#fff' },  // 更深的青色
    { bg: '#eab308', fg: '#000' },  // 更深的黄色
];

const PX_PER_TICK = 24;
const LANE_HEIGHT = 40;
const RULER_HEIGHT = 30;

export const TickMeter: React.FC = () => {
    const currentTick = useGameStore(s => s.tick);
    const actions = useGameStore(s => s.scheduledActions);
    const entities = useGameStore(s => s.entities);
    const [mode, setMode] = useState<LayoutMode>('lanes');
    const [collapsed, setCollapsed] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        useGameStore.getState().clearExpiredActions(currentTick);
    }, [currentTick]);

    // Auto-scroll to keep playhead centered
    useEffect(() => {
        if (scrollRef.current && !collapsed && actions.length > 0) {
            const allStart = Math.min(...actions.map(a => a.timeline.start));
            const offset = (currentTick - allStart) * PX_PER_TICK - (containerRef.current?.clientWidth ?? 600) / 2 + 100;
            scrollRef.current.scrollLeft = Math.max(0, offset);
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
                    Timeline ({actions.length})
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
                    className="bg-zinc-900/80 border border-zinc-800 text-zinc-500 text-xs px-3 py-1 rounded-b-lg hover:text-zinc-400 transition-colors"
                >
                    ⏱ No actions scheduled
                </button>
            </div>
        );
    }

    const allStart = Math.min(...actions.map(a => a.timeline.start));
    const allEnd = Math.max(...actions.map(a => a.timeline.end));
    const globalStart = Math.min(currentTick, allStart);
    const globalEnd = allEnd + 20;
    const totalWidth = (globalEnd - globalStart) * PX_PER_TICK;

    const entityIds = [...new Set(actions.map(a => a.entityId))];
    const entityOrder = entityIds.map((eid, i) => ({
        entityId: eid,
        name: entities[eid]?.templateId ?? eid,
        color: LANE_COLORS[i % LANE_COLORS.length]
    }));

    const tickOffset = (t: number) => (t - globalStart) * PX_PER_TICK;

    // Ruler ticks
    const rulerTicks = (() => {
        const span = globalEnd - globalStart;
        const step = span < 8 ? 1 : span < 20 ? 2 : span < 40 ? 5 : span < 80 ? 10 : 20;
        const ticks: { tick: number; offset: number }[] = [];
        for (let t = Math.floor(globalStart / step) * step; t <= globalEnd; t += step) {
            ticks.push({ tick: t, offset: tickOffset(t) });
        }
        return ticks;
    })();

    const rulerWidth = Math.max(totalWidth, 200);

    // Render action bar on lanes
    const renderActionSegments = (entityId: string, laneColor: typeof LANE_COLORS[number], fullMode: boolean) => {
        const entityActions = actions.filter(a => a.entityId === entityId);
        return entityActions.map((action, ai) => {
            const t = action.timeline;
            const left = tickOffset(t.start);
            const width = tickOffset(t.end) - left;
            const startupWidth = tickOffset(t.startupEnd) - left;
            const lastPulse = t.pulseTicks?.[t.pulseTicks.length - 1] ?? t.startupEnd;
            const recoveryStart = tickOffset(lastPulse + 1);
            const recoveryWidth = tickOffset(t.end) - recoveryStart;
            const pulseTicks = t.pulseTicks ?? [t.startupEnd];

            if (!fullMode) {
                return (
                    <div
                        key={`${action.actionId}-${ai}`}
                        className="absolute top-1 h-5 rounded-md flex items-center overflow-hidden shadow-md hover:shadow-lg transition-all hover:brightness-110 cursor-pointer"
                        style={{ left: startupWidth > 0 ? left : left, width: Math.max(width, 16), backgroundColor: laneColor.bg, opacity: 0.9 }}
                    >
                        <span className="text-[9px] px-2 truncate leading-none font-bold" style={{ color: laneColor.fg, textShadow: '0 1px 2px rgba(0,0,0,0.2)' }}>
                            {entityOrder.find(e => e.entityId === entityId)?.name?.slice(0, 10) ?? '?'} {action.actionName}
                        </span>
                    </div>
                );
            }

            return (
                <React.Fragment key={`${action.actionId}-${ai}`}>
                    {/* STARTUP green */}
                    {startupWidth > 3 && (
                        <div className="absolute top-1 h-[22px] bg-emerald-600 rounded-l-md border-r border-emerald-400/50 flex items-center justify-center shadow-sm hover:brightness-110 transition-all"
                             style={{ left, width: startupWidth }}>
                            <span className="text-[9px] font-mono text-emerald-100 leading-none font-bold" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}>
                                {t.startupEnd - t.start}
                            </span>
                        </div>
                    )}
                    {/* ACTIVE blocks (red, full tick width to fill gap) */}
                    {pulseTicks.map((pt, i) => {
                        const activeLeft = tickOffset(pt);
                        return (
                            <div key={`a-${pt}`}
                                className="absolute top-0 h-full bg-red-500 flex items-center justify-center z-10 border-x border-red-400/40 shadow-md hover:brightness-110 transition-all"
                                style={{ left: activeLeft, width: PX_PER_TICK }}>
                                <span className="text-[8px] font-mono text-white leading-none drop-shadow-lg font-bold">
                                    {pulseTicks.length === 1 ? '⚡' : `P${i + 1}`}
                                </span>
                            </div>
                        );
                    })}
                    {/* CHANNELING gaps */}
                    {pulseTicks.length > 1 && pulseTicks.slice(1).map((pt, i) => {
                        const prev = pulseTicks[i];
                        const gapStart = tickOffset(prev + 1);
                        const gapW = tickOffset(pt) - gapStart;
                        if (gapW < 1) return null;
                        return (
                            <div key={`gap-${i}`} className="absolute top-1 h-[22px] bg-indigo-600/60 flex items-center justify-center hover:brightness-110 transition-all rounded-sm"
                                 style={{ left: gapStart, width: Math.max(gapW, 1) }}>
                                {gapW > 16 && <span className="text-[8px] font-mono text-indigo-200 leading-none font-bold" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}>{pt - prev - 1}</span>}
                            </div>
                        );
                    })}
                    {/* RECOVERY blue */}
                    {recoveryWidth > 3 && (
                        <div className="absolute top-1 h-[22px] bg-blue-600 rounded-r-md border-l border-blue-400/50 flex items-center justify-center shadow-sm hover:brightness-110 transition-all"
                             style={{ left: recoveryStart, width: recoveryWidth }}>
                            {recoveryWidth > 14 && <span className="text-[9px] font-mono text-blue-100 leading-none font-bold" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}>{t.end - lastPulse - 1}</span>}
                        </div>
                    )}
                </React.Fragment>
            );
        });
    };

    return (
        <div className="pointer-events-auto flex justify-center" ref={containerRef}>
            <div className="bg-zinc-950 border-b border-x border-zinc-700 rounded-b-lg shadow-2xl" style={{ width: '85vw', minWidth: 800 }}>
                {/* Mode bar */}
                <div className="flex items-center justify-between px-4 py-2 bg-zinc-900 border-b border-zinc-700 rounded-b-lg">
                    <div className="flex items-center gap-3">
                        <span className="text-sm font-bold text-zinc-100">⏱ Timeline</span>
                        <span className="text-[11px] text-zinc-400 font-mono bg-zinc-800/50 px-2 py-1 rounded">
                            T{globalStart}–{globalEnd}
                        </span>
                    </div>
                    <div className="flex items-center gap-0.5">
                        {(['lanes', 'overlay', 'compact'] as LayoutMode[]).map(m => (
                            <button
                                key={m}
                                onClick={() => setMode(m)}
                                className={`text-[10px] px-3 py-1 rounded-md transition-all font-medium ${
                                    mode === m
                                        ? 'bg-amber-500 text-white shadow-lg hover:shadow-xl hover:brightness-110'
                                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 hover:shadow-md'
                                }`}
                            >
                                {m === 'lanes' ? '⊟ Lanes' : m === 'overlay' ? '⊞ Overlay' : '≡ Compact'}
                            </button>
                        ))}
                        <button onClick={() => setCollapsed(true)}
                            className="text-[10px] px-2 py-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 ml-2 transition-all">✕</button>
                    </div>
                </div>

                {/* Fixed Ruler — always visible */}
                <div className="relative overflow-hidden border-b border-zinc-700" style={{ height: RULER_HEIGHT, backgroundColor: '#09090b' }}>
                    <div className="absolute inset-0 overflow-x-hidden" ref={scrollRef}>
                        <div className="relative h-full" style={{ width: rulerWidth }}>
                            {rulerTicks.map(({ tick, offset }) => (
                                <div key={tick} className="absolute top-0 flex flex-col items-center h-full"
                                     style={{ left: offset, transform: 'translateX(-50%)' }}>
                                    <div className="h-3 w-px bg-zinc-500" />
                                    <div className="text-[10px] font-mono text-zinc-300 leading-none font-bold">
                                        {tick}
                                    </div>
                                </div>
                            ))}
                            {/* Ruler playhead */}
                            <div className="absolute top-0 h-full w-0.5 bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.8)] z-20"
                                 style={{ left: tickOffset(currentTick) }}>
                                <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-amber-400 rotate-45 shadow-lg" />
                                <div className="absolute top-2 left-1/2 -translate-x-1/2 text-[11px] font-mono font-bold text-amber-300 whitespace-nowrap bg-amber-900/60 px-2 py-0.5 rounded shadow-md">
                                    T{currentTick}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Content area */}
                {mode === 'compact' ? (
                    <div className="h-12 relative overflow-hidden mx-2 py-1">
                        <div className="absolute inset-0 overflow-x-auto" onScroll={e => {
                            if (scrollRef.current) scrollRef.current.scrollLeft = (e.target as HTMLElement).scrollLeft;
                        }}>
                            <div className="relative h-full" style={{ width: rulerWidth }}>
                                <div className="absolute inset-x-0 top-1" style={{ height: 32 }}>
                                    {actions.map((action, i) => {
                                        const ent = entityOrder.find(e => e.entityId === action.entityId);
                                        const t = action.timeline;
                                        const left = tickOffset(t.start);
                                        const width = tickOffset(t.end) - left;
                                        return (
                                            <div key={`${action.actionId}-${i}`}
                                                className="absolute top-0 h-6 rounded-md flex items-center overflow-hidden px-2 shadow-md hover:shadow-lg hover:brightness-110 transition-all cursor-pointer"
                                                style={{ left, width: Math.max(width, 12), backgroundColor: ent?.color.bg ?? '#666', opacity: 0.85 }}>
                                                <span className="text-[8px] font-bold truncate" style={{ color: ent?.color.fg ?? '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.2)' }}>
                                                    {ent?.name?.slice(0, 8)} {action.actionName}
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    </div>
                ) : mode === 'overlay' ? (
                    <div className="h-16 relative overflow-hidden mx-2 py-1">
                        <div className="absolute inset-0 overflow-x-auto" onScroll={e => {
                            if (scrollRef.current) scrollRef.current.scrollLeft = (e.target as HTMLElement).scrollLeft;
                        }}>
                            <div className="relative h-full" style={{ width: rulerWidth }}>
                                {actions.map((action, i) => {
                                    const ent = entityOrder.find(e => e.entityId === action.entityId);
                                    const t = action.timeline;
                                    const left = tickOffset(t.start);
                                    const width = tickOffset(t.end) - left;
                                    return (
                                        <div key={`${action.actionId}-${i}`}
                                            className="absolute top-1 h-6 rounded-md flex items-center overflow-hidden px-1.5 shadow-md hover:shadow-lg hover:brightness-110 transition-all cursor-pointer"
                                            style={{ left, width: Math.max(width, 12), backgroundColor: ent?.color.bg ?? '#666', opacity: 0.65 + 0.2 * (i % 3) }}>
                                            <span className="text-[8px] font-bold truncate" style={{ color: ent?.color.fg ?? '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.2)' }}>
                                                {ent?.name?.slice(0, 8)} {action.actionName}
                                            </span>
                                        </div>
                                    );
                                })}
                                <div className="absolute bottom-1 left-0 flex gap-2 px-2">
                                    {entityOrder.map(ent => (
                                        <div key={ent.entityId} className="flex items-center gap-1 text-[9px] text-zinc-300 font-medium">
                                            <div className="w-2 h-2 rounded-sm shadow-sm" style={{ backgroundColor: ent.color.bg }} />
                                            {ent.name.slice(0, 8)}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                ) : (
                    /* Lanes */
                    <div style={{ height: entityIds.length * LANE_HEIGHT, minHeight: 80, maxHeight: 240 }}
                         className="relative overflow-hidden overflow-y-auto mx-2">
                        <div className="absolute inset-0 overflow-x-auto" onScroll={e => {
                            if (scrollRef.current) scrollRef.current.scrollLeft = (e.target as HTMLElement).scrollLeft;
                        }}>
                            <div className="relative" style={{ width: rulerWidth, height: entityIds.length * LANE_HEIGHT }}>
                                {entityOrder.map((ent, li) => (
                                    <div key={ent.entityId}
                                        className="absolute left-0 right-0 border-b border-zinc-700"
                                        style={{
                                            top: li * LANE_HEIGHT, height: LANE_HEIGHT,
                                            backgroundColor: li % 2 === 0 ? 'transparent' : 'rgba(39,39,42,0.5)'
                                        }}>
                                        <div className="absolute left-0 top-0 bottom-0 w-16 flex items-center justify-end pr-2 text-[10px] font-bold z-10 shadow-md"
                                             style={{ color: ent.color.bg, backgroundColor: 'rgba(9,9,11,0.95)', borderRight: `2px solid ${ent.color.bg}` }}>
                                            {ent.name.slice(0, 8)}
                                        </div>
                                        <div className="absolute left-16 right-0 h-full">
                                            {renderActionSegments(ent.entityId, ent.color, true)}
                                        </div>
                                    </div>
                                ))}
                                {/* Playhead */}
                                <div className="absolute top-0 w-0.5 bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.8)] z-20 pointer-events-none"
                                     style={{ left: tickOffset(currentTick), height: entityIds.length * LANE_HEIGHT }}>
                                    <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-amber-400 rotate-45 shadow-lg" />
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
