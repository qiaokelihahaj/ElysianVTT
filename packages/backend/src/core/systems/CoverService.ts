// packages/backend/src/core/systems/CoverService.ts
// 掩体系统：掩体判定、Cover DR、战术姿态、爆风阴影

import type {
    Entity, Vector3D, CoverState, CoverType, TacticalStance,
    StanceConfig, BodyPart, HitLocationEntry
} from '@hard-vtt/shared';
import { VectorMath } from '../../utils/VectorMath.js';
import { Logger } from '../../utils/Logger.js';

const logger = Logger.create('System:Cover');

// 预设姿态配置
const STANCE_CONFIGS: Record<TacticalStance, StanceConfig> = {
    'ADS': {
        stance: 'ADS',
        accuracyModifier: 2,       // 架枪：+2 命中
        exposedBodyParts: ['HEAD', 'LEFT_ARM', 'RIGHT_ARM'],
        shotDeviation: 0,          // 无偏移
        switchCostTicks: 5
    },
    'BLIND_FIRE': {
        stance: 'BLIND_FIRE',
        accuracyModifier: -4,      // 撩枪：-4 命中
        exposedBodyParts: [],      // 完全隐蔽
        shotDeviation: 3,          // 弹着点偏移半径 3 单位
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

export interface CoverCheckResult {
    hasCover: boolean;
    coverState?: CoverState;
    hitsCover: boolean;           // 攻击是否命中了掩体
    coverDrApplied: number;       // 掩体减免的伤害
}

export interface StanceCheckResult {
    stance: TacticalStance;
    accuracyModifier: number;
    exposedParts: BodyPart[];
    shotDeviation: number;
}

export class CoverService {
    /**
     * 获取两点之间的掩体
     * 使用线段与掩体朝向的交点检测
     *
     * @param attackerPos  攻击者坐标
     * @param target       目标实体（需有 coverState）
     * @returns CoverState | null
     */
    public static getCoverBetween(
        attackerPos: Vector3D,
        target: Entity
    ): CoverState | null {
        if (!target.coverState) return null;
        const cover = target.coverState;

        // 掩体朝向：掩体面对的方向（保护方向）
        // 攻击者必须在掩体朝向的反方向才能受到保护
        const coverFacingRad = cover.facing * (Math.PI / 180);

        // 攻击者相对于掩体位置的方向向量
        // 简化为：攻击者与目标的连线方向
        const dx = attackerPos.x - target.transform.coords.x;
        const dy = attackerPos.y - target.transform.coords.y;

        // 掩体朝向向量
        const facingX = Math.cos(coverFacingRad);
        const facingY = Math.sin(coverFacingRad);

        // 点积：判断攻击者是否在掩体正面
        // 若攻击者方向与掩体朝向同向（点积>0），则攻击来自掩体保护方向
        const dot = dx * facingX + dy * facingY;

        return dot > 0 ? cover : null;
    }

    /**
     * 掩体碰撞判定
     * d20 >= coverThreshold → 越过掩体命中目标
     * d20 < coverThreshold → 命中掩体（伤害被掩体吸收）
     */
    public static resolveCoverCollision(
        d20Roll: number,
        coverThreshold: number
    ): { hitsCover: boolean } {
        return { hitsCover: d20Roll < coverThreshold };
    }

    /**
     * 应用掩体 DR
     * 掩体 DR 与护甲 DR 叠加
     */
    public static applyCoverDR(rawDamage: number, coverDr: number): number {
        return Math.max(0, rawDamage - coverDr);
    }

    /**
     * 根据战术姿态过滤部位命中表
     * ADS: 只暴露 HEAD + ARMs
     * BLIND_FIRE: 无部位暴露（掩体完全保护）
     * NONE: 全身暴露
     */
    public static filterHitTableByStance(
        hitTable: HitLocationEntry[],
        stance: TacticalStance
    ): HitLocationEntry[] {
        const stanceConfig = STANCE_CONFIGS[stance];
        if (!stanceConfig || stanceConfig.exposedBodyParts.length === 0) {
            return []; // 无暴露部位 → 无法被命中
        }

        return hitTable.filter(entry =>
            stanceConfig.exposedBodyParts.includes(entry.part)
        );
    }

    /**
     * 获取某个姿态下暴露的身体部位列表
     */
    public static getExposedParts(stance: TacticalStance): BodyPart[] {
        return STANCE_CONFIGS[stance]?.exposedBodyParts ?? [];
    }

    /**
     * 获取姿态配置
     */
    public static getStanceConfig(stance: TacticalStance): StanceConfig {
        return { ...STANCE_CONFIGS[stance] };
    }

    /**
     * 计算爆风阴影减伤倍率
     * 距离掩体越近、爆炸半径越小 → 减伤越多
     *
     * @param distToCover    目标到掩体的距离
     * @param blastRadius    爆炸有效半径
     * @returns 0.0 ~ 1.0 的伤害倍率（1.0 = 全额伤害）
     */
    public static getBlastShadowMultiplier(
        distToCover: number,
        blastRadius: number
    ): number {
        if (blastRadius <= 0) return 1.0;

        // 越靠近掩体减伤越明显
        const shadowFactor = Math.min(1.0, distToCover / (blastRadius * 0.5));
        // 至少保留 30% 伤害（爆炸冲击波绕射）
        return Math.max(0.3, 1.0 - shadowFactor * 0.7);
    }

    /**
     * 获取姿态命中修正（用于命中判定）
     * ADS: +2, BLIND_FIRE: -4
     */
    public static getAccuracyModifier(stance: TacticalStance): number {
        return STANCE_CONFIGS[stance]?.accuracyModifier ?? 0;
    }

    /**
     * 获取撩枪状态的弹着点偏移
     * 返回一个随机偏移向量
     */
    public static getShotDeviation(stance: TacticalStance): Vector3D {
        const config = STANCE_CONFIGS[stance];
        if (!config || config.shotDeviation <= 0) {
            return { x: 0, y: 0, z: 0 };
        }

        // 随机方向和随机距离 (0 ~ deviation)
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * config.shotDeviation;

        return {
            x: Math.cos(angle) * dist,
            y: Math.sin(angle) * dist,
            z: 0
        };
    }

    /**
     * 获取姿态切换 Tick 消耗
     */
    public static getSwitchCost(stance: TacticalStance): number {
        return STANCE_CONFIGS[stance]?.switchCostTicks ?? 0;
    }

    /**
     * 计算目标在掩体后的暴露程度
     * 用于决定攻击是否可能绕过掩体
     *
     * @param cover 掩体状态
     * @param d20Roll d20 掷骰结果
     * @returns 是否命中目标（true=越过掩体命中，false=被掩体挡住）
     */
    public static checkCoverPenetration(
        cover: CoverState,
        d20Roll: number
    ): { penetrates: boolean; hitsCover: boolean } {
        if (cover.coverType === 'FULL') {
            // 全掩体：只有 PRECISION 路线且 d20 >= threshold 才能命中
            return {
                penetrates: d20Roll >= cover.coverThreshold,
                hitsCover: d20Roll < cover.coverThreshold
            };
        }

        // 半掩体：d20 >= threshold 越过掩体，否则命中掩体
        return {
            penetrates: d20Roll >= cover.coverThreshold,
            hitsCover: d20Roll < cover.coverThreshold
        };
    }
}
