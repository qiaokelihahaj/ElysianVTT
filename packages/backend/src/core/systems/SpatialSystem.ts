import type { Entity, HexCoord, Vector3D, Tick, MovementStepEvent, TrajectoryType } from '@hard-vtt/shared';
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

    /**
     * 计算六边形网格距离 (轴向坐标)
     * Uses axial coordinate hex distance formula from Red Blob Games
     */
    public static hexDistance(a: HexCoord, b: HexCoord): number {
        const dq = a.q - b.q;
        const dr = a.r - b.r;
        const ds = a.q + a.r - b.q - b.r;
        return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
    }

    /**
     * 获取六边形的六个邻居
     */
    public static hexNeighbors(coord: HexCoord): HexCoord[] {
        const directions: [number, number][] = [
            [1, 0], [0, 1], [-1, 1],
            [-1, 0], [0, -1], [1, -1]
        ];
        return directions.map(([dq, dr]) => ({
            q: coord.q + dq,
            r: coord.r + dr
        }));
    }

    // ============================================
    // 弹道路径规划 (Projectile Trajectory)
    // ============================================

    /**
     * 预计算弹道路径航点（射线算法）
     *
     * @param from            发射坐标
     * @param to              目标坐标
     * @param trajectoryType  轨迹类型
     * @param stepSize        每步推进距离（默认 1.0 网格单位）
     * @param options         可选: maxHeight（抛物线最高点 Z）,
     *                              minRange（最小射程内不产生航点）
     * @returns 从发射到目标的航点列表（不含起点）
     */
    public static planProjectilePath(
        from: Vector3D,
        to: Vector3D,
        trajectoryType: TrajectoryType,
        stepSize: number = 1.0,
        options?: { maxHeight?: number; minRange?: number }
    ): Vector3D[] {
        const totalDist = VectorMath.distance(from, to);

        // 最小射程盲区：距离小于 minRange 时不生成航点（直接到达）
        if (options?.minRange && totalDist < options.minRange) {
            return [{ ...to }];
        }

        if (trajectoryType === 'LINEAR') {
            return this.planLinearPath(from, to, stepSize);
        } else {
            const maxHeight = options?.maxHeight ?? Math.max(totalDist * 0.3, 2.0);
            return this.planParabolicPath(from, to, stepSize, maxHeight);
        }
    }

    /**
     * 直射弹道：贴地平飞，逐网格推进
     * 航点 Z 值保持与起点一致（地面高度）
     */
    private static planLinearPath(
        from: Vector3D,
        to: Vector3D,
        stepSize: number
    ): Vector3D[] {
        const waypoints: Vector3D[] = [];
        let cursor = { ...from };

        // 确保地面高度一致
        const groundZ = from.z ?? 0;

        while (VectorMath.distance(cursor, to) > stepSize * 0.1) {
            cursor = VectorMath.stepTowards(cursor, to, stepSize);
            waypoints.push({ x: cursor.x, y: cursor.y, z: groundZ });
        }

        // 确保终点包含
        if (waypoints.length === 0 || VectorMath.distance(waypoints[waypoints.length - 1], to) > 0.01) {
            waypoints.push({ ...to, z: groundZ });
        }

        return waypoints;
    }

    /**
     * 抛物线弹道：升弧段→降弧段
     * 使用二次贝塞尔插值计算弹道上各点 Z 值
     *
     * 升弧段：Z 逐渐上升至 maxHeight
     * 降弧段：Z 从 maxHeight 下降至目标 Z
     *
     * @param from      起点
     * @param to        终点
     * @param stepSize  步长
     * @param maxHeight 最高点 Z 值
     */
    private static planParabolicPath(
        from: Vector3D,
        to: Vector3D,
        stepSize: number,
        maxHeight: number
    ): Vector3D[] {
        const waypoints: Vector3D[] = [];
        const totalDist = VectorMath.distance(from, to);
        const steps = Math.max(2, Math.ceil(totalDist / stepSize));

        const fromZ = from.z ?? 0;
        const toZ = to.z ?? 0;

        for (let i = 1; i <= steps; i++) {
            const t = i / steps;  // 0..1 插值参数

            // XY 线性插值
            const x = from.x + (to.x - from.x) * t;
            const y = from.y + (to.y - from.y) * t;

            // Z 抛物线插值：使用二次函数 h(t) = 4 * maxHeight * t * (1 - t)
            // 在 t=0.5 时达到最高点，在 t=0 和 t=1 时回到起/终点高度
            const baseZ = fromZ + (toZ - fromZ) * t;
            const arcOffset = 4 * maxHeight * t * (1 - t);
            const z = baseZ + arcOffset;

            waypoints.push({ x, y, z });
        }

        return waypoints;
    }

    /**
     * 检查直线段上是否有障碍物阻挡（简单的线段求交检测）
     * 用于抛物线越障检查和射击视线判断
     *
     * @param from        起点
     * @param to          终点
     * @param obstacles   障碍物坐标列表（只检查 Z 值超过弹道高度的障碍物）
     * @param clearanceZ  越障净高（弹道必须高于障碍物至少此值）
     * @returns           阻挡的障碍物坐标（无阻挡则 null）
     */
    public static checkObstacle(
        from: Vector3D,
        to: Vector3D,
        obstacles: Vector3D[],
        clearanceZ: number = 0.5
    ): Vector3D | null {
        const fromZ = from.z ?? 0;
        const toZ = to.z ?? 0;

        for (const obs of obstacles) {
            const obsZ = obs.z ?? 0;

            // 计算弹道在障碍物处的 Z 高度（线性插值）
            const totalDist = VectorMath.distance(from, to);
            const distToObs = VectorMath.distance(from, obs);

            if (totalDist === 0) continue;

            const t = distToObs / totalDist;
            const pathZ = fromZ + (toZ - fromZ) * t;

            // 障碍物 Z 值超过弹道高度 → 阻挡
            if (obsZ > pathZ + clearanceZ) {
                // 检查障碍物是否在弹道路径附近（水平距离小于 1 单位）
                const horizDist = VectorMath.distance(
                    { x: from.x, y: from.y, z: 0 },
                    { x: obs.x, y: obs.y, z: 0 }
                );
                const progressDist = horizDist * t;

                // 粗略检查：障碍物到弹道线的垂距
                const dx = to.x - from.x;
                const dy = to.y - from.y;
                const len = Math.sqrt(dx * dx + dy * dy);
                if (len === 0) continue;

                // 点到线段距离公式
                const tProj = ((obs.x - from.x) * dx + (obs.y - from.y) * dy) / (len * len);
                if (tProj < 0 || tProj > 1) continue;  // 不在线段范围内

                const projX = from.x + tProj * dx;
                const projY = from.y + tProj * dy;
                const perpDist = VectorMath.distance(
                    { x: obs.x, y: obs.y, z: 0 },
                    { x: projX, y: projY, z: 0 }
                );

                if (perpDist < 1.0) {
                    return obs;  // 阻挡
                }
            }
        }

        return null;
    }

    /**
     * 计算抛物线弹道在给定水平位置上的高度
     * 用于越障检查
     */
    public static getParabolicHeight(
        from: Vector3D,
        to: Vector3D,
        currentX: number,
        currentY: number,
        maxHeight: number
    ): number {
        const totalDist = VectorMath.distance(from, to);
        const currentPos = { x: currentX, y: currentY, z: 0 };
        const progress = VectorMath.distance(from, currentPos);

        if (totalDist === 0) return from.z ?? 0;

        const t = progress / totalDist;
        const fromZ = from.z ?? 0;
        const toZ = to.z ?? 0;
        const baseZ = fromZ + (toZ - fromZ) * t;
        const arcOffset = 4 * maxHeight * t * (1 - t);

        return baseZ + arcOffset;
    }

    // ============================================
    // 空间战术 (Spatial Tactics — Phase 3.4)
    // ============================================

    /**
     * 计算从当前朝向转向目标方向所需的最小角度差（0~180）
     */
    public static turnAngle(currentFacing: number, targetFacing: number): number {
        const diff = ((targetFacing - currentFacing) % 360 + 540) % 360 - 180;
        return Math.abs(diff);
    }

    /**
     * 计算转身所需 Tick
     * @param angle 需要转过的角度
     * @param turnRate 每 Tick 可转角度（默认 45°）
     */
    public static turnTime(angle: number, turnRate: number = 45): number {
        if (angle <= 0) return 0;
        return Math.ceil(angle / turnRate);
    }

    /**
     * 判断目标是否在攻击者的前方扇形区域内
     * @param attackerFacing 攻击者朝向（度）
     * @param toTargetAngle  指向目标的绝对角度（度）
     * @param arc 前方扇形半角（默认 90°）
     */
    public static isInFrontArc(
        attackerFacing: number,
        toTargetAngle: number,
        arc: number = 90
    ): boolean {
        const diff = ((toTargetAngle - attackerFacing) % 360 + 540) % 360 - 180;
        return Math.abs(diff) <= arc;
    }

    /**
     * 判断攻击者是否在目标的后方（背刺判定用）
     * @param targetFacing    目标朝向
     * @param toAttackerAngle 指向攻击者的绝对角度
     * @param backArc 后方扇形半角（默认 90°）
     */
    public static isBehind(
        targetFacing: number,
        toAttackerAngle: number,
        backArc: number = 90
    ): boolean {
        const diff = ((toAttackerAngle - targetFacing + 180) % 360 + 540) % 360 - 180;
        return Math.abs(diff) <= backArc;
    }

    /**
     * 完整背刺判定
     * @returns 是否背刺成功（攻击者在目标背后）
     */
    public static isBackstab(attacker: Entity, target: Entity): boolean {
        const toAttackerAngle = Math.atan2(
            attacker.transform.coords.y - target.transform.coords.y,
            attacker.transform.coords.x - target.transform.coords.x
        ) * (180 / Math.PI);
        const normalizedAngle = (toAttackerAngle + 360) % 360;
        return this.isBehind(target.transform.facing, normalizedAngle);
    }

    /**
     * 获取两个实体之间的绝对角度
     */
    public static angleBetween(from: Entity, to: Entity): number {
        const dx = to.transform.coords.x - from.transform.coords.x;
        const dy = to.transform.coords.y - from.transform.coords.y;
        const angle = Math.atan2(dy, dx) * (180 / Math.PI);
        return (angle + 360) % 360;
    }

    /**
     * 计算冲刺移动的 Tick 消耗（连续移动递减加速）
     */
    public static sprintTickCost(
        consecutiveMoves: number,
        baseTickCost: number,
        reductionPerStep: number = 0.1,
        maxReduction: number = 0.5,
        minCost: number = 1
    ): number {
        if (consecutiveMoves <= 0) return baseTickCost;
        const reduction = Math.min(consecutiveMoves * reductionPerStep, maxReduction);
        return Math.max(Math.round(baseTickCost * (1 - reduction)), minCost);
    }

    /**
     * 检查冲刺是否中断（超过阈值未移动）
     */
    public static isSprintBroken(
        currentTick: number,
        lastMoveTick: number,
        breakThreshold: number = 20
    ): boolean {
        return (currentTick - lastMoveTick) > breakThreshold;
    }

    /**
     * 获取冲刺等级（用于视觉/动量效果）
     */
    public static sprintLevel(consecutiveMoves: number): number {
        if (consecutiveMoves <= 1) return 0;
        if (consecutiveMoves <= 3) return 1;
        if (consecutiveMoves <= 5) return 2;
        return 3;
    }

    /**
     * 检查目标是否在武器触及范围内
     */
    public static isInReach(dist: number, maxReach: number, minReach?: number): boolean {
        if (minReach && dist < minReach) return false;
        return dist <= maxReach;
    }

    /**
     * 计算极限距离死角惩罚
     */
    public static deadZonePenalty(dist: number, maxReach: number): number {
        if (dist > maxReach) return -1;
        if (maxReach <= 0) return 0;

        const effectiveZone = maxReach * 0.7;
        if (dist <= effectiveZone) return 0;

        const deadZoneRatio = (dist - effectiveZone) / (maxReach - effectiveZone);
        return Math.round(deadZoneRatio * 4);
    }

    /**
     * 计算长武器贴太近惩罚
     */
    public static tooClosePenalty(dist: number, minReach: number): number {
        if (minReach <= 0 || dist >= minReach) return 0;
        return Math.ceil((minReach - dist) / minReach * 3);
    }

    /**
     * 获取有效攻击范围描述
     */
    public static describeRange(dist: number, maxReach: number, minReach: number = 0): string {
        if (dist > maxReach) return 'OUT_OF_RANGE';
        if (minReach > 0 && dist < minReach) return 'TOO_CLOSE';
        const deadZone = maxReach * 0.7;
        if (dist > deadZone) return 'DEAD_ZONE';
        return 'SWEET_SPOT';
    }
}
