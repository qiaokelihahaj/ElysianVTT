import { Socket } from 'socket.io';
import { ClientIntent } from '@hard-vtt/shared';
import { CampaignManager } from '../campaigns/CampaignManager.js';
import { Logger } from '../utils/Logger.js';
import { PermissionService, type PermissionSubject, type PermissionSnapshot } from '../permissions/PermissionService.js';
import { PermissionSnapshotRepository } from '../db/PermissionSnapshotRepository.js';

const logger = Logger.create('Network:IntentRouter');

interface SocketSessionState {
    currentSceneId?: string;
    permissionSubject?: PermissionSubject;
    sessionId?: string;
    permissionSnapshot?: PermissionSnapshot;
    authenticated: boolean;
}

export class IntentRouter {
    private campaignManager: CampaignManager;

    constructor(campaignManager: CampaignManager) {
        this.campaignManager = campaignManager;
    }

    async routeIntent(socket: Socket, intent: ClientIntent): Promise<void> {
        const socketState = socket.data as SocketSessionState;
        const sceneId = socketState.currentSceneId;

        if (!socketState.authenticated) {
            logger.warn(`Intent dropped: Socket ${socket.id} not authenticated`);
            socket.emit('ERROR', { code: 'UNAUTHENTICATED', message: '请先认证' });
            return;
        }

        if (!sceneId) {
            logger.warn(`Intent dropped: Socket ${socket.id} has not joined any scene`);
            socket.emit('ERROR', { code: 'NOT_IN_SCENE', message: '尚未加入任何场景' });
            return;
        }

        let snapshot = socketState.permissionSnapshot;

        if (!snapshot && socketState.sessionId) {
            snapshot = await PermissionSnapshotRepository.getLatestSnapshot(socketState.sessionId);
            if (snapshot) {
                socketState.permissionSnapshot = snapshot;
            }
        }

        if (!snapshot) {
            logger.warn(`Intent dropped: Socket ${socket.id} has no permission snapshot`, null, { sceneId });
            socket.emit('ERROR', { code: 'UNAUTHENTICATED', message: '权限快照已失效，请重新认证' });
            return;
        }

        const subject = socketState.permissionSubject;
        if (!subject) {
            logger.warn(`Intent dropped: Socket ${socket.id} has no permission subject`, null, { sceneId });
            socket.emit('ERROR', { code: 'UNAUTHENTICATED', message: '尚未建立权限上下文' });
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

        const authorization = PermissionService.authorizeIntent(subject, sceneId, intent);
        if (!authorization.allowed) {
            logger.warn(`Intent authorization failed`, {
                sceneId,
                actorId: intent.actorId,
                intentType: intent.intentType,
                code: authorization.code,
                message: authorization.message
            });
            socket.emit('ERROR', {
                code: authorization.code ?? 'UNAUTHORIZED',
                message: authorization.message ?? '无权限执行该意图'
            });
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
