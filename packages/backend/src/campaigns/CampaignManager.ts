// packages/backend/src/campaigns/CampaignManager.ts
import { CombatEngine } from './engines/CombatEngine.js';
import { CharacterSheetRepository } from '../db/CharacterSheetRepository.js';
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

    async getOrCreateEngine(sceneId: string): Promise<CombatEngine> {
        const scene = this.getOrCreateScene(sceneId);

        if (scene.currentState === SceneState.ACTIVE && scene.activeCombatEngine) {
            return scene.activeCombatEngine;
        }

        await scene.startLoading();

        const newEngine = new CombatEngine(sceneId);

        const entitiesToMount = await CharacterSheetRepository.findBySceneId(sceneId);

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

    async getEngine(sceneId: string): Promise<CombatEngine | undefined> {
        const scene = this.getScene(sceneId);
        return scene?.activeCombatEngine ?? undefined;
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
