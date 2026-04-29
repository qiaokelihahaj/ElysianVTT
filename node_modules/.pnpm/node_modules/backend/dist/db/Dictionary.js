"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Dictionary = void 0;
const prisma_js_1 = require("./prisma.js");
const SafeJsonParser_js_1 = require("../utils/SafeJsonParser.js");
/**
 * 模拟内存数据库/JSON加载器
 * 在正式环境中，这会在服务器启动时从 Prisma(SQLite) 或 JSON 文件中加载
 */
class Dictionary {
    static actions = new Map();
    // packages/backend/src/db/Dictionary.ts
    static async loadAllFromDb() {
        const templates = await prisma_js_1.prisma.actionTemplate.findMany();
        for (const t of templates) {
            this.actions.set(t.id, {
                id: t.id,
                timeCost: {
                    startupTicks: t.startupTicks,
                    recoveryTicks: t.recoveryTicks
                },
                effects: (0, SafeJsonParser_js_1.safeParseArray)(t.effectsJson, [], `effectsJson of ${t.id}`),
                // 使用安全解析，在数据缺失或损坏时提供默认值
                tags: (0, SafeJsonParser_js_1.safeParseArray)(t.tagsJson ?? '', [], `tagsJson of ${t.id}`),
                resourceCost: (0, SafeJsonParser_js_1.safeParseRecord)(t.resourceCostJson ?? '', {}, `resourceCostJson of ${t.id}`),
                range: (0, SafeJsonParser_js_1.safeParse)(t.rangeJson ?? '', { type: 'MELEE', distanceExpr: '1' }, `rangeJson of ${t.id}`)
            });
        }
        console.log(`📚 成功从数据库加载 ${this.actions.size} 个技能模板.`);
    }
    static getAction(id) {
        return this.actions.get(id);
    }
}
exports.Dictionary = Dictionary;
//# sourceMappingURL=Dictionary.js.map