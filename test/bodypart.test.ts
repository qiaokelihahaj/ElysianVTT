// test/bodypart.test.ts
// 部位破坏与重击系统测试

// ==========================================
// 1. 内联类型定义
// ==========================================
type EntityId = string;

type BodyPart = 'HEAD' | 'TORSO' | 'LEFT_ARM' | 'RIGHT_ARM' | 'LEFT_LEG' | 'RIGHT_LEG';

interface HitLocationEntry {
  part: BodyPart;
  weight: number;          // d100 权重
  damageCap?: number;      // 单次伤害上限
  critMultiplier?: number; // 部位专属暴击倍率（覆盖默认）
}

interface HitResult {
  part: BodyPart;
  isCrit: boolean;
  critMultiplier: number;
  rawDamage: number;       // 暴击加成后的原始伤害
  cappedDamage: number;    // 经过部位上限截断后的最终伤害
  overflowDamage: number;  // 溢出伤害（浪费）
  partDestroyed: boolean;  // 部位是否已破坏（打空）
}

interface BodyPartState {
  currentHp: number;
  maxHp: number;
  destroyed: boolean;
}

interface Entity {
  id: EntityId;
  resources: { current: Record<string, number>; max: Record<string, number> };
  defenses?: { dr: number; parry: number; dodge: number };
  bodyParts?: Record<string, BodyPartState>;
}

// ==========================================
// 2. 部位判定与重击计算器
// ==========================================
class BodyPartResolver {
  /**
   * 加权随机选取命中部位
   * @param table 部位权重表
   * @param roll d100 掷骰结果 (1-100)
   */
  static rollHitLocation(table: HitLocationEntry[], roll: number): BodyPart {
    const totalWeight = table.reduce((sum, e) => sum + e.weight, 0);
    let cumulative = 0;
    const normalizedRoll = ((roll - 1) / 100) * totalWeight;

    for (const entry of table) {
      cumulative += entry.weight;
      if (normalizedRoll < cumulative) return entry.part;
    }
    // 兜底：返回最后一个部位
    return table[table.length - 1].part;
  }

  /**
   * 判定是否暴击
   * @param d20Roll d20 掷骰结果
   * @param critRange 暴击阈值 (>= 此值即暴击)
   * @param poolTags 骰子标签（支持 CRIT_SUCCESS 标签）
   */
  static isCritical(d20Roll: number, critRange: number, poolTags: string[] = []): boolean {
    return d20Roll >= critRange || poolTags.includes('CRIT_SUCCESS');
  }

  /**
   * 计算完整命中结果
   * @param rawDamage 基础伤害（来自公式求值）
   * @param hitTable 部位权重表
   * @param d100Roll d100 部位骰
   * @param d20Roll d20 暴击骰
   * @param critConfig 暴击配置
   * @param bodyParts 目标当前部位状态
   * @param poolTags 骰子标签
   */
  static resolveHit(
    rawDamage: number,
    hitTable: HitLocationEntry[],
    d100Roll: number,
    d20Roll: number,
    critConfig: { range: number; defaultMultiplier: number },
    bodyParts: Record<string, BodyPartState> | undefined,
    poolTags: string[] = []
  ): HitResult {
    const part = BodyPartResolver.rollHitLocation(hitTable, d100Roll);
    const isCrit = BodyPartResolver.isCritical(d20Roll, critConfig.range, poolTags);

    // 查找部位配置
    const partConfig = hitTable.find(e => e.part === part);
    const critMultiplier = (isCrit ? (partConfig?.critMultiplier ?? critConfig.defaultMultiplier) : 1);

    const afterCrit = Math.floor(rawDamage * critMultiplier);

    // 检查部位是否已破坏
    const partState = bodyParts?.[part];
    const partDestroyed = partState?.destroyed ?? false;

    if (partDestroyed) {
      return {
        part,
        isCrit,
        critMultiplier,
        rawDamage: afterCrit,
        cappedDamage: 0,     // 已破坏 → 打空
        overflowDamage: afterCrit,
        partDestroyed: true
      };
    }

    // 应用部位伤害上限
    const cap = partConfig?.damageCap;
    let cappedDamage = afterCrit;
    let overflowDamage = 0;

    if (cap !== undefined && afterCrit > cap) {
      cappedDamage = cap;
      overflowDamage = afterCrit - cap;
    }

    return {
      part,
      isCrit,
      critMultiplier,
      rawDamage: afterCrit,
      cappedDamage,
      overflowDamage,
      partDestroyed: false
    };
  }

  /**
   * 更新部位状态（应用伤害后）
   */
  static applyPartDamage(
    bodyParts: Record<string, BodyPartState>,
    part: BodyPart,
    damage: number
  ): { destroyed: boolean; newHp: number } {
    if (!bodyParts[part]) return { destroyed: false, newHp: 0 };

    const state = bodyParts[part];

    // 已破坏部位不再扣血
    if (state.destroyed) return { destroyed: true, newHp: 0 };

    const newHp = Math.max(0, state.currentHp - damage);
    state.currentHp = newHp;

    if (newHp <= 0) {
      state.destroyed = true;
      return { destroyed: true, newHp: 0 };
    }

    return { destroyed: false, newHp };
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

function assertEqual(actual: number, expected: number, label: string) {
  testCount++;
  if (actual === expected) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label} (期望=${expected}, 实际=${actual})`); process.exitCode = 1; }
}

function runTests() {
  console.log('=== ElysianVTT 部位破坏与重击系统测试 ===\n');

  // ---- 标准部位表（伊利塞昂风格）----
  const standardHitTable: HitLocationEntry[] = [
    { part: 'HEAD', weight: 10, damageCap: 30, critMultiplier: 3.0 },
    { part: 'TORSO', weight: 40, damageCap: 80 },
    { part: 'LEFT_ARM', weight: 15, damageCap: 25, critMultiplier: 1.5 },
    { part: 'RIGHT_ARM', weight: 15, damageCap: 25, critMultiplier: 1.5 },
    { part: 'LEFT_LEG', weight: 10, damageCap: 30 },
    { part: 'RIGHT_LEG', weight: 10, damageCap: 30 },
  ];

  // =======================================
  // Test 1: 部位命中判定 — 权重分布正确
  // =======================================
  console.log('[Test 1] 部位命中判定 — d100 加权随机');
  {
    // d100=1 → 头部（权重10, 落在 [0,10) 区间）
    assertEqual(
      BodyPartResolver.rollHitLocation(standardHitTable, 1),
      'HEAD' as any,
      'd100=1 → HEAD'
    );
    // d100=10 → 仍在头部 (权重10, [0,10))
    assertEqual(
      BodyPartResolver.rollHitLocation(standardHitTable, 10),
      'HEAD' as any,
      'd100=10 → HEAD'
    );
    // d100=11 → TORSO (权重10+40=50, [10,50))
    assertEqual(
      BodyPartResolver.rollHitLocation(standardHitTable, 11),
      'TORSO' as any,
      'd100=11 → TORSO'
    );
    // d100=50 → TORSO
    assertEqual(
      BodyPartResolver.rollHitLocation(standardHitTable, 50),
      'TORSO' as any,
      'd100=50 → TORSO'
    );
    // d100=51 → LEFT_ARM (权重10+40+15=65, [50,65))
    assertEqual(
      BodyPartResolver.rollHitLocation(standardHitTable, 51),
      'LEFT_ARM' as any,
      'd100=51 → LEFT_ARM'
    );
    // d100=100 → RIGHT_LEG (最后一个)
    assertEqual(
      BodyPartResolver.rollHitLocation(standardHitTable, 100),
      'RIGHT_LEG' as any,
      'd100=100 → RIGHT_LEG'
    );
  }

  // =======================================
  // Test 2: 暴击判定
  // =======================================
  console.log('\n[Test 2] 暴击判定');
  {
    const critConfig = { range: 18, defaultMultiplier: 2.0 };

    // d20=18 → 暴击 (>= 18)
    assert(BodyPartResolver.isCritical(18, critConfig.range) === true, 'd20=18 >= 18 → 暴击');
    // d20=20 → 暴击
    assert(BodyPartResolver.isCritical(20, critConfig.range) === true, 'd20=20 >= 18 → 暴击');
    // d20=17 → 未暴击
    assert(BodyPartResolver.isCritical(17, critConfig.range) === false, 'd20=17 < 18 → 未暴击');
    // CRIT_SUCCESS 标签 → 强暴击
    assert(BodyPartResolver.isCritical(5, critConfig.range, ['CRIT_SUCCESS']) === true, 'CRIT_SUCCESS 标签 → 强暴击');
    // CRIT_FAILURE → 不影响暴击判定
    assert(BodyPartResolver.isCritical(19, critConfig.range, ['CRIT_FAILURE']) === true, 'CRIT_FAILURE 不阻止自然暴击');
  }

  // =======================================
  // Test 3: 要害优先路线 — 完整命中结算
  // =======================================
  console.log('\n[Test 3] 要害优先路线 — 完整命中结算');
  {
    const critConfig = { range: 18, defaultMultiplier: 2.0 };
    const freshParts: Record<string, BodyPartState> = {
      HEAD: { currentHp: 30, maxHp: 30, destroyed: false },
      TORSO: { currentHp: 100, maxHp: 100, destroyed: false },
      LEFT_ARM: { currentHp: 30, maxHp: 30, destroyed: false },
      RIGHT_ARM: { currentHp: 30, maxHp: 30, destroyed: false },
      LEFT_LEG: { currentHp: 35, maxHp: 35, destroyed: false },
      RIGHT_LEG: { currentHp: 35, maxHp: 35, destroyed: false },
    };

    // 场景A: 普通命中躯干, 伤害20 → 无暴击，无截断
    const r1 = BodyPartResolver.resolveHit(20, standardHitTable, 30, 10, critConfig, freshParts);
    assertEqual(r1.part as any, 'TORSO', 'd100=30 → TORSO');
    assert(r1.isCrit === false, 'd20=10 → 非暴击');
    assertEqual(r1.cappedDamage, 20, '躯干伤害20 < 上限80, 无截断');
    assertEqual(r1.partDestroyed, false, '躯干未破坏');

    // 场景B: 暴击命中头部, 伤害15 → 暴击(20>=18) × 头部3.0倍 = 45 → 截断至30
    const r2 = BodyPartResolver.resolveHit(15, standardHitTable, 5, 20, critConfig, freshParts);
    assertEqual(r2.part as any, 'HEAD', 'd100=5 → HEAD');
    assert(r2.isCrit === true, 'd20=20 → 暴击');
    assertEqual(r2.critMultiplier, 3.0, '头部暴击倍率=3.0');
    assertEqual(r2.rawDamage, 45, '15 × 3.0 = 45');
    assertEqual(r2.cappedDamage, 30, '头部上限30 → 截断至30');
    assertEqual(r2.overflowDamage, 15, '溢出伤害 45-30=15');

    // 场景C: 非暴击命中手臂, 伤害40 → 无暴击，截断至25
    const r3 = BodyPartResolver.resolveHit(40, standardHitTable, 55, 10, critConfig, freshParts);
    assertEqual(r3.part as any, 'LEFT_ARM', 'd100=55 → LEFT_ARM');
    assert(r3.isCrit === false, 'd20=10 → 非暴击');
    assertEqual(r3.rawDamage, 40, '无暴击倍率');
    assertEqual(r3.cappedDamage, 25, '手臂上限25 → 截断');
    assertEqual(r3.overflowDamage, 15, '溢出 40-25=15');
  }

  // =======================================
  // Test 4: 部位破坏跟踪 — 已破坏部位 = 打空
  // =======================================
  console.log('\n[Test 4] 已破坏部位 → 打空');
  {
    const critConfig = { range: 18, defaultMultiplier: 2.0 };
    const damagedParts: Record<string, BodyPartState> = {
      HEAD: { currentHp: 0, maxHp: 30, destroyed: true },  // 头部已破坏!
      TORSO: { currentHp: 50, maxHp: 100, destroyed: false },
      LEFT_ARM: { currentHp: 30, maxHp: 30, destroyed: false },
      RIGHT_ARM: { currentHp: 30, maxHp: 30, destroyed: false },
      LEFT_LEG: { currentHp: 35, maxHp: 35, destroyed: false },
      RIGHT_LEG: { currentHp: 35, maxHp: 35, destroyed: false },
    };

    // 暴击命中已破坏的头部 → 打空
    const r = BodyPartResolver.resolveHit(50, standardHitTable, 3, 20, critConfig, damagedParts);
    assertEqual(r.part as any, 'HEAD', '命中部位=HEAD');
    assert(r.isCrit === true, '暴击成立');
    assertEqual(r.cappedDamage, 0, '部位已破坏 → 伤害=0（打空）');
    assert(r.partDestroyed === true, '标记部位已破坏');
    assert(r.overflowDamage > 0, '溢出伤害 > 0（全伤浪费）');
  }

  // =======================================
  // Test 5: 部位伤害应用 — HP 递减与破坏触发
  // =======================================
  console.log('\n[Test 5] 部位伤害应用 — 破坏触发');
  {
    const parts: Record<string, BodyPartState> = {
      LEFT_ARM: { currentHp: 20, maxHp: 30, destroyed: false },
    };

    // 伤害15 → 剩余5, 未破坏
    const r1 = BodyPartResolver.applyPartDamage(parts, 'LEFT_ARM', 15);
    assertEqual(r1.newHp, 5, '20-15=5 剩余');
    assert(r1.destroyed === false, 'HP>0 → 未破坏');
    assert(parts.LEFT_ARM.destroyed === false, 'state.destroyed=false');

    // 伤害10 → 归零, 触发破坏
    const r2 = BodyPartResolver.applyPartDamage(parts, 'LEFT_ARM', 10);
    assertEqual(r2.newHp, 0, '5-10 → 归零');
    assert(r2.destroyed === true, 'HP≤0 → 触发破坏');
    assert(parts.LEFT_ARM.destroyed === true, 'state.destroyed=true');

    // 再次攻击已破坏部位 → 保持破坏状态
    const r3 = BodyPartResolver.applyPartDamage(parts, 'LEFT_ARM', 5);
    assertEqual(r3.newHp, 0, '已破坏, 不再扣血');
    assert(r3.destroyed === true, '保持破坏状态');
  }

  // =======================================
  // Test 6: 损伤优先路线 — 无部位判定, 全额伤害
  // =======================================
  console.log('\n[Test 6] 损伤优先路线 — 全额伤害, 无截断');
  {
    // 损伤路线：不传部位表，直接全伤
    // 模拟: 伤害50, DR=10, 全部打到 hp
    const entity: Entity = {
      id: 'test',
      resources: { current: { hp: 100 }, max: { hp: 100 } },
      defenses: { dr: 10, parry: 0, dodge: 0 }
    };

    const rawDamage = 50;
    const dr = entity.defenses?.dr ?? 0;
    const finalDamage = Math.max(0, rawDamage - dr);
    entity.resources.current.hp -= finalDamage;

    assertEqual(finalDamage, 40, '损伤路线: 50-10=40 (DR后)');
    assertEqual(entity.resources.current.hp, 60, 'HP: 100-40=60');
  }

  // =======================================
  // Test 7: 整合 — 要害路线完整流程 (命中→暴击→截断→部位伤害→HP扣除)
  // =======================================
  console.log('\n[Test 7] 完整整合流程: 要害优先路线');
  {
    const critConfig = { range: 17, defaultMultiplier: 2.0 };
    const freshParts: Record<string, BodyPartState> = {
      HEAD: { currentHp: 30, maxHp: 30, destroyed: false },
      TORSO: { currentHp: 100, maxHp: 100, destroyed: false },
      LEFT_ARM: { currentHp: 30, maxHp: 30, destroyed: false },
      RIGHT_ARM: { currentHp: 30, maxHp: 30, destroyed: false },
      LEFT_LEG: { currentHp: 35, maxHp: 35, destroyed: false },
      RIGHT_LEG: { currentHp: 35, maxHp: 35, destroyed: false },
    };

    // 攻击: 基础伤害25, d100=1(头部), d20=19(暴击)
    // 预期: 25 × 3.0(头暴) = 75 → 截断至30 → 头部HP 30→0
    const hitResult = BodyPartResolver.resolveHit(25, standardHitTable, 1, 19, critConfig, freshParts);
    assertEqual(hitResult.part as any, 'HEAD', '命中头部');
    assert(hitResult.isCrit === true, 'd20=19 → 暴击');
    assertEqual(hitResult.rawDamage, 75, '25 × 3.0 = 75');
    assertEqual(hitResult.cappedDamage, 30, '截断至头部上限30');

    const partResult = BodyPartResolver.applyPartDamage(freshParts, hitResult.part, hitResult.cappedDamage);
    assertEqual(partResult.newHp, 0, '头部HP 30→0');
    assert(partResult.destroyed === true, '头部被破坏!');
    assert(freshParts.HEAD.destroyed === true, 'state 标记已破坏');

    // 第二轮: 再次命中头部(已破坏) → 打空
    const hitResult2 = BodyPartResolver.resolveHit(50, standardHitTable, 5, 15, critConfig, freshParts);
    assertEqual(hitResult2.part as any, 'HEAD', '再次命中头部');
    assertEqual(hitResult2.cappedDamage, 0, '头部已破坏 → 打空');
    assert(hitResult2.partDestroyed === true, '标记已破坏');
  }

  // =======================================
  // Test 8: 部位专属暴击倍率覆盖
  // =======================================
  console.log('\n[Test 8] 部位专属暴击倍率 vs 默认倍率');
  {
    const critConfig = { range: 17, defaultMultiplier: 2.0 };
    const freshParts: Record<string, BodyPartState> = {
      HEAD: { currentHp: 30, maxHp: 30, destroyed: false },
      TORSO: { currentHp: 100, maxHp: 100, destroyed: false },
      LEFT_ARM: { currentHp: 30, maxHp: 30, destroyed: false },
      RIGHT_ARM: { currentHp: 30, maxHp: 30, destroyed: false },
      LEFT_LEG: { currentHp: 35, maxHp: 35, destroyed: false },
      RIGHT_LEG: { currentHp: 35, maxHp: 35, destroyed: false },
    };

    // 暴击命中躯干: 无专属倍率 → 使用默认 2.0
    const r1 = BodyPartResolver.resolveHit(20, standardHitTable, 30, 19, critConfig, freshParts);
    assertEqual(r1.part as any, 'TORSO', '命中躯干');
    assertEqual(r1.critMultiplier, 2.0, '躯干无专属倍率 → 默认 2.0');
    assertEqual(r1.rawDamage, 40, '20 × 2.0 = 40');

    // 暴击命中手臂: 专属倍率 1.5
    const r2 = BodyPartResolver.resolveHit(20, standardHitTable, 55, 19, critConfig, { ...freshParts });
    assertEqual(r2.part as any, 'LEFT_ARM', '命中左臂');
    assertEqual(r2.critMultiplier, 1.5, '手臂专属倍率 1.5');
    assertEqual(r2.rawDamage, 30, '20 × 1.5 = 30');
  }

  // =======================================
  // Test 9: 边界条件 — 无部位表 (损伤路线兼容)
  // =======================================
  console.log('\n[Test 9] 边界条件 — 空部位表');
  {
    // 单部位表 (只定义躯干，模拟无部位判定的简化情况)
    const torsoOnly: HitLocationEntry[] = [
      { part: 'TORSO', weight: 100 }
    ];
    const critConfig = { range: 20, defaultMultiplier: 1.5 };
    const parts: Record<string, BodyPartState> = {
      TORSO: { currentHp: 100, maxHp: 100, destroyed: false },
    };

    const r = BodyPartResolver.resolveHit(30, torsoOnly, 50, 15, critConfig, parts);
    assertEqual(r.part as any, 'TORSO', '唯一部位=TORSO');
    assert(r.isCrit === false, 'd20=15 < 20 → 非暴击');
    assertEqual(r.cappedDamage, 30, '无 cap → 全伤30');
    assertEqual(r.overflowDamage, 0, '无溢出');
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有部位破坏测试通过!');
}

runTests();
