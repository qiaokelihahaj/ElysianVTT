// test/projectile-integration.test.ts
// 实体弹道系统集成测试：直射/抛物线/碰撞/混沌命中

// ==========================================
// 1. 内联类型定义
// ==========================================
type EntityId = string;
type TrajectoryType = 'LINEAR' | 'PARABOLIC';
interface Vector3D { x: number; y: number; z: number; }
interface Entity {
  id: EntityId;
  transform: { coords: Vector3D; facing: number };
  physics: { scaleClass: number; collisionRadius: number; mass: number };
  bodyParts?: Record<string, { currentHp: number; maxHp: number; destroyed: boolean }>;
}

// ==========================================
// 2. VectorMath (内联)
// ==========================================
class VectorMath {
  static distance(v1: Vector3D, v2: Vector3D): number {
    const dx = v2.x - v1.x;
    const dy = v2.y - v1.y;
    const dz = (v2.z ?? 0) - (v1.z ?? 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  static normalize(v: Vector3D): Vector3D {
    const mag = Math.sqrt(v.x ** 2 + v.y ** 2 + (v.z ?? 0) ** 2);
    if (mag === 0) return { x: 0, y: 0, z: 0 };
    return { x: v.x / mag, y: v.y / mag, z: (v.z ?? 0) / mag };
  }
  static direction(from: Vector3D, to: Vector3D): Vector3D {
    return { x: to.x - from.x, y: to.y - from.y, z: (to.z ?? 0) - (from.z ?? 0) };
  }
  static stepTowards(current: Vector3D, target: Vector3D, stepSize: number): Vector3D {
    const dist = VectorMath.distance(current, target);
    if (dist <= stepSize) return { x: target.x, y: target.y, z: target.z ?? 0 };
    const dir = VectorMath.normalize(VectorMath.direction(current, target));
    return {
      x: current.x + dir.x * stepSize,
      y: current.y + dir.y * stepSize,
      z: (current.z ?? 0) + (dir.z ?? 0) * stepSize
    };
  }
}

// ==========================================
// 3. 弹道投影系统
// ==========================================
class BallisticsSolver {
  /**
   * 预计算直射弹道路径
   * 从起点到终点逐格推进，返回所有路径格子坐标
   */
  static solveLinear(
    origin: Vector3D,
    target: Vector3D,
    stepSize: number = 1.0
  ): Vector3D[] {
    const path: Vector3D[] = [];
    let cursor = { x: origin.x, y: origin.y, z: origin.z ?? 0 };
    const end = { x: target.x, y: target.y, z: target.z ?? 0 };

    while (VectorMath.distance(cursor, end) > stepSize * 0.5) {
      cursor = VectorMath.stepTowards(cursor, end, stepSize);
      path.push({ x: cursor.x, y: cursor.y, z: cursor.z });
    }
    // 确保终点包含在路径中
    if (path.length === 0 || VectorMath.distance(path[path.length - 1], end) > 0.01) {
      path.push({ ...end });
    }
    return path;
  }

  /**
   * 预计算抛物线弹道路径
   * 包含升弧段和降弧段，可越过中间障碍
   */
  static solveParabolic(
    origin: Vector3D,
    target: Vector3D,
    apexHeight: number,
    stepSize: number = 1.0
  ): Vector3D[] {
    const path: Vector3D[] = [];
    const totalDist = VectorMath.distance(origin, target);
    if (totalDist < 0.01) return [{ ...origin }];

    const numSteps = Math.max(2, Math.ceil(totalDist / stepSize));
    const dir = VectorMath.normalize(VectorMath.direction(origin, target));

    for (let i = 1; i <= numSteps; i++) {
      const t = i / numSteps; // 0..1 归一化进度
      const flatX = origin.x + dir.x * t * totalDist;
      const flatY = origin.y + dir.y * t * totalDist;
      // 抛物线高度：t*(1-t)*4 使中点为最高
      const zOffset = apexHeight * 4 * t * (1 - t);
      const baseZ = (origin.z ?? 0) + ((target.z ?? 0) - (origin.z ?? 0)) * t;
      path.push({ x: flatX, y: flatY, z: baseZ + zOffset });
    }
    return path;
  }

  /**
   * 检查路径上是否有障碍物阻挡
   * 对路径上每个格点检查是否有实体在碰撞范围内
   */
  static checkObstruction(
    path: Vector3D[],
    obstacles: Entity[],
    collisionRadius: number
  ): Entity | null {
    for (const point of path) {
      for (const obs of obstacles) {
        const dist = VectorMath.distance(point, obs.transform.coords);
        if (dist <= collisionRadius + (obs.physics.collisionRadius ?? 0)) {
          return obs;
        }
      }
    }
    return null;
  }

  /**
   * 检查最小射程盲区
   * 目标在最小射程内时产生散布惩罚
   */
  static checkMinimumRange(
    origin: Vector3D,
    target: Vector3D,
    minRange: number
  ): { withinMinRange: boolean; spreadPenalty: number } {
    const dist = VectorMath.distance(origin, target);
    if (dist < minRange) {
      // 盲区惩罚：越近惩罚越大
      const penalty = 1 - (dist / minRange);
      return { withinMinRange: true, spreadPenalty: Math.ceil(penalty * 5) };
    }
    return { withinMinRange: false, spreadPenalty: 0 };
  }

  /**
   * 获取弹道在指定高度层的位置
   * 用于判断是否越过掩体
   */
  static getHeightAt(path: Vector3D[], fraction: number): number {
    if (path.length === 0) return 0;
    const idx = Math.min(path.length - 1, Math.floor(fraction * path.length));
    return path[idx].z;
  }
}

// ==========================================
// 4. 碰撞检定系统
// ==========================================
class CollisionResolver {
  /**
   * 盲目碰撞检定
   * @param d20Roll d20 掷骰
   * @param shooterScale 射击者体型 (scaleClass)
   * @param targetScale 目标体型
   * @param coverDR 掩体提供的碰撞难度
   * @returns 是否命中
   */
  static checkBlindCollision(
    d20Roll: number,
    shooterScale: number,
    targetScale: number,
    coverDR: number = 0
  ): { hit: boolean; threshold: number } {
    // 基础阈值 = 15 - 目标体型差 + 掩体DR
    // 目标体越大越容易命中，掩体越好越难命中
    const sizeBonus = (targetScale - shooterScale) * 2;
    const threshold = 10 - sizeBonus + coverDR;
    return { hit: d20Roll >= threshold, threshold };
  }

  /**
   * 覆盖碰撞检定（掩体命中判定）
   * 被掩体覆盖时，先检定是否命中掩体
   */
  static checkCoverCollision(
    d20Roll: number,
    coverThreshold: number
  ): { hitsCover: boolean } {
    return { hitsCover: d20Roll < coverThreshold };
  }
}

// ==========================================
// 5. 混沌命中 (Chaotic Impact)
// ==========================================
class ChaoticHitResolver {
  /**
   * 混沌命中：流弹击中部位随机结算
   * @param d100Roll d100 掷骰
   * @returns 命中的部位
   */
  static resolveChaoticPart(
    d100Roll: number
  ): string {
    const partTable: { part: string; weight: number }[] = [
      { part: 'HEAD', weight: 5 },     // 低概率
      { part: 'TORSO', weight: 35 },
      { part: 'LEFT_ARM', weight: 15 },
      { part: 'RIGHT_ARM', weight: 15 },
      { part: 'LEFT_LEG', weight: 15 },
      { part: 'RIGHT_LEG', weight: 15 },
    ];
    const totalWeight = partTable.reduce((s, e) => s + e.weight, 0);
    const normalized = ((d100Roll - 1) / 100) * totalWeight;
    let cumulative = 0;
    for (const entry of partTable) {
      cumulative += entry.weight;
      if (normalized < cumulative) return entry.part;
    }
    return 'TORSO';
  }

  /**
   * 混沌伤害结算
   * 固定伤害值按比例均匀分配到所有部位
   */
  static distributeDamageUniform(
    totalDamage: number,
    bodyParts: Record<string, { currentHp: number; maxHp: number; destroyed: boolean }>
  ): Record<string, number> {
    const activeParts = Object.entries(bodyParts).filter(([_, ps]) => !ps.destroyed);
    if (activeParts.length === 0) return {};

    const perPart = Math.floor(totalDamage / activeParts.length);
    const result: Record<string, number> = {};
    for (const [name] of activeParts) {
      result[name] = perPart;
    }
    // 余数分配给躯干
    const remainder = totalDamage - perPart * activeParts.length;
    if (remainder > 0 && result['TORSO'] !== undefined) {
      result['TORSO'] += remainder;
    }
    return result;
  }
}

// ==========================================
// 6. 测试框架
// ==========================================
let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
  testCount++;
  if (cond) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}
function assertEqual<T>(actual: T, expected: T, label: string) {
  testCount++;
  if (actual === expected) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label} (期望=${expected}, 实际=${actual})`); process.exitCode = 1; }
}

// ==========================================
// 7. 场景测试
// ==========================================
function runTests() {
  console.log('=== ElysianVTT 实体弹道系统集成测试 ===\n');

  // ===============================================
  // Scenario A: 直射弹道 — 水平直线路径覆盖
  // ===============================================
  console.log('[Scenario A] 直射弹道 — 水平直线路径');
  {
    const origin = { x: 0, y: 0, z: 0 };
    const target = { x: 5, y: 0, z: 0 };

    const path = BallisticsSolver.solveLinear(origin, target, 1.0);
    assert(path.length >= 5, `5格距离生成 ${path.length} 个路径点`);
    assert(path[0].x === 1, `第1个路径点 x=1 (实际=${path[0].x})`);
    assert(path[1].x === 2, `第2个路径点 x=2`);
    assert(path[2].x === 3, `第3个路径点 x=3`);
    assert(path[3].x === 4, `第4个路径点 x=4`);
    assert(Math.abs(path[path.length - 1].x - 5) < 0.01, `终点 x=5`);

    // 所有路径点 z=0
    for (const p of path) {
      assert(p.z === 0, `直射路径点 z=0 (实际=${p.z})`);
    }
    // Y坐标不变
    for (const p of path) {
      assert(Math.abs(p.y) < 0.01, `直射路径点 y=0`);
    }
  }

  // ===============================================
  // Scenario B: 抛物线弹道 — 越障能力 + 盲区
  // ===============================================
  console.log('\n[Scenario B] 抛物线弹道 — 越障与盲区');
  {
    const origin = { x: 0, y: 0, z: 0 };
    const target = { x: 8, y: 0, z: 0 };

    // 抛物线：apexHeight=3 最高点高度3
    const path = BallisticsSolver.solveParabolic(origin, target, 3.0, 1.0);
    assert(path.length >= 4, `8格距离生成 ${path.length} 个路径点`);

    // 升弧段：前半段 z 递增
    const midIdx = Math.floor(path.length / 2);
    const firstHalf = path.slice(0, midIdx);
    // 验证升弧：z = zOffset，应为抛物线趋势
    assert(path[0].z > 0, `升弧段起点 z>0 (实际=${path[0].z})`);
    const midPoint = path[midIdx];
    assert(midPoint.z > 0, `中间点 z>0 (实际=${midPoint.z})`);

    // 验证抛物线最高点 z>0 且拱高满足预期
    const maxZ = Math.max(...path.map(p => p.z));
    assert(maxZ >= 3.0, `最高点 z=${maxZ.toFixed(2)} >= 3.0 (apexHeight=3)`);

    // 最小射程盲区
    const blindResultClose = BallisticsSolver.checkMinimumRange(origin, { x: 1, y: 0, z: 0 }, 3);
    assert(blindResultClose.withinMinRange === true, '目标在 minRange=3 内 → 盲区');
    assert(blindResultClose.spreadPenalty > 0, '盲区散布惩罚 > 0');

    const blindResultFar = BallisticsSolver.checkMinimumRange(origin, { x: 5, y: 0, z: 0 }, 3);
    assert(blindResultFar.withinMinRange === false, '目标超出 minRange=3 → 非盲区');
    assertEqual(blindResultFar.spreadPenalty, 0, '散布惩罚 = 0');
  }

  // ===============================================
  // Scenario C: 抛物线越障 — 高弹道绕过矮掩体
  // ===============================================
  console.log('\n[Scenario C] 抛物线越障 — 越过矮掩体');
  {
    const origin = { x: 0, y: 0, z: 0 };
    const target = { x: 6, y: 0, z: 0 };
    // 掩体在 x=3, 高度 z=1
    const cover: Entity = {
      id: 'low_wall',
      transform: { coords: { x: 3, y: 0, z: 0 }, facing: 0 },
      physics: { scaleClass: 1, collisionRadius: 0.5, mass: 100 }
    };

    // 直射弹道 → 被掩体阻挡
    const linearPath = BallisticsSolver.solveLinear(origin, target, 0.5);
    const linearBlocked = BallisticsSolver.checkObstruction(linearPath, [cover], 0.3);
    assert(linearBlocked !== null, '直射弹道被掩体阻挡');

    // 抛物线 (apexHeight=3) → 越过掩体
    const parabolicPath = BallisticsSolver.solveParabolic(origin, target, 3.0, 0.5);
    const parabollicBlocked = BallisticsSolver.checkObstruction(parabolicPath, [cover], 0.3);
    assert(parabollicBlocked === null, '高抛物线弹道绕过掩体');

    // 验证抛物线的中点高度高于掩体
    const midIdx = Math.floor(parabolicPath.length / 2);
    const heightOverCover = parabolicPath[midIdx].z;
    assert(heightOverCover > 1.0, `抛物线在掩体上方通过 (z=${heightOverCover.toFixed(2)} > 掩体 z=1)`);
  }

  // ===============================================
  // Scenario D: 碰撞检定 — 盲目碰撞 + 体型影响
  // ===============================================
  console.log('\n[Scenario D] 碰撞检定 — 盲骰命中判定');
  {
    // 小体型射手 vs 大体型目标 → 易命中
    const smallShooter = { hit: false, threshold: 0 };
    const result1 = CollisionResolver.checkBlindCollision(12, 0, 2, 0);
    // 体型差=2, sizeBonus=4, 阈值=10-4=6, d20=12 >= 6 → 命中
    assert(result1.hit === true, `体型差大: d20=12 >= 阈值${result1.threshold} → 命中`);

    // 大体型射手 vs 小体型目标 → 难命中
    const result2 = CollisionResolver.checkBlindCollision(12, 2, 0, 0);
    // 体型差=-2, sizeBonus=-4, 阈值=10-(-4)=14, d20=12 < 14 → 未命中
    assert(result2.hit === false, `体型差小: d20=12 < 阈值${result2.threshold} → 未命中`);

    // 掩体增加命中难度
    const result3 = CollisionResolver.checkBlindCollision(15, 1, 1, 5);
    // 体型相同, 阈值=10+5=15
    assert(result3.hit === true, `掩体DR=5: d20=15 >= 15 → 擦边命中`);

    const result4 = CollisionResolver.checkBlindCollision(14, 1, 1, 5);
    assert(result4.hit === false, `掩体DR=5: d20=14 < 15 → 未命中`);

    // d20=1 永远失败（除非阈值<=1）
    const result5 = CollisionResolver.checkBlindCollision(1, 2, 2, 0);
    assert(result5.hit === false, 'd20=1 → 脱靶');
  }

  // ===============================================
  // Scenario E: 掩体覆盖 — 命中掩体 vs 命中目标
  // ===============================================
  console.log('\n[Scenario E] 掩体覆盖 — 命中判定分流');
  {
    // 掩体覆盖阈值=8：d20 < 8 命中掩体
    const r1 = CollisionResolver.checkCoverCollision(5, 8);
    assert(r1.hitsCover === true, 'd20=5 < 8 → 命中掩体');

    const r2 = CollisionResolver.checkCoverCollision(10, 8);
    assert(r2.hitsCover === false, 'd20=10 >= 8 → 越过掩体命中目标');

    // 高掩体（阈值高）更容易被命中
    const r3 = CollisionResolver.checkCoverCollision(15, 16);
    assert(r3.hitsCover === true, 'd20=15 < 16 → 命中全掩体');
  }

  // ===============================================
  // Scenario F: 混沌命中 — 流弹部位随机分配
  // ===============================================
  console.log('\n[Scenario F] 混沌命中 — 流弹部位随机分配');
  {
    // d100=10 → 头部(权重5) 在[0,5)范围, 所以d100=10在[5,20)→TORSO
    const part1 = ChaoticHitResolver.resolveChaoticPart(10);
    assertEqual(part1, 'TORSO', 'd100=10 → TORSO');

    // d100=1 → HEAD (权重5)
    const part2 = ChaoticHitResolver.resolveChaoticPart(1);
    assertEqual(part2, 'HEAD', 'd100=1 → HEAD');

    // d100=100 → RIGHT_LEG（最后一个区域）
    const part3 = ChaoticHitResolver.resolveChaoticPart(100);
    assertEqual(part3, 'RIGHT_LEG', 'd100=100 → RIGHT_LEG');

    // d100=21 → TORSO (HEAD=5, TORSO=5+35=40, 20<40)
    const part4 = ChaoticHitResolver.resolveChaoticPart(21);
    assertEqual(part4, 'TORSO', 'd100=21 → TORSO');

    // d100=60 → RIGHT_ARM (累积 HEAD5+TORSO35+LEFT_ARM15=55, 55<=59<70)
    const part5 = ChaoticHitResolver.resolveChaoticPart(60);
    assertEqual(part5, 'RIGHT_ARM', 'd100=60 → RIGHT_ARM');
  }

  // ===============================================
  // Scenario G: 混沌伤害均匀分配
  // ===============================================
  console.log('\n[Scenario G] 混沌伤害 — 均匀分配到各部位');
  {
    const bodyParts = {
      HEAD: { currentHp: 30, maxHp: 30, destroyed: false },
      TORSO: { currentHp: 100, maxHp: 100, destroyed: false },
      LEFT_ARM: { currentHp: 30, maxHp: 30, destroyed: false },
      RIGHT_ARM: { currentHp: 30, maxHp: 30, destroyed: false },
      LEFT_LEG: { currentHp: 35, maxHp: 35, destroyed: false },
      RIGHT_LEG: { currentHp: 35, maxHp: 35, destroyed: false },
    };

    // 30点伤害均分到6个部位 = 每部位5点
    const dist = ChaoticHitResolver.distributeDamageUniform(30, bodyParts);
    assertEqual(dist['HEAD'], 5, 'HEAD 分到 5 点');
    assertEqual(dist['TORSO'], 5, 'TORSO 分到 5 点');
    assertEqual(dist['LEFT_ARM'], 5, 'LEFT_ARM 分到 5 点');

    // 31点伤害: 每部位 floor(31/6)=5, 余数1 → 给 TORSO
    const dist2 = ChaoticHitResolver.distributeDamageUniform(31, bodyParts);
    assertEqual(dist2['TORSO'], 6, 'TORSO 分到 6 点（含余数）');
    assertEqual(dist2['HEAD'], 5, 'HEAD 分到 5 点');

    // 已破坏部位不分配伤害
    const partsWithDestroyed = {
      ...bodyParts,
      LEFT_ARM: { currentHp: 0, maxHp: 30, destroyed: true },
    };
    const dist3 = ChaoticHitResolver.distributeDamageUniform(25, partsWithDestroyed);
    assert(dist3['LEFT_ARM'] === undefined, 'LEFT_ARM 已破坏 → 不分伤害');
    assertEqual(dist3['TORSO'], 5, 'TORSO 仍分到 5 点');
  }

  // ===============================================
  // Scenario H: 整合 — 完整弹道射击流程
  // ===============================================
  console.log('\n[Scenario H] 整合 — 弹道射击完整流程');
  {
    // 射手 → 目标，中间有矮墙
    const origin = { x: 0, y: 0, z: 0 };
    const target = { x: 6, y: 0, z: 0 };
    const lowWall: Entity = {
      id: 'wall',
      transform: { coords: { x: 3, y: 0, z: 0 }, facing: 0 },
      physics: { scaleClass: 2, collisionRadius: 0.5, mass: 100 }
    };

    // 步骤1: 选择抛物线 (apex=3) 越障
    const path = BallisticsSolver.solveParabolic(origin, target, 3.0, 0.5);
    const blocked = BallisticsSolver.checkObstruction(path, [lowWall], 0.3);
    assert(blocked === null, '抛物线路径无阻挡');

    // 步骤2: 碰撞检定
    const collision = CollisionResolver.checkBlindCollision(14, 1, 1, 0);
    assert(collision.hit === true, '碰撞检定命中');

    // 步骤3: 若是流弹，用混沌命中确定部位
    const part = ChaoticHitResolver.resolveChaoticPart(42);
    assert(['TORSO', 'LEFT_ARM', 'RIGHT_ARM'].includes(part),
      `混沌命中部位=${part} (合理部位范围)`);
  }

  // ===============================================
  // Scenario I: 最小射程盲区 — 抛物线的近端失效区
  // ===============================================
  console.log('\n[Scenario I] 最小射程盲区 — 近端失效');
  {
    // 抛物线武器如迫击炮有最小射程
    const origin = { x: 0, y: 0, z: 0 };

    // 目标在盲区内 (1.5格 < minRange=4)
    const blindCheck = BallisticsSolver.checkMinimumRange(origin, { x: 1.5, y: 0, z: 0 }, 4);
    assert(blindCheck.withinMinRange === true, '1.5 < 4 → 盲区内');
    assert(blindCheck.spreadPenalty >= 3, '接近盲区边界 → 散布惩罚≥3');

    // 目标刚好在盲区边界
    const boundaryCheck = BallisticsSolver.checkMinimumRange(origin, { x: 4, y: 0, z: 0 }, 4);
    assert(boundaryCheck.withinMinRange === false, '4 = minRange → 非盲区');

    // 目标在盲区内极近处
    const pointBlank = BallisticsSolver.checkMinimumRange(origin, { x: 0.5, y: 0, z: 0 }, 4);
    assert(pointBlank.spreadPenalty >= 4, '极近距离 → 散布惩罚≥4');
  }

  // ===============================================
  // Scenario J: 边界 — 零距离零点射
  // ===============================================
  console.log('\n[Scenario J] 边界条件 — 零距离射击');
  {
    const origin = { x: 0, y: 0, z: 0 };
    const target = { x: 0, y: 0, z: 0 };

    const linearPath = BallisticsSolver.solveLinear(origin, target, 1.0);
    assert(linearPath.length >= 1, '零距离依然生成至少1个路径点');
    assert(Math.abs(linearPath[0].x) < 0.01, '零距离路径点在原点');

    // 零距离碰撞检定 (自动命中)
    const collision = CollisionResolver.checkBlindCollision(20, 1, 1, 0);
    assert(collision.hit === true, 'd20=20 → 必然命中');
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有弹道集成测试通过!');
}

runTests();
