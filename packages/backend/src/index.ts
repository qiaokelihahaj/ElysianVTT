import { createServer } from 'http';
import { createApp } from './app.js';
import { SocketServer } from './network/SocketServer.js';
import { Dictionary } from './db/Dictionary.js';
import { Logger } from './utils/Logger.js';

const PORT = Number(process.env.PORT || 3000);
const logger = Logger.create('Server:Bootstrap');

async function bootstrap() {
    logger.info('🚀 [ElysianVTT] 正在初始化硬核战术引擎...');

    try {
        await Dictionary.loadAllFromDb();
        logger.info('📚 [Dictionary] 规则字典已从数据库全量注入内存.');

        const app = createApp();
        const httpServer = createServer(app);

        new SocketServer(httpServer);
        logger.info('🌐 [Network] WebSocket 服务器已启动并监听指令.');

        httpServer.listen(PORT, '127.0.0.1', () => {
            logger.info('\n================================================');
            logger.info(`✅ ElysianVTT 后端就绪！`);
            logger.info('通用服务仅用于本机开发；局域网游玩请使用 pnpm demo。');
            logger.info(`📍 监听端口: ${PORT}`);
            logger.info(`🔗 调试地址: http://localhost:${PORT}/health`);
            logger.info('================================================\n');
        });

    } catch (error) {
        logger.error('❌ [Bootstrap] 致命启动错误:', error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

bootstrap();
