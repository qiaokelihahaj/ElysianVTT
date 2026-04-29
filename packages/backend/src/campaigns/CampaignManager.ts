// packages/backend/src/campaigns/CampaignManager.ts
import { Server } from 'socket.io';
import { CombatEngine } from './engines/CombatEngine.js';
import { prisma } from '../db/prisma.js';
import { Entity } from '@hard-vtt/shared';
import { safeParse } from '../utils/SafeJsonParser.js';
import { Logger } from '../utils/Logger.js';

const logger = Logger.create('CampaignManager');

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
            try {
                return await this.engines.get(sceneId)!;
            } catch {
                this.engines.delete(sceneId);
            }
        }

        const enginePromise = this.createEngine(sceneId);
        this.engines.set(sceneId, enginePromise);

        try {
            return await enginePromise;
        } catch (error) {
            this.engines.delete(sceneId);
            throw error;
        }
    }

    private async createEngine(sceneId: string): Promise<CombatEngine> {
        const newEngine = new CombatEngine(sceneId);

        // --- 从数据库拉取参战实体 ---
        const sheets = await prisma.characterSheet.findMany({
            where: { currentSceneId: sceneId } // 👈 谁在这个房间就拉谁！
        });

        const DEFAULT_RESOURCES = { current: {}, max: {} };
        const DEFAULT_TRANSFORM = { coords: { x: 0, y: 0, z: 0 }, planeId: sceneId, facing: 0 };
        const DEFAULT_PHYSICS   = { scaleClass: 1, collisionRadius: 0.5, mass: 50, movementModes: ['WALK'] };

        const entitiesToMount: Entity[] = sheets.map(sheet => {
            return {
                id: sheet.id,
                templateId: sheet.id,
                type: sheet.type as 'ACTOR' | 'PROP' | 'PROJECTILE',
                resources: safeParse(sheet.resourcesJson, DEFAULT_RESOURCES, `resourcesJson of ${sheet.id}`),
                transform: safeParse(sheet.transformJson, DEFAULT_TRANSFORM, `transformJson of ${sheet.id}`),
                physics:   safeParse(sheet.physicsJson, DEFAULT_PHYSICS, `physicsJson of ${sheet.id}`),
                activeEffects: []
            };
        });

        if (entitiesToMount.length > 0) {
            newEngine.mountEntities(entitiesToMount);
            logger.info(`Successfully hydrated ${entitiesToMount.length} entities into scene ${sceneId}`, null, { sceneId });
        } else {
            logger.info(`Scene ${sceneId} is currently empty`, null, { sceneId });
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