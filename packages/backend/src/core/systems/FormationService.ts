// packages/backend/src/core/systems/FormationService.ts
// 阵型与团队协作 — 物理拦截 + Active Interception + 封锁区域 (Phase 3.5)

import type { Entity, EntityId, Vector3D, InterceptionResult } from '@hard-vtt/shared';
import { LogVisibility, getEntityFaction } from '@hard-vtt/shared';
import { VectorMath } from '../../utils/VectorMath.js';
import { SpatialSystem } from './SpatialSystem.js';
import { Logger } from '../../utils/Logger.js';

const logger = Logger.create('System:Formation');

export class FormationService {
  /**
   * 执行拦截判定
   * @returns 拦截结果（含减免后伤害）
   */
  static resolveInterception(
    guardian: Entity,
    attacker: Entity,
    protectee: Entity,
    attackValue: number,
    baseDamage: number,
    coopBonus = 0,
  ): InterceptionResult {
    const config = guardian.formationContext?.interceptConfig;
    const interceptValue = (config?.interceptionRating ?? 10) + coopBonus;
    const success = interceptValue >= attackValue;
    const reduction = config?.interceptDamageReduction ?? 0.4;
    const reducedDamage = success ? Math.floor(baseDamage * (1 - reduction)) : baseDamage;

    const result: InterceptionResult = {
      success,
      interceptorId: guardian.id,
      interceptValue,
      attackValue,
      reducedDamage
    };

    if (!success) {
      result.penaltyApplied = 'STAGGER';
    }

    return result;
  }

  /**
   * 拦截失败惩罚：护卫被击退 + 损失韧性
   */
  static applyFailurePenalty(
    guardian: Entity,
    penaltyDistance?: number
  ): { newCoords: Vector3D; poiseLoss: number } {
    const config = guardian.formationContext?.interceptConfig;
    const knockback = penaltyDistance ?? config?.failureKnockback ?? 1.5;
    const poiseLoss = config?.failurePenaltyPoise ?? 15;

    const curPoise = guardian.resources.current['poise'] ?? 50;
    guardian.resources.current['poise'] = Math.max(0, curPoise - poiseLoss);

    const facingRad = (guardian.transform.facing ?? 0) * Math.PI / 180;
    const newCoords = {
      x: guardian.transform.coords.x - Math.cos(facingRad) * knockback,
      y: guardian.transform.coords.y - Math.sin(facingRad) * knockback,
      z: guardian.transform.coords.z ?? 0
    };
    guardian.transform.coords = { ...newCoords, z: newCoords.z ?? 0 };

    return { newCoords, poiseLoss };
  }

  /**
   * 多拦截者协同加成
   */
  static calculateCoopBonus(guardians: Entity[]): number {
    const eligible = guardians.filter(g => g.formationContext?.interceptConfig);
    if (eligible.length <= 1) return 0;
    const config = eligible[0].formationContext!.interceptConfig!;
    const perAlly = config.coopBonusPerAlly ?? 2;
    const max = config.maxCoopBonus ?? 6;
    return Math.min((eligible.length - 1) * perAlly, max);
  }

  /**
   * 处理移动路径的物理拦截
   * @returns 如果被阻挡，返回截断后的目标坐标
   */
  static checkMoveBlocked(
    mover: Entity,
    targetCoords: Vector3D,
    allEntities: Map<EntityId, Entity>,
    engineCtx?: { tick?: number; sceneId?: string }
  ): { blocked: boolean; adjustedTarget: Vector3D; blocker: Entity | null } {
    const blockers: Entity[] = [];
    for (const [, e] of allEntities) {
      if (e.id === mover.id) continue;
      if (e.type !== 'ACTOR' && e.type !== 'PROP') continue;
      if ((e.resources.current.hp ?? 1) <= 0 || e.transform.planeId !== mover.transform.planeId) continue;
      if (!e.bodyBlocking && !e.formationContext?.interceptConfig) continue;
      blockers.push(e);
    }

    if (blockers.length === 0) {
      return { blocked: false, adjustedTarget: targetCoords, blocker: null };
    }

    const result = SpatialSystem.checkPathBlocked(
      mover.transform.coords, targetCoords, blockers
    );

    if (result.blocked && result.blockPoint && result.blocker) {
      logger.game(
        `🧱 [Formation] ${mover.id} 移动路径被 ${result.blocker.id} 阻挡于 (${result.blockPoint.x.toFixed(1)},${result.blockPoint.y.toFixed(1)})`,
        { moverId: mover.id, blockerId: result.blocker.id },
        LogVisibility.PLAYER,
        engineCtx
      );
      return { blocked: true, adjustedTarget: result.blockPoint, blocker: result.blocker };
    }

    return { blocked: false, adjustedTarget: targetCoords, blocker: null };
  }

  /**
   * 检查攻击路径上是否存在主动拦截者
   */
  static checkAttackIntercepted(
    attacker: Entity,
    targets: Entity[],
    allEntities: Map<EntityId, Entity>,
    attackValue: number,
    baseDamage: number,
    engineCtx?: { tick?: number; sceneId?: string }
  ): { intercepted: boolean; result: InterceptionResult | null; adjustedDamage: number } {
    if (targets.length === 0) {
      return { intercepted: false, result: null, adjustedDamage: baseDamage };
    }

    const primaryTarget = targets[0];
    const entityList: Entity[] = [];
    for (const [, e] of allEntities) {
      if (e.id === attacker.id || e.id === primaryTarget.id) continue;
      if (e.type !== 'ACTOR') continue;
      if ((e.resources.current.hp ?? 1) <= 0 || e.transform.planeId !== primaryTarget.transform.planeId) continue;
      const guardianFaction = getEntityFaction(e) ?? e.tags?.find(tag => tag.startsWith('FACTION_'));
      const protecteeFaction = getEntityFaction(primaryTarget) ?? primaryTarget.tags?.find(tag => tag.startsWith('FACTION_'));
      if (!guardianFaction || guardianFaction !== protecteeFaction) continue;
      entityList.push(e);
    }

    const interceptors = SpatialSystem.getNearestInterceptors(
      attacker.transform.coords,
      primaryTarget.transform.coords,
      entityList
    );

    if (interceptors.length === 0) {
      return { intercepted: false, result: null, adjustedDamage: baseDamage };
    }

    const guardian = SpatialSystem.selectInterceptor(interceptors, attacker.transform.coords);
    if (!guardian) {
      return { intercepted: false, result: null, adjustedDamage: baseDamage };
    }

    const coopBonus = FormationService.calculateCoopBonus(interceptors);
    const effectiveInterceptValue = (guardian.formationContext?.interceptConfig?.interceptionRating ?? 10) + coopBonus;

    const result = FormationService.resolveInterception(
      guardian, attacker, primaryTarget,
      attackValue, baseDamage, coopBonus,
    );

    logger.game(
      `🛡️ [Intercept] ${guardian.id} ${result.success ? '成功拦截' : '拦截失败'} 对 ${primaryTarget.id} 的攻击 (拦截值=${effectiveInterceptValue}, 攻击值=${attackValue})`,
      { guardianId: guardian.id, attackerId: attacker.id, targetId: primaryTarget.id, success: result.success },
      LogVisibility.PLAYER,
      engineCtx
    );

    return { intercepted: true, result, adjustedDamage: result.reducedDamage };
  }
}
