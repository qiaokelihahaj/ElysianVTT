import type { ActionExecutionEvent, ActionTemplate, Entity, EntityId, Tick } from '@hard-vtt/shared';

/**
 * Runtime helpers for event-driven ACTIVE windows.
 *
 * The combat engine owns the entity state and queue; this module only keeps
 * the window arithmetic and event construction in one place.  A window is
 * half-open, [start, end), so the boundary event that enters RECOVERY can
 * never apply the strike again.
 */
export interface ActiveWindowState {
    start: Tick;
    end: Tick;
    strikeIndex: number;
    strikeCount: number;
    targetIds: EntityId[];
    hitTargetIds: EntityId[];
}

export function activeWindowTicks(template: ActionTemplate): number {
    const configured = template.activeWindowTicks;
    return Number.isFinite(configured) && configured !== undefined
        ? Math.max(1, Math.floor(configured))
        : 1;
}

export function strikeCount(template: ActionTemplate): number {
    const configured = template.strikeSequence?.count;
    return configured !== undefined && Number.isInteger(configured)
        ? Math.max(1, configured)
        : 1;
}

export function strikeStartupTicks(template: ActionTemplate): number {
    if (!template.strikeSequence) return 0;
    const configured = template.strikeSequence.startupTicks;
    const smallStartup = Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 0;
    // A sequence is deliberately big startup + small startup before its
    // first strike, then small startup before every following strike.  The
    // caller adds the normal action startup for the first strike.
    return smallStartup;
}

export function strikeWindowTicks(template: ActionTemplate): number {
    const configured = template.strikeSequence?.activeWindowTicks;
    return Number.isFinite(configured) && configured !== undefined
        ? Math.max(1, Math.floor(configured))
        : activeWindowTicks(template);
}

export function isWindowOpen(window: Pick<ActiveWindowState, 'start' | 'end'>, tick: Tick): boolean {
    return tick >= window.start && tick < window.end;
}

export function buildActiveWindowEndEvent(
    source: ActionExecutionEvent,
    start: Tick,
    end: Tick,
    strikeIndex: number,
    strikeTotal: number,
): ActionExecutionEvent {
    return {
        ...source,
        eventId: `${source.eventId}:active-end:${start}`,
        targetTick: end,
        status: 'PENDING',
        phase: 'ACTIVE',
        activeWindowStart: start,
        activeWindowEnd: end,
        strikeIndex,
        strikeCount: strikeTotal,
        activeWindowEndEvent: true,
    };
}

/** Return targets whose ids have not been consumed by this strike. */
export function unhitTargets(
    entities: Map<EntityId, Entity>,
    targetIds: EntityId[],
    hitTargetIds: EntityId[],
): Entity[] {
    const hit = new Set(hitTargetIds);
    return targetIds
        .filter(targetId => !hit.has(targetId))
        .map(targetId => entities.get(targetId))
        .filter((target): target is Entity => target !== undefined);
}
