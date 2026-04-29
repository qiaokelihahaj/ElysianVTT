"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CampaignManager = void 0;
const CombatEngine_js_1 = require("./engines/CombatEngine.js");
const prisma_js_1 = require("../db/prisma.js");
const SafeJsonParser_js_1 = require("../utils/SafeJsonParser.js");
class CampaignManager {
    // 内存中保存所有正在运行的场景/战斗引擎 (Key: sceneId)
    engines = new Map();
    io;
    constructor(io) {
        this.io = io;
    }
    /**
     * 获取或创建一个场景的战斗引擎
     */
    async getOrCreateEngine(sceneId) {
        if (this.engines.has(sceneId)) {
            return this.engines.get(sceneId);
        }
        const enginePromise = this.createEngine(sceneId);
        this.engines.set(sceneId, enginePromise);
        return enginePromise;
    }
    async createEngine(sceneId) {
        const newEngine = new CombatEngine_js_1.CombatEngine(sceneId);
        // --- 从数据库拉取参战实体 ---
        const sheets = await prisma_js_1.prisma.characterSheet.findMany({
            where: { currentSceneId: sceneId } // 👈 谁在这个房间就拉谁！
        });
        const DEFAULT_RESOURCES = { current: {}, max: {} };
        const DEFAULT_TRANSFORM = { coords: { x: 0, y: 0, z: 0 }, planeId: sceneId, facing: 0 };
        const DEFAULT_PHYSICS = { scaleClass: 1, collisionRadius: 0.5, mass: 50, movementModes: ['WALK'] };
        const entitiesToMount = sheets.map(sheet => {
            return {
                id: sheet.id,
                templateId: sheet.id,
                type: sheet.type,
                resources: (0, SafeJsonParser_js_1.safeParse)(sheet.resourcesJson, DEFAULT_RESOURCES, `resourcesJson of ${sheet.id}`),
                transform: (0, SafeJsonParser_js_1.safeParse)(sheet.transformJson, DEFAULT_TRANSFORM, `transformJson of ${sheet.id}`),
                physics: (0, SafeJsonParser_js_1.safeParse)(sheet.physicsJson, DEFAULT_PHYSICS, `physicsJson of ${sheet.id}`),
                activeEffects: []
            };
        });
        if (entitiesToMount.length > 0) {
            newEngine.mountEntities(entitiesToMount);
            console.log(`[CampaignManager] 成功为场景 ${sceneId} 注水 ${entitiesToMount.length} 个实体`);
        }
        else {
            console.log(`[CampaignManager] 场景 ${sceneId} 目前为空`);
        }
        newEngine.on('STATE_MUTATED', (payload) => {
            this.io.to(sceneId).emit('STATE_MUTATED', payload);
        });
        return newEngine;
    }
    async getEngine(sceneId) {
        const engine = this.engines.get(sceneId);
        return engine ? await engine : undefined;
    }
}
exports.CampaignManager = CampaignManager;
//# sourceMappingURL=CampaignManager.js.map