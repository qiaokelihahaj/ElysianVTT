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
    private static actionsByPack = new Map<string, Map<string, ActionTemplate>>();

    private static actionTemplateFromDbRow(t: any): ActionTemplate {
        return {
            id: t.id,
            timeCost: {
                startupTicks: t.startupTicks,
                recoveryTicks: t.recoveryTicks
            },
            effects: safeParseArray(t.effectsJson, [], `effectsJson of ${t.id}`),
            tags:         safeParseArray(t.tagsJson ?? '', [], `tagsJson of ${t.id}`),
            resourceCost: safeParseRecord(t.resourceCostJson ?? '', {}, `resourceCostJson of ${t.id}`),
            range:        safeParse(t.rangeJson ?? '', { type: 'MELEE', distanceExpr: '1' }, `rangeJson of ${t.id}`),
            priorityExpr: t.priorityExpr ?? undefined,
            sustainResources: safeParseArray(t.sustainResourcesJson ?? '[]', [], `sustainResourcesJson of ${t.id}`),
            channelOptions: safeParse(t.channelOptionsJson ?? '', undefined, `channelOptionsJson of ${t.id}`),
            diceRules:    safeParseArray('[]', [], 'diceRules') as any,
            rulePackId: t.rulePackId ?? undefined,
        };
    }

    // packages/backend/src/db/Dictionary.ts

    public static async loadAllFromDb() {
        const templates = await prisma.actionTemplate.findMany();

        for (const t of templates) {
            this.actions.set(t.id, this.actionTemplateFromDbRow(t));
        }
        logger.info(`📚 成功从数据库加载 ${this.actions.size} 个技能模板.`);
    }

    public static async loadByRulePackId(rulePackId: string): Promise<Map<string, ActionTemplate>> {
        const templates = await prisma.actionTemplate.findMany({
            where: { rulePackId }
        });

        const map = new Map<string, ActionTemplate>();
        for (const t of templates) {
            const template = this.actionTemplateFromDbRow(t);
            map.set(t.id, template);
        }

        this.actionsByPack.set(rulePackId, map);
        logger.info(`📚 从 RulePack '${rulePackId}' 加载 ${map.size} 个技能模板.`);
        return map;
    }

    public static getAction(id: string): ActionTemplate | undefined {
        return this.actions.get(id);
    }

    public static getActionsByPack(rulePackId: string): Map<string, ActionTemplate> | undefined {
        return this.actionsByPack.get(rulePackId);
    }
}