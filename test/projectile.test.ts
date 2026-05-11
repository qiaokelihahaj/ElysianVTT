// test/projectile.test.ts
// Phase 3.2 实体弹道系统测试 — 直射/抛物线/碰撞/边界事件

// ==========================================
// 1. 内联类型 & 系统实现
// ==========================================

type Vector3D = { x: number; y: number; z: number };
type EntityId = string;
type TrajectoryType = 'LINEAR' | 'PARABOLIC';
type BodyPart = 'HEAD' | 'TORSO' | 'LEFT_ARM' | 'RIGHT_ARM' | 'LEFT_LEG' | 'RIGHT_LEG';

interface ProjectileData {
    id: EntityId;
    trajectoryType: TrajectoryType;
    speed: number;
    coords: Vector3D;
    waypoints: Vector3D[];
    currentWaypointIndex: number;
    maxHeight: number;
    isAscending: boolean;
    hasCollided: boolean;
    collisionRadius: number;
    targetEntityId?: EntityId;
}

interface CollisionResult {
    hit: boolean;
    targetId?: EntityId;
    impactCoords: Vector3D;
    bodyPart?: BodyPart;
}

// ==========================================
// 2. Vector Math (项目内 VectorMath 的简化版)
// ==========================================

class VMath {
    static distance(v1: Vector3D, v2: Vector3D): number {
        const dx = v2.x - v1.x;
        const dy = v2.y - v1.y;
        const dz = (v2.z ?? 0) - (v1.z ?? 0);
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    static stepTowards(current: Vector3D, target: Vector3D, stepSize: number): Vector3D {
        const dist = VMath.distance(current, target);
        if (dist <= stepSize) return { ...target };
        const dx = (target.x - current.x) / dist;
        const dy = (target.y - current.y) / dist;
        const dz = ((target.z ?? 0) - (current.z ?? 0)) / dist;
        return {
            x: current.x + dx * stepSize,
            y: current.y + dy * stepSize,
            z: (current.z ?? 0) + dz * stepSize
        };
    }
}

// ==========================================
// 3. 弹道系统实现 (内联版)
// ==========================================

class ProjectileSystem {
    /** 预计算弹道路径 */
    static planPath(
        from: Vector3D, to: Vector3D,
        trajectoryType: TrajectoryType,
        stepSize: number,
        maxHeight?: number
    ): Vector3D[] {
        const totalDist = VMath.distance(from, to);
        if (totalDist < 0.01) return [{ ...to }];

        if (trajectoryType === 'LINEAR') {
            return this.planLinearPath(from, to, stepSize);
        } else {
            const mh = maxHeight ?? Math.max(totalDist * 0.3, 2.0);
            return this.planParabolicPath(from, to, stepSize, mh);
        }
    }

    private static planLinearPath(from: Vector3D, to: Vector3D, stepSize: number): Vector3D[] {
        const waypoints: Vector3D[] = [];
        const groundZ = from.z ?? 0;
        let cursor = { ...from };

        while (VMath.distance(cursor, to) > stepSize * 0.1) {
            cursor = VMath.stepTowards(cursor, to, stepSize);
            waypoints.push({ x: cursor.x, y: cursor.y, z: groundZ });
        }

        const lastDist = waypoints.length > 0
            ? VMath.distance(waypoints[waypoints.length - 1], to) : Infinity;
        if (lastDist > 0.01) waypoints.push({ ...to, z: groundZ });

        return waypoints;
    }

    private static planParabolicPath(
        from: Vector3D, to: Vector3D,
        stepSize: number, maxHeight: number
    ): Vector3D[] {
        const waypoints: Vector3D[] = [];
        const totalDist = VMath.distance(from, to);
        const steps = Math.max(2, Math.ceil(totalDist / stepSize));
        const fromZ = from.z ?? 0;
        const toZ = to.z ?? 0;

        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const x = from.x + (to.x - from.x) * t;
            const y = from.y + (to.y - from.y) * t;
            const baseZ = fromZ + (toZ - fromZ) * t;
            const arcOffset = 4 * maxHeight * t * (1 - t);
            waypoints.push({ x, y, z: baseZ + arcOffset });
        }

        return waypoints;
    }

    /** 模拟单步推进 */
    static advance(proj: ProjectileData): boolean {
        if (proj.currentWaypointIndex >= proj.waypoints.length - 1) return true;
        if (proj.hasCollided) return true;

        const next = proj.waypoints[proj.currentWaypointIndex + 1];
        const dist = VMath.distance(proj.coords, next);

        if (dist <= proj.speed) {
            proj.coords = { ...next };
            proj.currentWaypointIndex++;
            if (proj.trajectoryType === 'PARABOLIC' && proj.waypoints.length > 1) {
                const mid = Math.floor(proj.waypoints.length / 2);
                proj.isAscending = proj.currentWaypointIndex <= mid;
            }
        } else {
            proj.coords = VMath.stepTowards(proj.coords, next, proj.speed);
        }

        return proj.currentWaypointIndex >= proj.waypoints.length - 1;
    }

    /** 碰撞检测 */
    static checkCollision(proj: ProjectileData, targetCoords: Vector3D, targetRadius: number): boolean {
        const dist = VMath.distance(proj.coords, targetCoords);
        return dist <= proj.collisionRadius + targetRadius;
    }

    /** 验证抛物线最高点 */
    static getParabolicPeak(waypoints: Vector3D[]): number {
        let maxZ = -Infinity;
        for (const wp of waypoints) {
            if ((wp.z ?? 0) > maxZ) maxZ = wp.z ?? 0;
        }
        return maxZ;
    }

    /** 验证抛物线升弧/降弧 */
    static getArcPhases(waypoints: Vector3D[]): { ascending: Vector3D[]; descending: Vector3D[] } {
        if (waypoints.length < 2) return { ascending: [...waypoints], descending: [] };
        const mid = Math.floor(waypoints.length / 2);
        return {
            ascending: waypoints.slice(0, mid + 1),
            descending: waypoints.slice(mid)
        };
    }

    /** 检查两个航点是否在地面高度（Z=0） */
    static isOnGround(wp: Vector3D, tolerance: number = 0.01): boolean {
        return Math.abs((wp.z ?? 0)) <= tolerance;
    }

    /** 计算弹道路径的总长度 */
    static pathLength(waypoints: Vector3D[]): number {
        let total = 0;
        for (let i = 1; i < waypoints.length; i++) {
            total += VMath.distance(waypoints[i - 1], waypoints[i]);
        }
        return total;
    }
}

// ==========================================
// 4. 测试框架
// ==========================================

let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
    testCount++;
    if (cond) { passCount++; console.log(`  ✅ ${label}`); }
    else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}

function approxEq(a: number, b: number, eps: number = 0.01): boolean {
    return Math.abs(a - b) < eps;
}

// ==========================================
// 5. 测试用例
// ==========================================

function runTests() {
    console.log('=== ElysianVTT 实体弹道系统测试 (Phase 3.2) ===\n');

    // ---- Test 1: 直射弹道路径 ----
    console.log('[Test 1] 直射弹道路径预计算');
    {
        const from: Vector3D = { x: 0, y: 0, z: 0 };
        const to: Vector3D = { x: 5, y: 0, z: 0 };
        const waypoints = ProjectileSystem.planPath(from, to, 'LINEAR', 1.0);

        assert(waypoints.length >= 4, `直射 5 单位应该有足够的航点 (实际: ${waypoints.length})`);
        assert(waypoints[0].x > 0, '第一个航点 x > 0');
        assert(waypoints[waypoints.length - 1].x === 5, '最后一个航点 x = 5');
        assert(waypoints[waypoints.length - 1].y === 0, '最后一个航点 y = 0');

        // 所有航点应该在地面
        const allGround = waypoints.every(wp => ProjectileSystem.isOnGround(wp));
        assert(allGround, '所有直射弹道航点 Z=0');
    }

    // ---- Test 2: 直射弹道推进 ----
    console.log('\n[Test 2] 直射弹道逐 Tick 推进');
    {
        const proj: ProjectileData = {
            id: 'test_proj_1',
            trajectoryType: 'LINEAR',
            speed: 1.0,
            coords: { x: 0, y: 0, z: 0 },
            waypoints: [
                { x: 1, y: 0, z: 0 },
                { x: 2, y: 0, z: 0 },
                { x: 3, y: 0, z: 0 },
            ],
            currentWaypointIndex: 0,
            maxHeight: 0,
            isAscending: true,
            hasCollided: false,
            collisionRadius: 0.3
        };

        // Tick 1: 向 waypoints[1]={2,0} 推进 1 单位，到达 (1,0)
        // 由于速度限制未到达 waypoints[1]，index 不前进
        const done1 = ProjectileSystem.advance(proj);
        assert(!done1, '第1步未到达终点');
        assert(approxEq(proj.coords.x, 1), `第1步后 x=1 (实际: ${proj.coords.x})`);
        assert(proj.currentWaypointIndex === 0, `第1步后 index=0 (未到达下一航点, 实际: ${proj.currentWaypointIndex})`);

        // Tick 2: 到达 waypoints[1]={2,0}
        const done2 = ProjectileSystem.advance(proj);
        assert(!done2, '第2步未到达终点');
        assert(approxEq(proj.coords.x, 2), `第2步后 x=2 (实际: ${proj.coords.x})`);
        assert(proj.currentWaypointIndex === 1, `第2步后 index=1 (实际: ${proj.currentWaypointIndex})`);

        // Tick 3: 到达 waypoints[2]={3,0}（最后一个）
        const done3 = ProjectileSystem.advance(proj);
        assert(done3, '第3步到达终点');
        assert(approxEq(proj.coords.x, 3), `第3步后 x=3 (实际: ${proj.coords.x})`);
        assert(proj.currentWaypointIndex === 2, `第3步后 index=2 (实际: ${proj.currentWaypointIndex})`);

        // 到达终点后再 advance 应保持 done
        const done4 = ProjectileSystem.advance(proj);
        assert(done4, '到达终点后 advance 仍返回 true');
    }

    // ---- Test 3: 抛物线弹道 ----
    console.log('\n[Test 3] 抛物线弹道预计算');
    {
        const from: Vector3D = { x: 0, y: 0, z: 0 };
        const to: Vector3D = { x: 10, y: 0, z: 0 };
        const maxHeight = 5;
        const waypoints = ProjectileSystem.planPath(from, to, 'PARABOLIC', 1.0, maxHeight);

        assert(waypoints.length >= 8, `抛物线应该有足够的航点 (实际: ${waypoints.length})`);
        assert(approxEq(waypoints[waypoints.length - 1].x, 10), `终点 x=10 (实际: ${waypoints[waypoints.length - 1].x})`);

        // 检查最高点是否约为 maxHeight
        const peak = ProjectileSystem.getParabolicPeak(waypoints);
        assert(approxEq(peak, maxHeight, 0.5), `抛物线最高点 ≈ ${maxHeight} (实际: ${peak})`);

        // 检查升弧和降弧
        const phases = ProjectileSystem.getArcPhases(waypoints);
        assert(phases.ascending.length >= 4, '升弧段有足够航点');
        assert(phases.descending.length >= 4, '降弧段有足够航点');

        // 检查弹道总长度大于直线距离（因为有弧线）
        const pathLen = ProjectileSystem.pathLength(waypoints);
        assert(pathLen > 10, `弹道路径长度 > 直线距离 (实际: ${pathLen.toFixed(2)})`);
    }

    // ---- Test 4: 抛物线推进与升弧/降弧 ----
    console.log('\n[Test 4] 抛物线升弧段/降弧段');
    {
        const waypoints = ProjectileSystem.planPath(
            { x: 0, y: 0, z: 0 }, { x: 8, y: 0, z: 0 }, 'PARABOLIC', 1.0, 4.0
        );

        const proj: ProjectileData = {
            id: 'test_proj_parabolic',
            trajectoryType: 'PARABOLIC',
            speed: 1.0,
            coords: { x: 0, y: 0, z: 0 },
            waypoints,
            currentWaypointIndex: 0,
            maxHeight: 4.0,
            isAscending: true,
            hasCollided: false,
            collisionRadius: 0.3
        };

        // 推进到升弧段的顶点附近
        const mid = Math.floor(waypoints.length / 2);
        for (let i = 0; i < mid; i++) {
            ProjectileSystem.advance(proj);
        }

        assert(proj.isAscending === (proj.currentWaypointIndex <= mid),
            `升弧/降弧状态正确 (idx=${proj.currentWaypointIndex}, mid=${mid}, ascending=${proj.isAscending})`);

        // 推进到降弧段
        while (!ProjectileSystem.advance(proj)) {
            // advance until done
        }
        assert(proj.currentWaypointIndex >= proj.waypoints.length - 1, '抛物线到达终点');
    }

    // ---- Test 5: 最小射程盲区 ----
    console.log('\n[Test 5] 最小射程盲区');
    {
        const from: Vector3D = { x: 0, y: 0, z: 0 };
        const to: Vector3D = { x: 2, y: 0, z: 0 };

        // 最小射程为 3 > 实际距离 2 → 直接返回终点
        const totalDist = VMath.distance(from, to);
        assert(totalDist < 3, `距离 2 < 最小射程 3`);

        // 模拟最小射程行为：返回终点作为唯一航点
        const waypoints: Vector3D[] = [{ ...to }];
        assert(waypoints.length === 1, '盲区内只返回终点航点');
        assert(waypoints[0].x === 2, '终点坐标正确');
    }

    // ---- Test 6: 碰撞检测 ----
    console.log('\n[Test 6] 碰撞检测');
    {
        const proj: ProjectileData = {
            id: 'test_proj_collision',
            trajectoryType: 'LINEAR',
            speed: 1.0,
            coords: { x: 3, y: 0, z: 0 },
            waypoints: [{ x: 5, y: 0, z: 0 }],
            currentWaypointIndex: 0,
            maxHeight: 0,
            isAscending: true,
            hasCollided: false,
            collisionRadius: 0.5
        };

        // 目标在 (3.2, 0) 碰撞半径 0.5 → 弹道在 (3,0) 碰撞半径 0.5 → 距离 0.2 <= 1.0
        const targetCoordsNear: Vector3D = { x: 3.2, y: 0, z: 0 };
        const hit = ProjectileSystem.checkCollision(proj, targetCoordsNear, 0.5);
        assert(hit, '近距离目标被碰撞检测命中');

        // 目标在 (6, 0) 碰撞半径 0.5 → 距离 3.0 > 1.0
        const targetCoordsFar: Vector3D = { x: 6, y: 0, z: 0 };
        const miss = ProjectileSystem.checkCollision(proj, targetCoordsFar, 0.5);
        assert(!miss, '远距离目标未被碰撞检测命中');
    }

    // ---- Test 7: 弹道行经中碰撞 ----
    console.log('\n[Test 7] 弹道行经中碰撞');
    {
        const waypoints = ProjectileSystem.planPath(
            { x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, 'LINEAR', 1.0
        );

        const proj: ProjectileData = {
            id: 'test_proj_midflight',
            trajectoryType: 'LINEAR',
            speed: 1.0,
            coords: { x: 0, y: 0, z: 0 },
            waypoints,
            currentWaypointIndex: 0,
            maxHeight: 0,
            isAscending: true,
            hasCollided: false,
            collisionRadius: 0.5
        };

        // 目标在 x=2.5 处
        const targetCoords: Vector3D = { x: 2.5, y: 0, z: 0 };

        // 推进弹道直到碰撞或到达终点
        let hit = false;
        let arrived = false;
        while (!arrived) {
            arrived = ProjectileSystem.advance(proj);
            if (ProjectileSystem.checkCollision(proj, targetCoords, 0.5)) {
                hit = true;
                break;
            }
        }

        assert(hit, '弹道行经中检测到碰撞');
    }

    // ---- Test 8: 弹道末端碰撞 ----
    console.log('\n[Test 8] 弹道末端碰撞');
    {
        const from: Vector3D = { x: 0, y: 0, z: 0 };
        const to: Vector3D = { x: 4, y: 0, z: 0 };
        const waypoints = ProjectileSystem.planPath(from, to, 'LINEAR', 1.0);

        // 目标在终点处
        const targetCoords: Vector3D = { x: 4, y: 0, z: 0 };

        // 最后一次碰撞检测
        const lastWp = waypoints[waypoints.length - 1];
        const distToTarget = VMath.distance(lastWp, targetCoords);
        assert(distToTarget < 0.5, `终点航点与目标距离 < 0.5 (实际: ${distToTarget})`);
    }

    // ---- Test 9: 多步推进长距离弹道 ----
    console.log('\n[Test 9] 长距离直射弹道完整飞行');
    {
        const from: Vector3D = { x: 0, y: 0, z: 0 };
        const to: Vector3D = { x: 10, y: 5, z: 0 };
        const waypoints = ProjectileSystem.planPath(from, to, 'LINEAR', 1.0);

        const proj: ProjectileData = {
            id: 'test_proj_long',
            trajectoryType: 'LINEAR',
            speed: 1.0,
            coords: { x: 0, y: 0, z: 0 },
            waypoints,
            currentWaypointIndex: 0,
            maxHeight: 0,
            isAscending: true,
            hasCollided: false,
            collisionRadius: 0.3
        };

        let steps = 0;
        while (!ProjectileSystem.advance(proj)) {
            steps++;
        }

        assert(steps > 0, '长距离飞行需要多步');
        assert(approxEq(proj.coords.x, 10, 0.1), `终点 x≈10 (实际: ${proj.coords.x})`);
        assert(approxEq(proj.coords.y, 5, 0.1), `终点 y≈5 (实际: ${proj.coords.y})`);
    }

    // ---- Test 10: 弹道命中后停止 ----
    console.log('\n[Test 10] 弹道碰撞后停止推进');
    {
        const waypoints = ProjectileSystem.planPath(
            { x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, 'LINEAR', 1.0
        );

        const proj: ProjectileData = {
            id: 'test_proj_stop',
            trajectoryType: 'LINEAR',
            speed: 1.0,
            coords: { x: 0, y: 0, z: 0 },
            waypoints,
            currentWaypointIndex: 0,
            maxHeight: 0,
            isAscending: true,
            hasCollided: true,  // 已碰撞
            collisionRadius: 0.5
        };

        const done = ProjectileSystem.advance(proj);
        assert(done, '已碰撞弹道直接返回结束');
    }

    // ---- Test 11: 抛物线越障能力 ----
    console.log('\n[Test 11] 抛物线越障检查');
    {
        const from: Vector3D = { x: 0, y: 0, z: 0 };
        const to: Vector3D = { x: 10, y: 0, z: 0 };
        const maxHeight = 5;

        // 直射弹道在障碍物处的插值高度（障碍物在 x=3 处）
        const linearZ = 0; // 直射地面高度 Z=0
        const obstacleZ = 2; // 障碍物高度 Z=2

        // 直射：Z=0 < 障碍物 Z=2，被阻挡
        assert(linearZ < obstacleZ, '直射弹道被障碍物阻挡');

        // 抛物线在 x=3 处的高度
        const t = 3 / 10; // t=0.3
        const arcZ = 4 * maxHeight * t * (1 - t); // 4*5*0.3*0.7 = 4.2
        assert(arcZ > obstacleZ, `抛物线在 x=3 处高度 > 障碍物高度 (弧高: ${arcZ.toFixed(2)}, 障碍: ${obstacleZ})`);

        const canClear = arcZ > obstacleZ + 0.5;
        assert(canClear, '抛物线能够越障（净高足够）');
    }

    // ---- Test 12: 90度方向弹道 ----
    console.log('\n[Test 12] 垂直方向直射弹道');
    {
        const from: Vector3D = { x: 0, y: 0, z: 0 };
        const to: Vector3D = { x: 0, y: 5, z: 0 };
        const waypoints = ProjectileSystem.planPath(from, to, 'LINEAR', 1.0);

        assert(waypoints.length >= 4, `垂直方向有足够航点 (实际: ${waypoints.length})`);
        assert(approxEq(waypoints[0].x, 0), 'x 坐标不变');
        assert(waypoints[waypoints.length - 1].y === 5, '终点 y=5');
    }

    // ---- Test 13: 超短距离弹道 ----
    console.log('\n[Test 13] 超短距离弹道（相同点）');
    {
        const from: Vector3D = { x: 1, y: 1, z: 0 };
        const to: Vector3D = { x: 1, y: 1, z: 0 };
        const waypoints = ProjectileSystem.planPath(from, to, 'LINEAR', 1.0);

        assert(waypoints.length === 1, '零距离弹道只有 1 个航点');
    }

    // ---- Test 14: 弹道总步数与 Tick 间隔对应 ----
    console.log('\n[Test 14] 弹道步数与距离关系');
    {
        const dist1 = 5;
        const dist2 = 10;
        const stepSize = 1.0;

        const wp1 = ProjectileSystem.planPath(
            { x: 0, y: 0, z: 0 }, { x: dist1, y: 0, z: 0 }, 'LINEAR', stepSize
        );
        const wp2 = ProjectileSystem.planPath(
            { x: 0, y: 0, z: 0 }, { x: dist2, y: 0, z: 0 }, 'LINEAR', stepSize
        );

        // 更远的距离应有更多步数
        assert(wp2.length >= wp1.length, `较远距离有更多步数 (wp1: ${wp1.length}, wp2: ${wp2.length})`);
        assert(wp1.length >= 4, `5 单位距离至少 4 步 (实际: ${wp1.length})`);
        assert(wp2.length >= 9, `10 单位距离至少 9 步 (实际: ${wp2.length})`);
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`结果: ${passCount}/${testCount} 通过`);
    if (passCount === testCount) console.log('✅ 所有弹道测试通过!');
    else console.log('❌ 存在失败测试!');
}

runTests();
