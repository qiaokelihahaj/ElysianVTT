// test/micro-evasion.test.ts
// Micro-evasion 微闪避系统测试（DUCK / HOP / SLIP）

// ==========================================
// 1. 内联类型定义
// ==========================================
type EntityId = string;
type Tick = number;

type EvadeType = 'DUCK' | 'HOP' | 'SLIP';
type AttackTag = 'HIGH' | 'LOW' | 'LINEAR';

interface Entity {
  id: EntityId;
  resources: { current: Record<string, number>; max: Record<string, number> };
  microEvasionState?: {
    evadeType: EvadeType;
    active: boolean;
    remainingTicks: number;
    recoveryTicks: number;
    totalRecovery: number;
  };
}

interface ActionTemplate {
  id: string;
  attackTags?: AttackTag[];
}

// ==========================================
// 2. Micro-evasion 系统实现
// ==========================================

const MICRO_EVASION = {
  FP_COST: 8,
  ACTIVE_TICKS: 4,
  RECOVERY_TICKS: 3,
};

interface EvasionResult {
  evaded: boolean;
  reason: string;
}

class MicroEvasionSystem {
  // 微闪避克制关系表: 闪避类型 vs 攻击类型
  private static readonly EVASION_MATRIX: Record<EvadeType, AttackTag[]> = {
    DUCK: ['HIGH'],    // 下蹲闪避 HIGH 攻击
    HOP: ['LOW'],      // 跳越闪避 LOW 攻击
    SLIP: ['LINEAR'],  // 滑步闪避 LINEAR 攻击
  };

  /**
   * 处理微闪避意图
   */
  static handleEvadeIntent(actor: Entity, evadeType: EvadeType): boolean {
    const fp = actor.resources.current['fp'] ?? 0;
    if (fp < MICRO_EVASION.FP_COST) {
      return false;
    }

    // 消耗 FP
    actor.resources.current['fp'] = fp - MICRO_EVASION.FP_COST;

    // 设置微闪避状态
    actor.microEvasionState = {
      evadeType,
      active: true,
      remainingTicks: MICRO_EVASION.ACTIVE_TICKS,
      recoveryTicks: MICRO_EVASION.RECOVERY_TICKS,
      totalRecovery: MICRO_EVASION.RECOVERY_TICKS,
    };

    return true;
  }

  /**
   * 检查攻击是否被微闪避规避
   * @param evadeType 玩家的闪避类型
   * @param attackTags 攻击标签列表
   * @returns 闪避结果
   */
  static checkEvasion(evadeType: EvadeType, attackTags: AttackTag[]): EvasionResult {
    // 如果攻击没有标签，无法微闪避
    if (!attackTags || attackTags.length === 0) {
      return { evaded: false, reason: 'NO_TAGS' };
    }

    const canEvade = MicroEvasionSystem.EVASION_MATRIX[evadeType];
    const matchingTag = attackTags.find(tag => canEvade.includes(tag));

    if (matchingTag) {
      return { evaded: true, reason: `${evadeType}_vs_${matchingTag}` };
    }

    // 不匹配 → 未闪避
    return { evaded: false, reason: `${evadeType}_MISMATCH` };
  }

  /**
   * 检查实体是否可以闪避当前攻击
   */
  static checkAttack(actor: Entity | null, attackTags: AttackTag[]): EvasionResult {
    if (!actor?.microEvasionState?.active) {
      return { evaded: false, reason: 'NOT_EVADING' };
    }

    return MicroEvasionSystem.checkEvasion(
      actor.microEvasionState.evadeType,
      attackTags
    );
  }

  /**
   * 推进微闪避状态
   */
  static tickEvasion(actor: Entity): boolean {
    if (!actor.microEvasionState) return false;

    if (actor.microEvasionState.remainingTicks > 0) {
      actor.microEvasionState.remainingTicks--;
      if (actor.microEvasionState.remainingTicks === 0) {
        actor.microEvasionState.active = false;
      }
      return true;
    }

    if (actor.microEvasionState.recoveryTicks > 0) {
      actor.microEvasionState.recoveryTicks--;
      if (actor.microEvasionState.recoveryTicks === 0) {
        actor.microEvasionState = undefined;
        return false;
      }
      return true;
    }

    actor.microEvasionState = undefined;
    return false;
  }

  /**
   * 获取微闪避状态
   */
  static getStatus(actor: Entity): 'IDLE' | 'EVADING' | 'RECOVERING' {
    if (!actor.microEvasionState) return 'IDLE';
    if (actor.microEvasionState.active) return 'EVADING';
    return 'RECOVERING';
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
  console.log('=== ElysianVTT Micro-evasion 微闪避系统测试 ===\n');

  // ---- Test 1: DUCK vs HIGH → 闪避 ----
  console.log('[Test 1] DUCK 规避 HIGH');
  {
    const result = MicroEvasionSystem.checkEvasion('DUCK', ['HIGH']);
    assert(result.evaded === true, 'DUCK 闪避 HIGH 攻击');
    assert(result.reason === 'DUCK_vs_HIGH', `原因: ${result.reason}`);
  }

  // ---- Test 2: HOP vs LOW → 闪避 ----
  console.log('\n[Test 2] HOP 规避 LOW');
  {
    const result = MicroEvasionSystem.checkEvasion('HOP', ['LOW']);
    assert(result.evaded === true, 'HOP 闪避 LOW 攻击');
    assert(result.reason === 'HOP_vs_LOW', `原因: ${result.reason}`);
  }

  // ---- Test 3: SLIP vs LINEAR → 闪避 ----
  console.log('\n[Test 3] SLIP 规避 LINEAR');
  {
    const result = MicroEvasionSystem.checkEvasion('SLIP', ['LINEAR']);
    assert(result.evaded === true, 'SLIP 闪避 LINEAR 攻击');
    assert(result.reason === 'SLIP_vs_LINEAR', `原因: ${result.reason}`);
  }

  // ---- Test 4: DUCK vs LOW → 不匹配（未闪避）----
  console.log('\n[Test 4] DUCK 对 LOW 不匹配');
  {
    const result = MicroEvasionSystem.checkEvasion('DUCK', ['LOW']);
    assert(result.evaded === false, 'DUCK 对 LOW 不闪避');
    assert(result.reason === 'DUCK_MISMATCH', `原因: ${result.reason}`);
  }

  // ---- Test 5: HOP vs HIGH → 不匹配 ----
  console.log('\n[Test 5] HOP 对 HIGH 不匹配');
  {
    const result = MicroEvasionSystem.checkEvasion('HOP', ['HIGH']);
    assert(result.evaded === false, 'HOP 对 HIGH 不闪避');
    assert(result.reason === 'HOP_MISMATCH', `原因: ${result.reason}`);
  }

  // ---- Test 6: SLIP vs HIGH → 不匹配 ----
  console.log('\n[Test 6] SLIP 对 HIGH 不匹配');
  {
    const result = MicroEvasionSystem.checkEvasion('SLIP', ['HIGH']);
    assert(result.evaded === false, 'SLIP 对 HIGH 不闪避');
    assert(result.reason === 'SLIP_MISMATCH', `原因: ${result.reason}`);
  }

  // ---- Test 7: 微闪避消耗 FP ----
  console.log('\n[Test 7] 微闪避消耗 FP');
  {
    const fighter: Entity = {
      id: 'fighter',
      resources: { current: { fp: 40, hp: 100 }, max: { fp: 50, hp: 100 } },
    };

    const success = MicroEvasionSystem.handleEvadeIntent(fighter, 'DUCK');
    assert(success === true, '闪避成功');
    assert(fighter.resources.current.fp === 32, `FP 40-8=32 (实际 ${fighter.resources.current.fp})`);
  }

  // ---- Test 8: 闪避后恢复期 ----
  console.log('\n[Test 8] 微闪避恢复期');
  {
    const fighter: Entity = {
      id: 'fighter',
      resources: { current: { fp: 50 }, max: { fp: 50 } },
    };

    MicroEvasionSystem.handleEvadeIntent(fighter, 'SLIP');
    assert(MicroEvasionSystem.getStatus(fighter) === 'EVADING', '活跃期');

    // 推进活跃 ticks
    for (let i = 0; i < MICRO_EVASION.ACTIVE_TICKS; i++) {
      MicroEvasionSystem.tickEvasion(fighter);
    }
    assert(MicroEvasionSystem.getStatus(fighter) === 'RECOVERING', '收招期');

    // 推进恢复 ticks
    for (let i = 0; i < MICRO_EVASION.RECOVERY_TICKS; i++) {
      MicroEvasionSystem.tickEvasion(fighter);
    }
    assert(MicroEvasionSystem.getStatus(fighter) === 'IDLE', '完全结束');
  }

  // ---- Test 9: 非活跃期微闪避检查 ----
  console.log('\n[Test 9] 非微闪避状态不规避');
  {
    const idleFighter: Entity = {
      id: 'idle_fighter',
      resources: { current: { fp: 50 }, max: { fp: 50 } },
    };

    const result = MicroEvasionSystem.checkAttack(idleFighter, ['HIGH']);
    assert(result.evaded === false, '非闪避状态 → 不规避');
    assert(result.reason === 'NOT_EVADING', `原因: ${result.reason}`);
  }

  // ---- Test 10: 多标签攻击（如 HIGH + LINEAR）----
  console.log('\n[Test 10] 多标签攻击');
  {
    // HIGH + LINEAR 攻击：DUCK 能闪避（匹配 HIGH），SLIP 也能闪避（匹配 LINEAR）
    const r1 = MicroEvasionSystem.checkEvasion('DUCK', ['HIGH', 'LINEAR']);
    assert(r1.evaded === true, 'DUCK 闪避 HIGH+LINEAR（匹配 HIGH）');

    const r2 = MicroEvasionSystem.checkEvasion('SLIP', ['HIGH', 'LINEAR']);
    assert(r2.evaded === true, 'SLIP 闪避 HIGH+LINEAR（匹配 LINEAR）');

    const r3 = MicroEvasionSystem.checkEvasion('HOP', ['HIGH', 'LINEAR']);
    assert(r3.evaded === false, 'HOP 不匹配 HIGH+LINEAR');
  }

  // ---- Test 11: 无标签攻击无法微闪避 ----
  console.log('\n[Test 11] 无标签攻击无法微闪避');
  {
    const result = MicroEvasionSystem.checkEvasion('DUCK', []);
    assert(result.evaded === false, '无标签攻击不可微闪避');
    assert(result.reason === 'NO_TAGS', `原因: ${result.reason}`);
  }

  // ---- Test 12: FP 不足无法闪避 ----
  console.log('\n[Test 12] FP 不足无法闪避');
  {
    const broke: Entity = {
      id: 'broke',
      resources: { current: { fp: 3, hp: 50 }, max: { fp: 50, hp: 100 } },
    };

    const result = MicroEvasionSystem.handleEvadeIntent(broke, 'DUCK');
    assert(result === false, 'FP=3 < 8, 闪避失败');
    assert(broke.resources.current.fp === 3, 'FP 未消耗');
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有 Micro-evasion 测试通过!');
}

runTests();
