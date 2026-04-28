// packages/backend/src/index.ts
import express from 'express';
import { createServer } from 'http';
import { SocketServer } from './network/SocketServer.js';
import { Dictionary } from './db/Dictionary.js';

const PORT = process.env.PORT || 3000;

/**
 * 引导程序：负责整个后端系统的异步初始化
 */
async function bootstrap() {
    console.log('🚀 [ElysianVTT] 正在初始化硬核战术引擎...');

    try {
        // 1. 规则字典解耦：从真实数据库加载所有 Action 模板
        // 这确保了引擎在处理第一个 Intent 之前，内存中已有完整的规则数据
        await Dictionary.loadAllFromDb();
        console.log('📚 [Dictionary] 规则字典已从数据库全量注入内存.');

        // 2. 基础架构初始化 (Express + HTTP)
        const app = express();
        const httpServer = createServer(app);

        // 3. 网络表现层挂载 (Socket.io)
        // 将 HttpServer 注入 SocketServer，并在其内部实例化 CampaignManager
        new SocketServer(httpServer);
        console.log('🌐 [Network] WebSocket 服务器已启动并监听指令.');

        // 4. 提供健康检查路由
        app.get('/health', (_req, res) => {
            res.send({ 
                status: 'running', 
                tick: 'discrete-event-system',
                db: 'sqlite-connected' 
            });
        });

        // 5. 正式开启监听
        httpServer.listen(PORT, () => {
            console.log('\n================================================');
            console.log(`✅ ElysianVTT 后端就绪！`);
            console.log(`📍 监听端口: ${PORT}`);
            console.log(`🔗 调试地址: http://localhost:${PORT}/health`);
            console.log('================================================\n');
        });

    } catch (error) {
        console.error('❌ [Bootstrap] 致命启动错误:', error);
        process.exit(1);
    }
}

bootstrap();