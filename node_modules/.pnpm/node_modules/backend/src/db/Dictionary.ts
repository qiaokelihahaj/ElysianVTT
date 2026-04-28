// packages/backend/src/db/Dictionary.ts
import { ActionTemplate } from '@hard-vtt/shared';

/**
 * 模拟内存数据库/JSON加载器
 * 在正式环境中，这会在服务器启动时从 Prisma(SQLite) 或 JSON 文件中加载
 */
export class Dictionary {
    private static actions = new Map<string, ActionTemplate>();

    // packages/backend/src/db/Dictionary.ts

    public static initMockData() {
        // 注册一个“重击”技能
        this.actions.set('HEAVY_STRIKE', {
            id: 'HEAVY_STRIKE',
            tags: ['physical', 'attack'],
            timeCost: { startupTicks: 10, recoveryTicks: 5 },
            // 1. resourceCost 必须是对象，值必须是字符串
            resourceCost: {},
            // 2. range 必须是对象结构
            range: {
                type: 'MELEE',
                distanceExpr: '1'
            },
            effects: [
                {
                    type: 'DAMAGE',
                    targetSelector: 'PRIMARY',
                    parameters: {
                        resource: 'hp',
                        amountExpr: 'actor.str + 2d6'
                    }
                }
                // ... 其他 effect
            ]
        });

        // 注册一个“治疗术”技能
        this.actions.set('HEAL_SPELL', {
            id: 'HEAL_SPELL',
            tags: ['magic', 'heal'],
            timeCost: { startupTicks: 15, recoveryTicks: 10 },
            // 如果有消耗，值也要写成字符串（如 '10'）
            resourceCost: {
                mp: '10'
            },
            range: {
                type: 'RANGED',
                distanceExpr: '5'
            },
            effects: [
                {
                    type: 'HEAL',
                    targetSelector: 'PRIMARY',
                    parameters: {
                        resource: 'hp',
                        amountExpr: '20 + 1d8'
                    }
                }
            ]
        });
    }

    public static getAction(id: string): ActionTemplate | undefined {
        return this.actions.get(id);
    }
}