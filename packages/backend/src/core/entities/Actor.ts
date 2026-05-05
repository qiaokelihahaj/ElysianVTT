import { BaseEntity } from './BaseEntity.js';
import type { ResourcePool, Transform, PhysicsBody } from '@hard-vtt/shared';

/**
 * 角色实体类
 * 代表战斗/探索中的可控角色，关联规则包、资源管理和状态机
 */
export class Actor extends BaseEntity {
    public rulePackId?: string;

    constructor(params: {
        id: string;
        templateId: string;
        transform: Transform;
        physics: PhysicsBody;
        resources: ResourcePool;
        rulePackId?: string;
    }) {
        super({
            ...params,
            type: 'ACTOR'
        });
        this.rulePackId = params.rulePackId;
    }

    /** 消耗资源（返回是否成功） */
    public spendResource(key: string, amount: number): boolean {
        if (!this.hasResource(key, amount)) return false;
        this.modifyResource(key, -amount);
        return true;
    }

    /** 恢复资源 */
    public restoreResource(key: string, amount: number): void {
        this.modifyResource(key, Math.abs(amount));
    }

    /** 设置关联规则包 */
    public setRulePack(rulePackId: string): void {
        this.rulePackId = rulePackId;
    }
}
