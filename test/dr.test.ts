// test/dr.test.ts
// DR (Damage Reduction) 护甲减伤系统测试

// ==========================================
// 1. 内联类型定义
// ==========================================
type EntityId = string;

interface Entity {
  id: EntityId;
  resources: { current: Record<string, number>; max: Record<string, number> };
  defenses?: { dr: number; parry: number; dodge: number };
}

interface ActionEffectPayload {
  type: 'DAMAGE' | 'HEAL' | 'APPLY_BUFF' | 'PUSH' | 'INTERRUPT';
  targetSelector: 'PRIMARY' | 'ALL_IN_AOE' | 'SELF';
  parameters: Record<string, any>;
}

interface ActionTemplate {
  id: string;
  effects: ActionEffectPayload[];
}

interface DamageResult {
  entityId: EntityId;
  originalDamage: number;
  drApplied: number;
  finalDamage: number;
  resource: string;
}

// ==========================================
// 2. DR 计算系统
// ==========================================
class DRCalculator {
  /**
   * 应用 DR 减伤计算
   * @param rawDamage 原始伤害值
   * @param target 目标实体
   * @param ignoreDr 是否忽略 DR
   * @returns 减伤后的最终伤害
   */
  static apply(rawDamage: number, target: Entity, ignoreDr: boolean = false): number {
    if (ignoreDr) return rawDamage;
    const dr = target.defenses?.dr ?? 0;
    return Math.max(0, rawDamage - dr);
  }

  /**
   * 应用 DR 并记录差分
   */
  static applyWithDetail(rawDamage: number, target: Entity, ignoreDr: boolean = false, resource: string = 'hp'): DamageResult {
    // DR 仅对 hp 生效（poise 等资源不受 DR 减免）
    const dr = (ignoreDr || resource !== 'hp') ? 0 : (target.defenses?.dr ?? 0);
    const finalDamage = Math.max(0, rawDamage - dr);
    return {
      entityId: target.id,
      originalDamage: rawDamage,
      drApplied: Math.min(dr, rawDamage),
      finalDamage,
      resource
    };
  }

  /**
   * 对实体应用伤害（含 DR 计算）
   */
  static applyDamage(target: Entity, amount: number, resource: string, ignoreDr: boolean = false): DamageResult {
    const result = DRCalculator.applyWithDetail(amount, target, ignoreDr, resource);
    const cur = target.resources.current[resource] ?? 0;
    target.resources.current[resource] = Math.max(0, cur - result.finalDamage);
    return result;
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
  console.log('=== ElysianVTT DR 护甲减伤测试 ===\n');

  // ---- Test 1: 伤害被 DR 值减免 ----
  console.log('[Test 1] 伤害被 DR 值减免');
  {
    const armored: Entity = {
      id: 'armored',
      resources: { current: { hp: 100, poise: 50 }, max: { hp: 100, poise: 50 } },
      defenses: { dr: 10, parry: 0, dodge: 0 }
    };

    const result = DRCalculator.applyWithDetail(25, armored, false);
    assert(result.originalDamage === 25, '原始伤害 = 25');
    assert(result.drApplied === 10, 'DR 减免 = 10');
    assert(result.finalDamage === 15, '最终伤害 = 25 - 10 = 15');
  }

  // ---- Test 2: DR 不会导致治疗（伤害不低于 0）----
  console.log('\n[Test 2] DR 不会导致治疗（最低 0 伤害）');
  {
    const armored: Entity = {
      id: 'tank',
      resources: { current: { hp: 50, poise: 50 }, max: { hp: 50, poise: 50 } },
      defenses: { dr: 20, parry: 0, dodge: 0 }
    };

    // 伤害 5, DR 20 → 最终伤害应为 0（不是 -15）
    const result = DRCalculator.applyWithDetail(5, armored, false);
    assert(result.finalDamage === 0, `小伤害(5)被高DR(20)减免为 0, 不为负`);
  }

  // ---- Test 3: ignoreDr=true 完全无视 DR ----
  console.log('\n[Test 3] ignoreDr=true 无视护甲');
  {
    const armored: Entity = {
      id: 'boss',
      resources: { current: { hp: 100, poise: 50 }, max: { hp: 100, poise: 50 } },
      defenses: { dr: 50, parry: 0, dodge: 0 }
    };

    // ignoreDr=true → 不减免
    const result = DRCalculator.applyWithDetail(30, armored, true);
    assert(result.drApplied === 0, 'ignoreDr=true 时 DR 不生效');
    assert(result.finalDamage === 30, '无视护甲，全额伤害 30');

    // ignoreDr=false → 正常减免
    const result2 = DRCalculator.applyWithDetail(30, armored, false);
    assert(result2.finalDamage === 0, 'DR=50 > 30, 正常减免为 0');
  }

  // ---- Test 4: 不同实体的不同 DR 值 ----
  console.log('\n[Test 4] 不同实体不同 DR');
  {
    const knight: Entity = {
      id: 'knight',
      resources: { current: { hp: 100 }, max: { hp: 100 } },
      defenses: { dr: 15, parry: 0, dodge: 0 }
    };
    const mage: Entity = {
      id: 'mage',
      resources: { current: { hp: 80 }, max: { hp: 80 } },
      defenses: { dr: 3, parry: 0, dodge: 0 }
    };
    const naked: Entity = {
      id: 'naked',
      resources: { current: { hp: 60 }, max: { hp: 60 } },
      defenses: undefined
    };

    const damage = 20;
    const r1 = DRCalculator.applyWithDetail(damage, knight, false);
    const r2 = DRCalculator.applyWithDetail(damage, mage, false);
    const r3 = DRCalculator.applyWithDetail(damage, naked, false);

    assert(r1.finalDamage === 5, '骑士 DR=15, 伤害=5');
    assert(r2.finalDamage === 17, '法师 DR=3, 伤害=17');
    assert(r3.finalDamage === 20, '无护甲实体 DR=0, 伤害=20');
  }

  // ---- Test 5: DR 只对特定资源生效（hp 减伤，poise 不减）----
  console.log('\n[Test 5] DR 仅适用于 hp，不影响 poise');
  {
    const entity: Entity = {
      id: 'guard',
      resources: { current: { hp: 100, poise: 50 }, max: { hp: 100, poise: 50 } },
      defenses: { dr: 10, parry: 0, dodge: 0 }
    };

    // 对 hp 应用伤害
    DRCalculator.applyDamage(entity, 30, 'hp', false);
    assert(entity.resources.current.hp === 80, `hp=100-(30-10)=80 (实际 ${entity.resources.current.hp})`);

    // 对 poise 应用伤害 (DR 不应减免 poise 伤害)
    DRCalculator.applyDamage(entity, 20, 'poise', false);
    assert(entity.resources.current.poise === 30, `poise=50-20=30, DR 不影响 poise (实际 ${entity.resources.current.poise})`);
  }

  // ---- Test 6: 整合 - EffectSystem 模拟 DR 流程 ----
  console.log('\n[Test 6] EffectSystem 集成模拟：DAMAGE 效果含 DR');
  {
    class EffectSystemWithDR {
      static applyAction(template: ActionTemplate, actor: Entity, targets: Entity[]): Map<string, number> {
        const mutations = new Map<string, number>();

        for (const effect of template.effects) {
          let resolvedTargets: Entity[] = [];
          if (effect.targetSelector === 'PRIMARY') resolvedTargets = targets;
          else if (effect.targetSelector === 'SELF') resolvedTargets = [actor];

          for (const target of resolvedTargets) {
            if (effect.type === 'DAMAGE') {
              const resource = effect.parameters.resource || 'hp';
              const amount = effect.parameters.amount || 0;
              const ignoreDr = effect.parameters.ignoreDr === true;

              // 仅 hp 类型伤害应用 DR
              const dr = (resource === 'hp' && !ignoreDr) ? (target.defenses?.dr ?? 0) : 0;
              const finalDamage = Math.max(0, amount - dr);

              const cur = target.resources.current[resource] ?? 0;
              target.resources.current[resource] = Math.max(0, cur - finalDamage);
              mutations.set(target.id, (mutations.get(target.id) ?? 0) + finalDamage);
            }
          }
        }

        return mutations;
      }
    }

    const template: ActionTemplate = {
      id: 'SWORD_SLASH',
      effects: [
        { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amount: 25 } },
        { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'poise', amount: 10 } }
      ]
    };

    const ignoreDrTemplate: ActionTemplate = {
      id: 'MAGIC_PIERCE',
      effects: [
        { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amount: 30, ignoreDr: true } }
      ]
    };

    const paladin: Entity = {
      id: 'paladin',
      resources: { current: { hp: 100, poise: 60 }, max: { hp: 100, poise: 60 } },
      defenses: { dr: 12, parry: 0, dodge: 0 }
    };

    // 应用两次伤害
    EffectSystemWithDR.applyAction(template, paladin, [paladin]);
    assert(paladin.resources.current.hp === 87, `hp: 100-(25-12)=87 (实际 ${paladin.resources.current.hp})`);
    assert(paladin.resources.current.poise === 50, `poise: 60-10=50 (实际 ${paladin.resources.current.poise})`);

    // 应用无视 DR 的伤害
    EffectSystemWithDR.applyAction(ignoreDrTemplate, paladin, [paladin]);
    assert(paladin.resources.current.hp === 57, `hp: 87-30=57 (无视DR, 实际 ${paladin.resources.current.hp})`);
  }

  // ---- Test 7: 大量小伤害被完全吸收 ----
  console.log('\n[Test 7] 大量小伤害被完全吸收');
  {
    const shielded: Entity = {
      id: 'shielded',
      resources: { current: { hp: 100 }, max: { hp: 100 } },
      defenses: { dr: 8, parry: 0, dodge: 0 }
    };

    // 受到 5 次每次 5 点伤害（全部被 DR 吸收）
    for (let i = 0; i < 5; i++) {
      DRCalculator.applyDamage(shielded, 5, 'hp', false);
    }
    assert(shielded.resources.current.hp === 100, '5 次伤害全部被 DR 8 吸收，HP 不变');
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有 DR 测试通过!');
}

runTests();
