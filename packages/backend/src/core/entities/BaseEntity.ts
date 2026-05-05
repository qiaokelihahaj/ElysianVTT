import type { Entity, EntityId, Transform, PhysicsBody, ResourcePool, AppliedEffect, Vector3D } from '@hard-vtt/shared';

/**
 * 基础实体抽象类
 * 实现 Entity 接口的核心字段，提供资源管理和状态查询方法
 */
export abstract class BaseEntity implements Entity {
    public id: EntityId;
    public templateId: string;
    public type: 'ACTOR' | 'PROP' | 'PROJECTILE';
    public transform: Transform;
    public physics: PhysicsBody;
    public resources: ResourcePool;
    public activeEffects: AppliedEffect[];
    public currentActionContext?: Entity['currentActionContext'];

    constructor(params: {
        id: EntityId;
        templateId: string;
        type: 'ACTOR' | 'PROP' | 'PROJECTILE';
        transform: Transform;
        physics: PhysicsBody;
        resources: ResourcePool;
    }) {
        this.id = params.id;
        this.templateId = params.templateId;
        this.type = params.type;
        this.transform = params.transform;
        this.physics = params.physics;
        this.resources = params.resources;
        this.activeEffects = [];
    }

    /** 获取当前资源值 */
    public getResource(key: string): number {
        return this.resources.current[key] ?? 0;
    }

    /** 设置资源值（钳制在 0~max 范围内） */
    public setResource(key: string, value: number): void {
        const maxVal = this.resources.max[key] ?? value;
        this.resources.current[key] = Math.max(0, Math.min(maxVal, value));
    }

    /** 修改资源值（正数=增加，负数=减少） */
    public modifyResource(key: string, delta: number): number {
        const current = this.getResource(key);
        const newVal = current + delta;
        this.setResource(key, newVal);
        return this.getResource(key);
    }

    /** 检查是否拥有足够的资源 */
    public hasResource(key: string, amount: number): boolean {
        return this.getResource(key) >= amount;
    }

    /** 检查是否存活 */
    public isAlive(): boolean {
        return (this.resources.current['hp'] ?? 0) > 0;
    }

    /** 获取当前动作阶段 */
    public getCurrentPhase(): string | undefined {
        return this.currentActionContext?.phase;
    }

    /** 是否在前摇阶段 */
    public isInStartup(): boolean {
        return this.currentActionContext?.phase === 'STARTUP';
    }

    /** 是否在收招阶段 */
    public isInRecovery(): boolean {
        return this.currentActionContext?.phase === 'RECOVERY';
    }

    /** 是否正在执行动作 */
    public isBusy(): boolean {
        return this.currentActionContext !== undefined;
    }

    /** 清除动作上下文 */
    public clearActionContext(): void {
        this.currentActionContext = undefined;
    }
}
