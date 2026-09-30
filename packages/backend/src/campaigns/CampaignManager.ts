// packages/backend/src/campaigns/CampaignManager.ts
import type { IEngineInstance } from '@hard-vtt/shared';
import { CombatEngine } from './engines/CombatEngine.js';
import { ExploreEngine } from './engines/ExploreEngine.js';
import { CharacterSheetRepository } from '../db/CharacterSheetRepository.js';
import { testArenaMap } from '../db/maps/test_arena.js';
import { Scene, SceneState } from './Scene.js';
import { StateBroadcaster } from '../network/StateBroadcaster.js';
import { Logger } from '../utils/Logger.js';
import type { Server } from 'socket.io';

const logger = Logger.create('CampaignManager');

export class CampaignManager {
    private scenes = new Map<string, Scene>();
    private broadcaster: StateBroadcaster;

    constructor(io: Server) {
        this.broadcaster = new StateBroadcaster(io);
    }

    getOrCreateScene(sceneId: string): Scene {
        let scene = this.scenes.get(sceneId);
        if (!scene || scene.currentState === SceneState.DESTROYED) {
            scene = new Scene(sceneId);
            this.scenes.set(sceneId, scene);
            this.wireSceneEvents(scene);
            logger.info(`Scene ${sceneId} registered`, { sceneId });
        }
        return scene;
    }

    async getOrCreateEngine(sceneId: string): Promise<IEngineInstance> {
        const scene = this.getOrCreateScene(sceneId);

        if ((scene.currentState === SceneState.ACTIVE || scene.currentState === SceneState.PAUSED) && scene.activeEngine) {
            return scene.activeEngine;
        }

        await scene.startLoading();

        const isExplore = sceneId.startsWith('explore_');
        const newEngine: IEngineInstance = isExplore
            ? new ExploreEngine(sceneId)
            : new CombatEngine(sceneId);

        // 探索模式：先加载地图数据（FOW 初始化需要地图）
        if (isExplore && newEngine instanceof ExploreEngine) {
            newEngine.loadMap(testArenaMap);
            logger.info(`Map '${testArenaMap.name}' loaded for explore scene ${sceneId}`, null, { sceneId });
        }

        // 探索模式加载所有角色卡（方便测试），战斗模式按场景过滤
        const entitiesToMount = isExplore
            ? await CharacterSheetRepository.findAll()
            : await CharacterSheetRepository.findBySceneId(sceneId);

        if (entitiesToMount.length > 0) {
            newEngine.mountEntities(entitiesToMount);
            logger.info(`Successfully hydrated ${entitiesToMount.length} entities into scene ${sceneId}`, null, { sceneId });
        } else {
            logger.info(`Scene ${sceneId} is currently empty`, null, { sceneId });
        }

        this.broadcaster.wireEngine(newEngine, sceneId);

        await scene.activate(newEngine);

        return newEngine;
    }

    getScene(sceneId: string): Scene | undefined {
        const scene = this.scenes.get(sceneId);
        if (scene && scene.currentState === SceneState.DESTROYED) return undefined;
        return scene;
    }

    async getEngine(sceneId: string): Promise<IEngineInstance | undefined> {
        const scene = this.getScene(sceneId);
        return scene?.activeEngine ?? undefined;
    }

    async destroyScene(sceneId: string): Promise<void> {
        const scene = this.scenes.get(sceneId);
        if (!scene) return;

        await scene.destroy();
        this.scenes.delete(sceneId);
        CharacterSheetRepository.invalidateScene(sceneId);
        logger.info(`Scene ${sceneId} removed from manager`, { sceneId });
    }

    getActiveSceneCount(): number {
        let count = 0;
        for (const scene of this.scenes.values()) {
            if (scene.isActive()) count++;
        }
        return count;
    }

    private wireSceneEvents(scene: Scene): void {
        scene.on('scene:idle_timeout', ({ sceneId }) => {
            logger.info(`Auto-evicting idle scene ${sceneId}`, { sceneId });
            void this.destroyScene(sceneId);
        });
    }
}
