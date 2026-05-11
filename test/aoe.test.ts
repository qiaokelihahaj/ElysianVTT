// test/aoe.test.ts
// AOE 与爆炸结算系统测试：圆形/锥形/线形范围、衰减、爆风阴影、友伤

// ==========================================
// 1. 内联类型定义
// ==========================================
interface Vector3D { x: number; y: number; z: number; }
type EntityId = string;
type AoeShape = 'CIRCULAR' | 'CONICAL' | 'LINEAR';
type DamageType = 'DIRECT' | 'BLAST' | 'FIRE' | 'SHATTER';

interface Entity {
  id: EntityId;
  transform: { coords: Vector3D; facing: number };
  physics: { scaleClass: number; collisionRadius: number; mass: number };
  resources: { current: Record<string, number>; max: Record<string, number> };
  defenses?: { dr: number; parry: number; dodge: number };
  tags?: string[]; // 'FRIENDLY' | 'HOSTILE' 等
}

interface AoeConfig {
  shape: AoeShape;
  origin: Vector3D;
  facing: number;              // 锥形/线形需要朝向
  radius: number;              // 圆形半径 / 锥形长度 / 线形长度
  angle?: number;              // 锥形角度（默认 90度）
  width?: number;              // 线形宽度（默认 1）
}

interface DamageFalloffConfig {
  fullDamageRadius: number;    // 全额伤害范围
  falloffStart: number;        // 开始衰减的距离
  minDamagePercent: number;    // 最小伤害百分比 (0-1)
  damageType: DamageType;
}

interface AoeTargetResult {
  entityId: EntityId;
  distance: number;
  inArea: boolean;
  damagePercent: number;       // 衰减后的伤害系数 (0-1)
  hasCover: boolean;           // 是否有掩体保护
  blockedByCover: boolean;     // 被掩体完全阻挡
}

// ==========================================
// 2. VectorMath (内联)
// ==========================================
class VectorMath {
  static distance(v1: Vector3D, v2: Vector3D): number {
    const dx = v2.x - v1.x;
    const dy = v2.y - v1.y;
    const dz = (v2.z ?? 0) - (v1.z ?? 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  static direction(from: Vector3D, to: Vector3D): Vector3D {
    return { x: to.x - from.x, y: to.y - from.y, z: (to.z ?? 0) - (from.z ?? 0) };
  }
  static normalize(v: Vector3D): Vector3D {
    const mag = Math.sqrt(v.x ** 2 + v.y ** 2 + (v.z ?? 0) ** 2);
    if (mag === 0) return { x: 0, y: 0, z: 0 };
    return { x: v.x / mag, y: v.y / mag, z: (v.z ?? 0) / mag };
  }
  static magnitude(v: Vector3D): number {
    return Math.sqrt(v.x ** 2 + v.y ** 2 + (v.z ?? 0) ** 2);
  }
}

// ==========================================
// 3. AOE 范围解析器
// ==========================================
class AoeResolver {
  /**
   * 判断目标是否在 AOE 范围内
   */
  static isInArea(
    entity: Entity,
    config: AoeConfig
  ): boolean {
    const dist = VectorMath.distance(config.origin, entity.transform.coords);
    if (dist > config.radius) return false;

    switch (config.shape) {
      case 'CIRCULAR':
        return dist <= config.radius;

      case 'CONICAL': {
        // 从原点到目标的朝向
        const toTarget = VectorMath.direction(config.origin, entity.transform.coords);
        const toTargetAngle = (Math.atan2(toTarget.y, toTarget.x) * 180 / Math.PI + 360) % 360;
        const coneAngle = config.angle ?? 90;
        // 计算与朝向的角度差
        let diff = ((toTargetAngle - config.facing) % 360 + 540) % 360 - 180;
        return Math.abs(diff) <= coneAngle / 2 && dist <= config.radius;
      }

      case 'LINEAR': {
        const width = config.width ?? 1;
        const toTarget = VectorMath.direction(config.origin, entity.transform.coords);
        const toTargetAngle = (Math.atan2(toTarget.y, toTarget.x) * 180 / Math.PI + 360) % 360;
        let diff = ((toTargetAngle - config.facing) % 360 + 540) % 360 - 180;

        // 线形：方向偏差在±30度内 + 距离在范围内
        if (Math.abs(diff) > 30) return false;

        // 横向偏移检查（垂直距离）
        const distAlong = (toTarget.x * Math.cos(config.facing * Math.PI / 180) +
                          toTarget.y * Math.sin(config.facing * Math.PI / 180));
        const distPerp = Math.sqrt(Math.max(0, dist * dist - distAlong * distAlong));

        return distAlong >= 0 && distAlong <= config.radius && distPerp <= width;
      }

      default:
        return false;
    }
  }

  /**
   * 查找一个配置内所有受影响的实体
   */
  static resolveTargets(
    entities: Entity[],
    config: AoeConfig
  ): Entity[] {
    return entities.filter(e => AoeResolver.isInArea(e, config));
  }
}

// ==========================================
// 4. 衰减计算器
// ==========================================
class DamageFalloff {
  /**
   * 计算衰减后的伤害百分比
   */
  static calculate(
    distance: number,
    config: DamageFalloffConfig
  ): number {
    if (distance <= config.fullDamageRadius) return 1.0;
    if (distance >= config.falloffStart) return config.minDamagePercent;

    // 线性插值：fullDamageRadius → falloffStart, 1.0 → minDamagePercent
    const ratio = (distance - config.fullDamageRadius) /
                  (config.falloffStart - config.fullDamageRadius);
    return 1.0 - ratio * (1.0 - config.minDamagePercent);
  }

  /**
   * 应用衰减到原始伤害
   */
  static applyDamage(
    baseDamage: number,
    distance: number,
    config: DamageFalloffConfig,
    dr: number = 0
  ): number {
    const percent = DamageFalloff.calculate(distance, config);
    const rawDamage = Math.floor(baseDamage * percent);
    return Math.max(0, rawDamage - dr);
  }
}

// ==========================================
// 5. 爆风阴影系统 (Blast Shadow)
// ==========================================
class BlastShadowResolver {
  /**
   * 计算点到线段的最短距离
   * 线段起点=A, 终点=B, 点=P
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

  /**
   * 判断实体是否在掩体后的阴影区
   * 几何法：爆炸中心→目标形成线段，掩体到该线段的距离 < 掩体碰撞半径
   */
  static isInBlastShadow(
    blastCenter: Vector3D,
    entity: Entity,
    covers: Entity[]
  ): { inShadow: boolean; blockingCover: Entity | null } {
    const blastToTarget = VectorMath.distance(blastCenter, entity.transform.coords);

    for (const cover of covers) {
      const coverDist = VectorMath.distance(blastCenter, cover.transform.coords);
      // 掩体必须在爆炸中心和目标之间（更靠近爆炸中心）
      if (coverDist >= blastToTarget) continue;

      // 掩体到爆炸中心→目标线段的距离
      const distToLine = BlastShadowResolver.pointToSegmentDist(
        blastCenter, entity.transform.coords, cover.transform.coords
      );

      // 掩体碰撞半径覆盖该线段 → 阴影
      if (distToLine <= (cover.physics.collisionRadius ?? 0.5)) {
        return { inShadow: true, blockingCover: cover };
      }
    }
    return { inShadow: false, blockingCover: null };
  }

  /**
   * 多层掩体判定
   */
  static isInFullCover(
    blastCenter: Vector3D,
    entity: Entity,
    covers: Entity[]
  ): boolean {
    const { inShadow } = BlastShadowResolver.isInBlastShadow(blastCenter, entity, covers);
    return inShadow;
  }
}

// ==========================================
// 6. 友伤系统
// ==========================================
class FriendlyFireResolver {
  /**
   * 检查实体是否会被 AOE 误伤
   * AOE 没有免伤机制，所有在范围内的实体都受影响
   */
  static isAffectedByAOE(
    entity: Entity,
    casterFaction: string,
    entityFaction: string
  ): boolean {
    // AOE 对所有在范围内的实体生效，不分敌我
    // 但可以通过特殊标记免除
    if (entity.tags?.includes('AOE_IMMUNE')) return false;
    return true;
  }

  /**
   * 获取 AOE 影响的所有实体（不分敌我）
   */
  static resolveAOETargets(
    allEntities: Entity[],
    aoeArea: Entity[],
    casterFaction: string
  ): { friendly: Entity[]; hostile: Entity[]; neutral: Entity[] } {
    const friendly: Entity[] = [];
    const hostile: Entity[] = [];
    const neutral: Entity[] = [];

    for (const entity of aoeArea) {
      if (!FriendlyFireResolver.isAffectedByAOE(entity, casterFaction, entity.tags?.find(t => t.startsWith('FACTION_'))?.replace('FACTION_', '') ?? '')) {
        continue;
      }

      const faction = entity.tags?.find(t => t.startsWith('FACTION_'));
      if (!faction) {
        neutral.push(entity);
      } else if (faction === `FACTION_${casterFaction}`) {
        friendly.push(entity);
      } else {
        hostile.push(entity);
      }
    }

    return { friendly, hostile, neutral };
  }
}

// ==========================================
// 7. 测试框架
// ==========================================
let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
  testCount++;
  if (cond) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}
function assertEqual<T>(actual: T, expected: T, label: string) {
  testCount++;
  if (actual === expected) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label} (期望=${expected}, 实际=${actual})`); process.exitCode = 1; }
}

// ==========================================
// 8. 场景测试
// ==========================================
function runTests() {
  console.log('=== ElysianVTT AOE 与爆炸结算系统测试 ===\n');

  // ===============================================
  // Scenario A: 圆形范围覆盖
  // ===============================================
  console.log('[Scenario A] 圆形范围覆盖');
  {
    const config: AoeConfig = {
      shape: 'CIRCULAR',
      origin: { x: 0, y: 0, z: 0 },
      facing: 0,
      radius: 5
    };

    const targets: Entity[] = [
      { id: 'a', transform: { coords: { x: 0, y: 0, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } } },
      { id: 'b', transform: { coords: { x: 3, y: 4, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } } },
      { id: 'c', transform: { coords: { x: 5, y: 0, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } } },
      { id: 'd', transform: { coords: { x: 6, y: 0, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } } },
    ];

    const inArea = AoeResolver.resolveTargets(targets, config);
    const ids = inArea.map(e => e.id).sort();
    assertEqual(ids.join(','), 'a,b,c', '在半径5内: a(原点), b(距离5), c(距离5)');
    assert(inArea.length === 3, '3个目标在圆形范围内');
    assert(inArea.find(e => e.id === 'd') === undefined, 'd在距离6 → 超出范围');
  }

  // ===============================================
  // Scenario B: 锥形范围覆盖
  // ===============================================
  console.log('\n[Scenario B] 锥形范围覆盖');
  {
    // 面向0度(向右)的90度锥形，半径5
    const config: AoeConfig = {
      shape: 'CONICAL',
      origin: { x: 0, y: 0, z: 0 },
      facing: 0,  // 面向右
      radius: 5,
      angle: 90
    };

    const targets: Entity[] = [
      { id: 'a', transform: { coords: { x: 4, y: 0, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } } },
      { id: 'b', transform: { coords: { x: 3, y: 2, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } } },
      { id: 'c', transform: { coords: { x: 0, y: 4, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } } },
      { id: 'd', transform: { coords: { x: -3, y: 0, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } } },
      { id: 'e', transform: { coords: { x: 4, y: 3, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } } },
    ];

    // a (4,0): 正前方, 距离4 → 在锥形内
    // b (3,2): 方向 atan2(2,3)=33.7°, 距离3.6 → 在90°锥形内
    // c (0,4): 方向 90°, 距离4 → 90°锥形边界 (在±45°内? 90° > 45° → 超出)
    // d (-3,0): 方向 180°, 距离3 → 背后 → 不在锥形内
    // e (4,3): 方向 atan2(3,4)=36.9°, 距离5 → 角度在45°内但距离=5在边界上
    const inArea = AoeResolver.resolveTargets(targets, config);
    const ids = inArea.map(e => e.id).sort();
    assert(ids.includes('a'), 'a 在锥形范围内');
    assert(ids.includes('b'), 'b 在锥形范围内');
    // At(0,4) = 90° from facing (0°). Cone half-angle = 45°. |90°| > 45° → out
    assert(ids.includes('c') === false, 'c(90°方向) 超出锥形范围');
    assert(ids.includes('d') === false, 'd(背后) 超出锥形范围');
  }

  // ===============================================
  // Scenario C: 线形范围覆盖
  // ===============================================
  console.log('\n[Scenario C] 线形范围覆盖');
  {
    // 面向0度(向右)的线形，长度5，宽度1
    const config: AoeConfig = {
      shape: 'LINEAR',
      origin: { x: 0, y: 0, z: 0 },
      facing: 0,
      radius: 5,
      width: 1
    };

    const targets: Entity[] = [
      { id: 'a', transform: { coords: { x: 4, y: 0, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } } },
      { id: 'b', transform: { coords: { x: 3, y: 0.8, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } } },
      { id: 'c', transform: { coords: { x: 2, y: 2, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } } },
      { id: 'd', transform: { coords: { x: 6, y: 0, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } } },
    ];

    // a (4,0): 正前, 纵向距离4≤5, 横向0≤1 → 在线形内
    // b (3,0.8): 方向~15°, 纵距~3, 横0.8≤1 → 在宽度内, 距离内
    // c (2,2): 方向45°, 横向距离 > 在距离4时宽度为1 → out
    // d (6,0): 距离6 > 5 → out
    const inArea = AoeResolver.resolveTargets(targets, config);
    const ids = inArea.map(e => e.id).sort();
    assert(ids.includes('a'), '正前方 → 在线形内');
    assert(ids.includes('b'), '偏移0.8在宽度1内 → 在线形内');
    assert(ids.includes('c') === false, '偏移2超出宽度1 → 在线形外');
    assert(ids.includes('d') === false, '距离6超出长度5 → 在线形外');
  }

  // ===============================================
  // Scenario D: 衰减计算
  // ===============================================
  console.log('\n[Scenario D] 衰减计算');
  {
    const config: DamageFalloffConfig = {
      fullDamageRadius: 2,    // 2格内全额
      falloffStart: 5,        // 5格外最低
      minDamagePercent: 0.3,  // 最低30%
      damageType: 'BLAST'
    };

    // 全额范围
    const pct0 = DamageFalloff.calculate(0, config);
    assertEqual(pct0, 1.0, '原点 → 100%');

    const pct1 = DamageFalloff.calculate(2, config);
    assertEqual(pct1, 1.0, '距离2 → 100% (全额边界)');

    // 衰减区
    const pct3 = DamageFalloff.calculate(3, config);
    // (3-2)/(5-2)=1/3, 1 - 1/3*(1-0.3) = 1 - 0.233 = 0.767
    assert(Math.abs(pct3 - 0.767) < 0.01, `距离3 → 约76.7% (实际=${pct3.toFixed(3)})`);

    const pct4 = DamageFalloff.calculate(4, config);
    // (4-2)/(5-2)=2/3, 1 - 2/3*(0.7) = 1 - 0.467 = 0.533
    assert(Math.abs(pct4 - 0.533) < 0.01, `距离4 → 约53.3% (实际=${pct4.toFixed(3)})`);

    // 最小伤害
    const pct5 = DamageFalloff.calculate(5, config);
    assertEqual(pct5, 0.3, '距离5(≥falloffStart) → 30%');

    const pct6 = DamageFalloff.calculate(10, config);
    assertEqual(pct6, 0.3, '距离10 → 30% (封顶)');
  }

  // ===============================================
  // Scenario E: 带 DR 的衰减伤害
  // ===============================================
  console.log('\n[Scenario E] 衰减 + DR 复合计算');
  {
    const config: DamageFalloffConfig = {
      fullDamageRadius: 2,
      falloffStart: 6,
      minDamagePercent: 0.25,
      damageType: 'BLAST'
    };

    // 全额范围，有DR
    const dmg0 = DamageFalloff.applyDamage(100, 1, config, 10);
    assertEqual(dmg0, 90, '全额100 - DR10 = 90');

    // 衰减后
    const dmg3 = DamageFalloff.applyDamage(100, 3, config, 5);
    // distance=3: (3-2)/(6-2)=0.25, percent=1-0.25*(0.75)=0.8125, raw=81, 81-5=76
    assertEqual(dmg3, 76, '距离3: 81.25% → 81 - DR5 = 76');

    // 极远距离最低伤害 + DR
    const dmg8 = DamageFalloff.applyDamage(100, 8, config, 5);
    // min=25%, raw=25, 25-5=20
    assertEqual(dmg8, 20, '距离8: 25% → 25 - DR5 = 20');

    // DR 高于伤害 → 0
    const dmgZero = DamageFalloff.applyDamage(10, 5, config, 20);
    assertEqual(dmgZero, 0, 'DR(20) > 衰减后伤害 → 0');
  }

  // ===============================================
  // Scenario F: 爆风阴影 — 掩体后安全区
  // ===============================================
  console.log('\n[Scenario F] 爆风阴影 — 掩体阻挡');
  {
    const blastCenter = { x: 0, y: 0, z: 0 };
    const wall: Entity = {
      id: 'wall',
      transform: { coords: { x: 3, y: 0, z: 0 }, facing: 0 },
      physics: { scaleClass: 2, collisionRadius: 1.5, mass: 500 },
      resources: { current: { hp: 200 }, max: { hp: 200 } }
    };
    const targetBehind: Entity = {
      id: 'behind',
      transform: { coords: { x: 5, y: 0.5, z: 0 }, facing: 0 },
      physics: { scaleClass: 1, collisionRadius: 0.5, mass: 70 },
      resources: { current: { hp: 100 }, max: { hp: 100 } }
    };
    const targetExposed: Entity = {
      id: 'exposed',
      transform: { coords: { x: 5, y: 3.5, z: 0 }, facing: 0 },
      physics: { scaleClass: 1, collisionRadius: 0.5, mass: 70 },
      resources: { current: { hp: 100 }, max: { hp: 100 } }
    };

    // 掩体在爆炸中心(0,0)和目标之间(3,0处)，目标在(5,0.5)
    const shadowBehind = BlastShadowResolver.isInBlastShadow(blastCenter, targetBehind, [wall]);
    assert(shadowBehind.inShadow === true, '掩体后的目标在阴影区内');

    // 暴露的目标 (横向偏移大，超出掩体覆盖范围)
    const shadowExposed = BlastShadowResolver.isInBlastShadow(blastCenter, targetExposed, [wall]);
    assert(shadowExposed.inShadow === false, '横向偏移大的目标不在阴影区内');
  }

  // ===============================================
  // Scenario G: 爆风阴影 — 多层掩体叠加
  // ===============================================
  console.log('\n[Scenario G] 爆风阴影 — 多层掩体');
  {
    const blastCenter = { x: 0, y: 0, z: 0 };
    const wall1: Entity = {
      id: 'outer_wall',
      transform: { coords: { x: 2, y: 0, z: 0 }, facing: 0 },
      physics: { scaleClass: 2, collisionRadius: 1, mass: 300 },
      resources: { current: { hp: 100 }, max: { hp: 100 } }
    };
    const wall2: Entity = {
      id: 'inner_wall',
      transform: { coords: { x: 3, y: 0, z: 0 }, facing: 0 },
      physics: { scaleClass: 2, collisionRadius: 1, mass: 300 },
      resources: { current: { hp: 100 }, max: { hp: 100 } }
    };
    const deepTarget: Entity = {
      id: 'bunker',
      transform: { coords: { x: 5, y: 0, z: 0 }, facing: 0 },
      physics: { scaleClass: 1, collisionRadius: 0.5, mass: 70 },
      resources: { current: { hp: 100 }, max: { hp: 100 } }
    };

    // 双重掩体
    const fullCover = BlastShadowResolver.isInFullCover(blastCenter, deepTarget, [wall1, wall2]);
    assert(fullCover === true, '双重掩体完全阻挡爆风');
  }

  // ===============================================
  // Scenario H: 友军伤害系统
  // ===============================================
  console.log('\n[Scenario H] 友军伤害 — AOE 波及友军');
  {
    const casterFaction = 'A';

    const targets: Entity[] = [
      { id: 'friend1', transform: { coords: { x: 2, y: 0, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } }, tags: ['FACTION_A'] },
      { id: 'friend2', transform: { coords: { x: 3, y: 0, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } }, tags: ['FACTION_A'] },
      { id: 'enemy1', transform: { coords: { x: 4, y: 0, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } }, tags: ['FACTION_B'] },
      { id: 'neutral', transform: { coords: { x: 5, y: 0, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } } },
    ];

    // 所有在AOE范围内的实体都会受影响
    for (const target of targets) {
      assert(FriendlyFireResolver.isAffectedByAOE(target, 'A', target.tags?.find(t => t.startsWith('FACTION_'))?.replace('FACTION_', '') ?? '') === true,
        `${target.id}: AOE 影响所有范围内实体`);
    }

    // AOE_IMMUNE 豁免
    const immuneTarget: Entity = {
      id: 'immune', transform: { coords: { x: 2, y: 0, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } }, tags: ['AOE_IMMUNE']
    };
    assert(FriendlyFireResolver.isAffectedByAOE(immuneTarget, 'A', '') === false, 'AOE_IMMUNE → 豁免');

    // 阵营分类
    const factionResult = FriendlyFireResolver.resolveAOETargets(targets, targets, 'A');
    assertEqual(factionResult.friendly.length, 2, '2个友方目标');
    assertEqual(factionResult.hostile.length, 1, '1个敌方目标');
    assertEqual(factionResult.neutral.length, 1, '1个中立目标');
  }

  // ===============================================
  // Scenario I: 整合 — 完整 AOE 伤害流程
  // ===============================================
  console.log('\n[Scenario I] 整合 — 完整 AOE 伤害结算');
  {
    // 法师在(0,0)施放圆形爆炸 AOE, 半径4
    const aoeConfig: AoeConfig = {
      shape: 'CIRCULAR',
      origin: { x: 0, y: 0, z: 0 },
      facing: 0,
      radius: 4
    };

    const falloffConfig: DamageFalloffConfig = {
      fullDamageRadius: 1.5,
      falloffStart: 4,
      minDamagePercent: 0.4,
      damageType: 'BLAST'
    };

    const baseDamage = 50;
    const entities: Entity[] = [
      { id: 'close_enemy', transform: { coords: { x: 1, y: 0, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 80 }, max: { hp: 80 } }, defenses: { dr: 5, parry: 0, dodge: 0 }, tags: ['FACTION_B'] },
      { id: 'far_enemy', transform: { coords: { x: 3.5, y: 0, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 60 }, max: { hp: 60 } }, defenses: { dr: 8, parry: 0, dodge: 0 }, tags: ['FACTION_B'] },
      { id: 'ally', transform: { coords: { x: 2, y: 0, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } }, defenses: { dr: 10, parry: 0, dodge: 0 }, tags: ['FACTION_A'] },
    ];

    // 步骤1: 确定所有在范围内的目标
    const inArea = AoeResolver.resolveTargets(entities, aoeConfig);
    assertEqual(inArea.length, 3, '3个实体均在AOE范围内');

    // 步骤2: 计算每个目标的伤害
    for (const entity of inArea) {
      const dist = VectorMath.distance(aoeConfig.origin, entity.transform.coords);
      const dmg = DamageFalloff.applyDamage(baseDamage, dist, falloffConfig, entity.defenses?.dr ?? 0);
      entity.resources.current.hp = Math.max(0, entity.resources.current.hp - dmg);
    }

    // close_enemy: 距离1, 全额50, -DR5=45, HP 80-45=35
    assertEqual(entities[0].resources.current.hp, 35, `近敌HP: 80-45=35 (实际=${entities[0].resources.current.hp})`);

    // far_enemy: 距离3.5, (3.5-1.5)/(4-1.5)=0.8, 1-0.8*(0.6)=0.52, dmg=floor(50*0.52)=26, -DR8=18, HP 60-18=42
    assertEqual(entities[1].resources.current.hp, 42, `远敌HP: 60-18=42 (实际=${entities[1].resources.current.hp})`);

    // ally: 距离2, (2-1.5)/(4-1.5)=0.2, 1-0.2*(0.6)=0.88, dmg=floor(50*0.88)=44, -DR10=34, HP 100-34=66
    assertEqual(entities[2].resources.current.hp, 66, `友方HP: 100-34=66 (实际=${entities[2].resources.current.hp})`);

    // 友军也受到伤害!
    assert(entities[2].resources.current.hp < 100, '友军同样受到AOE伤害（无豁免）');
  }

  // ===============================================
  // Scenario J: 边界条件 — 空列表/零半径
  // ===============================================
  console.log('\n[Scenario J] 边界条件');
  {
    // 空实体列表
    const empty = AoeResolver.resolveTargets([], {
      shape: 'CIRCULAR', origin: { x: 0, y: 0, z: 0 }, facing: 0, radius: 10
    });
    assertEqual(empty.length, 0, '空实体列表 → 0个目标');

    // 零半径
    const zeroRadius = AoeResolver.resolveTargets([
      { id: 'a', transform: { coords: { x: 0, y: 0, z: 0 }, facing: 0 }, physics: { scaleClass: 1, collisionRadius: 1, mass: 70 }, resources: { current: { hp: 100 }, max: { hp: 100 } } },
    ], { shape: 'CIRCULAR', origin: { x: 0, y: 0, z: 0 }, facing: 0, radius: 0 });
    assertEqual(zeroRadius.length, 1, '零半径但实体在原点 → 原点被认为在范围内');

    // 极小衰减
    const minConfig: DamageFalloffConfig = {
      fullDamageRadius: 0, falloffStart: 1, minDamagePercent: 0.5, damageType: 'BLAST'
    };
    const pct = DamageFalloff.calculate(0.5, minConfig);
    assert(pct >= 0.5 && pct <= 1.0, '极小范围内衰减计算不会越界');
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有 AOE 测试通过!');
}

runTests();
