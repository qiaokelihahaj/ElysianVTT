// packages/backend/src/network/SocketServer.ts
import { Server, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { ClientIntent, DecisionResponsePayload } from '@hard-vtt/shared';
import { CampaignManager } from '../campaigns/CampaignManager.js';
import { IntentRouter } from './IntentRouter.js';
import { PermissionGrantRepository } from '../db/PermissionGrantRepository.js';
import { Logger } from '../utils/Logger.js';
import { PermissionService, type PermissionSubject, type PermissionSnapshot } from '../permissions/PermissionService.js';
import { AuthenticationService, type AuthToken } from '../auth/AuthenticationService.js';
import { PermissionSnapshotRepository } from '../db/PermissionSnapshotRepository.js';
import { VisibilityFilter } from './VisibilityFilter.js';
import { CombatEngine } from '../campaigns/engines/CombatEngine.js';
import { ExploreEngine } from '../campaigns/engines/ExploreEngine.js';
import type { IEngineInstance } from '@hard-vtt/shared';

const logger = Logger.create('Network:Socket');

interface SocketSessionState {
    currentSceneId?: string;
    currentActorId?: string;
    permissionSubject?: PermissionSubject;
    userId?: string;
    role?: 'GM' | 'PL' | 'OB';
    sessionId?: string;
    authToken?: AuthToken;
    permissionSnapshot?: PermissionSnapshot;
    authenticationSubject?: PermissionSubject;
    accessToken?: string;
    authenticated: boolean;
}

export class SocketServer {
    private io: Server;
    private campaignManager: CampaignManager;
    private intentRouter: IntentRouter;
    private permissionService = PermissionService;

    constructor(httpServer: HttpServer) {
        const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5173').split(',');
        
        this.io = new Server(httpServer, {
            cors: {
                origin: allowedOrigins.map(o => o.trim()),
                methods: ['GET', 'POST'],
                credentials: true,
                maxAge: 86400
            }
        });

        this.campaignManager = new CampaignManager(this.io);
        this.intentRouter = new IntentRouter(this.campaignManager);
        this.setupListeners();
    }

    /**
     * 汇总当前场景所有 socket 的权限，更新 CombatEngine 的 playerControlledEntities。
     * GM 控制所有实体，PL 控制各自的 actorId。
     */
    private async refreshPlayerControlledEntities(sceneId: string): Promise<void> {
        try {
            const engine = await this.campaignManager.getEngine(sceneId);
            if (!(engine instanceof CombatEngine)) return;
            const sockets = await this.io.in(sceneId).fetchSockets();
            const allControlled = new Set<string>();

            for (const s of sockets) {
                const data = s.data as SocketSessionState;
                if (data.role === 'GM') {
                    engine.getAllEntities().forEach(e => allControlled.add(e.id));
                } else if (data.role === 'PL' && data.currentActorId) {
                    allControlled.add(data.currentActorId);
                }
            }

            engine.setPlayerControlledEntities(Array.from(allControlled));
        } catch (error) {
            logger.warn(`refreshPlayerControlledEntities failed for scene ${sceneId}`, error);
        }
    }

    private setupListeners() {
        this.io.on('connection', (socket: Socket) => {
            logger.info(`Client connected: ${socket.id}`);
            const socketState = socket.data as SocketSessionState;
            socketState.authenticated = false;

            socket.on('AUTHENTICATE', async (data: { token: string }, callback?: (response: any) => void) => {
                try {
                    if (!data || typeof data.token !== 'string') {
                        socket.emit('AUTH_FAILED', { ok: false, code: 'AUTH_FAILED', message: '需要有效访问令牌' });
                        return;
                    }
                    const verification = AuthenticationService.verify(data.token);
                    if (!verification.valid || !verification.token) {
                        logger.warn(`Authentication failed for ${socket.id}: ${verification.error}`);
                        const response = {
                            ok: false,
                            code: 'AUTH_FAILED',
                            message: verification.error ?? '认证失败'
                        };
                        if (callback) callback(response);
                        socket.emit('AUTH_FAILED', response);
                        return;
                    }

                    const token = verification.token;
                    const activeGrants = await PermissionGrantRepository.getActiveGrantsForUser(token.userId);
                    const delegatedEntities = activeGrants
                        .filter(g => g.capability === 'control_entity' && g.scopeType === 'entity' && g.scopeId)
                        .map(g => g.scopeId!);
                    const extraCapabilities = activeGrants.map(g => g.capability as any);
                    
                    const baseControlledEntities = token.role === 'PL' ? [token.userId] : [];
                    const allowedSceneIds = Array.from(new Set(activeGrants.flatMap(grant => [
                        ...(grant.sceneId ? [grant.sceneId] : []),
                        ...(grant.capability === 'join_scene' && grant.scopeType === 'scene' && grant.scopeId ? [grant.scopeId] : []),
                    ])));

                    const authenticationSubject = PermissionService.createSubject({
                            sessionId: token.sessionId,
                            userId: token.userId,
                            role: token.role,
                            controlledEntityIds: [...baseControlledEntities, ...delegatedEntities],
                            visibleEntityIds: [...baseControlledEntities, ...delegatedEntities],
                            allowedSceneIds,
                            expiresAt: token.expiresAt,
                            permissionSnapshotVersion: 1
                        });
                    const initialSnapshot = PermissionService.buildSnapshot(authenticationSubject);
                    
                    if (extraCapabilities.length > 0) {
                        initialSnapshot.capabilities = Array.from(new Set([...initialSnapshot.capabilities, ...extraCapabilities])) as any;
                    }

                    await PermissionSnapshotRepository.createSnapshot(token.sessionId, initialSnapshot);
                    this.leaveScene(socket);
                    socketState.authenticated = true;
                    socketState.userId = token.userId;
                    socketState.role = token.role;
                    socketState.sessionId = token.sessionId;
                    socketState.authToken = token;
                    socketState.accessToken = data.token;
                    socketState.authenticationSubject = authenticationSubject;
                    socketState.permissionSnapshot = initialSnapshot;

                    const response = {
                        ok: true,
                        subject: {
                            userId: token.userId,
                            role: token.role,
                            sessionId: token.sessionId,
                            permissionSnapshotVersion: initialSnapshot.version
                        },
                        permissionSnapshot: initialSnapshot
                    };

                    logger.info(`Socket ${socket.id} authenticated as ${token.userId} (${token.role})`, {
                        socketId: socket.id,
                        userId: token.userId,
                        role: token.role
                    });

                    if (callback) callback(response);
                    socket.emit('AUTH_SUCCESS', response);
                } catch (error) {
                    logger.error(`Authentication handler error: ${error}`, error);
                    const response = {
                        ok: false,
                        code: 'AUTH_ERROR',
                        message: '认证服务异常'
                    };
                    if (callback) callback(response);
                    socket.emit('AUTH_FAILED', response);
                }
            });

            socket.on('JOIN_SCENE', async (data: { sceneId: string, actorId?: string }) => {
                if (!data || typeof data.sceneId !== 'string' || !data.sceneId
                    || (data.actorId !== undefined && typeof data.actorId !== 'string')) {
                    socket.emit('ERROR', { code: 'INVALID_PAYLOAD', message: '需要有效的场景和实体 ID' });
                    return;
                }
                const { sceneId, actorId = 'guest' } = data;
                const socketState = socket.data as SocketSessionState;

                if (!this.requireAuthentication(socket) || !socketState.userId || !socketState.sessionId) {
                    logger.warn(`JOIN_SCENE rejected: Socket ${socket.id} not authenticated`);
                    socket.emit('ERROR', { code: 'UNAUTHENTICATED', message: '请先认证' });
                    return;
                }

                const authenticatedSubject = socketState.authenticationSubject;
                if (!authenticatedSubject || !PermissionService.canJoinScene(authenticatedSubject, sceneId)
                    || (authenticatedSubject.role !== 'GM' && actorId !== 'guest' && !authenticatedSubject.controlledEntityIds.includes(actorId))) {
                    socket.emit('ERROR', { code: 'UNAUTHORIZED', message: '没有进入该场景或控制该实体的权限' });
                    return;
                }

                if (!socketState.permissionSnapshot) {
                    const snapshot = await PermissionSnapshotRepository.getLatestSnapshot(socketState.sessionId);
                    if (!snapshot) {
                        logger.warn(`JOIN_SCENE rejected: No snapshot for session ${socketState.sessionId}`);
                        socket.emit('ERROR', { code: 'UNAUTHENTICATED', message: '权限快照已失效' });
                        return;
                    }
                    socketState.permissionSnapshot = snapshot;
                }

                try {
                    logger.info(`User ${socketState.userId} requested to join scene: ${sceneId}`, null, { sceneId });

                    const engine = await this.campaignManager.getOrCreateEngine(sceneId);
                    const scene = this.campaignManager.getScene(sceneId);
                    if (!socket.connected || !this.requireAuthentication(socket)) return;
                    const permissionSubject = VisibilityFilter.forScene(this.permissionService.createSubject({
                        ...authenticatedSubject,
                        controlledEntityIds: actorId === 'guest' ? [] : [actorId],
                        allowedSceneIds: [sceneId]
                    }), engine.getAllEntities());

                    this.leaveScene(socket);

                    socketState.permissionSubject = permissionSubject;

                    // 更新权限快照为场景级别（含正确的实体 ID），供 StateBroadcaster 路由 DECISION_POLL 使用
                    const sceneSnapshot = this.permissionService.buildSnapshot(permissionSubject, sceneId);
                    socketState.permissionSnapshot = sceneSnapshot;

                    await socket.join(sceneId);

                    socketState.currentSceneId = sceneId;
                    socketState.currentActorId = actorId ?? socketState.userId;

                    scene?.onPlayerJoin(socket.id);

                    // 更新引擎的玩家控制实体列表
                    this.refreshPlayerControlledEntities(sceneId);

                    socket.emit('JOIN_SUCCESS', {
                        sceneId,
                        serverTime: Date.now(),
                        message: `Successfully entered ${sceneId}`,
                        permissionSnapshot: this.permissionService.buildSnapshot(permissionSubject, sceneId)
                    });

                    this.emitSceneSync(socket, engine);

                } catch (error) {
                    logger.error(`Failed to join scene:`, error, { sceneId });
                    socket.emit('ERROR', { code: 'JOIN_FAILED', message: '无法加载场景数据' });
                }
            });

            socket.on('CLIENT_INTENT', async (intent: ClientIntent) => {
                if (!this.requireAuthentication(socket)) return;
                await this.intentRouter.routeIntent(socket, intent);
            });

            socket.on('REFRESH_PERMISSION', async (callback?: (response: any) => void) => {
                const socketState = socket.data as SocketSessionState;

                if (!this.requireAuthentication(socket) || !socketState.sessionId) {
                    logger.warn(`REFRESH_PERMISSION: Socket ${socket.id} not authenticated`);
                    const response = {
                        ok: false,
                        code: 'UNAUTHENTICATED',
                        message: '请先认证'
                    };
                    if (callback) callback(response);
                    return;
                }

                try {
                    const snapshot = await PermissionSnapshotRepository.getLatestSnapshot(socketState.sessionId);

                    if (!snapshot) {
                        logger.warn(`REFRESH_PERMISSION: No snapshot found for session ${socketState.sessionId}`);
                        const response = {
                            ok: false,
                            code: 'NO_SNAPSHOT',
                            message: '权限快照不存在'
                        };
                        if (callback) callback(response);
                        return;
                    }

                    socketState.permissionSnapshot = snapshot;

                    const response = {
                        ok: true,
                        permissionSnapshot: snapshot
                    };

                    logger.info(`Permission refreshed for session ${socketState.sessionId}`, {
                        sessionId: socketState.sessionId,
                        version: snapshot.version
                    });

                    if (callback) callback(response);
                    socket.emit('PERMISSION_REFRESHED', response);
                } catch (error) {
                    logger.error(`REFRESH_PERMISSION failed for ${socketState.sessionId}:`, error);
                    const response = {
                        ok: false,
                        code: 'REFRESH_FAILED',
                        message: '权限刷新失败'
                    };
                    if (callback) callback(response);
                }
            });

            socket.on('PING', (data: { t: number }, callback?: (response: any) => void) => {
                const response = { ok: true, t: data?.t, serverTime: Date.now() };
                if (callback) callback(response);
                else socket.emit('PONG', response);
            });

            socket.on('RESYNC', async () => {
                const sState = socket.data as SocketSessionState;
                if (!this.requireAuthentication(socket)) return;
                if (!sState.currentSceneId) return;
                const engine = await this.campaignManager.getOrCreateEngine(sState.currentSceneId);
                this.emitSceneSync(socket, engine);
            });

            socket.on('DECISION_RESPONSE', async (payload: DecisionResponsePayload) => {
                if (!this.requireAuthentication(socket) || !payload || typeof payload.windowId !== 'string'
                    || (payload.chosenOptionId !== null && typeof payload.chosenOptionId !== 'string')) return;
                const sState = socket.data as SocketSessionState;
                if (!sState.currentSceneId) return;
                const engine = await this.campaignManager.getOrCreateEngine(sState.currentSceneId);
                if (engine instanceof CombatEngine && this.canRespond(socket, engine, payload.windowId)) {
                    engine.handleDecisionResponse(payload, socket.id);
                }
            });

            socket.on('DECISION_ENGAGE', async (payload: { windowId: string }) => {
                if (!this.requireAuthentication(socket) || !payload || typeof payload.windowId !== 'string') return;
                const sState = socket.data as SocketSessionState;
                if (!sState.currentSceneId) return;
                const engine = await this.campaignManager.getOrCreateEngine(sState.currentSceneId);
                if (engine instanceof CombatEngine && this.canRespond(socket, engine, payload.windowId)) {
                    engine.handleDecisionEngage(payload.windowId, socket.id);
                }
            });

            socket.on('GM_FORCE_RESOLVE', async () => {
                if (!this.requireAuthentication(socket)) return;
                const sState = socket.data as SocketSessionState;
                if (!sState.currentSceneId || sState.role !== 'GM') return;
                const engine = await this.campaignManager.getOrCreateEngine(sState.currentSceneId);
                if (engine instanceof CombatEngine) {
                    engine.handleGmForceResolve();
                }
            });

            socket.on('LEAVE_SCENE', () => {
                this.leaveScene(socket);
            });

            socket.on('disconnect', () => {
                this.leaveScene(socket);
                logger.info(`Client disconnected: ${socket.id}`);
            });
        });
    }

    private leaveScene(socket: Socket): void {
        const state = socket.data as SocketSessionState;
        const sceneId = state.currentSceneId;
        state.currentSceneId = undefined;
        state.currentActorId = undefined;
        state.permissionSubject = undefined;
        if (!sceneId) return;
        void socket.leave(sceneId);
        const scene = this.campaignManager.getScene(sceneId);
        scene?.activeCombatEngine?.releaseSocketDecisionWindows(socket.id);
        scene?.onPlayerLeave(socket.id);
        void this.refreshPlayerControlledEntities(sceneId);
    }

    private requireAuthentication(socket: Socket): boolean {
        const state = socket.data as SocketSessionState;
        if (state.authenticated && state.accessToken && AuthenticationService.verify(state.accessToken).valid) return true;
        state.authenticated = false;
        this.leaveScene(socket);
        socket.emit('ERROR', { code: 'UNAUTHENTICATED', message: '会话已失效，请重新认证' });
        return false;
    }

    private canRespond(socket: Socket, engine: CombatEngine, windowId: string): boolean {
        const state = socket.data as SocketSessionState;
        const poll = engine.getActiveDecisionPolls().find(candidate => candidate.windowId === windowId);
        return !!poll && !!state.permissionSubject && (state.role === 'GM'
            || state.permissionSubject.controlledEntityIds.includes(poll.actorId));
    }

    /** Initial join and reconnect use the same visibility boundary. */
    private emitSceneSync(socket: Socket, engine: IEngineInstance): void {
        const state = socket.data as SocketSessionState;
        if (!state.permissionSubject || !this.requireAuthentication(socket)) return;
        const viewer = VisibilityFilter.forScene(state.permissionSubject, engine.getAllEntities());
        state.permissionSubject = viewer;
        const entities = VisibilityFilter.getVisibleEntities(engine.getAllEntities(), viewer);
        const activeDecisionPolls = (engine.getActiveDecisionPolls?.() ?? []).flatMap(poll => {
            const filtered = VisibilityFilter.filterDecisionPoll(poll, viewer);
            return filtered ? [filtered] : [];
        });
        const explore = engine instanceof ExploreEngine ? engine : undefined;
        const perEntityFow = explore?.getPerEntityFowState();
        const result = engine.getCombatResult?.() ?? null;
        socket.emit('SCENE_SYNC', {
            tick: engine.currentTick,
            entities,
            scheduledActions: (engine.getScheduledActions?.() ?? []).flatMap(action => {
                const filtered = VisibilityFilter.filterAction(action, viewer);
                return filtered ? [filtered] : [];
            }),
            hookPresets: (engine.getActiveHookPresets?.() ?? []).filter(hook => viewer.role === 'GM' || viewer.controlledEntityIds.includes(hook.entityId)),
            activeDecisionPolls,
            pendingDecisionCount: viewer.role === 'GM' ? engine.getPendingDecisionCount?.() ?? 0 : activeDecisionPolls.length,
            combatResult: result && viewer.role !== 'GM' ? {
                ...result,
                survivors: result.survivors.filter(id => VisibilityFilter.isEntityVisibleTo(id, viewer)),
                casualties: result.casualties.filter(id => VisibilityFilter.isEntityVisibleTo(id, viewer)),
            } : result,
            engineType: engine.engineType,
            mapData: explore?.getMapData() ?? null,
            fowCells: viewer.role === 'GM' ? explore?.getFowState() ?? null : null,
            perEntityFow: perEntityFow ? Object.fromEntries(Object.entries(perEntityFow).filter(([id]) => viewer.role === 'GM' || viewer.controlledEntityIds.includes(id))) : null,
            globalFowState: viewer.role === 'GM' ? explore?.getGlobalFowState() ?? null : null,
        });
    }
}
