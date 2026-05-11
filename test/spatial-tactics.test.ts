// test/spatial-tactics.test.ts
// Phase 3.4 空间战术元素测试

// ==========================================
// 1. 内联类型
// ==========================================
type EntityId = string;

interface Vector3D { x: number; y: number; z: number; }

interface Entity {
  id: EntityId;
  transform: { coords: Vector3D; facing: number };
  physics?: { scaleClass: number; collisionRadius: number; mass: number };
}

// ==========================================
// 2. 内联实现
// ==========================================

class VMath {
  static distance(v1: Vector3D, v2: Vector3D): number {
    const dx = v2.x - v1.x, dy = v2.y - v1.y, dz = (v2.z ?? 0) - (v1.z ?? 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  static angleBetween(from: Vector3D, to: Vector3D): number {
    const dir = { x: to.x - from.x, y: to.y - from.y, z: 0 };
    return (Math.atan2(dir.y, dir.x) * 180 / Math.PI + 360) % 360;
  }
}

class SpatialTactics {
  static turnAngle(currentFacing: number, targetFacing: number): number {
    const diff = ((targetFacing - currentFacing) % 360 + 540) % 360 - 180;
    return Math.abs(diff);
  }

  static turnTime(angle: number, turnRate = 45): number {
    if (angle <= 0) return 0;
    return Math.ceil(angle / turnRate);
  }

  static isInFrontArc(attackerFacing: number, toTargetAngle: number, arc = 90): boolean {
    const diff = ((toTargetAngle - attackerFacing) % 360 + 540) % 360 - 180;
    return Math.abs(diff) <= arc;
  }

  static isBehind(targetFacing: number, toAttackerAngle: number, backArc = 90): boolean {
    const diff = ((toAttackerAngle - targetFacing + 180) % 360 + 540) % 360 - 180;
    return Math.abs(diff) <= backArc;
  }

  static isBackstab(attacker: Entity, target: Entity): boolean {
    const toAttackerAngle = VMath.angleBetween(target.transform.coords, attacker.transform.coords);
    return this.isBehind(target.transform.facing, toAttackerAngle);
  }

  static angleBetweenEntities(from: Entity, to: Entity): number {
    return VMath.angleBetween(from.transform.coords, to.transform.coords);
  }

  static sprintTickCost(consecutiveMoves: number, base: number, reductionPerStep = 0.1, maxReduction = 0.5, minCost = 1): number {
    if (consecutiveMoves <= 0) return base;
    const reduction = Math.min(consecutiveMoves * reductionPerStep, maxReduction);
    return Math.max(Math.round(base * (1 - reduction)), minCost);
  }

  static isSprintBroken(currentTick: number, lastMoveTick: number, threshold = 20): boolean {
    return (currentTick - lastMoveTick) > threshold;
  }

  static sprintLevel(consecutiveMoves: number): number {
    if (consecutiveMoves <= 1) return 0;
    if (consecutiveMoves <= 3) return 1;
    if (consecutiveMoves <= 5) return 2;
    return 3;
  }

  static isInReach(dist: number, maxReach: number, minReach?: number): boolean {
    if (minReach && dist < minReach) return false;
    return dist <= maxReach;
  }

  static deadZonePenalty(dist: number, maxReach: number): number {
    if (dist > maxReach) return -1;
    if (maxReach <= 0) return 0;
    const effectiveZone = maxReach * 0.7;
    if (dist <= effectiveZone) return 0;
    return Math.round((dist - effectiveZone) / (maxReach - effectiveZone) * 4);
  }

  static tooClosePenalty(dist: number, minReach: number): number {
    if (minReach <= 0 || dist >= minReach) return 0;
    return Math.ceil((minReach - dist) / minReach * 3);
  }

  static describeRange(dist: number, maxReach: number, minReach = 0): string {
    if (dist > maxReach) return 'OUT_OF_RANGE';
    if (minReach > 0 && dist < minReach) return 'TOO_CLOSE';
    if (dist > maxReach * 0.7) return 'DEAD_ZONE';
    return 'SWEET_SPOT';
  }
}

// ==========================================
// 3. 测试框架
// ==========================================

let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
  testCount++;
  if (cond) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}

function runTests() {
  console.log('=== ElysianVTT 空间战术元素测试 (Phase 3.4) ===\n');

  // ---- Test 1: 转身角度最小路径 ----
  console.log('[Test 1] 转身角度 — 最短路径');
  {
    assert(SpatialTactics.turnAngle(0, 0) === 0, '同向 0°');
    assert(SpatialTactics.turnAngle(0, 90) === 90, '0→90 = 90°');
    assert(SpatialTactics.turnAngle(0, 270) === 90, '0→270 = 90°（逆时针）');
    assert(SpatialTactics.turnAngle(350, 10) === 20, '350→10 = 20°（跨 360）');
    assert(SpatialTactics.turnAngle(10, 350) === 20, '10→350 = 20°（跨 360 回）');
  }

  // ---- Test 2: 转身耗时 ----
  console.log('\n[Test 2] 转身耗时计算');
  {
    assert(SpatialTactics.turnTime(0) === 0, '0° = 0 Tick');
    assert(SpatialTactics.turnTime(45) === 1, '45° / 45 = 1 Tick');
    assert(SpatialTactics.turnTime(90) === 2, '90° / 45 = 2 Tick');
    assert(SpatialTactics.turnTime(180, 60) === 3, '180° / 60 = 3 Tick');
    assert(SpatialTactics.turnTime(180, 90) === 2, '180° / 90 = 2 Tick');
  }

  // ---- Test 3: 前方扇形判定 ----
  console.log('\n[Test 3] 前方扇形判定');
  {
    assert(SpatialTactics.isInFrontArc(0, 0) === true, '方向相同');
    assert(SpatialTactics.isInFrontArc(0, 45) === true, '45° 在前方');
    assert(SpatialTactics.isInFrontArc(0, 91) === false, '91° 超出前方');
    assert(SpatialTactics.isInFrontArc(0, 180) === false, '180° 正后方');
    assert(SpatialTactics.isInFrontArc(0, 20, 30) === true, '窄扇区 20° 内');
    assert(SpatialTactics.isInFrontArc(0, 40, 30) === false, '窄扇区 40° 超出');
    assert(SpatialTactics.isInFrontArc(270, 270) === true, '朝下同向');
  }

  // ---- Test 4: 背刺判定（后方判断）----
  console.log('\n[Test 4] 背刺 — 后方扇形');
  {
    assert(SpatialTactics.isBehind(0, 180) === true, 'facing=0° 攻击 180° → 背后');
    assert(SpatialTactics.isBehind(0, 0) === false, 'facing=0° 攻击 0° → 前方');
    assert(SpatialTactics.isBehind(0, 170) === true, 'facing=0° 攻击 170° → 背后（边界内）');
    assert(SpatialTactics.isBehind(0, 80) === false, 'facing=0° 攻击 80° → 前方非背刺');
    assert(SpatialTactics.isBehind(0, 100) === true, 'facing=0° 攻击 100° → 后侧方背刺');
    assert(SpatialTactics.isBehind(180, 0) === true, 'facing=180° 攻击 0° → 背后');

    // 窄后方扇区
    assert(SpatialTactics.isBehind(0, 180, 45) === true, '窄扇区 180° 在内');
    assert(SpatialTactics.isBehind(0, 134, 45) === false, '窄扇区 134° 超出（背弧 [135,225]）');
  }

  // ---- Test 5: 完整背刺检测 ----
  console.log('\n[Test 5] 完整背刺检测');
  {
    // target 朝右 (0°)，attacker 在下方 (270°)
    const target: Entity = { id: 't', transform: { coords: { x: 0, y: 0, z: 0 }, facing: 0 } };

    // 攻击者在正后方（target 朝右，攻击者在左 = 180°）
    const attackerBack: Entity = { id: 'a', transform: { coords: { x: -3, y: 0, z: 0 }, facing: 0 } };
    assert(SpatialTactics.isBackstab(attackerBack, target) === true, '攻击者在正后方 → 背刺');

    // 攻击者在前方（target 朝右，攻击者在右 = 0°）
    const attackerFront: Entity = { id: 'b', transform: { coords: { x: 3, y: 0, z: 0 }, facing: 0 } };
    assert(SpatialTactics.isBackstab(attackerFront, target) === false, '攻击者在正前方 → 非背刺');

    // target 朝下 (270°)，攻击者在上方 (90° = 背后)
    const targetDown: Entity = { id: 'c', transform: { coords: { x: 0, y: 0, z: 0 }, facing: 270 } };
    const attackerUp: Entity = { id: 'd', transform: { coords: { x: 0, y: 3, z: 0 }, facing: 0 } };
    assert(SpatialTactics.isBackstab(attackerUp, targetDown) === true, '朝下目标被上方攻击 → 背刺');
  }

  // ---- Test 6: 冲刺加速递减 ----
  console.log('\n[Test 6] 冲刺加速 Tick 递减');
  {
    assert(SpatialTactics.sprintTickCost(0, 10) === 10, '0连 → 10 Tick');
    assert(SpatialTactics.sprintTickCost(1, 10) === 9, '1连 → 9 Tick (-10%)');
    assert(SpatialTactics.sprintTickCost(2, 10) === 8, '2连 → 8 Tick (-20%)');
    assert(SpatialTactics.sprintTickCost(4, 10) === 6, '4连 → 6 Tick (-40%)');
    assert(SpatialTactics.sprintTickCost(5, 10) === 5, '5连 → 5 Tick (-50% 封顶)');
    assert(SpatialTactics.sprintTickCost(10, 2) === 1, '小基数封顶 → 1 Tick');
  }

  // ---- Test 7: 冲刺中断检查 ----
  console.log('\n[Test 7] 冲刺中断');
  {
    assert(SpatialTactics.isSprintBroken(50, 30, 20) === false, 'diff=20 ≤ 阈值 → 未中断');
    assert(SpatialTactics.isSprintBroken(51, 30, 20) === true, 'diff=21 > 阈值 → 中断');
    assert(SpatialTactics.isSprintBroken(100, 50) === true, '默认阈值 20, diff=50 > 20 → 中断');
  }

  // ---- Test 8: 冲刺等级 ----
  console.log('\n[Test 8] 冲刺等级');
  {
    assert(SpatialTactics.sprintLevel(0) === 0, '0连 → Lv0');
    assert(SpatialTactics.sprintLevel(1) === 0, '1连 → Lv0');
    assert(SpatialTactics.sprintLevel(2) === 1, '2连 → Lv1');
    assert(SpatialTactics.sprintLevel(3) === 1, '3连 → Lv1');
    assert(SpatialTactics.sprintLevel(4) === 2, '4连 → Lv2');
    assert(SpatialTactics.sprintLevel(6) === 3, '6连 → Lv3');
  }

  // ---- Test 9: 触及距离 + 死角 + 贴太近 ----
  console.log('\n[Test 9] 触及距离完整判定');
  {
    assert(SpatialTactics.isInReach(3, 5) === true, 'dist=3 max=5 → 触及内');
    assert(SpatialTactics.isInReach(6, 5) === false, 'dist=6 max=5 → 超出');
    assert(SpatialTactics.isInReach(1, 5, 2) === false, 'dist=1 min=2 → 太近');

    assert(SpatialTactics.deadZonePenalty(3, 5) === 0, '舒适区无惩罚');
    assert(SpatialTactics.deadZonePenalty(4.5, 5) >= 1, '死角区有惩罚');
    assert(SpatialTactics.deadZonePenalty(5.5, 5) === -1, '超距返回 -1');

    assert(SpatialTactics.tooClosePenalty(1, 2) >= 1, '太近有惩罚');
    assert(SpatialTactics.tooClosePenalty(3, 2) === 0, '正常无惩罚');

    assert(SpatialTactics.describeRange(3, 5) === 'SWEET_SPOT', '舒适区');
    assert(SpatialTactics.describeRange(6, 5) === 'OUT_OF_RANGE', '超出');
    assert(SpatialTactics.describeRange(4.5, 5) === 'DEAD_ZONE', '死角');
    assert(SpatialTactics.describeRange(1, 5, 2) === 'TOO_CLOSE', '太近');
  }

  // ---- Test 10: 实体间角度 ----
  console.log('\n[Test 10] 实体间绝对角度');
  {
    const origin: Entity = { id: 'o', transform: { coords: { x: 0, y: 0, z: 0 }, facing: 0 } };
    const right: Entity = { id: 'r', transform: { coords: { x: 5, y: 0, z: 0 }, facing: 0 } };
    const up: Entity = { id: 'u', transform: { coords: { x: 0, y: 5, z: 0 }, facing: 0 } };
    const left: Entity = { id: 'l', transform: { coords: { x: -5, y: 0, z: 0 }, facing: 0 } };
    const down: Entity = { id: 'd', transform: { coords: { x: 0, y: -5, z: 0 }, facing: 0 } };

    assert(SpatialTactics.angleBetweenEntities(origin, right) === 0, '右 = 0°');
    assert(SpatialTactics.angleBetweenEntities(origin, up) === 90, '上 = 90°');
    assert(SpatialTactics.angleBetweenEntities(origin, left) === 180, '左 = 180°');
    assert(SpatialTactics.angleBetweenEntities(origin, down) === 270, '下 = 270°');
  }

  // ---- Test 11: 冲刺背刺额外加成 ----
  console.log('\n[Test 11] 冲刺背刺额外加成计算');
  {
    // 基础背刺: 1.5x
    const baseDmg = 20;
    const backstabDmg = Math.floor(baseDmg * 1.5);
    assert(backstabDmg === 30, `基础背刺: ${baseDmg} * 1.5 = ${backstabDmg}`);

    // 冲刺连击加成: 每连 +0.1, max 5 连 (+0.5)
    const consecutiveMoves = 3;
    const bonus = 0.1 * Math.min(consecutiveMoves, 5);
    const sprintBackstabDmg = Math.floor(baseDmg * (1.5 + bonus));
    assert(sprintBackstabDmg === 36, `冲刺背刺 (3连): ${baseDmg} * 1.8 = ${sprintBackstabDmg}`);

    const maxBonus = 0.1 * Math.min(10, 5); // 5连封顶
    const maxDmg = Math.floor(baseDmg * (1.5 + maxBonus));
    assert(maxDmg === 40, `冲刺背刺 (5+连): ${baseDmg} * 2.0 = ${maxDmg}`);
  }

  // ---- Test 12: 多方向背刺验证 ----
  console.log('\n[Test 12] 多方向背刺验证 (facing=0°)');
  {
    const target: Entity = { id: 't', transform: { coords: { x: 0, y: 0, z: 0 }, facing: 0 } };

    const angles = [
      { x: -3, y: 0, expect: true, label: '正后方 (180°)' },
      { x: -2, y: 2, expect: true, label: '后侧方 (135°)' },
      { x: -2, y: -2, expect: true, label: '后侧方 (-135°)' },
      { x: 0.5, y: 3, expect: false, label: '前侧方 (80° 左右)' },
      { x: 3, y: 0, expect: false, label: '正前方 (0°)' },
      { x: 2, y: 2, expect: false, label: '前侧方 (45°)' },
    ];

    for (const { x, y, expect: exp, label } of angles) {
      const attacker: Entity = { id: 'a', transform: { coords: { x, y, z: 0 }, facing: 0 } };
      const result = SpatialTactics.isBackstab(attacker, target);
      assert(result === exp, `${label}: ${result === exp ? (exp ? '背刺 ✓' : '非背刺 ✓') : 'FAIL'}`);
    }
  }

  // ---- Test 13: 多武器触及 ----
  console.log('\n[Test 13] 不同武器触及');
  {
    // 匕首: maxReach=2
    assert(SpatialTactics.isInReach(1.5, 2) === true, '匕首触及 1.5');
    assert(SpatialTactics.isInReach(2.5, 2) === false, '匕首超距 2.5');

    // 长枪: maxReach=6, minReach=2
    assert(SpatialTactics.isInReach(3, 6, 2) === true, '长枪触及 3');
    assert(SpatialTactics.isInReach(1, 6, 2) === false, '长枪太近 1');
    assert(SpatialTactics.isInReach(7, 6, 2) === false, '长枪超距 7');

    // 弓箭: maxReach=15
    assert(SpatialTactics.isInReach(10, 15) === true, '弓箭触及 10');
    assert(SpatialTactics.isInReach(16, 15) === false, '弓箭超距 16');
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有空间战术测试通过!');
}

runTests();
