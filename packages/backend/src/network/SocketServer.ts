// packages/backend/src/network/SocketServer.ts
import { Server, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { ClientIntent } from '@hard-vtt/shared';
import { CampaignManager } from '../campaigns/CampaignManager.js';
import { IntentRouter } from './IntentRouter.js';
import { PermissionGrantRepository } from '../db/PermissionGrantRepository.js';
import { Logger } from '../utils/Logger.js';
import { PermissionService, type PermissionSubject, type PermissionSnapshot } from '../permissions/PermissionService.js';
import { AuthenticationService, type AuthToken } from '../auth/AuthenticationService.js';
import { PermissionSnapshotRepository } from '../db/PermissionSnapshotRepository.js';

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

    private setupListeners() {
        this.io.on('connection', (socket: Socket) => {
            logger.info(`Client connected: ${socket.id}`);
            const socketState = socket.data as SocketSessionState;
            socketState.authenticated = false;

            socket.on('AUTHENTICATE', async (data: { token: string }, callback?: (response: any) => void) => {
                try {
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
                    socketState.authenticated = true;
                    socketState.userId = token.userId;
                    socketState.role = token.role;
                    socketState.sessionId = token.sessionId;
                    socketState.authToken = token;

                    const activeGrants = await PermissionGrantRepository.getActiveGrantsForUser(token.userId);
                    const delegatedEntities = activeGrants
                        .filter(g => g.scopeType === 'entity' && g.scopeId)
                        .map(g => g.scopeId!);
                    const extraCapabilities = activeGrants.map(g => g.capability as any);
                    
                    const baseControlledEntities = token.role === 'GM' ? [] : [token.userId];

                    const initialSnapshot = PermissionService.buildSnapshot(
                        PermissionService.createSubject({
                            sessionId: token.sessionId,
                            userId: token.userId,
                            role: token.role,
                            controlledEntityIds: [...baseControlledEntities, ...delegatedEntities],
                            visibleEntityIds: [...baseControlledEntities, ...delegatedEntities],
                            permissionSnapshotVersion: 1
                        })
                    );
                    
                    if (extraCapabilities.length > 0) {
                        initialSnapshot.capabilities = Array.from(new Set([...initialSnapshot.capabilities, ...extraCapabilities])) as any;
                    }

                    await PermissionSnapshotRepository.createSnapshot(token.sessionId, initialSnapshot);
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
                const { sceneId, actorId = 'guest' } = data;
                const socketState = socket.data as SocketSessionState;

                if (!socketState.authenticated || !socketState.userId || !socketState.sessionId) {
                    logger.warn(`JOIN_SCENE rejected: Socket ${socket.id} not authenticated`);
                    socket.emit('ERROR', { code: 'UNAUTHENTICATED', message: '请先认证' });
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

                    const permissionSubject = this.permissionService.createSubject({
                        sessionId: socketState.sessionId,
                        userId: socketState.userId,
                        role: socketState.role,
                        controlledEntityIds: actorId === 'guest' ? [] : [actorId],
                        visibleEntityIds: actorId === 'guest' ? [] : [actorId],
                        allowedSceneIds: [sceneId]
                    });
                    const engine = await this.campaignManager.getOrCreateEngine(sceneId);
                    const scene = this.campaignManager.getScene(sceneId);

                    socketState.permissionSubject = permissionSubject;

                    socket.join(sceneId);

                    socketState.currentSceneId = sceneId;
                    socketState.currentActorId = actorId ?? socketState.userId;

                    scene?.onPlayerJoin(actorId);

                    socket.emit('JOIN_SUCCESS', {
                        sceneId,
                        serverTime: Date.now(),
                        message: `Successfully entered ${sceneId}`,
                        permissionSnapshot: this.permissionService.buildSnapshot(permissionSubject, sceneId)
                    });

                    socket.emit('SCENE_SYNC', {
                        tick: engine.currentTick,
                        entities: engine.getAllEntities()
                    });

                } catch (error) {
                    logger.error(`Failed to join scene:`, error, { sceneId });
                    socket.emit('ERROR', { code: 'JOIN_FAILED', message: '无法加载场景数据' });
                }
            });

            socket.on('CLIENT_INTENT', async (intent: ClientIntent) => {
                await this.intentRouter.routeIntent(socket, intent);
            });

            socket.on('REFRESH_PERMISSION', async (callback?: (response: any) => void) => {
                const socketState = socket.data as SocketSessionState;

                if (!socketState.authenticated || !socketState.sessionId) {
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

            socket.on('LEAVE_SCENE', () => {
                const socketState = socket.data as SocketSessionState;
                const sceneId = socketState.currentSceneId;
                const actorId = socketState.currentActorId ?? 'guest';

                if (sceneId) {
                    socket.leave(sceneId);
                    const scene = this.campaignManager.getScene(sceneId);
                    scene?.onPlayerLeave(actorId);

                    logger.info(`Player ${actorId} left scene ${sceneId}`, { sceneId });
                }

                socketState.currentSceneId = undefined;
                socketState.currentActorId = undefined;
                socketState.permissionSubject = undefined;
            });

            socket.on('disconnect', () => {
                const socketState = socket.data as SocketSessionState;
                const sceneId = socketState.currentSceneId;
                const actorId = socketState.currentActorId ?? 'guest';

                if (sceneId) {
                    const scene = this.campaignManager.getScene(sceneId);
                    scene?.onPlayerLeave(actorId);

                    logger.info(`Client disconnected: ${socket.id} from scene ${sceneId}`, { sceneId, socketId: socket.id });
                } else {
                    logger.info(`Client disconnected: ${socket.id}`);
                }

                socketState.currentSceneId = undefined;
                socketState.currentActorId = undefined;
                socketState.permissionSubject = undefined;
            });
        });
    }
}
