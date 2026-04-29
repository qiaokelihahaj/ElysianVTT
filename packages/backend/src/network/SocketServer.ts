// packages/backend/src/network/SocketServer.ts
import { Server, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { ClientIntent } from '@hard-vtt/shared';
import { CampaignManager } from '../campaigns/CampaignManager.js';
import { Logger } from '../utils/Logger.js';

const logger = Logger.create('Network:Socket');

export class SocketServer {
    private io: Server;

    private campaignManager: CampaignManager;

    constructor(httpServer: HttpServer) {
        // 配置 Socket.io 跨域策略 (MVP 阶段允许所有源)
        this.io = new Server(httpServer, {
            cors: { 
                origin: '*', 
                methods: ['GET', 'POST'] 
            }
        });

        // 实例化战役管理器，它是网络层与引擎层的纽带
        this.campaignManager = new CampaignManager(this.io);
        this.setupListeners();
    }

    /**
     * 设置全局 Socket 事件监听
     */
    private setupListeners() {
        this.io.on('connection', (socket: Socket) => {
            logger.info(`Client connected: ${socket.id}`);

            /**
             * [场景加入] - 关键路径
             */
            socket.on('JOIN_SCENE', async (data: { sceneId: string, actorId?: string }) => {
                const { sceneId, actorId = 'guest' } = data;

                try {
                    logger.info(`Player ${actorId} requested to join scene: ${sceneId}`, null, { sceneId });

                    // 1. 异步注水：获取或创建该场景的引擎实例
                    const engine = await this.campaignManager.getOrCreateEngine(sceneId);
                    
                    // 2. 在 Socket.io 层面加入物理房间
                    socket.join(sceneId);

                    // 记录一下这个 socket 的当前关联信息
                    (socket as any).currentSceneId = sceneId;
                    (socket as any).currentActorId = actorId;
                    
                    // 3. 回馈客户端
                    socket.emit('JOIN_SUCCESS', { 
                        sceneId, 
                        serverTime: Date.now(),
                        message: `Successfully entered ${sceneId}` 
                    });

                    // 4. 下发该场景全部实体以便前端完成初始态构建
                    socket.emit('SCENE_SYNC', {
                        tick: engine.currentTick,
                        entities: engine.getAllEntities()
                    });

                } catch (error) {
                    logger.error(`Failed to join scene:`, error, { sceneId });
                    socket.emit('ERROR', { code: 'JOIN_FAILED', message: '无法加载场景数据' });
                }
            });

            /**
             * [客户端意图] - 指令分发
             */
            socket.on('CLIENT_INTENT', async (intent: ClientIntent) => {
                const sceneId = (socket as any).currentSceneId;
                
                if (!sceneId) {
                    logger.warn(`Intent dropped: Socket ${socket.id} has not joined any scene`);
                    socket.emit('ERROR', { code: 'NOT_IN_SCENE', message: '尚未加入任何场景' });
                    return;
                }

                // 路由意图：根据场景 ID 寻找对应的 Engine 实例
                const engine = await this.campaignManager.getEngine(sceneId);
                
                if (engine) {
                    logger.debug(`Routed intent to scene ${sceneId} | Type: ${intent.intentType} | Actor: ${intent.actorId}`, intent, { sceneId });
                    engine.receiveIntent(intent);
                } else {
                    logger.warn(`Invalid intent route: Scene ${sceneId} not found or inactive`, null, { sceneId });
                    socket.emit('ERROR', { code: 'ENGINE_NOT_FOUND', message: '目标引擎未启动' });
                }
            });

            socket.on('disconnect', () => {
                logger.info(`Client disconnected: ${socket.id}`);
                // TODO: 在此处触发角色的“断线托管”或“离线持久化”逻辑
            });
        });
    }
}