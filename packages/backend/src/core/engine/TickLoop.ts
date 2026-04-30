// packages/backend/src/core/engine/TickLoop.ts
import type { Tick, TickEvent, ActionExecutionEvent } from '@hard-vtt/shared';
import { PriorityQueue } from './PriorityQueue.js';

export class TickLoop {
    public currentTick: Tick = 0;
    private queue: PriorityQueue;
    private running = false;

    constructor(queue: PriorityQueue) {
        this.queue = queue;
    }

    public getCurrentTick(): Tick {
        return this.currentTick;
    }

    public isEmpty(): boolean {
        return this.queue.size === 0;
    }

    /**
     * 单步推进：跃迁到下一个有事件的 Tick，收集同 Tick 事件并返回
     * 
     * @returns 该 Tick 下所有事件（已从优先队列弹出），以及到达的 Tick
     */
    public step(): { tick: Tick; events: TickEvent[] } | null {
        if (this.queue.size === 0) return null;

        // 窥视下一个事件的目标时间
        const nextEvent = this.queue.peek()!;

        // 时间直接跃迁（跳过空闲 Tick）
        if (nextEvent.targetTick > this.currentTick) {
            this.currentTick = nextEvent.targetTick;
        }

        // 收集同一 Tick 的所有事件（ClashPool 批次）
        const batch: TickEvent[] = [];
        while (this.queue.size > 0 && this.queue.peek()!.targetTick === this.currentTick) {
            const event = this.queue.pop()!;
            batch.push(event);
        }

        return { tick: this.currentTick, events: batch };
    }

    /**
     * 一次推进所有待处理 Tick（类似 setInterval 循环但非轮询）
     */
    public runUntilEmpty(): number {
        let steps = 0;
        while (this.queue.size > 0) {
            this.step();
            steps++;
        }
        return steps;
    }

    /**
     * 收集当前堆中所有同 targetTick 的 PENDING 事件（不弹出）
     * 供 ClashPool 预处理使用
     */
    public peekSameTickEvents(): TickEvent[] {
        const heap = (this.queue as any).heap as TickEvent[];
        if (heap.length === 0) return [];

        const firstTick = heap[0].targetTick;
        const collected: TickEvent[] = [];
        for (const evt of heap) {
            if (evt.targetTick === firstTick && evt.status === 'PENDING') {
                collected.push(evt);
            }
        }
        return collected;
    }

    /**
     * 分离事件：哪些是 STARTUP 阶段（需要 ClashPool 判定）
     */
    public static filterClashable(events: TickEvent[]): ActionExecutionEvent[] {
        return events.filter(
            e => (e as any).eventType === 'ACTION_PHASE' && (e as ActionExecutionEvent).phase === 'STARTUP'
        ) as ActionExecutionEvent[];
    }
}
