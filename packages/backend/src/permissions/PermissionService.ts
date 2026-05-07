import type { ClientIntent } from '@hard-vtt/shared';

export type SubjectRole = 'GM' | 'PL' | 'OB';

export type Capability =
    | 'join_scene'
    | 'move_own_pc'
    | 'cast_action'
    | 'interact'
    | 'read_own_log'
    | 'read_observation_log'
    | 'control_entity'
    | 'manage_permissions'
    | 'override_dice'
    | 'read_audit_log';

export interface PermissionSubject {
    userId: string;
    role: SubjectRole;
    sessionId: string;
    controlledEntityIds: string[];
    visibleEntityIds: string[];
    allowedSceneIds: string[];
    permissionSnapshotVersion: number;
    expiresAt?: number;
}

export interface PermissionSnapshot {
    sessionId: string;
    userId: string;
    role: SubjectRole;
    version: number;
    controllableEntities: string[];
    visibleEntities: string[];
    capabilities: Capability[];
    currentSceneIds: string[];
    issuedAt: number;
    expiresAt?: number;
    refreshedAt: number;
}

export interface AuthorizationResult {
    allowed: boolean;
    code?: string;
    message?: string;
    snapshot: PermissionSnapshot;
}

export interface JoinSubjectInput {
    sessionId: string;
    userId: string;
    role?: SubjectRole;
    controlledEntityIds?: string[];
    visibleEntityIds?: string[];
    allowedSceneIds?: string[];
    permissionSnapshotVersion?: number;
    expiresAt?: number;
}

const ALL_CAPABILITIES: Capability[] = [
    'join_scene',
    'move_own_pc',
    'cast_action',
    'interact',
    'read_own_log',
    'read_observation_log',
    'control_entity',
    'manage_permissions',
    'override_dice',
    'read_audit_log'
];

const PLAYER_CAPABILITIES: Capability[] = [
    'join_scene',
    'move_own_pc',
    'cast_action',
    'interact',
    'read_own_log'
];

const OBSERVER_CAPABILITIES: Capability[] = [
    'join_scene',
    'read_observation_log'
];

export class PermissionService {
    static createSubject(input: JoinSubjectInput): PermissionSubject {
        return {
            userId: input.userId,
            role: input.role ?? 'PL',
            sessionId: input.sessionId,
            controlledEntityIds: [...(input.controlledEntityIds ?? [])],
            visibleEntityIds: [...(input.visibleEntityIds ?? input.controlledEntityIds ?? [])],
            allowedSceneIds: [...(input.allowedSceneIds ?? [])],
            permissionSnapshotVersion: input.permissionSnapshotVersion ?? 1,
            expiresAt: input.expiresAt
        };
    }

    static createLegacyJoinSubject(sceneId: string, sessionId: string, actorId: string): PermissionSubject {
        const role: SubjectRole = actorId === 'guest' ? 'OB' : 'PL';

        return this.createSubject({
            sessionId,
            userId: actorId,
            role,
            controlledEntityIds: actorId === 'guest' ? [] : [actorId],
            visibleEntityIds: actorId === 'guest' ? [] : [actorId],
            allowedSceneIds: [sceneId]
        });
    }

    static buildSnapshot(subject: PermissionSubject, currentSceneId?: string): PermissionSnapshot {
        const now = Date.now();

        return {
            sessionId: subject.sessionId,
            userId: subject.userId,
            role: subject.role,
            version: subject.permissionSnapshotVersion,
            controllableEntities: [...subject.controlledEntityIds],
            visibleEntities: [...subject.visibleEntityIds],
            capabilities: this.getCapabilities(subject),
            currentSceneIds: currentSceneId ? [currentSceneId] : [...subject.allowedSceneIds],
            issuedAt: now,
            expiresAt: subject.expiresAt,
            refreshedAt: now
        };
    }

    static canJoinScene(subject: PermissionSubject, sceneId: string): boolean {
        if (subject.role === 'GM') return true;
        return subject.allowedSceneIds.includes(sceneId);
    }

    static authorizeJoinScene(subject: PermissionSubject, sceneId: string): AuthorizationResult {
        const snapshot = this.buildSnapshot(subject, sceneId);

        if (this.canJoinScene(subject, sceneId)) {
            return { allowed: true, snapshot };
        }

        return {
            allowed: false,
            code: 'NOT_IN_SCENE',
            message: '当前主体没有进入该场景的权限',
            snapshot
        };
    }

    static authorizeIntent(subject: PermissionSubject, sceneId: string, intent: ClientIntent): AuthorizationResult {
        const snapshot = this.buildSnapshot(subject, sceneId);

        if (subject.role !== 'GM' && !subject.allowedSceneIds.includes(sceneId)) {
            return {
                allowed: false,
                code: 'NOT_IN_SCENE',
                message: '尚未进入当前场景',
                snapshot
            };
        }

        if (subject.role !== 'GM' && !subject.controlledEntityIds.includes(intent.actorId) && !this.hasCapability(subject, 'control_entity')) {
            return {
                allowed: false,
                code: 'UNAUTHORIZED',
                message: '当前主体不能控制该实体',
                snapshot
            };
        }

        switch (intent.intentType) {
            case 'MOVE':
                if (!this.hasCapability(subject, 'move_own_pc')) {
                    return this.reject('UNAUTHORIZED', '当前主体没有移动权限', snapshot);
                }
                break;
            case 'CAST_ACTION':
                if (!this.hasCapability(subject, 'cast_action')) {
                    return this.reject('UNAUTHORIZED', '当前主体没有施法权限', snapshot);
                }
                break;
            case 'BATCH_CAST':
                // 批量施法仅 GM 可用（测试/调试功能）
                if (subject.role !== 'GM') {
                    return this.reject('UNAUTHORIZED', '批量施法仅 GM 可用', snapshot);
                }
                break;
            case 'INTERACT':
                if (!this.hasCapability(subject, 'interact')) {
                    return this.reject('UNAUTHORIZED', '当前主体没有交互权限', snapshot);
                }
                break;
            case 'CANCEL_ACTION':
            case 'DEFEND':
            case 'DODGE':
            case 'REACTION':
            case 'MICRO_EVADE':
            case 'PRIORITY_TOGGLE':
            case 'HOOK_PRESET':
                // 这些类型的意图仅需 entity 控制权检查（已在上面完成）
                break;
            default:
                return this.reject('INVALID_INTENT', `Unknown intent type: ${intent.intentType}`, snapshot);
        }

        return { allowed: true, snapshot };
    }

    static hasCapability(subject: PermissionSubject, capability: Capability): boolean {
        if (subject.role === 'GM') return true;
        return this.getCapabilities(subject).includes(capability);
    }

    private static getCapabilities(subject: PermissionSubject): Capability[] {
        if (subject.role === 'GM') return [...ALL_CAPABILITIES];

        const baseCapabilities = subject.role === 'OB' ? OBSERVER_CAPABILITIES : PLAYER_CAPABILITIES;

        // 注意：'control_entity' 能力不应通过 controlledEntityIds 自动添加
        // 它应该仅通过显式的权限授予（如临时授权）才能获得
        // PL 的 controlledEntityIds 确定了它可以直接控制的实体列表
        // 而不是 'control_entity' 能力

        return [...baseCapabilities];
    }

    private static reject(code: string, message: string, snapshot: PermissionSnapshot): AuthorizationResult {
        return {
            allowed: false,
            code,
            message,
            snapshot
        };
    }
}