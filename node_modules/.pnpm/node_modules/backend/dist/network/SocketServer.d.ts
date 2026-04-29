import { Server as HttpServer } from 'http';
export declare class SocketServer {
    private io;
    private campaignManager;
    constructor(httpServer: HttpServer);
    /**
     * 设置全局 Socket 事件监听
     */
    private setupListeners;
}
//# sourceMappingURL=SocketServer.d.ts.map