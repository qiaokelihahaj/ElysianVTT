// test/whiff.test.ts
// Whiff/Punish 挥空与确反测试

// ==========================================
// 1. 内联类型定义
// ==========================================
type EntityId = string;
type Tick = number;

interface Entity {
  id: EntityId;
  transform?: { coords: { x: number; y: number; z: number }; facing?: number };
  resources: { current: Record<string, number>; max: Record<string, number> };
  currentActionContext?: any;
}

interface ActionExecutionEvent {
  eventId: string;
  targetTick: Tick;
  status: 'PENDING' | 'RESOLVED' | 'CANCELLED';
  eventType: string;
  actorId: EntityId;
  targetIds?: EntityId[];
  actionTemplateId: string;
  phase: string;
  whiffed?: boolean;
  punishBonus?: number;
}

interface ActionTemplate {
  id: string;
  range: { type: string; distanceExpr: string };
  timeCost: { startupTicks: number; recoveryTicks: number };
}

// ==========================================
// 2. Whiff/Punish 系统实现
// ==========================================

interface WhiffResult {
  whiffed: boolean;
  recoveryMultiplier: number;
  punishable: boolean;
  whiffRecoveryTicks: number;
  originalRecoveryTicks: number;
}

class WhiffSystem {
  static readonly WHIFF_RECOVERY_MULTIPLIER = 1.5;
  static readonly PUNISH_BONUS_DAMAGE = 0.3; // 30% 额外伤害

  /**
   * 判断攻击是否挥空
   * @param rangeExpr 攻击范围表达式（数字）
   * @param distance 实际距离
   * @returns true 如果挥空
   */
  static isWhiff(rangeExpr: number | string, distance: number): boolean {
    const range = typeof rangeExpr === 'string' ? parseFloat(rangeExpr) : rangeExpr;
    return distance > range;
  }

  /**
   * 计算挥空后的恢复时间
   */
  static calculateWhiffRecovery(originalRecovery: number): number {
    return Math.ceil(originalRecovery * WhiffSystem.WHIFF_RECOVERY_MULTIPLIER);
  }

  /**
   * 处理一次攻击的挥空判定
   */
  static processAttack(
    actor: Entity,
    target: Entity | null,
    template: ActionTemplate
  ): { whiffResult: WhiffResult; event: ActionExecutionEvent } {
    const eventId = 'whiff_' + Math.random().toString(36).substring(2, 9);

    // 计算距离
    let distance = 0;
    if (target && actor.transform && target.transform) {
      const dx = actor.transform.coords.x - target.transform.coords.x;
      const dy = actor.transform.coords.y - target.transform.coords.y;
      const dz = actor.transform.coords.z - target.transform.coords.z;
      distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    const rangeExpr = template.range.distanceExpr;
    const whiffed = !target || WhiffSystem.isWhiff(rangeExpr, distance);

    const originalRecovery = template.timeCost.recoveryTicks;
    let recoveryTicks = originalRecovery;

    if (whiffed) {
      recoveryTicks = WhiffSystem.calculateWhiffRecovery(originalRecovery);
    }

    const event: ActionExecutionEvent = {
      eventId,
      targetTick: 0,
      status: 'RESOLVED',
      eventType: 'ACTION_PHASE',
      actorId: actor.id,
      targetIds: target ? [target.id] : [],
      actionTemplateId: template.id,
      phase: 'RECOVERY',
      whiffed,
      punishBonus: whiffed ? 0 : undefined,
    };

    const whiffResult: WhiffResult = {
      whiffed,
      recoveryMultiplier: whiffed ? WhiffSystem.WHIFF_RECOVERY_MULTIPLIER : 1.0,
      punishable: whiffed,
      whiffRecoveryTicks: recoveryTicks,
      originalRecoveryTicks: originalRecovery,
    };

    return { whiffResult, event };
  }

  /**
   * 计算确反伤害加成
   */
  static calculatePunishDamage(baseDamage: number, whiffRecoveryRemaining: number): {
    damage: number;
    bonusDamage: number;
    isPunish: boolean;
  } {
    if (whiffRecoveryRemaining <= 0) {
      return { damage: baseDamage, bonusDamage: 0, isPunish: false };
    }
    const bonus = Math.floor(baseDamage * WhiffSystem.PUNISH_BONUS_DAMAGE);
    return { damage: baseDamage + bonus, bonusDamage: bonus, isPunish: true };
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
  console.log('=== ElysianVTT Whiff/Punish 挥空与确反测试 ===\n');

  // ---- Test 1: 超出范围攻击挥空 ----
  console.log('[Test 1] 超出范围攻击挥空');
  {
    const swordsman: Entity = {
      id: 'swordsman',
      transform: { coords: { x: 0, y: 0, z: 0 } },
      resources: { current: { hp: 100 }, max: { hp: 100 } },
    };
    const archer: Entity = {
      id: 'archer',
      transform: { coords: { x: 15, y: 0, z: 0 } },
      resources: { current: { hp: 50 }, max: { hp: 50 } },
    };

    const template: ActionTemplate = {
      id: 'SWORD_SLASH',
      range: { type: 'MELEE', distanceExpr: '3' },
      timeCost: { startupTicks: 5, recoveryTicks: 4 },
    };

    const result = WhiffSystem.processAttack(swordsman, archer, template);
    assert(result.whiffResult.whiffed === true, '距离 15 > 范围 3 → 挥空');
  }

  // ---- Test 2: 挥空延长恢复时间 ----
  console.log('\n[Test 2] 挥空延长恢复时间 (1.5x)');
  {
    const swordsman: Entity = {
      id: 'swordsman',
      transform: { coords: { x: 0, y: 0, z: 0 } },
      resources: { current: { hp: 100 }, max: { hp: 100 } },
    };
    const farTarget: Entity = {
      id: 'far_target',
      transform: { coords: { x: 10, y: 0, z: 0 } },
      resources: { current: { hp: 50 }, max: { hp: 50 } },
    };

    const template: ActionTemplate = {
      id: 'SWORD_SLASH',
      range: { type: 'MELEE', distanceExpr: '2' },
      timeCost: { startupTicks: 5, recoveryTicks: 6 },
    };

    const result = WhiffSystem.processAttack(swordsman, farTarget, template);
    assert(result.whiffResult.whiffRecoveryTicks === 9, `挥空恢复 = ceil(6*1.5) = 9 (实际 ${result.whiffResult.whiffRecoveryTicks})`);
    assert(result.whiffResult.originalRecoveryTicks === 6, '原始恢复时间 = 6');
    assert(result.whiffResult.recoveryMultiplier === 1.5, '挥空倍率 = 1.5');
  }

  // ---- Test 3: 范围内正常命中 ----
  console.log('\n[Test 3] 范围内正常命中');
  {
    const warrior: Entity = {
      id: 'warrior',
      transform: { coords: { x: 0, y: 0, z: 0 } },
      resources: { current: { hp: 100 }, max: { hp: 100 } },
    };
    const target: Entity = {
      id: 'target',
      transform: { coords: { x: 2, y: 0, z: 0 } },
      resources: { current: { hp: 50 }, max: { hp: 50 } },
    };

    const template: ActionTemplate = {
      id: 'SPEAR_THRUST',
      range: { type: 'MELEE', distanceExpr: '3' },
      timeCost: { startupTicks: 8, recoveryTicks: 5 },
    };

    const result = WhiffSystem.processAttack(warrior, target, template);
    assert(result.whiffResult.whiffed === false, '距离 2 <= 范围 3 → 命中');
    assert(result.whiffResult.whiffRecoveryTicks === 5, '恢复时间不变 = 5');
    assert(result.event.whiffed === false, '事件 whiffed=false');
    assert(result.event.punishBonus === undefined, '命中无 punishBonus');
  }

  // ---- Test 4: Whiff 事件被标记 ----
  console.log('\n[Test 4] Whiff 事件标记');
  {
    const swordsman: Entity = {
      id: 'swordsman',
      transform: { coords: { x: 0, y: 0, z: 0 } },
      resources: { current: { hp: 100 }, max: { hp: 100 } },
    };

    const template: ActionTemplate = {
      id: 'SWORD_SLASH',
      range: { type: 'MELEE', distanceExpr: '2' },
      timeCost: { startupTicks: 4, recoveryTicks: 3 },
    };

    // 无目标 = 自动挥空
    const result = WhiffSystem.processAttack(swordsman, null, template);
    assert(result.whiffResult.whiffed === true, '无目标自动挥空');
    assert(result.event.whiffed === true, '事件 whiffed=true');
  }

  // ---- Test 5: 确反伤害加成 ----
  console.log('\n[Test 5] 确反伤害加成');
  {
    // 在挥空恢复期间受到攻击获得 bonus
    const baseDamage = 50;
    const punish = WhiffSystem.calculatePunishDamage(baseDamage, 1);
    assert(punish.isPunish === true, '恢复期间攻击 → 确反');
    assert(punish.bonusDamage === 15, `确反加成 = floor(50*0.3) = 15 (实际 ${punish.bonusDamage})`);
    assert(punish.damage === 65, `总伤害 = 50+15 = 65 (实际 ${punish.damage})`);
  }

  // ---- Test 6: 无恢复时不触发确反 ----
  console.log('\n[Test 6] 恢复结束无确反');
  {
    const baseDamage = 50;
    const normal = WhiffSystem.calculatePunishDamage(baseDamage, 0);
    assert(normal.isPunish === false, '恢复结束，不触发确反');
    assert(normal.damage === 50, '无加成');
  }

  // ---- Test 7: 完整挥空流程 ----
  console.log('\n[Test 7] 完整挥空生命周期');
  {
    const actor: Entity = {
      id: 'heavy_swordsman',
      transform: { coords: { x: 0, y: 0, z: 0 } },
      resources: { current: { hp: 200 }, max: { hp: 200 } },
    };
    const distant: Entity = {
      id: 'distant_foe',
      transform: { coords: { x: 20, y: 0, z: 0 } },
      resources: { current: { hp: 100 }, max: { hp: 100 } },
    };

    const template: ActionTemplate = {
      id: 'GREAT_SLAM',
      range: { type: 'MELEE', distanceExpr: '3' },
      timeCost: { startupTicks: 10, recoveryTicks: 8 },
    };

    // 1. 判定挥空
    const { whiffResult, event } = WhiffSystem.processAttack(actor, distant, template);
    assert(whiffResult.whiffed === true, '远距离攻击挥空');
    assert(event.whiffed === true, '事件标记挥空');

    // 2. 恢复延长
    assert(whiffResult.whiffRecoveryTicks === 12, `恢复 8 -> 12 (ceil(8*1.5))`);

    // 3. 使用剩余恢复 Ticks 触发确反
    const punish = WhiffSystem.calculatePunishDamage(40, whiffResult.whiffRecoveryTicks);
    assert(punish.isPunish === true, '挥空恢复中可被确反');
    assert(punish.bonusDamage === 12, `floor(40*0.3)=12 (实际 ${punish.bonusDamage})`);
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有 Whiff/Punish 测试通过!');
}

runTests();
