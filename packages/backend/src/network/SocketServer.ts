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
             * 玩家通过此事件进入特定的战斗或探索场景
             */
            socket.on('JOIN_SCENE', async (data: { sceneId: string, actorId: string }) => {
                const { sceneId, actorId } = data;

                try {
                    logger.info(`Player ${actorId} requested to join scene: ${sceneId}`, null, { sceneId });

                    // 1. 异步注水：获取或创建该场景的引擎实例
                    // 该方法会从数据库拉取 CharacterSheet 并注水到 Engine 内存中
                    await this.campaignManager.getOrCreateEngine(sceneId);
                    
                    // 2. 在 Socket.io 层面加入物理房间 (用于后续的 Diff 广播)
                    socket.join(sceneId);
                    
                    // 3. 回馈客户端
                    socket.emit('JOIN_SUCCESS', { 
                        sceneId, 
                        serverTime: Date.now(),
                        message: `Successfully entered ${sceneId}` 
                    });

                } catch (error) {
                    logger.error(`Failed to join scene:`, error, { sceneId });
                    socket.emit('ERROR', { code: 'JOIN_FAILED', message: '无法加载场景数据' });
                }
            });

            /**
             * [客户端意图] - 指令分发
             * 处理来自玩家的所有战术动作 (移动、攻击、施法)
             */
            socket.on('CLIENT_INTENT', async (data: { sceneId: string, intent: ClientIntent }) => {
                const { sceneId, intent } = data;
                
                // 路由意图：根据场景 ID 寻找对应的 Engine 实例
                const engine = await this.campaignManager.getEngine(sceneId);
                
                if (engine) {
                    // 验证 actorId (未来：确保该 socket 拥有操作此实体的权限)
                    logger.debug(`Routed intent to scene ${sceneId} | Type: ${intent.intentType} | Actor: ${intent.actorId}`, intent, { sceneId });
                    
                    // 将意图塞进 Engine 的事件处理管道 (无需等待，异步处理)
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