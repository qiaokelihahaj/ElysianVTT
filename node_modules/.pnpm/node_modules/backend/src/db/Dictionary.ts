// packages/backend/src/db/Dictionary.ts
import { ActionTemplate } from '@hard-vtt/shared';
import { prisma } from './prisma.js';
import { safeParse, safeParseArray, safeParseRecord } from '../utils/SafeJsonParser.js';
import { Logger } from '../utils/Logger.js';

const logger = Logger.create('DB:Dictionary');

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
                effects: safeParseArray(t.effectsJson, [], `effectsJson of ${t.id}`),

                // 使用安全解析，在数据缺失或损坏时提供默认值
                tags:         safeParseArray(t.tagsJson ?? '', [], `tagsJson of ${t.id}`),
                resourceCost: safeParseRecord(t.resourceCostJson ?? '', {}, `resourceCostJson of ${t.id}`),
                range:        safeParse(t.rangeJson ?? '', { type: 'MELEE', distanceExpr: '1' }, `rangeJson of ${t.id}`)
            });
        }
        logger.info(`📚 成功从数据库加载 ${this.actions.size} 个技能模板.`);
    }

    public static getAction(id: string): ActionTemplate | undefined {
        return this.actions.get(id);
    }
}