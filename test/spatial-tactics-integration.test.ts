// test/spatial-tactics-integration.test.ts
// 空间战术元素集成测试：触及距离/死角/冲刺加速/朝向/背刺

// ==========================================
// 1. 内联类型定义
// ==========================================
interface Vector3D { x: number; y: number; z: number; }
type EntityId = string;
interface Entity {
  id: EntityId;
  transform: { coords: Vector3D; facing: number }; // facing: 0-360 度
  physics: { scaleClass: number; collisionRadius: number; mass: number };
  resources: { current: Record<string, number>; max: Record<string, number> };
  defenses?: { dr: number; parry: number; dodge: number };
  currentActionContext?: {
    type: 'CASTING' | 'MOVING';
    actionId: string;
    phase: string;
    resolveTick: number;
    consecutiveMoves?: number;     // 冲刺系统：连续移动次数
    lastMoveTick?: number;         // 冲刺系统：上次移动 Tick
  };
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
  static angleBetween(from: Vector3D, to: Vector3D): number {
    const dir = VectorMath.direction(from, to);
    // 使用 atan2 计算方向角度（度）
    return (Math.atan2(dir.y, dir.x) * 180 / Math.PI + 360) % 360;
  }
}

// ==========================================
// 3. 触及距离与死角 (Reach & Dead Zone)
// ==========================================
class ReachResolver {
  /**
   * 检查目标是否在武器触及范围内
   * @param dist 双方距离
   * @param weaponReach 武器触及距离
   * @returns 是否在有效范围内
   */
  static isInReach(dist: number, weaponReach: number): boolean {
    return dist <= weaponReach;
  }

  /**
   * 计算极限距离死角惩罚
   * 目标在武器最大触及的边缘时，攻击判定受到惩罚
   * @param dist 实际距离
   * @param weaponReach 武器触及距离
   * @returns 死角惩罚值（正值=不利, 0=无惩罚）
   */
  static deadZonePenalty(dist: number, weaponReach: number): number {
    if (dist > weaponReach) return -1; // 超出范围，无法攻击
    if (weaponReach <= 0) return 0;

    // 有效范围的最后30%为死角区
    const effectiveZone = weaponReach * 0.7;
    if (dist <= effectiveZone) return 0; // 舒适区，无惩罚

    // 死角区：线性递增惩罚
    const deadZoneRatio = (dist - effectiveZone) / (weaponReach - effectiveZone);
    return Math.round(deadZoneRatio * 4); // 1-4 惩罚
  }

  /**
   * 计算武器最短距离惩罚（贴太近也不利）
   * 适用于长武器（如长枪、大剑）
   */
  static tooClosePenalty(dist: number, minReach: number): number {
    if (minReach <= 0 || dist >= minReach) return 0;
    return Math.ceil((minReach - dist) / minReach * 3); // 1-3 惩罚
  }

  /**
   * 获取有效攻击范围描述
   */
  static describeRange(dist: number, weaponReach: number, minReach: number = 0): string {
    if (dist > weaponReach) return 'OUT_OF_RANGE';
    if (minReach > 0 && dist < minReach) return 'TOO_CLOSE';
    const deadZone = weaponReach * 0.7;
    if (dist > deadZone) return 'DEAD_ZONE';
    return 'SWEET_SPOT';
  }
}

// ==========================================
// 4. 冲刺系统 (Sprint Momentum)
// ==========================================
class SprintTracker {
  /**
   * 计算连续移动的 Tick 消耗（递减 = 加速）
   * @param consecutiveMoves 连续移动次数
   * @param baseTickCost 基础 Tick 消耗
   * @returns 本次移动的 Tick 消耗
   */
  static movementTickCost(consecutiveMoves: number, baseTickCost: number): number {
    if (consecutiveMoves <= 0) return baseTickCost;
    // 每次连续移动递减 10%，最少 50% base
    const reduction = Math.min(consecutiveMoves * 0.1, 0.5);
    return Math.max(Math.round(baseTickCost * (1 - reduction)), 1);
  }

  /**
   * 检查冲刺是否被中断（超过中断阈值时间未移动）
   */
  static isSprintBroken(
    currentTick: number,
    lastMoveTick: number,
    breakThreshold: number = 20
  ): boolean {
    return (currentTick - lastMoveTick) > breakThreshold;
  }

  /**
   * 获取当前冲刺等级（用于视觉效果/动量计算）
   */
  static sprintLevel(consecutiveMoves: number): number {
    if (consecutiveMoves <= 1) return 0;
    if (consecutiveMoves <= 3) return 1;
    if (consecutiveMoves <= 5) return 2;
    return 3;
  }
}

// ==========================================
// 5. 朝向与转身系统 (Facing & Turn)
// ==========================================
class FacingSystem {
  /**
   * 计算从当前朝向转向目标方向所需的最小角度差
   */
  static turnAngle(currentFacing: number, targetFacing: number): number {
    let diff = ((targetFacing - currentFacing) % 360 + 540) % 360 - 180;
    return Math.abs(diff);
  }

  /**
   * 计算转身所需 Tick
   * @param angle 需要转过的角度
   * @param turnRate 每秒/每Tick转动角度
   */
  static turnTime(angle: number, turnRate: number = 45): number {
    if (angle <= 0) return 0;
    return Math.ceil(angle / turnRate);
  }

  /**
   * 判断目标是否在攻击者的前方扇形区域内
   * @param attackerFacing 攻击者朝向
   * @param toTargetAngle 指向目标的绝对角度
   * @param arc 前方弧度（半角，默认 90度）
   */
  static isInFrontArc(
    attackerFacing: number,
    toTargetAngle: number,
    arc: number = 90
  ): boolean {
    let diff = ((toTargetAngle - attackerFacing) % 360 + 540) % 360 - 180;
    return Math.abs(diff) <= arc;
  }

  /**
   * 判断攻击者是否在目标的后方
   * @param targetFacing 目标朝向
   * @param toAttackerAngle 指向攻击者的绝对角度
   * @param backArc 后方弧度（半角，默认 90度）
   */
  static isBehind(
    targetFacing: number,
    toAttackerAngle: number,
    backArc: number = 90
  ): boolean {
    // 后方夹角：目标朝向 + 180度 ± backArc
    let diff = ((toAttackerAngle - targetFacing + 180) % 360 + 540) % 360 - 180;
    return Math.abs(diff) <= backArc;
  }
}

// ==========================================
// 6. 背刺系统 (Backstab)
// ==========================================
class BackstabResolver {
  /**
   * 背刺判定：目标背面攻击无视 DEF (Parry/Dodge)
   * @returns 是否绕过防御
   */
  static checkBackstab(
    attacker: Entity,
    target: Entity
  ): { isBackstab: boolean; defBypassed: boolean; bypassMessage: string } {
    const toAttackerAngle = VectorMath.angleBetween(target.transform.coords, attacker.transform.coords);
    const behind = FacingSystem.isBehind(target.transform.facing, toAttackerAngle);

    if (behind) {
      return {
        isBackstab: true,
        defBypassed: true,
        bypassMessage: '背刺：目标在背后，DEF 被绕过'
      };
    }

    return {
      isBackstab: false,
      defBypassed: false,
      bypassMessage: '正面攻击：DEF 正常生效'
    };
  }

  /**
   * 计算背刺额外伤害加成
   */
  static backstabDamageBonus(
    baseDamage: number,
    attackerConsecutiveMoves: number = 0
  ): number {
    let multiplier = 1.5; // 基础背刺倍率
    // 冲刺背刺：额外加成
    if (attackerConsecutiveMoves >= 2) {
      multiplier += 0.1 * Math.min(attackerConsecutiveMoves, 5);
    }
    return Math.floor(baseDamage * multiplier);
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

// ==========================================
// 8. 场景测试
// ==========================================
function runTests() {
  console.log('=== ElysianVTT 空间战术元素集成测试 ===\n');

  // ===============================================
  // Scenario A: 触及判定 — 武器范围与死角
  // ===============================================
  console.log('[Scenario A] 触及判定 — 武器范围与死角惩罚');
  {
    const weaponReach = 5; // 长剑，触及 5 单位

    // 舒适区内
    assert(ReachResolver.isInReach(3, weaponReach) === true, '距离3 < 触及5 → 在范围内');
    assertEqual(ReachResolver.deadZonePenalty(3, weaponReach), 0, '距离3 → 舒适区，无死角惩罚');

    // 死角区 (5*0.7=3.5 以上为死角)
    assert(ReachResolver.isInReach(4.5, weaponReach) === true, '距离4.5 < 5 → 仍在范围内');
    assert(ReachResolver.deadZonePenalty(4.5, weaponReach) >= 1, '距离4.5 → 死角惩罚≥1');

    // 超出范围
    assert(ReachResolver.isInReach(5.5, weaponReach) === false, '距离5.5 > 5 → 超出范围');
    assertEqual(ReachResolver.deadZonePenalty(5.5, weaponReach), -1, '超出范围返回 -1');

    // 死角区的惩罚递增
    const p1 = ReachResolver.deadZonePenalty(4.0, weaponReach);
    const p2 = ReachResolver.deadZonePenalty(4.9, weaponReach);
    assert(p2 >= p1, `极限死角惩罚≥中距死角惩罚 (${p2} >= ${p1})`);
  }

  // ===============================================
  // Scenario B: 长武器贴太近惩罚
  // ===============================================
  console.log('\n[Scenario B] 长武器贴太近惩罚');
  {
    const weaponReach = 6;
    const minReach = 2; // 长枪最小有效距离

    // 贴太近
    assertEqual(ReachResolver.describeRange(1, weaponReach, minReach), 'TOO_CLOSE', '距离1 < 2 → TOO_CLOSE');
    assert(ReachResolver.tooClosePenalty(1, minReach) >= 1, '距离1 → 贴太近惩罚≥1');

    // 舒适区
    assertEqual(ReachResolver.describeRange(3, weaponReach, minReach), 'SWEET_SPOT', '距离3 → SWEET_SPOT');
    assertEqual(ReachResolver.tooClosePenalty(3, minReach), 0, '正常距离 → 无惩罚');

    // 精确到边界
    assertEqual(ReachResolver.tooClosePenalty(1.5, minReach), 1, '距离1.5 → ceil((2-1.5)/2*3)=1');
    assertEqual(ReachResolver.tooClosePenalty(0.5, minReach), 3, '距离0.5 → ceil((2-0.5)/2*3)=3');
  }

  // ===============================================
  // Scenario C: 冲刺加速 — 连续移动 Tick 递减
  // ===============================================
  console.log('\n[Scenario C] 冲刺加速 — 连续移动消耗递减');
  {
    const baseTickCost = 10; // 基础每格 10 Tick

    // 第一次移动：全额
    const cost1 = SprintTracker.movementTickCost(0, baseTickCost);
    assertEqual(cost1, 10, '第1次移动: 10 Tick');

    // 第2次：减10%
    const cost2 = SprintTracker.movementTickCost(1, baseTickCost);
    assertEqual(cost2, 9, '第2次移动: 9 Tick');

    // 第3次：减20%
    const cost3 = SprintTracker.movementTickCost(2, baseTickCost);
    assertEqual(cost3, 8, '第3次移动: 8 Tick');

    // 第5次：减40%
    const cost5 = SprintTracker.movementTickCost(4, baseTickCost);
    assertEqual(cost5, 6, '第5次移动: 6 Tick');

    // 第6次及以上：最多减50%
    const cost6 = SprintTracker.movementTickCost(5, baseTickCost);
    assertEqual(cost6, 5, '第6次移动: 5 Tick (减50% 封顶)');

    const cost10 = SprintTracker.movementTickCost(9, baseTickCost);
    assertEqual(cost10, 5, '第10次移动: 5 Tick (封顶，不低于1)');

    // 小基数测试：确保最小值 1
    const costMin = SprintTracker.movementTickCost(10, 2);
    assertEqual(costMin, 1, '基数2连续10次 → 1 Tick (最小1)');
  }

  // ===============================================
  // Scenario D: 冲刺中断 — 超时重置
  // ===============================================
  console.log('\n[Scenario D] 冲刺中断 — 超时重置');
  {
    // 当前tick=50, 上次移动tick=30, 阈值=20 → 未中断
    const notBroken = SprintTracker.isSprintBroken(50, 30, 20);
    assert(notBroken === false, '差异20 ≤ 阈值20 → 冲刺未中断');

    // 当前tick=51, 上次移动tick=30, 阈值=20 → 中断
    const broken = SprintTracker.isSprintBroken(51, 30, 20);
    assert(broken === true, '差异21 > 阈值20 → 冲刺中断');

    // 冲刺等级
    assertEqual(SprintTracker.sprintLevel(0), 0, '0连 → 等级0');
    assertEqual(SprintTracker.sprintLevel(2), 1, '2连 → 等级1');
    assertEqual(SprintTracker.sprintLevel(4), 2, '4连 → 等级2');
    assertEqual(SprintTracker.sprintLevel(6), 3, '6连 → 等级3');
  }

  // ===============================================
  // Scenario E: 朝向与转身 — 角度与时间
  // ===============================================
  console.log('\n[Scenario E] 朝向与转身');
  {
    // 同向
    assertEqual(FacingSystem.turnAngle(0, 0), 0, '朝向相同 → 角度0');
    assertEqual(FacingSystem.turnTime(0, 45), 0, '0度 → 0 Tick');

    // 90度转身
    assertEqual(FacingSystem.turnAngle(0, 90), 90, '0→90 → 90度');
    assertEqual(FacingSystem.turnTime(90, 45), 2, '90度 / 45 = 2 Tick');

    // 180度转身
    assertEqual(FacingSystem.turnAngle(0, 180), 180, '0→180 → 180度');
    assertEqual(FacingSystem.turnTime(180, 90), 2, '180度 / 90 = 2 Tick');

    // 最短路径（顺时针vs逆时针）
    assertEqual(FacingSystem.turnAngle(350, 10), 20, '350→10 最短20度');
    assertEqual(FacingSystem.turnAngle(10, 350), 20, '10→350 最短20度');

    // 转身速率不同
    assertEqual(FacingSystem.turnTime(120, 60), 2, '120度 / 60 = 2 Tick');
    assertEqual(FacingSystem.turnTime(120, 30), 4, '120度 / 30 = 4 Tick');
  }

  // ===============================================
  // Scenario F: 前方扇形区域判定
  // ===============================================
  console.log('\n[Scenario F] 前方扇形判定');
  {
    // 面向0度（向右），扇形半角90度

    // 目标在正前方
    const front = FacingSystem.isInFrontArc(0, 0, 90);
    assert(front === true, '方向相同 → 前方');

    // 目标在45度
    const angled = FacingSystem.isInFrontArc(0, 45, 90);
    assert(angled === true, '45度角 → 前方');

    // 目标在91度（超出扇形）
    const outside = FacingSystem.isInFrontArc(0, 91, 90);
    assert(outside === false, '91度 → 超出前方扇形');

    // 目标在180度（正后方）
    const behind = FacingSystem.isInFrontArc(0, 180, 90);
    assert(behind === false, '180度 → 后方（最短路径180° > 90°）');

    // 窄扇形（如架枪状态）
    const narrowArc = FacingSystem.isInFrontArc(0, 20, 30);
    assert(narrowArc === true, '20度在30度窄扇区内');
    const outsideNarrow = FacingSystem.isInFrontArc(0, 40, 30);
    assert(outsideNarrow === false, '40度超出30度窄扇区');
  }

  // ===============================================
  // Scenario G: 背刺判定 — 后方攻击绕过 DEF
  // ===============================================
  console.log('\n[Scenario G] 背刺判定 — 绕过 DEF');
  {
    const attacker: Entity = {
      id: 'rogue',
      transform: { coords: { x: 0, y: 5, z: 0 }, facing: 0 },
      physics: { scaleClass: 1, collisionRadius: 1, mass: 70 },
      resources: { current: { hp: 100 }, max: { hp: 100 } },
      defenses: { dr: 5, parry: 15, dodge: 12 }
    };
    const target: Entity = {
      id: 'guard',
      transform: { coords: { x: 0, y: 0, z: 0 }, facing: 0 }, // 面朝+X (0度)
      physics: { scaleClass: 1, collisionRadius: 1, mass: 80 },
      resources: { current: { hp: 100 }, max: { hp: 100 } },
      defenses: { dr: 10, parry: 18, dodge: 10 }
    };

    // 攻击者在目标后方（target facing=0°, attacker在正Y方向=90°）
    // target朝向0°, 攻击者角度=atan2(5-0, 0-0)=90°
    const result = BackstabResolver.checkBackstab(attacker, target);
    assert(result.isBackstab === true, '攻击者在目标正后方 → 背刺');
    assert(result.defBypassed === true, 'DEF被绕过');

    // 背刺伤害加成
    const bonusDmg = BackstabResolver.backstabDamageBonus(20, 0);
    assertEqual(bonusDmg, 30, '20 * 1.5 = 30 (基础背刺倍率)');

    // 冲刺背刺加成: 基础1.5 + 0.1*min(3,5)=0.3 → 1.8倍, floor(20*1.8)=36
    const sprintBonusDmg = BackstabResolver.backstabDamageBonus(20, 3);
    assertEqual(sprintBonusDmg, 36, '20 * 1.8 = 36 (冲刺背刺3连倍率)');

    // 将攻击者移到目标前方
    const frontAttacker: Entity = {
      ...attacker,
      transform: { coords: { x: 5, y: 0, z: 0 }, facing: 0 }
    };
    const frontResult = BackstabResolver.checkBackstab(frontAttacker, target);
    assert(frontResult.isBackstab === false, '攻击者在目标前方 → 非背刺');
    assert(frontResult.defBypassed === false, 'DEF正常生效');
  }

  // ===============================================
  // Scenario H: 整合 — 冲刺背刺流程
  // ===============================================
  console.log('\n[Scenario H] 整合 — 冲刺背刺攻击全流程');
  {
    const rogue: Entity = {
      id: 'rogue',
      transform: { coords: { x: 0, y: 8, z: 0 }, facing: 270 }, // 面向下
      physics: { scaleClass: 1, collisionRadius: 1, mass: 70 },
      resources: { current: { hp: 100, stamina: 100 }, max: { hp: 100, stamina: 100 } },
      defenses: { dr: 5, parry: 12, dodge: 15 }
    };
    const guard: Entity = {
      id: 'guard',
      transform: { coords: { x: 0, y: 0, z: 0 }, facing: 0 }, // 面朝右
      physics: { scaleClass: 1, collisionRadius: 1, mass: 80 },
      resources: { current: { hp: 80 }, max: { hp: 80 } },
      defenses: { dr: 10, parry: 18, dodge: 10 }
    };

    // 步骤1: 冲刺接近
    const baseCost = 10;
    let tickCosts: number[] = [];
    for (let i = 0; i < 3; i++) {
      tickCosts.push(SprintTracker.movementTickCost(i, baseCost));
    }
    assertEqual(tickCosts[0], 10, '第1步 10 Tick');
    assertEqual(tickCosts[1], 9, '第2步 9 Tick');
    assertEqual(tickCosts[2], 8, '第3步 8 Tick');

    // 步骤2: 到达目标背后
    const reach = 2; // 匕首
    const distToTarget = VectorMath.distance(rogue.transform.coords, guard.transform.coords);
    assert(ReachResolver.isInReach(distToTarget, reach) === false, '距离8 > 2 → 尚未进入攻击范围');

    // 步骤3: 走近后检查背刺
    rogue.transform.coords = { x: 0, y: 1.5, z: 0 }; // 在目标背后1.5格
    const reachable = ReachResolver.isInReach(
      VectorMath.distance(rogue.transform.coords, guard.transform.coords),
      reach
    );
    assert(reachable === true, '已进入匕首触及范围');

    const backstab = BackstabResolver.checkBackstab(rogue, guard);
    assert(backstab.isBackstab === true, '盗贼在守卫背后 → 背刺');

    // 冲刺背刺: 基础1.5 + 0.1*min(3,5)=0.3 → 1.8倍, floor(15*1.8)=27
    const damage = BackstabResolver.backstabDamageBonus(15, 3);
    assertEqual(damage, 27, '冲刺背刺: 15 * 1.8 = 27');

    // 步骤4: 背刺无视 DEF，但 DR 依然生效
    const effectiveDmg = Math.max(0, damage - (guard.defenses?.dr ?? 0));
    assertEqual(effectiveDmg, 17, '27 - 10(DR) = 17 (背刺绕过DEF但DR仍在)');
  }

  // ===============================================
  // Scenario I: 转身迎击 — 背刺未发生时
  // ===============================================
  console.log('\n[Scenario I] 转身迎击 — 正面防御');
  {
    // 坐标约定：0°=右, 90°=上, 180°=左, 270°=下
    // facing=180° → 面朝左（负X方向）
    const defender: Entity = {
      id: 'swordsman',
      transform: { coords: { x: 0, y: 0, z: 0 }, facing: 180 }, // 面朝左
      physics: { scaleClass: 1, collisionRadius: 1, mass: 80 },
      resources: { current: { hp: 100 }, max: { hp: 100 } },
      defenses: { dr: 8, parry: 16, dodge: 8 }
    };

    // 攻击者在防御者左侧面 → 防御者正前方 (facing=180°, 攻击者在180°方向)
    const frontAttacker: Entity = {
      id: 'enemy_front',
      transform: { coords: { x: -3, y: 0, z: 0 }, facing: 0 }, // 在左方 (180°方向)
      physics: { scaleClass: 1, collisionRadius: 1, mass: 70 },
      resources: { current: { hp: 100 }, max: { hp: 100 } }
    };

    const toFrontAngle = VectorMath.angleBetween(defender.transform.coords, frontAttacker.transform.coords);
    // def(0,0) → atk(-3,0): atan2(0, -3)*180/π = 180°
    assertEqual(toFrontAngle, 180, '攻击者在左方 → 角度180°');

    const behindCheck = FacingSystem.isBehind(defender.transform.facing, toFrontAngle);
    assert(behindCheck === false, '左侧攻击面对朝左防御者 → 非背刺');

    const inFront = FacingSystem.isInFrontArc(defender.transform.facing, toFrontAngle);
    assert(inFront === true, '左侧攻击面对朝左防御者 → 在前方扇形内');

    // 攻击者在防御者右方 → 防御者正背后 (facing=180°, 攻击者在0°方向)
    const backAttacker: Entity = {
      id: 'enemy_back',
      transform: { coords: { x: 3, y: 0, z: 0 }, facing: 0 }, // 在右方 (0°方向 = 背后)
      physics: { scaleClass: 1, collisionRadius: 1, mass: 70 },
      resources: { current: { hp: 100 }, max: { hp: 100 } }
    };

    const toBackAngle = VectorMath.angleBetween(defender.transform.coords, backAttacker.transform.coords);
    assertEqual(toBackAngle, 0, '攻击者在右方 → 角度0°');

    const behindCheck2 = FacingSystem.isBehind(defender.transform.facing, toBackAngle);
    assert(behindCheck2 === true, '右侧攻击面对朝左防御者 → 背刺');
  }

  // ===============================================
  // Scenario J: 范围字符串标签 — 整合
  // ===============================================
  console.log('\n[Scenario J] 范围标签 — 整合');
  {
    assertEqual(ReachResolver.describeRange(1, 5, 0), 'SWEET_SPOT', '距离1 触及5 → SWEET_SPOT');
    assertEqual(ReachResolver.describeRange(6, 5, 0), 'OUT_OF_RANGE', '距离6 触及5 → 超距');
    assertEqual(ReachResolver.describeRange(4, 5, 0), 'DEAD_ZONE', '距离4(>5*0.7=3.5) → DEAD_ZONE');
    assertEqual(ReachResolver.describeRange(4, 5, 2), 'DEAD_ZONE', '距离4 触及5 min2 → DEAD_ZONE');
    assertEqual(ReachResolver.describeRange(1, 5, 2), 'TOO_CLOSE', '距离1 < min2 → TOO_CLOSE');
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有空间战术测试通过!');
}

runTests();
