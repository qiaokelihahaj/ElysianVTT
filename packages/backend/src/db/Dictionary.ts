// packages/backend/src/db/Dictionary.ts
import type { ActionTemplate } from '@hard-vtt/shared';
import type { ActionTemplate as ActionTemplateRow } from '@prisma/client';
import { prisma } from './prisma.js';
import { safeParse, safeParseArray, safeParseRecord } from '../utils/SafeJsonParser.js';
import { Logger } from '../utils/Logger.js';
import type { ActionCatalog } from '../rules/ActionCatalog.js';
import { validateActionTemplate } from '../rules/ActionCatalog.js';

const logger = Logger.create('DB:Dictionary');

/**
 * 模拟内存数据库/JSON加载器
 * 在正式环境中，这会在服务器启动时从 Prisma(SQLite) 或 JSON 文件中加载
 */
export class Dictionary {
    private static actions = new Map<string, ActionTemplate>();
    private static actionsByPack = new Map<string, Map<string, ActionTemplate>>();
    /** Runtime/demo templates are isolated from the persistent dictionary. */
    private static runtimeActions = new Map<string, ActionTemplate>();

    private static actionTemplateFromDbRow(t: ActionTemplateRow): ActionTemplate {
        const template: ActionTemplate = {
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
            diceRules: [],
            rulePackId: t.rulePackId ?? undefined,
        };
        validateActionTemplate(template);
        return template;
    }

    // packages/backend/src/db/Dictionary.ts

    public static async loadAllFromDb() {
        const templates = await prisma.actionTemplate.findMany();

        this.actions = new Map(templates.map(t => [t.id, this.actionTemplateFromDbRow(t)]));
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
        return this.runtimeActions.get(id) ?? this.actions.get(id);
    }

    /** Register a trusted server-side template without touching Prisma. */
    public static registerAction(template: ActionTemplate): void {
        validateActionTemplate(template);
        this.runtimeActions.set(template.id, structuredClone(template));
    }

    public static registerActions(templates: ActionTemplate[]): void {
        for (const template of templates) this.registerAction(template);
    }

    public static unregisterAction(id: string): void {
        this.runtimeActions.delete(id);
    }

    public static clearRuntimeActions(): void {
        this.runtimeActions.clear();
    }

    public static getActionsByPack(rulePackId: string): Map<string, ActionTemplate> | undefined {
        return this.actionsByPack.get(rulePackId);
    }
}

/** Legacy process-wide catalog adapter for engines without explicit rules. */
export class DictionaryActionCatalog implements ActionCatalog {
    public getAction(id: string): ActionTemplate | undefined {
        return Dictionary.getAction(id);
    }
}
