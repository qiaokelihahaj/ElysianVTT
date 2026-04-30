import type { Entity, Vector3D, Tick, MovementStepEvent } from '@hard-vtt/shared';
import { VectorMath } from '../../utils/VectorMath.js';
import { generateId } from '../../utils/IdGenerator.js';

const DEFAULT_TICKS_PER_UNIT = 10;
const DEFAULT_STEP_SIZE = 1.0;

export class SpatialSystem {
    /**
     * 将移动意图转化为航点坐标列表（不生成事件，由 CombatEngine 递归调度）
     */
    public static planWaypoints(
        actor: Entity,
        targetCoords: Vector3D,
        stepSize: number = DEFAULT_STEP_SIZE
    ): Vector3D[] {
        const waypoints: Vector3D[] = [];
        const startCoords = { ...actor.transform.coords };
        let cursor = { x: startCoords.x, y: startCoords.y, z: startCoords.z ?? 0 };

        while (VectorMath.distance(cursor, targetCoords) > 0.01) {
            cursor = VectorMath.stepTowards(cursor, targetCoords, stepSize);
            waypoints.push({ x: cursor.x, y: cursor.y, z: cursor.z });
        }

        return waypoints;
    }

    /**
     * 当前事件类型仍使用此方法生成 MovementStepEvent
     */
    public static planMovement(
        actor: Entity,
        targetCoords: Vector3D,
        currentTick: Tick,
        ticksPerUnit: number = DEFAULT_TICKS_PER_UNIT,
        stepSize: number = DEFAULT_STEP_SIZE
    ): MovementStepEvent[] {
        const events: MovementStepEvent[] = [];
        const startCoords = { ...actor.transform.coords };

        let cursor = { x: startCoords.x, y: startCoords.y, z: startCoords.z ?? 0 };
        let tickCursor = currentTick;

        while (VectorMath.distance(cursor, targetCoords) > 0.01) {
            cursor = VectorMath.stepTowards(cursor, targetCoords, stepSize);
            tickCursor += ticksPerUnit;

            const isLastStep = VectorMath.distance(cursor, targetCoords) <= 0.01;

            events.push({
                eventId: generateId(),
                eventType: 'MOVEMENT_STEP',
                targetTick: tickCursor,
                status: 'PENDING',
                actorId: actor.id,
                currentCoords: { x: cursor.x, y: cursor.y, z: cursor.z },
                targetCoords: { ...targetCoords },
                isLastStep
            });
        }

        return events;
    }

    /**
     * 计算两点之间的曼哈顿距离（网格计数）
     */
    public static gridDistance(from: Vector3D, to: Vector3D): number {
        return Math.abs(to.x - from.x) + Math.abs(to.y - from.y) + Math.abs((to.z ?? 0) - (from.z ?? 0));
    }

    /**
     * 计算移动的总 Tick 消耗
     */
    public static movementCost(from: Vector3D, to: Vector3D, ticksPerUnit: number = DEFAULT_TICKS_PER_UNIT): Tick {
        const dist = VectorMath.distance(from, to);
        return Math.ceil(dist * ticksPerUnit);
    }
}
