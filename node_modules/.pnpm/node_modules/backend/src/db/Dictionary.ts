// packages/backend/src/db/Dictionary.ts
import { ActionTemplate } from '@hard-vtt/shared';
import { prisma } from './prisma.js';

/**
 * 模拟内存数据库/JSON加载器
 * 在正式环境中，这会在服务器启动时从 Prisma(SQLite) 或 JSON 文件中加载
 */
export class Dictionary {
    private static actions = new Map<string, ActionTemplate>();

    // packages/backend/src/db/Dictionary.ts

    public static async loadAllFromDb() {
        const templates = await prisma.actionTemplate.findMany();

        for (const t of templates) {
            this.actions.set(t.id, {
                id: t.id,
                timeCost: {
                    startupTicks: t.startupTicks,
                    recoveryTicks: t.recoveryTicks
                },
                effects: JSON.parse(t.effectsJson),

                // 因为我们在 schema 里将它们设为可选字段(String?)，所以加上回退保护
                tags: t.tagsJson ? JSON.parse(t.tagsJson) : [],
                resourceCost: t.resourceCostJson ? JSON.parse(t.resourceCostJson) : {},
                range: t.rangeJson ? JSON.parse(t.rangeJson) : { type: 'MELEE', distanceExpr: '1' }
            });
        }
        console.log(`📚 成功从数据库加载 ${this.actions.size} 个技能模板.`);
    }

    public static getAction(id: string): ActionTemplate | undefined {
        return this.actions.get(id);
    }
}