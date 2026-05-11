// packages/backend/src/core/systems/BodyPartResolver.ts
// 部位破坏与重击判定引擎

import { BodyPart, HitLocationEntry, HitResult, CritConfig, BodyPartState } from '@hard-vtt/shared';

export class BodyPartResolver {
  /**
   * 加权随机选取命中部位 (d100 掷骰)
   */
  static rollHitLocation(table: HitLocationEntry[], roll: number): BodyPart {
    const totalWeight = table.reduce((sum, e) => sum + e.weight, 0);
    let cumulative = 0;
    const normalizedRoll = ((roll - 1) / 100) * totalWeight;

    for (const entry of table) {
      cumulative += entry.weight;
      if (normalizedRoll < cumulative) return entry.part;
    }
    return table[table.length - 1].part;
  }

  /**
   * 判定是否暴击
   */
  static isCritical(d20Roll: number, critRange: number, poolTags: string[] = []): boolean {
    return d20Roll >= critRange || poolTags.includes('CRIT_SUCCESS');
  }

  /**
   * 计算完整命中结果
   * @param rawDamage 基础伤害（来自公式求值）
   * @param hitTable 部位权重表
   * @param d100Roll d100 部位掷骰
   * @param d20Roll d20 暴击掷骰
   * @param critConfig 暴击配置
   * @param bodyParts 目标当前部位状态
   * @param poolTags 骰子标签
   */
  static resolveHit(
    rawDamage: number,
    hitTable: HitLocationEntry[],
    d100Roll: number,
    d20Roll: number,
    critConfig: CritConfig,
    bodyParts: Record<string, BodyPartState> | undefined,
    poolTags: string[] = []
  ): HitResult {
    const part = this.rollHitLocation(hitTable, d100Roll);
    const isCrit = this.isCritical(d20Roll, critConfig.range, poolTags);

    const partConfig = hitTable.find(e => e.part === part);
    const critMultiplier = (isCrit ? (partConfig?.critMultiplier ?? critConfig.defaultMultiplier) : 1);

    const afterCrit = Math.floor(rawDamage * critMultiplier);

    const partState = bodyParts?.[part];
    const partDestroyed = partState?.destroyed ?? false;

    if (partDestroyed) {
      return {
        part,
        isCrit,
        critMultiplier,
        rawDamage: afterCrit,
        cappedDamage: 0,
        overflowDamage: afterCrit,
        partDestroyed: true
      };
    }

    const cap = partConfig?.damageCap;
    let cappedDamage = afterCrit;
    let overflowDamage = 0;

    if (cap !== undefined && afterCrit > cap) {
      cappedDamage = cap;
      overflowDamage = afterCrit - cap;
    }

    return { part, isCrit, critMultiplier, rawDamage: afterCrit, cappedDamage, overflowDamage, partDestroyed: false };
  }

  /**
   * 应用部位伤害，返回破坏状态变更
   */
  static applyPartDamage(
    bodyParts: Record<string, BodyPartState>,
    part: BodyPart,
    damage: number
  ): { destroyed: boolean; newHp: number } {
    if (!bodyParts[part]) return { destroyed: false, newHp: 0 };

    const state = bodyParts[part];
    if (state.destroyed) return { destroyed: true, newHp: 0 };

    const newHp = Math.max(0, state.currentHp - damage);
    state.currentHp = newHp;

    if (newHp <= 0) {
      state.destroyed = true;
      return { destroyed: true, newHp: 0 };
    }

    return { destroyed: false, newHp };
  }

  /** 掷 d100 (1-100) */
  static rollD100(): number {
    return Math.floor(Math.random() * 100) + 1;
  }

  /** 掷 d20 (1-20) */
  static rollD20(): number {
    return Math.floor(Math.random() * 20) + 1;
  }
}
