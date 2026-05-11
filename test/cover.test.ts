// test/cover.test.ts
// Phase 3.3 掩体系统与战术姿态测试

// ==========================================
// 1. 内联类型
// ==========================================
type EntityId = string;
type CoverType = 'NONE' | 'HALF' | 'FULL';
type TacticalStance = 'ADS' | 'BLIND_FIRE' | 'NONE';
type BodyPart = 'HEAD' | 'TORSO' | 'LEFT_ARM' | 'RIGHT_ARM' | 'LEFT_LEG' | 'RIGHT_LEG';

interface Vector3D { x: number; y: number; z: number; }

interface CoverState {
  coverDefId: string;
  coverType: CoverType;
  coverDr: number;
  coverThreshold: number;
  facing: number;
  height: number;
}

interface Entity {
  id: EntityId;
  transform: { coords: Vector3D; facing: number; planeId?: string };
  coverState?: CoverState;
  currentStance?: TacticalStance;
}

interface StanceConfig {
  stance: TacticalStance;
  accuracyModifier: number;
  exposedBodyParts: BodyPart[];
  shotDeviation: number;
  switchCostTicks: number;
}

// ==========================================
// 2. CoverService (内联实现)
// ==========================================

const STANCE_CONFIGS: Record<TacticalStance, StanceConfig> = {
  'ADS': {
    stance: 'ADS',
    accuracyModifier: 2,
    exposedBodyParts: ['HEAD', 'LEFT_ARM', 'RIGHT_ARM'],
    shotDeviation: 0,
    switchCostTicks: 5
  },
  'BLIND_FIRE': {
    stance: 'BLIND_FIRE',
    accuracyModifier: -4,
    exposedBodyParts: [],
    shotDeviation: 3,
    switchCostTicks: 3
  },
  'NONE': {
    stance: 'NONE',
    accuracyModifier: 0,
    exposedBodyParts: ['HEAD', 'TORSO', 'LEFT_ARM', 'RIGHT_ARM', 'LEFT_LEG', 'RIGHT_LEG'],
    shotDeviation: 0,
    switchCostTicks: 0
  }
};

class CoverService {
  static getCoverBetween(attackerPos: Vector3D, target: Entity): CoverState | null {
    if (!target.coverState) return null;
    const cover = target.coverState;
    const coverFacingRad = cover.facing * (Math.PI / 180);
    const dx = attackerPos.x - target.transform.coords.x;
    const dy = attackerPos.y - target.transform.coords.y;
    const facingX = Math.cos(coverFacingRad);
    const facingY = Math.sin(coverFacingRad);
    const dot = dx * facingX + dy * facingY;
    return dot > 0 ? cover : null;
  }

  static resolveCoverCollision(d20Roll: number, coverThreshold: number): { hitsCover: boolean } {
    return { hitsCover: d20Roll < coverThreshold };
  }

  static checkCoverPenetration(cover: CoverState, d20Roll: number): { penetrates: boolean; hitsCover: boolean } {
    if (cover.coverType === 'FULL') {
      return {
        penetrates: d20Roll >= cover.coverThreshold,
        hitsCover: d20Roll < cover.coverThreshold
      };
    }
    return {
      penetrates: d20Roll >= cover.coverThreshold,
      hitsCover: d20Roll < cover.coverThreshold
    };
  }

  static applyCoverDR(rawDamage: number, coverDr: number): number {
    return Math.max(0, rawDamage - coverDr);
  }

  static getExposedParts(stance: TacticalStance): BodyPart[] {
    return [...STANCE_CONFIGS[stance]?.exposedBodyParts ?? []];
  }

  static getStanceConfig(stance: TacticalStance): StanceConfig {
    return { ...STANCE_CONFIGS[stance] };
  }

  static getAccuracyModifier(stance: TacticalStance): number {
    return STANCE_CONFIGS[stance]?.accuracyModifier ?? 0;
  }

  static getBlastShadowMultiplier(distToCover: number, blastRadius: number): number {
    if (blastRadius <= 0) return 1.0;
    const shadowFactor = Math.min(1.0, distToCover / (blastRadius * 0.5));
    return Math.max(0.3, 1.0 - shadowFactor * 0.7);
  }

  static getSwitchCost(stance: TacticalStance): number {
    return STANCE_CONFIGS[stance]?.switchCostTicks ?? 0;
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

// ==========================================
// 4. 测试用例
// ==========================================

function runTests() {
  console.log('=== ElysianVTT 掩体系统与战术姿态测试 (Phase 3.3) ===\n');

  // ---- Test 1: 掩体识别 ----
  console.log('[Test 1] 掩体识别 — getCoverBetween');
  {
    // 射手在南，目标在原点，掩体朝南（保护来自南方的攻击）
    const attacker: Vector3D = { x: 0, y: -5, z: 0 };
    const target: Entity = {
      id: 'target',
      transform: { coords: { x: 0, y: 0, z: 0 }, facing: 0 },
      coverState: {
        coverDefId: 'wall',
        coverType: 'HALF',
        coverDr: 5,
        coverThreshold: 10,
        facing: 270,  // 朝南（270°）
        height: 2
      }
    };

    // 攻击者从南方来 → 有掩体
    const coverFromSouth = CoverService.getCoverBetween(attacker, target);
    assert(coverFromSouth !== null, '攻击来自掩体朝向方向时返回有效掩体');

    // 攻击者从北方来 → 无掩体
    const attackerNorth: Vector3D = { x: 0, y: 5, z: 0 };
    const coverFromNorth = CoverService.getCoverBetween(attackerNorth, target);
    assert(coverFromNorth === null, '攻击来自掩体背面时返回 null');

    // 无掩体实体 → null
    const nakedTarget: Entity = {
      id: 'naked',
      transform: { coords: { x: 0, y: 0, z: 0 }, facing: 0 }
    };
    const noCover = CoverService.getCoverBetween(attacker, nakedTarget);
    assert(noCover === null, '无 coverState 实体返回 null');
  }

  // ---- Test 2: 掩体碰撞阈值 ----
  console.log('\n[Test 2] 掩体碰撞判定');
  {
    const cover: CoverState = {
      coverDefId: 'wall', coverType: 'HALF', coverDr: 5,
      coverThreshold: 10, facing: 0, height: 2
    };

    // d20 < 10 → 命中掩体
    const r1 = CoverService.checkCoverPenetration(cover, 5);
    assert(r1.hitsCover === true, 'd20=5 < 10 → 命中掩体');
    assert(r1.penetrates === false, 'd20=5 → 未穿透');

    // d20 >= 10 → 穿透掩体
    const r2 = CoverService.checkCoverPenetration(cover, 12);
    assert(r2.hitsCover === false, 'd20=12 >= 10 → 未命中掩体');
    assert(r2.penetrates === true, 'd20=12 → 穿透');

    // 边界值
    const r3 = CoverService.checkCoverPenetration(cover, 10);
    assert(r3.penetrates === true, 'd20=10 = 阈值 → 穿透');
  }

  // ---- Test 3: 全掩体 vs 半掩体 ----
  console.log('\n[Test 3] 全掩体 vs 半掩体');
  {
    const halfCover: CoverState = {
      coverDefId: 'low_wall', coverType: 'HALF', coverDr: 3,
      coverThreshold: 8, facing: 0, height: 1.5
    };
    const fullCover: CoverState = {
      coverDefId: 'high_wall', coverType: 'FULL', coverDr: 10,
      coverThreshold: 14, facing: 0, height: 3
    };

    // 半掩体：d20=12 >= 8 穿透
    const r1 = CoverService.checkCoverPenetration(halfCover, 12);
    assert(r1.penetrates === true, '半掩体 d20=12 >= 8 → 穿透');

    // 半掩体：d20=5 < 8 命中掩体
    const r2 = CoverService.checkCoverPenetration(halfCover, 5);
    assert(r2.hitsCover === true, '半掩体 d20=5 < 8 → 命中掩体');

    // 全掩体：高阈值
    const r3 = CoverService.checkCoverPenetration(fullCover, 12);
    assert(r3.hitsCover === true, '全掩体 d20=12 < 14 → 命中掩体');
    assert(r3.penetrates === false, '全掩体 d20=12 → 未穿透');

    const r4 = CoverService.checkCoverPenetration(fullCover, 16);
    assert(r4.penetrates === true, '全掩体 d20=16 >= 14 → 穿透');
  }

  // ---- Test 4: 掩体 DR 计算 ----
  console.log('\n[Test 4] 掩体 DR');
  {
    const rawDamage = 25;
    const coverDr = 8;

    const afterCover = CoverService.applyCoverDR(rawDamage, coverDr);
    assert(afterCover === 17, `掩体 DR=${coverDr}: ${rawDamage}-${coverDr}=${afterCover}`);

    // 掩体 DR 高于伤害 → 减为 0
    const highCoverDR = CoverService.applyCoverDR(5, 10);
    assert(highCoverDR === 0, '掩体 DR > 伤害 → 0');

    // 无掩体 DR
    const noCoverDR = CoverService.applyCoverDR(20, 0);
    assert(noCoverDR === 20, '无掩体 DR → 全额伤害');
  }

  // ---- Test 5: 战术姿态配置 ----
  console.log('\n[Test 5] 战术姿态配置');
  {
    const adsCfg = CoverService.getStanceConfig('ADS');
    assert(adsCfg.accuracyModifier === 2, 'ADS 命中修正 +2');
    assert(adsCfg.shotDeviation === 0, 'ADS 无偏移');
    assert(adsCfg.switchCostTicks === 5, 'ADS 切换消耗 5 Tick');

    const bfCfg = CoverService.getStanceConfig('BLIND_FIRE');
    assert(bfCfg.accuracyModifier === -4, 'BLIND_FIRE 命中修正 -4');
    assert(bfCfg.shotDeviation === 3, 'BLIND_FIRE 偏移半径 3');
    assert(bfCfg.switchCostTicks === 3, 'BLIND_FIRE 切换消耗 3 Tick');

    const noneCfg = CoverService.getStanceConfig('NONE');
    assert(noneCfg.accuracyModifier === 0, 'NONE 命中修正 0');
    assert(noneCfg.switchCostTicks === 0, 'NONE 切换消耗 0');
  }

  // ---- Test 6: 姿态暴露部位 ----
  console.log('\n[Test 6] 姿态暴露部位');
  {
    const adsParts = CoverService.getExposedParts('ADS');
    assert(adsParts.length === 3, 'ADS 暴露 3 个部位');
    assert(adsParts.includes('HEAD'), 'ADS 暴露 HEAD');
    assert(adsParts.includes('LEFT_ARM'), 'ADS 暴露 LEFT_ARM');
    assert(adsParts.includes('RIGHT_ARM'), 'ADS 暴露 RIGHT_ARM');
    assert(!adsParts.includes('TORSO'), 'ADS 不暴露 TORSO');

    const bfParts = CoverService.getExposedParts('BLIND_FIRE');
    assert(bfParts.length === 0, 'BLIND_FIRE 暴露 0 个部位');

    const noneParts = CoverService.getExposedParts('NONE');
    assert(noneParts.length === 6, 'NONE 暴露全部 6 个部位');
  }

  // ---- Test 7: 姿态命中修正组合 ----
  console.log('\n[Test 7] 姿态命中修正组合');
  {
    const cover: CoverState = {
      coverDefId: 'wall', coverType: 'HALF', coverDr: 5,
      coverThreshold: 10, facing: 0, height: 2
    };

    // ADS: +2 → d20=8 变成 10 → 穿透
    const adsPenetrates = CoverService.checkCoverPenetration(cover, 8 + 2);
    assert(adsPenetrates.penetrates === true, 'ADS d20=8+2=10 >= 10 → 穿透');

    // BLIND_FIRE: -4 → d20=14 变成 10 → 刚好穿透
    const bfPenetrates = CoverService.checkCoverPenetration(cover, 14 + (-4));
    assert(bfPenetrates.penetrates === true, 'BLIND_FIRE d20=14-4=10 >= 10 → 刚好穿透');

    // BLIND_FIRE: -4 → d20=12 变成 8 → 命中掩体
    const bfCover = CoverService.checkCoverPenetration(cover, 12 + (-4));
    assert(bfCover.hitsCover === true, 'BLIND_FIRE d20=12-4=8 < 10 → 命中掩体');
  }

  // ---- Test 8: 爆风阴影 ----
  console.log('\n[Test 8] 爆风阴影（Blast Shadow）');
  {
    // 有爆炸半径时产生减伤
    const near = CoverService.getBlastShadowMultiplier(0.5, 5);
    assert(near < 1.0, `爆炸范围内: 有减伤 (倍率=${near.toFixed(2)})`);
    assert(near >= 0.3, '不低于 30% 最低倍率');

    // 随距离变化
    const mid = CoverService.getBlastShadowMultiplier(2.5, 5);
    assert(mid > 0.3 && mid < 1.0, `中等距离: 部分减伤 (倍率=${mid.toFixed(2)})`);

    // 无爆炸半径 → 全额伤害
    const noBlast = CoverService.getBlastShadowMultiplier(1, 0);
    assert(noBlast === 1.0, '无爆炸半径 → 全额伤害');

    // blastRadius=0 边缘情况
    const zero = CoverService.getBlastShadowMultiplier(0, 0);
    assert(zero === 1.0, 'blastRadius=0 → 全额伤害');
  }

  // ---- Test 9: 命中修正对覆盖穿透的影响 ----
  console.log('\n[Test 9] 命中修正的综合影响');
  {
    const cover: CoverState = {
      coverDefId: 'wall', coverType: 'FULL', coverDr: 5,
      coverThreshold: 12, facing: 0, height: 2
    };

    // 无姿态：d20=11 < 12 → 命中掩体
    const noStance = CoverService.checkCoverPenetration(cover, 11);
    assert(noStance.hitsCover === true, '无姿态 d20=11 < 12 → 命中全掩体');

    // ADS +2: d20=11+2=13 >= 12 → 穿透
    const stanceCfg = CoverService.getStanceConfig('ADS');
    const effectiveRoll = 11 + stanceCfg.accuracyModifier;
    const adsResult = CoverService.checkCoverPenetration(cover, effectiveRoll);
    assert(adsResult.penetrates === true, `ADS d20=11+2=${effectiveRoll} >= 12 → 穿透全掩体`);

    // BLIND_FIRE -4: d20=14-4=10 < 12 → 命中掩体（即使原始骰较高）
    const bfCfg = CoverService.getStanceConfig('BLIND_FIRE');
    const bfRoll = 14 + bfCfg.accuracyModifier;
    const bfResult = CoverService.checkCoverPenetration(cover, bfRoll);
    assert(bfResult.hitsCover === true, `BLIND_FIRE d20=14-4=${bfRoll} < 12 → 命中掩体`);
  }

  // ---- Test 10: 实体掩体朝向多处攻击 ----
  console.log('\n[Test 10] 多方向掩体检测');
  {
    const target: Entity = {
      id: 'protected',
      transform: { coords: { x: 0, y: 0, z: 0 }, facing: 0 },
      coverState: {
        coverDefId: 'wall', coverType: 'HALF', coverDr: 5,
        coverThreshold: 8, facing: 0, height: 2 // 朝东（0°）
      }
    };

    // 从东面攻击 → 在掩体正面 → 有掩体
    const east = CoverService.getCoverBetween({ x: 5, y: 0, z: 0 }, target);
    assert(east !== null, '从东面攻击 → 有掩体');

    // 从西面攻击 → 在掩体背面 → 无掩体
    const west = CoverService.getCoverBetween({ x: -5, y: 0, z: 0 }, target);
    assert(west === null, '从西面攻击 → 无掩体');

    // 从北面攻击 → 侧向 → 无掩体
    const north = CoverService.getCoverBetween({ x: 0, y: 5, z: 0 }, target);
    assert(north === null, '从北面攻击 → 无掩体');
  }

  // ---- Test 11: 姿态切换消耗 ----
  console.log('\n[Test 11] 姿态切换消耗');
  {
    // NONE → ADS: 5 Tick
    assert(CoverService.getSwitchCost('ADS') === 5, 'NONE → ADS 消耗 5 Tick');

    // NONE → BLIND_FIRE: 3 Tick
    assert(CoverService.getSwitchCost('BLIND_FIRE') === 3, 'NONE → BLIND_FIRE 消耗 3 Tick');

    // NONE: 无消耗
    assert(CoverService.getSwitchCost('NONE') === 0, 'NONE 无消耗');
  }

  // ---- Test 12: 掩体 DR 与护甲 DR 叠加 ----
  console.log('\n[Test 12] 掩体 DR + 护甲 DR 叠加');
  {
    const rawDamage = 30;
    const armorDr = 5;
    const coverDr = 8;

    // 先护甲再掩体
    const afterArmor = Math.max(0, rawDamage - armorDr);
    const afterCover = Math.max(0, afterArmor - coverDr);
    assert(afterArmor === 25, `护甲 DR=${armorDr}: ${rawDamage}-${armorDr}=${afterArmor}`);
    assert(afterCover === 17, `护甲+掩体 DR=${armorDr}+${coverDr}: ${afterArmor}-${coverDr}=${afterCover}`);

    // 叠加后不应低于 0
    const smallDmg = 5;
    const stackedDR = Math.max(0, Math.max(0, smallDmg - armorDr) - coverDr);
    assert(stackedDR === 0, '小伤害被叠加 DR 减为 0');
  }

  // ---- Test 13: 无掩体行为 ----
  console.log('\n[Test 13] 无掩体实体总是可被命中');
  {
    const target: Entity = {
      id: 'exposed',
      transform: { coords: { x: 0, y: 0, z: 0 }, facing: 0 }
      // 无 coverState
    };

    const cover = CoverService.getCoverBetween({ x: 5, y: 0, z: 0 }, target);
    assert(cover === null, '无掩体实体返回 null');
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有掩体系统测试通过!');
  else console.log('❌ 存在失败测试!');
}

runTests();
