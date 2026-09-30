import { BaseEntity } from './BaseEntity.js';
import type {
    Vector3D, ResourcePool, Transform, PhysicsBody, EntityId,
    TrajectoryType, CollisionRoll, CollisionResult, BodyPart
} from '@hard-vtt/shared';
import { VectorMath } from '../../utils/VectorMath.js';
import { SpatialSystem } from '../systems/SpatialSystem.js';

/**
 * 弹道实体类
 * 代表飞行中的投射物（子弹、箭矢、法术弹），含完整轨迹和碰撞逻辑
 *
 * 功能：
 * - 直射弹道（Linear）：贴地平飞、逐网格推进
 * - 抛物线弹道（Parabolic）：升弧段/降弧段、越障、最小射程盲区
 * - 盲投碰撞检查（d20 + 尺度阈值）
 * - Chaotic Impact 随机部位判定
 * - 边界事件预计算（射线算法）
 */
export class Projectile extends BaseEntity {
    public trajectoryType: TrajectoryType;
    public speed: number;                 // 每 Tick 移动距离（单位长度）
    public sourceEntityId: EntityId;
    public sourceActionTemplateId: string; // 来源技能模板 ID（碰撞后用于伤害结算）
    public targetEntityId?: EntityId;
    public targetCoords?: Vector3D;       // 最终目的地

    // 预计算弹道路径
    public waypoints: Vector3D[];
    public currentWaypointIndex: number;

    // 抛物线参数
    public maxHeight: number;             // 最高点 Z 值
    public minRange: number;              // 最小射程（盲区）
    public isAscending: boolean;          // true=升弧中, false=降弧中

    // 碰撞状态
    public collisionResult?: CollisionResult;
    public hasCollided: boolean;

    // 盲投碰撞配置
    public collisionDieSize: number;      // 碰撞判定面数（默认 d20）
    public dieThreshold: number;          // >= 此值命中

    constructor(params: {
        id: string;
        templateId: string;
        sourceEntityId: EntityId;
        sourceActionTemplateId?: string;
        transform: Transform;
        physics: PhysicsBody;
        resources: ResourcePool;
        trajectoryType?: TrajectoryType;
        speed?: number;
        maxHeight?: number;
        minRange?: number;
        collisionDieSize?: number;
        dieThreshold?: number;
        targetEntityId?: EntityId;
        targetCoords?: Vector3D;
    }) {
        super({
            ...params,
            type: 'PROJECTILE'
        });
        this.sourceEntityId = params.sourceEntityId;
        this.sourceActionTemplateId = params.sourceActionTemplateId ?? '';
        this.trajectoryType = params.trajectoryType ?? 'LINEAR';
        this.speed = params.speed ?? 1.0;

        this.waypoints = [];
        // Generated paths omit the launch point; no waypoint has been reached yet.
        this.currentWaypointIndex = -1;

        this.maxHeight = params.maxHeight ?? 0;
        this.minRange = params.minRange ?? 0;
        this.isAscending = true;

        this.hasCollided = false;

        this.collisionDieSize = params.collisionDieSize ?? 20;
        this.dieThreshold = params.dieThreshold ?? 10;

        this.targetEntityId = params.targetEntityId;
        this.targetCoords = params.targetCoords;
    }

    /** 设置直射弹道路径 */
    public setLinearPath(from: Vector3D, to: Vector3D, stepSize: number): void {
        this.waypoints = SpatialSystem.planProjectilePath(from, to, 'LINEAR', stepSize);
        this.transform.coords = { ...from };
        this.currentWaypointIndex = -1;
        this.trajectoryType = 'LINEAR';
    }

    /** 设置抛物线弹道路径 */
    public setParabolicPath(from: Vector3D, to: Vector3D, stepSize: number, maxHeight: number): void {
        this.waypoints = SpatialSystem.planProjectilePath(from, to, 'PARABOLIC', stepSize, { maxHeight });
        this.transform.coords = { ...from };
        this.maxHeight = maxHeight;
        this.currentWaypointIndex = -1;
        this.trajectoryType = 'PARABOLIC';
    }

    /**
     * 推进一个 Tick 的飞行
     * 先检查速度是否能到达下一个航点，如果不能则插值前进
     *
     * @returns 是否到达终点
     */
    public advance(): boolean {
        if (this.currentWaypointIndex >= this.waypoints.length - 1) return true;
        if (this.hasCollided) return true;

        const next = this.waypoints[this.currentWaypointIndex + 1];
        const dist = VectorMath.distance(this.transform.coords, next);

        if (dist <= this.speed) {
            // 可以直接到达下一个航点
            this.transform.coords = { ...next };
            this.currentWaypointIndex++;

            // 更新升弧/降弧状态
            if (this.trajectoryType === 'PARABOLIC' && this.waypoints.length > 1) {
                const midPoint = Math.floor(this.waypoints.length / 2);
                this.isAscending = this.currentWaypointIndex <= midPoint;
            }
        } else {
            // 按速度向航点方向前进
            this.transform.coords = VectorMath.stepTowards(
                this.transform.coords,
                next,
                this.speed
            );
        }

        return this.currentWaypointIndex >= this.waypoints.length - 1;
    }

    /**
     * 获取当前航段的起点和终点
     * 用于生成边界事件
     */
    public getCurrentSegment(): { from: Vector3D; to: Vector3D } | null {
        if (this.currentWaypointIndex >= this.waypoints.length - 1) return null;

        return {
            from: { ...this.transform.coords },
            to: { ...this.waypoints[this.currentWaypointIndex + 1] }
        };
    }

    /**
     * 盲投碰撞检查（Collision Roll）
     * 当弹道路径上有潜在目标时进行盲投判定
     *
     * 规则：掷 d20 + 尺度补正 >= 阈值 => 命中
     * - 大尺度目标（Scale Class 2+）: 阈值减半
     * - 盲投（无直瞄）: 额外 -4 减值
     *
     * @param scaleClass 目标的尺度级别
     * @param isBlind    是否盲射（无直接视线）
     */
    public rollCollision(scaleClass: number, isBlind: boolean = false): CollisionRoll {
        const d20 = Math.floor(Math.random() * this.collisionDieSize) + 1;
        const scaleBonus = scaleClass >= 2 ? Math.floor(this.collisionDieSize * 0.25) : 0;
        const blindPenalty = isBlind ? 4 : 0;
        const threshold = Math.max(1, this.dieThreshold - scaleBonus + blindPenalty);

        return {
            d20,
            threshold,
            isBlind,
            bodyPart: d20 >= threshold ? this.resolveChaoticImpact() : undefined
        };
    }

    /**
     * Chaotic Impact：随机命中部位
     * 盲投碰撞时随机决定命中身体哪个部位
     */
    public resolveChaoticImpact(): BodyPart {
        const roll = Math.floor(Math.random() * 100);
        // 权重分配：TORSO 最常被命中
        const table: Array<{ part: BodyPart; weight: number }> = [
            { part: 'HEAD', weight: 10 },
            { part: 'TORSO', weight: 40 },
            { part: 'LEFT_ARM', weight: 12 },
            { part: 'RIGHT_ARM', weight: 12 },
            { part: 'LEFT_LEG', weight: 13 },
            { part: 'RIGHT_LEG', weight: 13 },
        ];

        let cumulative = 0;
        for (const entry of table) {
            cumulative += entry.weight;
            if (roll < cumulative) return entry.part;
        }

        return 'TORSO'; // fallback
    }

    /**
     * 触发碰撞回调，记录碰撞结果
     */
    public onCollision(targetId?: EntityId): CollisionResult {
        this.hasCollided = true;
        const result: CollisionResult = {
            hit: true,
            targetId,
            impactCoords: { ...this.transform.coords }
        };
        this.collisionResult = result;
        return result;
    }

    /** 检查弹道是否已在终点或已碰撞 */
    public isDone(): boolean {
        return this.hasCollided || this.currentWaypointIndex >= this.waypoints.length - 1;
    }
}
