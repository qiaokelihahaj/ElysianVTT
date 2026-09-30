// test/parry.test.ts
// Parry 招架系统测试

// ==========================================
// 1. 内联类型定义
// ==========================================
type EntityId = string;
type Tick = number;

interface Entity {
  id: EntityId;
  resources: { current: Record<string, number>; max: Record<string, number> };
  defenses?: { dr: number; parry: number; dodge: number };
  currentActionContext?: any;
  parryState?: {
    active: boolean;
    remainingTicks: number;
    parryValue: number;
    startupTicks: number;
    recoveryTicks: number;
  };
}

interface ActionEffectPayload {
  type: 'DAMAGE' | 'HEAL' | 'APPLY_BUFF' | 'PUSH' | 'INTERRUPT';
  targetSelector: 'PRIMARY' | 'ALL_IN_AOE' | 'SELF';
  parameters: Record<string, any>;
}

// ==========================================
// 2. Parry 系统实现
// ==========================================

/** 招架配置常量 */
const PARRY = {
  STARTUP_TICKS: 3,    // 招架前摇
  ACTIVE_TICKS: 8,     // 招架判定窗口
  RECOVERY_TICKS: 4,   // 招架收招
  PP_COST: 15,         // 招架消耗的 PP (Poise)
  DAMAGE_REDUCTION: 0.5, // 招架成功减免 50% 伤害
};

class ParrySystem {
  /**
   * 处理 DEFEND 意图，创建招架状态
   */
  static handleDefendIntent(actor: Entity, currentTick: Tick): boolean {
    // 检查 PP 是否足够
    const pp = actor.resources.current['poise'] ?? 0;
    if (pp < PARRY.PP_COST) {
      return false; // PP 不足，招架失败
    }

    // 消耗 PP
    actor.resources.current['poise'] = pp - PARRY.PP_COST;

    // 设置招架状态
    actor.parryState = {
      active: true,
      remainingTicks: PARRY.ACTIVE_TICKS,
      parryValue: actor.defenses?.parry ?? 0,
      startupTicks: PARRY.STARTUP_TICKS,
      recoveryTicks: PARRY.RECOVERY_TICKS,
    };

    return true;
  }

  /**
   * 尝试招架一次攻击
   * @returns 减免后的伤害（0 表示完全格挡）
   */
  static tryParry(actor: Entity, incomingDamage: number): number {
    if (!actor.parryState?.active) {
      return incomingDamage; // 非招架状态，全额伤害
    }

    // 招架减免伤害
    const reduced = Math.floor(incomingDamage * PARRY.DAMAGE_REDUCTION);
    return reduced;
  }

  /**
   * 推进招架状态 Tick
   * @returns true 如果招架仍活跃
   */
  static tickParry(actor: Entity): boolean {
    if (!actor.parryState) return false;

    if (actor.parryState.startupTicks > 0) {
      // 还处在前摇阶段
      actor.parryState.startupTicks--;
      return true;
    }

    if (actor.parryState.remainingTicks > 0) {
      // 招架判定窗口
      actor.parryState.remainingTicks--;
      return true;
    }

    if (actor.parryState.recoveryTicks > 0) {
      // 收招阶段
      actor.parryState.recoveryTicks--;
      return true;
    }

    // 招架完全结束
    actor.parryState = undefined;
    return false;
  }

  /**
   * 检查当前是否在招架判定窗口内
   */
  static isInParryWindow(actor: Entity): boolean {
    return !!(
      actor.parryState?.active &&
      actor.parryState.startupTicks <= 0 &&
      actor.parryState.remainingTicks > 0
    );
  }

  /**
   * 尝试对攻击应用招架
   */
  static processAttack(actor: Entity, attacker: Entity, damage: number): {
    parried: boolean;
    finalDamage: number;
    damageReduced: number;
  } {
    if (!ParrySystem.isInParryWindow(actor)) {
      return { parried: false, finalDamage: damage, damageReduced: 0 };
    }

    const finalDamage = ParrySystem.tryParry(actor, damage);
    return {
      parried: true,
      finalDamage,
      damageReduced: damage - finalDamage,
    };
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
  console.log('=== ElysianVTT Parry 招架系统测试 ===\n');

  // ---- Test 1: DEFEND 意图创建招架状态 ----
  console.log('[Test 1] DEFEND 意图创建招架状态');
  {
    const fighter: Entity = {
      id: 'fighter',
      resources: { current: { hp: 100, poise: 50 }, max: { hp: 100, poise: 50 } },
      defenses: { dr: 0, parry: 15, dodge: 0 }
    };

    const result = ParrySystem.handleDefendIntent(fighter, 0);
    assert(result === true, '招架意图被接受');
    assert(fighter.parryState?.active === true, '招架状态为活跃');
    assert(fighter.parryState?.remainingTicks === PARRY.ACTIVE_TICKS, `招架窗口 = ${PARRY.ACTIVE_TICKS} ticks`);
    assert(fighter.parryState?.parryValue === 15, '招架值从 defenses 读取');
  }

  // ---- Test 2: 招架减免伤害 ----
  console.log('\n[Test 2] 招架减免伤害');
  {
    const defender: Entity = {
      id: 'defender',
      resources: { current: { hp: 100, poise: 50 }, max: { hp: 100, poise: 50 } },
      defenses: { dr: 0, parry: 20, dodge: 0 }
    };

    ParrySystem.handleDefendIntent(defender, 0);
    assert(ParrySystem.isInParryWindow(defender) === false, '前摇阶段不进入判定窗口');

    // 推进过前摇
    ParrySystem.tickParry(defender);
    ParrySystem.tickParry(defender);
    ParrySystem.tickParry(defender); // 3 ticks → 进入判定窗口
    assert(ParrySystem.isInParryWindow(defender) === true, '前摇结束进入判定窗口');

    // 受到 40 点伤害
    const result = ParrySystem.processAttack(defender, { id: 'attacker' } as Entity, 40);
    assert(result.parried === true, '攻击被招架');
    assert(result.finalDamage === 20, `伤害减免 50%: 40->20 (实际 ${result.finalDamage})`);
    assert(result.damageReduced === 20, `减免伤害 = 20 (实际 ${result.damageReduced})`);
  }

  // ---- Test 3: 招架消耗 PP ----
  console.log('\n[Test 3] 招架消耗 PP');
  {
    const fighter: Entity = {
      id: 'fighter',
      resources: { current: { hp: 100, poise: 40 }, max: { hp: 100, poise: 50 } },
      defenses: { dr: 0, parry: 10, dodge: 0 }
    };

    const beforePP = fighter.resources.current.poise;
    ParrySystem.handleDefendIntent(fighter, 0);
    assert(fighter.resources.current.poise === beforePP - PARRY.PP_COST,
      `PP 消耗 ${PARRY.PP_COST}: ${beforePP}->${fighter.resources.current.poise}`);
  }

  // ---- Test 4: 招架启动/收招时序 ----
  console.log('\n[Test 4] 招架启动/收招时序');
  {
    const fighter: Entity = {
      id: 'fighter',
      resources: { current: { hp: 100, poise: 50 }, max: { hp: 100, poise: 50 } },
      defenses: { dr: 0, parry: 10, dodge: 0 }
    };

    ParrySystem.handleDefendIntent(fighter, 0);

    // 前摇 3 ticks
    assert(ParrySystem.isInParryWindow(fighter) === false, 'T0: 前摇中，不在判定窗口');
    ParrySystem.tickParry(fighter);
    assert(ParrySystem.isInParryWindow(fighter) === false, 'T1: 前摇中');
    ParrySystem.tickParry(fighter);
    assert(ParrySystem.isInParryWindow(fighter) === false, 'T2: 前摇中');
    ParrySystem.tickParry(fighter);
    assert(ParrySystem.isInParryWindow(fighter) === true, 'T3: 前摇结束，进入判定窗口');

    // 判定窗口 8 ticks（每次 assert 后 tick，剩余Ticks归零后active→false）
    for (let i = 0; i < 8; i++) {
      assert(ParrySystem.isInParryWindow(fighter) === true, `判定窗口 T${4 + i}`);
      ParrySystem.tickParry(fighter);
    }

    assert(ParrySystem.isInParryWindow(fighter) === false, '判定窗口结束');

    // 收招 4 ticks
    for (let i = 0; i < 4; i++) {
      ParrySystem.tickParry(fighter);
      if (i < 3) {
        assert(fighter.parryState !== undefined, `收招中 T${12 + i}`);
      }
    }

    // recoveryTicks 归零后，还需一次 tickParry 清理 parryState
    ParrySystem.tickParry(fighter);
    assert(fighter.parryState === undefined, '收招结束，招架状态清除');
  }

  // ---- Test 5: PP 不足时招架失败 ----
  console.log('\n[Test 5] PP 不足时招架失败');
  {
    const exhausted: Entity = {
      id: 'exhausted',
      resources: { current: { hp: 50, poise: 5 }, max: { hp: 100, poise: 50 } },
      defenses: { dr: 0, parry: 10, dodge: 0 }
    };

    const result = ParrySystem.handleDefendIntent(exhausted, 0);
    assert(result === false, 'PP 不足，招架意图被拒绝');
    assert(exhausted.parryState === undefined, '未创建招架状态');
    assert(exhausted.resources.current.poise === 5, 'PP 未消耗');
  }

  // ---- Test 6: 非招架状态无减免 ----
  console.log('\n[Test 6] 非招架状态无减免');
  {
    const civilian: Entity = {
      id: 'civilian',
      resources: { current: { hp: 50 }, max: { hp: 50 } },
    };

    const result = ParrySystem.processAttack(civilian, { id: 'bandit' } as Entity, 30);
    assert(result.parried === false, '未招架');
    assert(result.finalDamage === 30, '全额伤害');
    assert(result.damageReduced === 0, '无减免');
  }

  // ---- Test 7: 招架成功后收招阶段仍可被攻击 ----
  console.log('\n[Test 7] 招架成功后收招阶段不受减免');
  {
    const defender: Entity = {
      id: 'defender',
      resources: { current: { hp: 100, poise: 50 }, max: { hp: 100, poise: 50 } },
      defenses: { dr: 0, parry: 10, dodge: 0 }
    };

    ParrySystem.handleDefendIntent(defender, 0);
    // 过前摇
    ParrySystem.tickParry(defender);
    ParrySystem.tickParry(defender);
    ParrySystem.tickParry(defender);
    // 判定窗口
    assert(ParrySystem.isInParryWindow(defender) === true, '判定窗口');

    // 招架成功
    const r1 = ParrySystem.processAttack(defender, { id: 'a' } as Entity, 20);
    assert(r1.parried === true, '攻击被招架');

    // 推进到收招阶段
    for (let i = 0; i < 8; i++) ParrySystem.tickParry(defender);

    // 收招阶段受到攻击 — 不再减免
    const r2 = ParrySystem.processAttack(defender, { id: 'b' } as Entity, 20);
    assert(r2.parried === false, '收招阶段攻击未被招架');
    assert(r2.finalDamage === 20, '收招阶段全额伤害');
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有 Parry 测试通过!');
}

runTests();
