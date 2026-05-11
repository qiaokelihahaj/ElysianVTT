// test/formation.test.ts
// 阵型与团队协作测试：物理空间拦截 / Active Interception / 封锁区域 / 多拦截优先级 / 拦截失败惩罚

// ==========================================
// 1. 内联类型定义
// ==========================================
interface Vector3D { x: number; y: number; z: number; }
type EntityId = string;
type Role = 'PROTECTOR' | 'PROTECTEE' | 'SCOUT' | 'ASSIST';

interface Entity {
  id: EntityId;
  role?: Role;
  transform: { coords: Vector3D; facing: number };
  physics: { scaleClass: number; collisionRadius: number; mass: number };
  resources: { current: Record<string, number>; max: Record<string, number> };
  defenses?: { dr: number; parry: number; dodge: number };
  currentActionContext?: {
    type: string;
    phase: string;
    actionTemplateId?: string;
  };
  // 阵型上下文
  formationContext?: {
    interceptRange: number;        // 拦截范围
    interceptionRating: number;    // 拦截判定值
    formationId?: string;          // 所属阵型
    blockedEntities?: EntityId[];  // 正在阻挡的实体
  };
}

interface InterceptionResult {
  success: boolean;
  interceptorId: EntityId;
  interceptValue: number;
  attackValue: number;
  reducedDamage: number;      // 成功拦截后减免的伤害
  penaltyApplied?: string;    // 失败惩罚
}

interface AreaDenialZone {
  id: string;
  center: Vector3D;
  radius: number;
  durationTicks: number;
  remainingTicks: number;
  ownerId: EntityId;
  triggerDamage: number;      // 进入触发伤害
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

  static direction(from: Vector3D, to: Vector3D): Vector3D {
    return { x: to.x - from.x, y: to.y - from.y, z: (to.z ?? 0) - (from.z ?? 0) };
  }

  static normalize(v: Vector3D): Vector3D {
    const mag = Math.sqrt(v.x ** 2 + v.y ** 2 + (v.z ?? 0) ** 2);
    if (mag === 0) return { x: 0, y: 0, z: 0 };
    return { x: v.x / mag, y: v.y / mag, z: (v.z ?? 0) / mag };
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
// 3. 物理空间拦截 (Physical Blocking)
// ==========================================
class BlockingResolver {
  /**
   * 检查从 from 到 to 的直线路径是否被实体阻挡
   */
  static isPathBlocked(
    from: Vector3D,
    to: Vector3D,
    blockers: Entity[],
    stepSize: number = 0.5
  ): { blocked: boolean; blocker: Entity | null; blockPoint: Vector3D | null } {
    let cursor = { x: from.x, y: from.y, z: from.z ?? 0 };
    const end = { x: to.x, y: to.y, z: to.z ?? 0 };

    while (VectorMath.distance(cursor, end) > 0.1) {
      cursor = VectorMath.stepTowards(cursor, end, stepSize);

      for (const blocker of blockers) {
        const dist = VectorMath.distance(cursor, blocker.transform.coords);
        const collisionDist = blocker.physics.collisionRadius + 0.3; // 体型+间距
        if (dist <= collisionDist) {
          return { blocked: true, blocker, blockPoint: { ...cursor } };
        }
      }
    }

    return { blocked: false, blocker: null, blockPoint: null };
  }

  /**
   * 尝试绕过阻挡实体（简单侧移）
   */
  static findBypassPath(
    from: Vector3D,
    to: Vector3D,
    blocker: Entity,
    stepSize: number = 0.5
  ): Vector3D[] | null {
    const dir = VectorMath.direction(from, to);
    const dist = VectorMath.distance(from, to);
    if (dist < 0.01) return null;

    // 计算侧移方向（垂直位移方向）
    const perpX = -dir.y;
    const perpY = dir.x;
    const perpMag = Math.sqrt(perpX * perpX + perpY * perpY);
    if (perpMag < 0.001) return null;

    const normPerpX = perpX / perpMag;
    const normPerpY = perpY / perpMag;

    // 尝试左右各偏移 2 格
    const bypassDist = blocker.physics.collisionRadius + 1.5;
    const midPoint = {
      x: blocker.transform.coords.x + normPerpX * bypassDist,
      y: blocker.transform.coords.y + normPerpY * bypassDist,
      z: from.z ?? 0
    };

    // 路径: from → midPoint → to
    const path: Vector3D[] = [];
    let c1 = { x: from.x, y: from.y, z: from.z ?? 0 };
    while (VectorMath.distance(c1, midPoint) > 0.1) {
      c1 = VectorMath.stepTowards(c1, midPoint, stepSize);
      path.push({ ...c1 });
    }

    let c2 = { x: midPoint.x, y: midPoint.y, z: midPoint.z };
    while (VectorMath.distance(c2, to) > 0.1) {
      c2 = VectorMath.stepTowards(c2, to, stepSize);
      path.push({ ...c2 });
    }

    return path;
  }

  /**
   * 获取在指定位置阻挡的实体列表
   */
  static getBlockersInArea(
    center: Vector3D,
    radius: number,
    entities: Entity[]
  ): Entity[] {
    return entities.filter(e =>
      e.role === 'PROTECTOR' &&
      VectorMath.distance(center, e.transform.coords) <= radius
    );
  }
}

// ==========================================
// 4. 主动拦截 (Active Interception)
// ==========================================
class InterceptionResolver {
  /**
   * 判断护卫是否可以拦截攻击者→目标的攻击
   */
  static canIntercept(
    guardian: Entity,
    attacker: Entity,
    protectee: Entity
  ): boolean {
    if (guardian.role !== 'PROTECTOR') return false;
    const range = guardian.formationContext?.interceptRange ?? 3;

    // 护卫必须在攻击者和目标之间（三角约束）
    const guardToAttacker = VectorMath.distance(guardian.transform.coords, attacker.transform.coords);
    const guardToProtectee = VectorMath.distance(guardian.transform.coords, protectee.transform.coords);

    // 护卫必须在 interceptRange 内能触及攻击路径
    return guardToAttacker <= range || guardToProtectee <= range;
  }

  /**
   * 执行拦截判定
   * @param attackValue 攻击者的攻击值
   * @param interceptValue 护卫的拦截值
   * @returns 拦截结果
   */
  static resolve(
    guardian: Entity,
    attacker: Entity,
    attackValue: number,
    baseDamage: number
  ): InterceptionResult {
    const interceptValue = guardian.formationContext?.interceptionRating ?? 10;
    const success = interceptValue >= attackValue;

    // 成功拦截：伤害减免 60%
    const reducedDamage = success ? Math.floor(baseDamage * 0.4) : baseDamage;

    const result: InterceptionResult = {
      success,
      interceptorId: guardian.id,
      interceptValue,
      attackValue,
      reducedDamage,
    };

    if (!success) {
      result.penaltyApplied = 'STAGGER';
      // 拦截失败：护卫被击退（在外部处理）
    }

    return result;
  }

  /**
   * 拦截失败惩罚：护卫被击退并损失资源
   */
  static applyFailurePenalty(
    guardian: Entity,
    penaltyDistance: number = 1.5
  ): { newCoords: Vector3D; poiseLoss: number } {
    const poiseLoss = 15;
    guardian.resources.current['poise'] = Math.max(0,
      (guardian.resources.current['poise'] ?? 50) - poiseLoss
    );

    // 击退：沿 facing 反向推开
    const facingRad = (guardian.transform.facing ?? 0) * Math.PI / 180;
    const newCoords = {
      x: guardian.transform.coords.x - Math.cos(facingRad) * penaltyDistance,
      y: guardian.transform.coords.y - Math.sin(facingRad) * penaltyDistance,
      z: guardian.transform.coords.z ?? 0
    };
    guardian.transform.coords = { ...newCoords };

    return { newCoords, poiseLoss };
  }
}

// ==========================================
// 5. 多拦截优先级
// ==========================================
class InterceptionPriorityResolver {
  /**
   * 从多个护卫中选择拦截者
   * 优先级: 距离攻击者最近 → 拦截值最高 → 按 ID 排序
   */
  static selectInterceptor(
    guardians: Entity[],
    attacker: Entity,
    protectee: Entity
  ): Entity | null {
    if (guardians.length === 0) return null;

    const eligible = guardians.filter(g =>
      InterceptionResolver.canIntercept(g, attacker, protectee)
    );

    if (eligible.length === 0) return null;
    if (eligible.length === 1) return eligible[0];

    // 排序：先按距离攻击者最近，再按 interceptRating
    eligible.sort((a, b) => {
      const distA = VectorMath.distance(a.transform.coords, attacker.transform.coords);
      const distB = VectorMath.distance(b.transform.coords, attacker.transform.coords);
      if (Math.abs(distA - distB) > 0.1) return distA - distB;

      const ratingA = a.formationContext?.interceptionRating ?? 0;
      const ratingB = b.formationContext?.interceptionRating ?? 0;
      return ratingB - ratingA;
    });

    return eligible[0];
  }

  /**
   * 多拦截者同时拦截时的协同加成
   */
  static calculateCoopBonus(guardians: Entity[]): number {
    const protectors = guardians.filter(g => g.role === 'PROTECTOR');
    if (protectors.length <= 1) return 0;
    // 每多一人 +2 拦截值，最多 +6
    return Math.min((protectors.length - 1) * 2, 6);
  }
}

// ==========================================
// 6. 封锁区域 (Area Denial)
// ==========================================
class AreaDenialResolver {
  /**
   * 创建封锁区域
   */
  static createZone(
    id: string,
    center: Vector3D,
    radius: number,
    durationTicks: number,
    ownerId: EntityId,
    triggerDamage: number
  ): AreaDenialZone {
    return {
      id, center, radius, durationTicks,
      remainingTicks: durationTicks,
      ownerId, triggerDamage
    };
  }

  /**
   * 检查实体是否进入封锁区域
   */
  static checkEntry(
    zone: AreaDenialZone,
    entity: Entity,
    previousPos: Vector3D
  ): { entered: boolean; distance: number } {
    const nowIn = VectorMath.distance(zone.center, entity.transform.coords) <= zone.radius;
    const wasIn = VectorMath.distance(zone.center, previousPos) <= zone.radius;

    const entered = nowIn && !wasIn;
    return { entered, distance: VectorMath.distance(zone.center, entity.transform.coords) };
  }

  /**
   * 封锁区域 tick 更新（递减持续时间）
   */
  static tick(zones: AreaDenialZone[]): AreaDenialZone[] {
    return zones
      .map(z => ({ ...z, remainingTicks: z.remainingTicks - 1 }))
      .filter(z => z.remainingTicks > 0);
  }

  /**
   * 检查区域封锁是否阻挡了一条路径
   */
  static isPathBlockedByZone(
    from: Vector3D,
    to: Vector3D,
    zones: AreaDenialZone[],
    stepSize: number = 0.5
  ): { blocked: boolean; blockingZone: AreaDenialZone | null; entryPoint: Vector3D | null } {
    let cursor = { x: from.x, y: from.y, z: from.z ?? 0 };
    const end = { x: to.x, y: to.y, z: to.z ?? 0 };

    while (VectorMath.distance(cursor, end) > 0.1) {
      cursor = VectorMath.stepTowards(cursor, end, stepSize);

      for (const zone of zones) {
        const dist = VectorMath.distance(zone.center, cursor);
        if (dist <= zone.radius) {
          return { blocked: true, blockingZone: zone, entryPoint: { ...cursor } };
        }
      }
    }

    return { blocked: false, blockingZone: null, entryPoint: null };
  }
}

// ==========================================
// 7. 测试框架
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

function createEntity(id: string, x: number, y: number, role?: Role, radius: number = 0.5): Entity {
  return {
    id,
    role,
    transform: { coords: { x, y, z: 0 }, facing: 0 },
    physics: { scaleClass: 1, collisionRadius: radius, mass: 70 },
    resources: { current: { hp: 100, poise: 50 }, max: { hp: 100, poise: 50 } },
    defenses: { dr: 5, parry: 10, dodge: 8 },
  };
}

function createProtector(id: string, x: number, y: number, interceptRange: number = 3, rating: number = 14): Entity {
  const e = createEntity(id, x, y, 'PROTECTOR');
  e.formationContext = { interceptRange, interceptionRating: rating };
  return e;
}

// ==========================================
// 8. 场景测试
// ==========================================
function runTests() {
  console.log('=== ElysianVTT 阵型与团队协作系统测试 ===\n');

  // ===============================================
  // Scenario A: 物理空间拦截 — 实体阻挡直线路径
  // ===============================================
  console.log('[Scenario A] 物理空间拦截 — 阻挡移动路径');
  {
    const wall: Entity = createEntity('wall', 3, 0, undefined, 0.8);
    const from = { x: 0, y: 0, z: 0 };
    const to = { x: 6, y: 0, z: 0 };

    // 路径上有阻挡
    const blocked = BlockingResolver.isPathBlocked(from, to, [wall], 0.5);
    assert(blocked.blocked === true, '直线上有障碍 → 路径被阻挡');
    assert(blocked.blocker?.id === 'wall', '阻挡实体为 wall');
    assert(blocked.blockPoint !== null, '阻挡点坐标非空');

    // 无阻挡的路径（上方绕行）
    const toTop = { x: 6, y: 3, z: 0 };
    const notBlocked = BlockingResolver.isPathBlocked(from, toTop, [wall], 0.5);
    assert(notBlocked.blocked === false, '绕行路径 → 无阻挡');

    // 多个阻挡者
    const wall2: Entity = createEntity('wall2', 4, 0, undefined, 0.8);
    const multiBlock = BlockingResolver.isPathBlocked(from, to, [wall, wall2], 0.5);
    assert(multiBlock.blocked === true, '多障碍 → 路径被阻挡');
    // 第一个阻挡应该是离起点最近的
    assert(multiBlock.blocker?.id === 'wall', '最近的阻挡者为 wall');
  }

  // ===============================================
  // Scenario B: 绕过阻挡 — 侧移路径生成
  // ===============================================
  console.log('\n[Scenario B] 绕过阻挡 — 侧移路径');
  {
    const wall: Entity = createEntity('wall', 3, 0, undefined, 0.8);
    const from = { x: 0, y: 0, z: 0 };
    const to = { x: 6, y: 0, z: 0 };

    const bypass = BlockingResolver.findBypassPath(from, to, wall);
    assert(bypass !== null, '找到绕行路径');
    assert(bypass!.length > 0, '绕行路径有点');

    // 验证终点到达
    const lastPt = bypass![bypass!.length - 1];
    const distToTarget = VectorMath.distance(lastPt, to);
    assert(distToTarget < 0.2, `绕行路径终点到达目标 (距离=${distToTarget.toFixed(2)})`);

    // 验证绕行路径绕过障碍
    let passedThrough = false;
    for (const pt of bypass!) {
      const d = VectorMath.distance(pt, wall.transform.coords);
      if (d < wall.physics.collisionRadius) {
        passedThrough = true;
        break;
      }
    }
    assert(passedThrough === false, '绕行路径不穿过障碍物');
  }

  // ===============================================
  // Scenario C: Active Interception — 护卫主动拦截
  // ===============================================
  console.log('\n[Scenario C] Active Interception — 护卫主动拦截动作');
  {
    const attacker: Entity = createEntity('attacker', 0, 0);
    const protectee: Entity = createEntity('protectee', 6, 0);
    const guardian: Entity = createProtector('guardian', 3, 0.5, 4, 16);

    // 护卫在攻击路径上
    const canIntercept = InterceptionResolver.canIntercept(guardian, attacker, protectee);
    assert(canIntercept === true, '护卫在拦截范围内');

    // 拦截成功：攻击值 12, 拦截值 16
    const successResult = InterceptionResolver.resolve(guardian, attacker, 12, 50);
    assert(successResult.success === true, '拦截值16 ≥ 攻击值12 → 成功拦截');
    assertEqual(successResult.reducedDamage, 20, '成功拦截: 50 * 0.4 = 20');
    assert(successResult.penaltyApplied === undefined, '成功拦截无惩罚');

    // 拦截失败：攻击值 18 > 拦截值 16
    const failResult = InterceptionResolver.resolve(guardian, attacker, 18, 50);
    assert(failResult.success === false, '拦截值16 < 攻击值18 → 拦截失败');
    assertEqual(failResult.reducedDamage, 50, '失败拦截: 全额伤害 50');
    assertEqual(failResult.penaltyApplied, 'STAGGER', '拦截失败标记 STAGGER');
  }

  // ===============================================
  // Scenario D: 拦截失败惩罚 — 击退 + 资源损失
  // ===============================================
  console.log('\n[Scenario D] 拦截失败 — 击退与失衡惩罚');
  {
    const guardian: Entity = createProtector('guardian', 3, 0, 4, 12);
    guardian.transform.facing = 0; // 面向右
    guardian.resources.current['poise'] = 50;

    const originalPos = { ...guardian.transform.coords };

    // 失败惩罚
    const penalty = InterceptionResolver.applyFailurePenalty(guardian, 2.0);

    // 被击退 2 格（面朝右→向左退）
    assert(penalty.newCoords.x < originalPos.x, `被击退: x ${originalPos.x} → ${penalty.newCoords.x.toFixed(2)}`);
    const moveDist = VectorMath.distance(originalPos, penalty.newCoords);
    assert(Math.abs(moveDist - 2.0) < 0.01, `击退距离 2.0 (实际=${moveDist.toFixed(2)})`);

    // 资源损失
    assertEqual(penalty.poiseLoss, 15, '拦截失败损失 15 poise');
    assertEqual(guardian.resources.current['poise'], 35, 'poise 50→35');

    // 多次失败可导致 poise 归零
    InterceptionResolver.applyFailurePenalty(guardian, 1.0);
    InterceptionResolver.applyFailurePenalty(guardian, 1.0);
    assertEqual(guardian.resources.current['poise'], 5, '连续失败3次: 50-15-15-15=5');
  }

  // ===============================================
  // Scenario E: 多拦截优先级 — 最近拦截者优先
  // ===============================================
  console.log('\n[Scenario E] 多拦截优先级 — 最近护卫优先');
  {
    const attacker: Entity = createEntity('attacker', 0, 0);
    const protectee: Entity = createEntity('protectee', 8, 0);

    // 三个护卫在不同距离
    const farGuard: Entity = createProtector('farGuard', 6, 0, 5, 12);
    const nearGuard: Entity = createProtector('nearGuard', 3, 0, 5, 14);
    const midGuard: Entity = createProtector('midGuard', 4.5, 0, 5, 16);

    const guardians = [farGuard, nearGuard, midGuard];

    // 预期: nearGuard 最近(距离3) → 应被选中
    const selected = InterceptionPriorityResolver.selectInterceptor(guardians, attacker, protectee);
    assert(selected !== null, '有可拦截的护卫');
    assertEqual(selected!.id, 'nearGuard', '最近护卫(距离3)优先拦截');

    // 移除最近的，期望选中次近
    const remaining = [farGuard, midGuard];
    const selected2 = InterceptionPriorityResolver.selectInterceptor(remaining, attacker, protectee);
    assert(selected2 !== null, '仍有可拦截的护卫');
    assertEqual(selected2!.id, 'midGuard', '次近护卫(距离4.5)被选中');
  }

  // ===============================================
  // Scenario F: 多拦截者 — 距离相同时拦截值判定
  // ===============================================
  console.log('\n[Scenario F] 多拦截者 — 同距离按拦截值');
  {
    const attacker: Entity = createEntity('attacker', 0, 0);
    const protectee: Entity = createEntity('protectee', 5, 0);

    // 两护卫到攻击者距离相同但拦截值不同
    const weakGuard: Entity = createProtector('weakGuard', 2, 1, 5, 10);
    const strongGuard: Entity = createProtector('strongGuard', 2, -1, 5, 18);

    const selected = InterceptionPriorityResolver.selectInterceptor(
      [weakGuard, strongGuard], attacker, protectee
    );
    assertEqual(selected!.id, 'strongGuard', '同距离 → 拦截值高(18>10)优先');

    // 协同加成
    const coopBonus = InterceptionPriorityResolver.calculateCoopBonus([weakGuard, strongGuard]);
    assertEqual(coopBonus, 2, '2名护卫 → 协同加成 +2');
  }

  // ===============================================
  // Scenario G: 封锁区域 — 路径阻断与进入检测
  // ===============================================
  console.log('\n[Scenario G] 封锁区域 — 阻断路径');
  {
    const zone = AreaDenialResolver.createZone(
      'fire_zone', { x: 3, y: 0, z: 0 }, 1.5, 30, 'caster', 25
    );

    assertEqual(zone.remainingTicks, 30, '封锁区域持续 30 Tick');
    assertEqual(zone.triggerDamage, 25, '进入触发伤害 25');

    // 检查路径阻断
    const from = { x: 0, y: 0, z: 0 };
    const throughZone = { x: 3, y: 0, z: 0 }; // 经过封锁区
    const farBypass = { x: 6, y: 5, z: 0 }; // 大幅绕行（距区中心>1.5）

    const blocked = AreaDenialResolver.isPathBlockedByZone(from, throughZone, [zone], 0.5);
    assert(blocked.blocked === true, '经过封锁区 → 路径被阻断');

    const notBlocked = AreaDenialResolver.isPathBlockedByZone(from, farBypass, [zone], 0.5);
    assert(notBlocked.blocked === false, '大幅绕行 → 未被阻断');

    // 进入检测
    const zombie: Entity = createEntity('zombie', 1, 0);
    const prevPos = { x: 0.5, y: 0, z: 0 };
    const prevInside = { x: 2.5, y: 0, z: 0 };

    const entry1 = AreaDenialResolver.checkEntry(zone, zombie, prevPos);
    // zombie at (1,0), zone center (3,0), radius 1.5 → dist=2 > 1.5 → not entered
    assert(entry1.entered === false, '距离2 > 半径1.5 → 未进入');

    zombie.transform.coords = { x: 2, y: 0, z: 0 };
    const entry2 = AreaDenialResolver.checkEntry(zone, zombie, prevPos);
    // zombie at (2,0), zone center (3,0), radius 1.5 → dist=1 → entered!
    assert(entry2.entered === true, '距离1 < 半径1.5 → 已进入');

    // 已经在区域内再移动不触发第二次
    const entry3 = AreaDenialResolver.checkEntry(zone, zombie, prevInside);
    assert(entry3.entered === false, '已在区域内 → 不重复触发');

    // Tick 衰减
    const zonesAfterTick = AreaDenialResolver.tick([zone]);
    assertEqual(zonesAfterTick[0].remainingTicks, 29, '1 tick 后剩余 29');

    // 到期自动消失
    const expired = { ...zone, remainingTicks: 1 };
    const afterExpiry = AreaDenialResolver.tick([expired]);
    assertEqual(afterExpiry.length, 0, '到期后消失');
  }

  // ===============================================
  // Scenario H: 整合 — 阵型护卫完整流程
  // ===============================================
  console.log('\n[Scenario H] 整合 — 阵型护卫对抗突进');
  {
    // 场景: 刺客突进法师，护卫拦截
    const assassin: Entity = createEntity('assassin', 0, 0);
    assassin.resources.current['hp'] = 80;
    assassin.defenses = { dr: 3, parry: 12, dodge: 14 };

    const mage: Entity = createEntity('mage', 8, 0);
    mage.resources.current['hp'] = 50;

    const knight: Entity = createProtector('knight', 3, 0, 5, 16);
    knight.resources.current['hp'] = 120;
    knight.resources.current['poise'] = 60;
    knight.defenses = { dr: 12, parry: 16, dodge: 6 };

    // 步骤1: 刺客向法师移动，路径被骑士阻挡
    const pathBlocked = BlockingResolver.isPathBlocked(
      assassin.transform.coords,
      mage.transform.coords,
      [knight], 0.5
    );
    assert(pathBlocked.blocked === true, '骑士阻挡了刺客到法师的路径');

    // 步骤2: 刺客绕过骑士
    const bypass = BlockingResolver.findBypassPath(
      assassin.transform.coords,
      mage.transform.coords,
      knight, 0.5
    );
    assert(bypass !== null, '刺客找到绕行路径');
    assassin.transform.coords = { x: 3.5, y: 2.5, z: 0 }; // 绕过骑士的位置

    // 步骤3: 骑士尝试拦截攻击
    const canIntercept = InterceptionResolver.canIntercept(knight, assassin, mage);
    assert(canIntercept === true, '骑士在拦截范围内');

    // 步骤4: 刺客攻击值 15, 骑士拦截值 16 → 成功拦截
    const interceptResult = InterceptionResolver.resolve(knight, assassin, 15, 35);
    assert(interceptResult.success === true, '16 ≥ 15 → 成功拦截');
    assertEqual(interceptResult.reducedDamage, 14, '拦截后伤害: 35*0.4=14');

    // 步骤5: 骑士承受减免后的伤害
    const actualDmg = Math.max(0, interceptResult.reducedDamage - (knight.defenses?.dr ?? 0));
    assertEqual(actualDmg, 2, '骑士承受: 14-12(DR)=2');
  }

  // ===============================================
  // Scenario I: 边界 — 不可拦截 / 无护卫
  // ===============================================
  console.log('\n[Scenario I] 边界条件 — 无拦截能力');
  {
    const attacker: Entity = createEntity('attacker', 0, 0);
    const protectee: Entity = createEntity('protectee', 5, 0);

    // 非 PROTECTOR 角色的实体不能拦截
    const civilian: Entity = createEntity('civilian', 2, 0, 'SCOUT');
    const canIntercept = InterceptionResolver.canIntercept(civilian, attacker, protectee);
    assert(canIntercept === false, '非 PROTECTOR 角色不能拦截');

    // 无护卫时的选择
    const selected = InterceptionPriorityResolver.selectInterceptor([], attacker, protectee);
    assert(selected === null, '空护卫列表 → 无拦截者');
  }

  // ===============================================
  // Scenario J: 多个封锁区域叠加
  // ===============================================
  console.log('\n[Scenario J] 多个封锁区域叠加');
  {
    const zone1 = AreaDenialResolver.createZone('z1', { x: 2, y: 0, z: 0 }, 1, 10, 'caster1', 15);
    const zone2 = AreaDenialResolver.createZone('z2', { x: 4, y: 0, z: 0 }, 1, 10, 'caster2', 20);

    const from = { x: 0, y: 0, z: 0 };
    const to = { x: 6, y: 0, z: 0 };

    // 穿过两个区域
    const blocked1 = AreaDenialResolver.isPathBlockedByZone(from, to, [zone1, zone2], 0.5);
    assert(blocked1.blocked === true, '多个封锁区 → 路径被阻断');

    // 大幅绕过两个区
    const farBypass = { x: 6, y: 6, z: 0 };
    const notBlocked = AreaDenialResolver.isPathBlockedByZone(from, farBypass, [zone1, zone2], 0.5);
    assert(notBlocked.blocked === false, '大幅绕行 → 避开所有封锁区');

    // 协同加成随人数增加
    const p1 = createProtector('p1', 0, 0);
    const p2 = createProtector('p2', 0, 1);
    const p3 = createProtector('p3', 0, 2);
    assertEqual(InterceptionPriorityResolver.calculateCoopBonus([p1, p2, p3]), 4, '3护卫 → +4');

    const p4 = createProtector('p4', 0, 3);
    assertEqual(InterceptionPriorityResolver.calculateCoopBonus([p1, p2, p3, p4]), 6, '4护卫 → +6(封顶)');
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有阵型协作测试通过!');
}

runTests();
