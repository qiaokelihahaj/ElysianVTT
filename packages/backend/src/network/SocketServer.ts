// packages/backend/src/network/SocketServer.ts
import { Server, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { ClientIntent } from '@hard-vtt/shared';
import { CampaignManager } from '../campaigns/CampaignManager.js';
import { IntentRouter } from './IntentRouter.js';
import { Logger } from '../utils/Logger.js';

const logger = Logger.create('Network:Socket');

export class SocketServer {
    private io: Server;
    private campaignManager: CampaignManager;
    private intentRouter: IntentRouter;

    constructor(httpServer: HttpServer) {
        this.io = new Server(httpServer, {
            cors: {
                origin: '*',
                methods: ['GET', 'POST']
            }
        });

        this.campaignManager = new CampaignManager(this.io);
        this.intentRouter = new IntentRouter(this.campaignManager);
        this.setupListeners();
    }

    private setupListeners() {
        this.io.on('connection', (socket: Socket) => {
            logger.info(`Client connected: ${socket.id}`);

            socket.on('JOIN_SCENE', async (data: { sceneId: string, actorId?: string }) => {
                const { sceneId, actorId = 'guest' } = data;

                try {
                    logger.info(`Player ${actorId} requested to join scene: ${sceneId}`, null, { sceneId });

                    const engine = await this.campaignManager.getOrCreateEngine(sceneId);
                    const scene = this.campaignManager.getScene(sceneId);

                    socket.join(sceneId);

                    (socket as any).currentSceneId = sceneId;
                    (socket as any).currentActorId = actorId;

                    scene?.onPlayerJoin(actorId);

                    socket.emit('JOIN_SUCCESS', {
                        sceneId,
                        serverTime: Date.now(),
                        message: `Successfully entered ${sceneId}`
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

            socket.on('LEAVE_SCENE', () => {
                const sceneId = (socket as any).currentSceneId;
                const actorId = (socket as any).currentActorId;

                if (sceneId) {
                    socket.leave(sceneId);
                    const scene = this.campaignManager.getScene(sceneId);
                    scene?.onPlayerLeave(actorId);

                    logger.info(`Player ${actorId} left scene ${sceneId}`, { sceneId });
                }

                (socket as any).currentSceneId = undefined;
                (socket as any).currentActorId = undefined;
            });

            socket.on('disconnect', () => {
                const sceneId = (socket as any).currentSceneId;
                const actorId = (socket as any).currentActorId;

                if (sceneId) {
                    const scene = this.campaignManager.getScene(sceneId);
                    scene?.onPlayerLeave(actorId);

                    logger.info(`Client disconnected: ${socket.id} from scene ${sceneId}`, { sceneId, socketId: socket.id });
                } else {
                    logger.info(`Client disconnected: ${socket.id}`);
                }

                (socket as any).currentSceneId = undefined;
                (socket as any).currentActorId = undefined;
            });
        });
    }
}
