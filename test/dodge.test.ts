// test/dodge.test.ts
// Dodge 闪避系统测试

// ==========================================
// 1. 内联类型定义
// ==========================================
type EntityId = string;
type Tick = number;

interface Vector3D { x: number; y: number; z: number; }

interface Entity {
  id: EntityId;
  transform: { coords: Vector3D; facing?: number };
  resources: { current: Record<string, number>; max: Record<string, number> };
  defenses?: { dr: number; parry: number; dodge: number };
  dodgeState?: {
    active: boolean;
    remainingTicks: number;
    dodgeValue: number;
    startCoords: Vector3D;
    endCoords: Vector3D;
    recoveryTicks: number;
    totalRecovery: number;
  };
}

interface ActionTemplate {
  id: string;
  range: { type: string; distanceExpr: string; radiusExpr?: string };
}

// ==========================================
// 2. Dodge 系统实现
// ==========================================

const DODGE = {
  FP_COST: 10,
  ACTIVE_TICKS: 6,
  RECOVERY_TICKS: 4,
  DODGE_DISTANCE: 3,
};

class DodgeSystem {
  /**
   * 处理闪避意图
   * @returns true 如果闪避成功创建
   */
  static handleDodgeIntent(actor: Entity, direction: Vector3D, currentTick: Tick): boolean {
    const fp = actor.resources.current['fp'] ?? 0;
    if (fp < DODGE.FP_COST) {
      return false; // FP 不足
    }

    // 消耗 FP
    actor.resources.current['fp'] = fp - DODGE.FP_COST;

    // 计算新位置（沿方向移动 DODGE_DISTANCE）
    const magnitude = Math.sqrt(direction.x * direction.x + direction.y * direction.y + direction.z * direction.z) || 1;
    const normalized = {
      x: direction.x / magnitude,
      y: direction.y / magnitude,
      z: direction.z / magnitude,
    };

    const endCoords: Vector3D = {
      x: actor.transform.coords.x + normalized.x * DODGE.DODGE_DISTANCE,
      y: actor.transform.coords.y + normalized.y * DODGE.DODGE_DISTANCE,
      z: actor.transform.coords.z + normalized.z * DODGE.DODGE_DISTANCE,
    };

    const startCoords = { ...actor.transform.coords };

    // 立即移动到新位置（实际游戏中可能存在过渡动画）
    actor.transform.coords = { ...endCoords };

    // 设置闪避状态
    actor.dodgeState = {
      active: true,
      remainingTicks: DODGE.ACTIVE_TICKS,
      dodgeValue: actor.defenses?.dodge ?? 5,
      startCoords,
      endCoords,
      recoveryTicks: DODGE.RECOVERY_TICKS,
      totalRecovery: DODGE.RECOVERY_TICKS,
    };

    return true;
  }

  /**
   * 检查攻击是否会命中（考虑闪避状态）
   */
  static checkHit(actor: Entity, attackerCoords: Vector3D, attackRange: number): boolean {
    if (!actor.dodgeState?.active) {
      return true; // 非闪避状态，命中
    }

    if (actor.dodgeState.recoveryTicks < actor.dodgeState.totalRecovery) {
      // 收招阶段
      return true;
    }

    // 闪避活跃期：计算攻击者与闪避后位置的距离
    const dx = attackerCoords.x - actor.transform.coords.x;
    const dy = attackerCoords.y - actor.transform.coords.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // 如果攻击范围覆盖新位置，则仍可能命中
    return distance <= attackRange;
  }

  /**
   * 推进闪避状态 Tick
   */
  static tickDodge(actor: Entity): boolean {
    if (!actor.dodgeState) return false;

    if (actor.dodgeState.remainingTicks > 0) {
      actor.dodgeState.remainingTicks--;
      if (actor.dodgeState.remainingTicks === 0) {
        // 活跃期结束，进入收招
        actor.dodgeState.active = false;
      }
      return true;
    }

    if (actor.dodgeState.recoveryTicks > 0) {
      actor.dodgeState.recoveryTicks--;
      if (actor.dodgeState.recoveryTicks === 0) {
        actor.dodgeState = undefined;
        return false;
      }
      return true;
    }

    actor.dodgeState = undefined;
    return false;
  }

  /**
   * 获取当前闪避状态
   */
  static getStatus(actor: Entity): 'IDLE' | 'DODGING' | 'RECOVERING' {
    if (!actor.dodgeState) return 'IDLE';
    if (actor.dodgeState.active) return 'DODGING';
    return 'RECOVERING';
  }

  /**
   * 检查单目标攻击是否挥空（因闪避导致）
   */
  static wouldSingleTargetAttackMiss(actor: Entity, attackerCoords: Vector3D, attackRange: number): boolean {
    if (!actor.dodgeState?.active) return false;
    if (actor.dodgeState.recoveryTicks < actor.dodgeState.totalRecovery) return false;
    return !DodgeSystem.checkHit(actor, attackerCoords, attackRange);
  }

  /**
   * AOE 始终命中（无视闪避）
   */
  static isAoeHit(attackTemplate: ActionTemplate): boolean {
    return attackTemplate.range.type === 'AOE' || !!attackTemplate.range.radiusExpr;
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
  console.log('=== ElysianVTT Dodge 闪避系统测试 ===\n');

  // ---- Test 1: 闪避移动角色到新位置 ----
  console.log('[Test 1] 闪避移动角色到新位置');
  {
    const rogue: Entity = {
      id: 'rogue',
      transform: { coords: { x: 5, y: 5, z: 0 } },
      resources: { current: { fp: 50, hp: 80 }, max: { fp: 50, hp: 80 } },
      defenses: { dr: 0, parry: 0, dodge: 15 }
    };

    const direction = { x: 1, y: 0, z: 0 };
    const result = DodgeSystem.handleDodgeIntent(rogue, direction, 0);
    assert(result === true, '闪避成功创建');
    assert(rogue.transform.coords.x === 8, `新位置 x=5+3=8 (实际 ${rogue.transform.coords.x})`);
    assert(rogue.transform.coords.y === 5, `新位置 y=5 (实际 ${rogue.transform.coords.y})`);
  }

  // ---- Test 2: FP 消耗 ----
  console.log('\n[Test 2] FP 消耗');
  {
    const rogue: Entity = {
      id: 'rogue',
      transform: { coords: { x: 0, y: 0, z: 0 } },
      resources: { current: { fp: 30, hp: 80 }, max: { fp: 50, hp: 80 } },
      defenses: { dr: 0, parry: 0, dodge: 10 }
    };

    const beforeFP = rogue.resources.current.fp;
    DodgeSystem.handleDodgeIntent(rogue, { x: 1, y: 0, z: 0 }, 0);
    assert(rogue.resources.current.fp === beforeFP - DODGE.FP_COST,
      `FP 消耗 ${DODGE.FP_COST}: ${beforeFP}->${rogue.resources.current.fp}`);
  }

  // ---- Test 3: 闪避后攻击挥空 ----
  console.log('\n[Test 3] 闪避后攻击挥空');
  {
    const rogue: Entity = {
      id: 'rogue',
      transform: { coords: { x: 0, y: 0, z: 0 } },
      resources: { current: { fp: 50 }, max: { fp: 50 } },
      defenses: { dr: 0, parry: 0, dodge: 15 }
    };

    // 向 x 正方向闪避
    DodgeSystem.handleDodgeIntent(rogue, { x: 1, y: 0, z: 0 }, 0);
    // 现在在 (3, 0, 0)

    // 攻击者在原点 (0,0,0) 用范围 2 攻击
    const wouldMiss = DodgeSystem.wouldSingleTargetAttackMiss(rogue, { x: 0, y: 0, z: 0 }, 2);
    assert(wouldMiss === true, `原点范围2攻击 -> 新位置(3,0,0)距离=3>2 → 挥空`);
  }

  // ---- Test 4: AOE 仍然命中（无视闪避）----
  console.log('\n[Test 4] AOE 无视闪避');
  {
    const aoeTemplate: ActionTemplate = {
      id: 'FIREBALL',
      range: { type: 'AOE', distanceExpr: '8', radiusExpr: '4' },
    };
    const singleTemplate: ActionTemplate = {
      id: 'ARROW',
      range: { type: 'RANGED', distanceExpr: '20' },
    };

    assert(DodgeSystem.isAoeHit(aoeTemplate) === true, 'AOE 模板被检测为范围攻击');
    assert(DodgeSystem.isAoeHit(singleTemplate) === false, '单体模板不被检测为范围攻击');
  }

  // ---- Test 5: 闪避有恢复期 ----
  console.log('\n[Test 5] 闪避恢复期');
  {
    const rogue: Entity = {
      id: 'rogue',
      transform: { coords: { x: 0, y: 0, z: 0 } },
      resources: { current: { fp: 50 }, max: { fp: 50 } },
      defenses: { dr: 0, parry: 0, dodge: 15 }
    };

    DodgeSystem.handleDodgeIntent(rogue, { x: 1, y: 0, z: 0 }, 0);
    assert(DodgeSystem.getStatus(rogue) === 'DODGING', '闪避活跃期');

    // 推进所有活跃 ticks
    for (let i = 0; i < DODGE.ACTIVE_TICKS; i++) {
      DodgeSystem.tickDodge(rogue);
    }
    assert(DodgeSystem.getStatus(rogue) === 'RECOVERING', '进入收招期');

    // 推进所有恢复 ticks
    for (let i = 0; i < DODGE.RECOVERY_TICKS; i++) {
      DodgeSystem.tickDodge(rogue);
    }
    assert(DodgeSystem.getStatus(rogue) === 'IDLE', '闪避完全结束');
  }

  // ---- Test 6: FP 不足无法闪避 ----
  console.log('\n[Test 6] FP 不足无法闪避');
  {
    const exhausted: Entity = {
      id: 'exhausted',
      transform: { coords: { x: 0, y: 0, z: 0 } },
      resources: { current: { fp: 3, hp: 30 }, max: { fp: 50, hp: 100 } },
    };

    const result = DodgeSystem.handleDodgeIntent(exhausted, { x: 1, y: 0, z: 0 }, 0);
    assert(result === false, 'FP=3 < 10, 闪避失败');
    assert(exhausted.dodgeState === undefined, '无闪避状态');
    assert(exhausted.resources.current.fp === 3, 'FP 未消耗');
  }

  // ---- Test 7: 闪避后近距离攻击仍可命中 ----
  console.log('\n[Test 7] 闪避后攻击范围覆盖新位置则命中');
  {
    const rogue: Entity = {
      id: 'rogue',
      transform: { coords: { x: 0, y: 0, z: 0 } },
      resources: { current: { fp: 50 }, max: { fp: 50 } },
      defenses: { dr: 0, parry: 0, dodge: 15 }
    };

    DodgeSystem.handleDodgeIntent(rogue, { x: 1, y: 0, z: 0 }, 0);
    // 新位置 (3, 0, 0)

    // 攻击者在 (2, 0, 0) 用范围 3 攻击
    const wouldMiss = DodgeSystem.wouldSingleTargetAttackMiss(rogue, { x: 2, y: 0, z: 0 }, 3);
    assert(wouldMiss === false, `距离 1 <= 范围 3 → 命中`);
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有 Dodge 测试通过!');
}

runTests();
