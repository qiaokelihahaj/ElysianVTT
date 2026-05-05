import { BaseEntity } from './BaseEntity.js';
import type { Vector3D, ResourcePool, Transform, PhysicsBody, EntityId } from '@hard-vtt/shared';
import { VectorMath } from '../../utils/VectorMath.js';

export type TrajectoryType = 'LINEAR' | 'PARABOLIC';

/**
 * 弹道实体类
 * 代表飞行中的投射物（子弹、箭矢、法术弹），含轨迹和碰撞逻辑
 */
export class Projectile extends BaseEntity {
    public trajectoryType: TrajectoryType;
    public speed: number;           // 每 Tick 移动距离
    public sourceEntityId: EntityId;
    public targetEntityId?: EntityId;
    public path: Vector3D[];        // 预计算路径
    public currentPathIndex: number;
    public collisionCallback?: (target: EntityId) => void;

    constructor(params: {
        id: string;
        templateId: string;
        sourceEntityId: EntityId;
        transform: Transform;
        physics: PhysicsBody;
        resources: ResourcePool;
        trajectoryType?: TrajectoryType;
        speed?: number;
    }) {
        super({
            ...params,
            type: 'PROJECTILE'
        });
        this.sourceEntityId = params.sourceEntityId;
        this.trajectoryType = params.trajectoryType ?? 'LINEAR';
        this.speed = params.speed ?? 1.0;
        this.path = [];
        this.currentPathIndex = 0;
    }

    /** 设定飞行路径 */
    public setPath(waypoints: Vector3D[]): void {
        this.path = waypoints;
        this.currentPathIndex = 0;
    }

    /** 推进一个 Tick 的飞行，返回是否到达终点 */
    public advance(): boolean {
        if (this.currentPathIndex >= this.path.length - 1) return true;

        const next = this.path[this.currentPathIndex + 1];
        const dist = VectorMath.distance(this.transform.coords, next);

        if (dist <= this.speed) {
            this.transform.coords = { ...next };
            this.currentPathIndex++;
        } else {
            this.transform.coords = VectorMath.stepTowards(
                this.transform.coords,
                next,
                this.speed
            );
        }

        return this.currentPathIndex >= this.path.length - 1;
    }

    /** 触发碰撞回调 */
    public onCollision(): void {
        if (this.collisionCallback && this.targetEntityId) {
            this.collisionCallback(this.targetEntityId);
        }
    }
}
