// packages/backend/src/core/systems/AoeResolver.ts
// AOE 与爆炸结算系统：范围覆盖、衰减、爆风阴影、友伤

import type {
  Entity, Vector3D, AoeShape, AoeConfig, DamageFalloffConfig
} from '@hard-vtt/shared';
import { VectorMath } from '../../utils/VectorMath.js';

export interface AoeTargetResult {
  entityId: string;
  distance: number;
  inArea: boolean;
  damagePercent: number;
  hasCover: boolean;
  blockedByCover: boolean;
}

export class AoeResolver {
  /**
   * 判断实体是否在 AOE 范围内
   */
  public static isInArea(entity: Entity, config: AoeConfig): boolean {
    const origin = config.origin;
    const dist = VectorMath.distance(origin, entity.transform.coords);
    if (dist > config.radius) return false;

    switch (config.shape) {
      case 'CIRCULAR':
        return dist <= config.radius;

      case 'CONICAL': {
        const toTarget = VectorMath.direction(origin, entity.transform.coords);
        const toTargetAngle = (Math.atan2(toTarget.y, toTarget.x) * 180 / Math.PI + 360) % 360;
        const coneAngle = config.angle ?? 90;
        let diff = ((toTargetAngle - config.facing) % 360 + 540) % 360 - 180;
        return Math.abs(diff) <= coneAngle / 2 && dist <= config.radius;
      }

      case 'LINEAR': {
        const width = config.width ?? 1;
        const toTarget = VectorMath.direction(origin, entity.transform.coords);
        const toTargetAngle = (Math.atan2(toTarget.y, toTarget.x) * 180 / Math.PI + 360) % 360;
        let diff = ((toTargetAngle - config.facing) % 360 + 540) % 360 - 180;
        if (Math.abs(diff) > 30) return false;

        const facingRad = config.facing * Math.PI / 180;
        const distAlong = toTarget.x * Math.cos(facingRad) + toTarget.y * Math.sin(facingRad);
        const distPerp = Math.sqrt(Math.max(0, dist * dist - distAlong * distAlong));

        return distAlong >= 0 && distAlong <= config.radius && distPerp <= width;
      }

      default:
        return false;
    }
  }

  /**
   * 解析 AOE 范围内所有目标
   */
  public static resolveTargets(
    entities: Entity[],
    config: AoeConfig
  ): Entity[] {
    return entities.filter(e => this.isInArea(e, config));
  }

  /**
   * 计算衰减后的伤害百分比
   */
  public static calculateFalloff(
    distance: number,
    config: DamageFalloffConfig
  ): number {
    if (distance <= config.fullDamageRadius) return 1.0;
    if (distance >= config.falloffStart) return config.minDamagePercent;

    const ratio = (distance - config.fullDamageRadius) /
                  (config.falloffStart - config.fullDamageRadius);
    return 1.0 - ratio * (1.0 - config.minDamagePercent);
  }

  /**
   * 应用衰减 + DR 的最终伤害
   */
  public static applyFalloffDamage(
    baseDamage: number,
    distance: number,
    config: DamageFalloffConfig,
    dr: number = 0
  ): number {
    const percent = this.calculateFalloff(distance, config);
    const raw = Math.floor(baseDamage * percent);
    return Math.max(0, raw - dr);
  }

  /**
   * 判断实体是否在掩体后的爆风阴影区
   * 几何法：爆炸中心→目标，掩体到该线段的距离 < 掩体碰撞半径
   */
  public static isInBlastShadow(
    blastCenter: Vector3D,
    entity: Entity,
    covers: Entity[]
  ): { inShadow: boolean; blockingCover: Entity | null } {
    const blastToTarget = VectorMath.distance(blastCenter, entity.transform.coords);

    for (const cover of covers) {
      const coverDist = VectorMath.distance(blastCenter, cover.transform.coords);
      if (coverDist >= blastToTarget) continue;

      const distToLine = this.pointToSegmentDist(
        blastCenter, entity.transform.coords, cover.transform.coords
      );

      if (distToLine <= (cover.physics.collisionRadius ?? 0.5)) {
        return { inShadow: true, blockingCover: cover };
      }
    }

    return { inShadow: false, blockingCover: null };
  }

  /**
   * 判断实体在 AOE 中是否会被友军伤害波及
   */
  public static isFriendlyFireAffected(
    entity: Entity,
    _casterFaction: string
  ): boolean {
    // AOE 不分敌我，但 AOE_IMMUNE 标签可豁免
    if (entity.tags?.includes('AOE_IMMUNE')) return false;
    return true;
  }

  /**
   * 计算点到线段的最短距离
   */
  private static pointToSegmentDist(
    a: Vector3D, b: Vector3D, p: Vector3D
  ): number {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const apx = p.x - a.x;
    const apy = p.y - a.y;
    const ab2 = abx * abx + aby * aby;
    if (ab2 === 0) return VectorMath.distance(a, p);
    let t = (apx * abx + apy * aby) / ab2;
    t = Math.max(0, Math.min(1, t));
    const projX = a.x + t * abx;
    const projY = a.y + t * aby;
    return Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2);
  }
}
