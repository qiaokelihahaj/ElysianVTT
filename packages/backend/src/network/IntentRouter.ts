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

        logger.debug(`Authorization check for ${intent.intentType}@${intent.actorId}`, {
            subjectRole: subject.role,
            subjectControlled: subject.controlledEntityIds,
            sceneId,
            actorId: intent.actorId,
            intentType: intent.intentType
        });

        const authorization = PermissionService.authorizeIntent(subject, sceneId, intent);
        if (!authorization.allowed) {
            logger.warn(`Intent authorization failed`, {
                sceneId,
                actorId: intent.actorId,
                intentType: intent.intentType,
                code: authorization.code,
                message: authorization.message,
                subjectRole: subject.role,
                subjectControlled: subject.controlledEntityIds
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
        if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return 'intent must be an object';
        if (typeof intent.actorId !== 'string' || !intent.actorId) return 'actorId is required';
        if (typeof intent.intentType !== 'string' || !intent.intentType) return 'intentType is required';
        if (!intent.payload || typeof intent.payload !== 'object' || Array.isArray(intent.payload)) return 'payload must be an object';
        if (intent.payload.targetCoords !== undefined && !this.isVector(intent.payload.targetCoords)) return 'targetCoords must contain finite x, y and z';
        if (intent.payload.targetIds !== undefined && (!Array.isArray(intent.payload.targetIds) || intent.payload.targetIds.some(id => typeof id !== 'string' || !id))) return 'targetIds must contain entity IDs';

        switch (intent.intentType) {
            case 'BATCH_CAST':
                if (!Array.isArray(intent.payload.batchIntents) || intent.payload.batchIntents.length === 0) {
                    return 'batchIntents is required for BATCH_CAST';
                }
                for (const bi of intent.payload.batchIntents) {
                    if (!bi || typeof bi !== 'object' || typeof bi.actorId !== 'string' || !bi.actorId) return 'actorId is required in each batch intent';
                    if (typeof bi.actionTemplateId !== 'string' || !bi.actionTemplateId) return 'actionTemplateId is required in each batch intent';
                    if (bi.targetIds !== undefined && (!Array.isArray(bi.targetIds) || bi.targetIds.some(id => typeof id !== 'string' || !id))) return 'targetIds must contain entity IDs in each batch intent';
                }
                break;
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
            case 'CANCEL_ACTION':
                break;
            case 'DEFEND':
                break;
            case 'DODGE':
                if (!intent.payload?.targetCoords) return 'targetCoords is required for DODGE';
                break;
            case 'REACTION':
                if (!intent.payload?.actionTemplateId) return 'actionTemplateId is required for REACTION';
                if (!intent.payload?.reactionTargetId) return 'reactionTargetId is required for REACTION';
                break;
            case 'MICRO_EVADE':
                if (!intent.payload?.evadeSubType) return 'evadeSubType is required for MICRO_EVADE';
                if (!['DUCK','HOP','SLIP'].includes(intent.payload.evadeSubType)) return 'evadeSubType must be DUCK, HOP, or SLIP';
                break;
            case 'PRIORITY_TOGGLE':
                if (!intent.payload?.toggleMode) return 'toggleMode is required for PRIORITY_TOGGLE';
                if (!['PASS_ALL', 'TARGET_ONLY', 'FULL_CONTROL'].includes(intent.payload.toggleMode)) return 'toggleMode must be PASS_ALL, TARGET_ONLY, or FULL_CONTROL';
                break;
            case 'CHANGE_STANCE':
                if (!['ADS', 'BLIND_FIRE', 'NONE'].includes(intent.payload.stance ?? '')) return 'stance must be ADS, BLIND_FIRE, or NONE';
                break;
            case 'ROTATE':
                if (typeof intent.payload.rotationDelta !== 'number' || !Number.isFinite(intent.payload.rotationDelta)) return 'rotationDelta must be a finite number';
                break;
            case 'HOOK_PRESET':
                if (!intent.payload?.hookPreset) return 'hookPreset is required for HOOK_PRESET';
                const preset = intent.payload.hookPreset;
                if (!preset.trigger || !preset.trigger.type) return 'hookPreset trigger type is required';
                const trigger = preset.trigger;
                switch (trigger.type) {
                    case 'TICK_REACHED':
                        if (!Number.isSafeInteger(trigger.targetTick) || trigger.targetTick < 0) return 'TICK_REACHED requires a non-negative integer targetTick';
                        break;
                    case 'ENEMY_ENTERS_RANGE':
                        if (typeof trigger.range !== 'number' || !Number.isFinite(trigger.range) || trigger.range < 0) return 'ENEMY_ENTERS_RANGE requires a non-negative finite range';
                        break;
                    case 'ENTITY_MOVES_TO':
                        if (!trigger.targetHex || !Number.isSafeInteger(trigger.targetHex.q) || !Number.isSafeInteger(trigger.targetHex.r))
                            return 'ENTITY_MOVES_TO requires targetHex with q and r (numbers)';
                        break;
                    case 'ENTITY_ENTERS_AREA':
                        if (!this.isVector(trigger.center) || !Number.isFinite(trigger.radius) || trigger.radius < 0) return 'ENTITY_ENTERS_AREA requires a finite center and non-negative radius';
                        break;
                    case 'ACTION_PHASE_DELAY':
                        if (typeof trigger.sourceEntityId !== 'string' || !trigger.sourceEntityId || typeof trigger.actionTemplateId !== 'string' || !trigger.actionTemplateId || !Number.isSafeInteger(trigger.delayTicks) || trigger.delayTicks < 0) return 'ACTION_PHASE_DELAY requires sourceEntityId, actionTemplateId and non-negative integer delayTicks';
                        break;
                    case 'ENEMY_CASTS_SPELL':
                        if (trigger.sourceFilter !== undefined && typeof trigger.sourceFilter !== 'string') return 'sourceFilter must be a string';
                        break;
                    default:
                        return 'Unknown hook trigger type';
                }
                break;
            default:
                return `Unknown intent type: ${intent.intentType}`;
        }

        return null;
    }

    private isVector(value: unknown): boolean {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const vector = value as Record<string, unknown>;
        return [vector.x, vector.y, vector.z].every(component => typeof component === 'number' && Number.isFinite(component));
    }
}
