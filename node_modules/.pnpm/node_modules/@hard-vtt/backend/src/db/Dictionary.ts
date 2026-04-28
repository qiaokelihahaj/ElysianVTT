// packages/backend/src/db/Dictionary.ts
import { ActionTemplate } from '@hard-vtt/shared';

/**
 * 模拟内存数据库/JSON加载器
 * 在正式环境中，这会在服务器启动时从 Prisma(SQLite) 或 JSON 文件中加载
 */
export class Dictionary {
    private static actions = new Map<string, ActionTemplate>();

    public static initMockData() {
        // 注册一个“重击”技能
        this.actions.set('HEAVY_STRIKE', {
            id: 'HEAVY_STRIKE',
            timeCost: { startupTicks: 10, recoveryTicks: 5 },
            effects: [
                {
                    type: 'DAMAGE',
                    targetSelector: 'PRIMARY',
                    parameters: {
                        resource: 'hp',
                        amountExpr: 'actor.str + 2d6' // 力量+2d6的伤害
                    }
                },
                {
                    type: 'DAMAGE', // 同时削减架势槽(专注值)
                    targetSelector: 'PRIMARY',
                    parameters: {
                        resource: 'poise',
                        amountExpr: '5' // 固定5点
                    }
                }
            ]
        });

        // 注册一个“治疗术”技能
        this.actions.set('HEAL_SPELL', {
            id: 'HEAL_SPELL',
            timeCost: { startupTicks: 15, recoveryTicks: 10 },
            effects: [
                {
                    type: 'HEAL',
                    targetSelector: 'PRIMARY', // 也可以对自己释放
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