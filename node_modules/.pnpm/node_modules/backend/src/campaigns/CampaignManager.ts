// packages/backend/src/campaigns/CampaignManager.ts
import { Server } from 'socket.io';
import { CombatEngine } from './engines/CombatEngine.js';
import { prisma } from '../db/prisma.js';
import { Entity } from '@hard-vtt/shared';

export class CampaignManager {
    // 内存中保存所有正在运行的场景/战斗引擎 (Key: sceneId)
    private engines = new Map<string, Promise<CombatEngine>>();
    private io: Server;

    constructor(io: Server) {
        this.io = io;
    }

    /**
     * 获取或创建一个场景的战斗引擎
     */
    public async getOrCreateEngine(sceneId: string): Promise<CombatEngine> {
        if (this.engines.has(sceneId)) {
            return this.engines.get(sceneId)!;
        }

        const enginePromise = this.createEngine(sceneId);
        this.engines.set(sceneId, enginePromise);

        return enginePromise;
    }

    private async createEngine(sceneId: string): Promise<CombatEngine> {
        const newEngine = new CombatEngine(sceneId);

        // --- 从数据库拉取参战实体 ---
        const sheets = await prisma.characterSheet.findMany({
            where: { currentSceneId: sceneId } // 👈 谁在这个房间就拉谁！
        });

        const entitiesToMount: Entity[] = sheets.map(sheet => {
            return {
                id: sheet.id,
                templateId: sheet.id,
                type: sheet.type as 'ACTOR' | 'PROP' | 'PROJECTILE',
                resources: JSON.parse(sheet.resourcesJson),
                transform: JSON.parse(sheet.transformJson), // 👈 直接解析数据库里的坐标
                physics: JSON.parse(sheet.physicsJson),     // 👈 直接解析数据库里的物理
                activeEffects: []
            };
        });

        if (entitiesToMount.length > 0) {
            newEngine.mountEntities(entitiesToMount);
            console.log(`[CampaignManager] 成功为场景 ${sceneId} 注水 ${entitiesToMount.length} 个实体`);
        } else {
            console.log(`[CampaignManager] 场景 ${sceneId} 目前为空`);
        }

        newEngine.on('STATE_MUTATED', (payload) => {
            this.io.to(sceneId).emit('STATE_MUTATED', payload);
        });

        return newEngine;
    }

    public async getEngine(sceneId: string): Promise<CombatEngine | undefined> {
        const engine = this.engines.get(sceneId);
        return engine ? await engine : undefined;
    }
}