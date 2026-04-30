import { Socket } from 'socket.io';
import { ClientIntent } from '@hard-vtt/shared';
import { CampaignManager } from '../campaigns/CampaignManager.js';
import { Logger } from '../utils/Logger.js';

const logger = Logger.create('Network:IntentRouter');

export class IntentRouter {
    private campaignManager: CampaignManager;

    constructor(campaignManager: CampaignManager) {
        this.campaignManager = campaignManager;
    }

    async routeIntent(socket: Socket, intent: ClientIntent): Promise<void> {
        const sceneId = (socket as any).currentSceneId;

        if (!sceneId) {
            logger.warn(`Intent dropped: Socket ${socket.id} has not joined any scene`);
            socket.emit('ERROR', { code: 'NOT_IN_SCENE', message: '尚未加入任何场景' });
            return;
        }

        const engine = await this.campaignManager.getEngine(sceneId);

        if (!engine) {
            logger.warn(`Invalid intent route: Scene ${sceneId} not found or inactive`, null, { sceneId });
            socket.emit('ERROR', { code: 'ENGINE_NOT_FOUND', message: '目标引擎未启动' });
            return;
        }

        const validationError = this.validateIntent(intent);
        if (validationError) {
            logger.warn(`Intent validation failed`, { error: validationError, sceneId });
            socket.emit('ERROR', { code: 'INVALID_INTENT', message: validationError });
            return;
        }

        logger.debug(`Routed intent to scene ${sceneId} | Type: ${intent.intentType} | Actor: ${intent.actorId}`, intent, { sceneId });
        engine.receiveIntent(intent);
    }

    private validateIntent(intent: ClientIntent): string | null {
        if (!intent.actorId) return 'actorId is required';
        if (!intent.intentType) return 'intentType is required';

        switch (intent.intentType) {
            case 'CAST_ACTION':
                if (!intent.payload?.actionTemplateId) return 'actionTemplateId is required for CAST_ACTION';
                break;
            case 'MOVE':
                if (!intent.payload?.targetCoords) return 'targetCoords is required for MOVE';
                break;
            case 'INTERACT':
                if (!intent.payload?.targetIds || intent.payload.targetIds.length === 0) {
                    return 'targetIds is required for INTERACT';
                }
                break;
            default:
                return `Unknown intent type: ${intent.intentType}`;
        }

        return null;
    }
}
