import type {
    ActionTimeline,
    ActionTimelinePatch,
    ActionTimelineSegment,
    ActionTimelineSegmentPhase,
    Entity,
    Tick,
    Vector3D,
} from '@hard-vtt/shared';
import { DictionaryActionCatalog } from '../../db/Dictionary.js';
import type { ActionCatalog } from '../../rules/ActionCatalog.js';
import { SpatialSystem } from '../../core/systems/SpatialSystem.js';
import { activeWindowTicks, strikeCount, strikeStartupTicks, strikeWindowTicks } from './CombatActiveWindowRuntime.js';

interface PhaseSegmentOptions {
    /** Boundary after the large initial startup, when it is known. */
    initialStartupEnd?: Tick;
    /** Phase used for gaps between ACTIVE windows. */
    interWindowPhase?: Extract<ActionTimelineSegmentPhase, 'SMALL_STARTUP' | 'CHANNELING'>;
    /** Movement has a continuous MOVING phase between the first step and recovery. */
    movement?: boolean;
}

function appendSegment(
    segments: ActionTimelineSegment[],
    phase: ActionTimelineSegmentPhase,
    start: Tick,
    end: Tick,
    strikeIndex?: number,
): void {
    if (end <= start) return;
    segments.push({
        phase,
        start,
        end,
        ...(strikeIndex === undefined ? {} : { strikeIndex }),
    });
}

/** Build explicit phase intervals from an already authoritative timeline. */
export function buildActionPhaseSegments(
    timeline: ActionTimeline,
    options: PhaseSegmentOptions = {},
): ActionTimelineSegment[] {
    const windows = [...(timeline.activeWindows ?? [])].sort((a, b) => a.start - b.start || a.strikeIndex - b.strikeIndex);
    const segments: ActionTimelineSegment[] = [];
    const first = windows[0];
    const firstActiveStart = first?.start ?? timeline.startupEnd;

    if (options.movement) {
        appendSegment(segments, 'STARTUP', timeline.start, firstActiveStart);
        appendSegment(segments, 'MOVING', firstActiveStart, timeline.recoveryStart);
    } else {
        const initialStartupEnd = Math.max(
            timeline.start,
            Math.min(firstActiveStart, options.initialStartupEnd ?? firstActiveStart),
        );
        appendSegment(segments, 'STARTUP', timeline.start, initialStartupEnd);
        if (initialStartupEnd < firstActiveStart) {
            appendSegment(segments, options.interWindowPhase ?? 'CHANNELING', initialStartupEnd, firstActiveStart, first?.strikeIndex);
        }

        for (let index = 0; index < windows.length; index += 1) {
            const window = windows[index];
            appendSegment(segments, 'ACTIVE', window.start, window.end, window.strikeIndex);
            const next = windows[index + 1];
            if (next) {
                appendSegment(segments, options.interWindowPhase ?? 'CHANNELING', window.end, next.start, next.strikeIndex);
            }
        }
    }

    if (!options.movement && windows.length === 0) {
        appendSegment(segments, 'ACTIVE', timeline.startupEnd, timeline.recoveryStart);
    }
    appendSegment(segments, 'RECOVERY', timeline.recoveryStart, timeline.end);
    return segments;
}

/** 计算实际脉冲与剩余脉冲的时间线；不修改实体、不调度事件、不广播。 */
export function buildActionTimelinePatch(
    actor: Entity,
    actionId: string,
    actionName: string,
    currentTick: Tick,
    movement: { intervalTicks: number; recoveryTicks: number; costForWaypoint?: (waypoint: Vector3D) => number },
    actionCatalog: ActionCatalog = new DictionaryActionCatalog(),
): ActionTimelinePatch | undefined {
    const ctx = actor.currentActionContext;
    if (!ctx) return;

    const actualPulses = ctx.pulseTickHistory ?? [];
    if (actualPulses.length === 0) return;

    const projectedPulses: number[] = [];
    let recoveryTicks: number;

    if (ctx.type === 'MOVING' && ctx.waypoints) {
        const nextIndex = ctx.currentWaypointIndex ?? 0;
        const remaining = ctx.waypoints.length - nextIndex;
        let cumulativeTick = currentTick;
        let sprintCount = Math.max(0, (ctx.consecutiveMoves ?? 0) - 1);

        for (let i = 0; i < remaining; i++) {
            const interval = SpatialSystem.sprintTickCost(
                sprintCount, movement.intervalTicks, 0.1, 0.5, 1
            ) * (movement.costForWaypoint?.(ctx.waypoints[nextIndex + i]) ?? 1);
            cumulativeTick += interval;
            projectedPulses.push(cumulativeTick);
            sprintCount++;
        }
        recoveryTicks = movement.recoveryTicks;
    } else if (ctx.type === 'CASTING') {
        const template = actionCatalog.getAction(ctx.actionTemplateId!);
        if (!template) return;

        const channel = template.channelOptions;
        const pulseNum = ctx.pulseCount ?? 0;
        const mayProjectFuture = ctx.phase !== 'RECOVERY' && ctx.stopAfterActiveWindow !== true;

        if (mayProjectFuture && template.strikeSequence && pulseNum < strikeCount(template)) {
            const remaining = strikeCount(template) - pulseNum;
            let cumulativeTick = actualPulses[actualPulses.length - 1] ?? currentTick;
            for (let i = 0; i < remaining; i++) {
                cumulativeTick += strikeWindowTicks(template) + strikeStartupTicks(template);
                projectedPulses.push(cumulativeTick);
            }
        } else if (mayProjectFuture && channel && (!channel.maxPulses || pulseNum < channel.maxPulses)) {
            const remaining = (channel.maxPulses ?? 1) - pulseNum;
            let cumulativeTick = actualPulses[actualPulses.length - 1] ?? currentTick;
            const channelWindowTicks = activeWindowTicks(template);
            for (let i = 0; i < remaining; i++) {
                cumulativeTick += Math.max(1, channel.intervalTicks, channelWindowTicks);
                projectedPulses.push(cumulativeTick);
            }
        }
        recoveryTicks = template.timeCost.recoveryTicks;
    } else {
        return;
    }

    const allPulseTicks = [...actualPulses, ...projectedPulses];
    const lastPulse = allPulseTicks[allPulseTicks.length - 1];
    const timelineTemplate = templateForTimeline(actor, actionCatalog);
    const windowTicks = timelineTemplate?.strikeSequence
        ? strikeWindowTicks(timelineTemplate)
        : timelineTemplate
            ? activeWindowTicks(timelineTemplate)
            : 1;
    const activeWindows = allPulseTicks.map((start, strikeIndex) => ({
        start,
        end: start + windowTicks,
        strikeIndex,
    }));
    const lastWindow = activeWindows[activeWindows.length - 1];
    let recoveryStart = lastWindow?.end ?? lastPulse + 1;
    let end = recoveryStart + recoveryTicks;
    if (ctx.phase === 'RECOVERY') {
        // Recovery is an authoritative terminal branch. Use its event
        // boundary instead of the old projected pulse schedule, which may
        // still contain strikes cancelled by an interrupt or resource stop.
        end = ctx.resolveTick;
        recoveryStart = Math.max(ctx.timelineStart ?? actualPulses[0], end - recoveryTicks);
    }
    const exposePhaseSegments = ctx.type === 'MOVING'
        || timelineTemplate?.activeWindowTicks !== undefined
        || timelineTemplate?.strikeSequence !== undefined;
    const timeline: ActionTimeline = {
        start: ctx.timelineStart ?? actualPulses[0],
        startupEnd: actualPulses[0],
        recoveryStart,
        end,
        pulseTicks: allPulseTicks,
        ...(exposePhaseSegments ? { activeWindows } : {}),
    };
    const isSequence = ctx.type === 'CASTING' && timelineTemplate?.strikeSequence !== undefined;
    const expectedInitialActive = timeline.start
        + (timelineTemplate?.timeCost.startupTicks ?? 0)
        + (isSequence ? strikeStartupTicks(timelineTemplate!) : 0);
    const firstPulseWasDelayed = actualPulses[0] !== expectedInitialActive;
    const patchedTimeline: ActionTimeline = exposePhaseSegments
        ? {
            ...timeline,
            phaseSegments: buildActionPhaseSegments(timeline, {
                movement: ctx.type === 'MOVING',
                // A delayed first pulse has no separately observable small
                // startup boundary. Keep it as one authoritative STARTUP
                // interval instead of inventing a segment.
                ...(isSequence
                    ? {
                        interWindowPhase: 'SMALL_STARTUP' as const,
                        ...(!firstPulseWasDelayed ? { initialStartupEnd: timeline.start + timelineTemplate!.timeCost.startupTicks } : {}),
                    }
                    : {}),
            }),
        }
        : timeline;

    return {
        entityId: actor.id,
        actionId,
        actionName,
        timeline: patchedTimeline,
    };
}

function templateForTimeline(actor: Entity, actionCatalog: ActionCatalog) {
    const actionTemplateId = actor.currentActionContext?.actionTemplateId;
    return actionTemplateId ? actionCatalog.getAction(actionTemplateId) : undefined;
}
