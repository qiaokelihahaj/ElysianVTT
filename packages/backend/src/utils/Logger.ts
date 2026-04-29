import { LogLevel, LogVisibility, LogPayload } from '@hard-vtt/shared';

export class Logger {
    private namespace: string;

    // ANSI 颜色定义
    private static COLORS = {
        RESET: '\x1b[0m',
        DEBUG: '\x1b[90m', // 灰色
        INFO: '\x1b[36m',  // 青色
        WARN: '\x1b[33m',  // 黄色
        ERROR: '\x1b[31m', // 红色
        GAME: '\x1b[35m',  // 紫色
        NAMESPACE: '\x1b[32m', // 绿色
        TICK: '\x1b[34m'   // 蓝色
    };

    constructor(namespace: string) {
        this.namespace = namespace;
    }

    // 工厂方法创建子 Logger
    public static create(namespace: string): Logger {
        return new Logger(namespace);
    }

    private formatTerminal(payload: LogPayload): string {
        const { level, namespace, tick, sceneId, message } = payload;
        
        // Enum to string logic
        const levelName = LogLevel[level] || 'UNKNOWN';
        let levelStr = levelName.padEnd(5);
        let color = Logger.COLORS[levelName as keyof typeof Logger.COLORS] || Logger.COLORS.RESET;
        
        const tickStr = tick !== undefined ? `${Logger.COLORS.TICK}[T:${tick.toString().padStart(4, '0')}]${Logger.COLORS.RESET}` : '';
        const sceneStr = sceneId ? `[${sceneId}]` : '';
        const nsStr = `${Logger.COLORS.NAMESPACE}[${namespace}]${Logger.COLORS.RESET}`;

        return `${color}${levelStr}${Logger.COLORS.RESET} ${tickStr} ${nsStr}${sceneStr} ${message}`;
    }

    public log(
        level: LogLevel, 
        message: string, 
        meta?: any, 
        visibility: LogVisibility = LogVisibility.DEV,
        context?: { tick?: number; sceneId?: string }
    ) {
        const payload: LogPayload = {
            timestamp: Date.now(),
            namespace: this.namespace,
            level,
            message,
            visibility,
            meta,
            ...context
        };

        // 1. 终端彩色输出
        console.log(this.formatTerminal(payload));

        // 如果 meta 存在且为 DEBUG/ERROR 级别，打印详细对象
        if (meta && (level === LogLevel.DEBUG || level === LogLevel.ERROR)) {
            console.dir(meta, { depth: 3, colors: true });
        }

        // 2. 将来在这里触发 EventBus，把 GAME 级别的日志通过 Socket 转发给前端
        // if (level === LogLevel.GAME) { EventBus.emit('GAME_LOG', payload); }
    }

    // 便捷方法
    public debug(msg: string, meta?: any, context?: { tick?: number; sceneId?: string }) { this.log(LogLevel.DEBUG, msg, meta, LogVisibility.DEV, context); }
    public info(msg: string, meta?: any, context?: { tick?: number; sceneId?: string }) { this.log(LogLevel.INFO, msg, meta, LogVisibility.DEV, context); }
    public warn(msg: string, meta?: any, context?: { tick?: number; sceneId?: string }) { this.log(LogLevel.WARN, msg, meta, LogVisibility.DEV, context); }
    public error(msg: string, meta?: any, context?: { tick?: number; sceneId?: string }) { this.log(LogLevel.ERROR, msg, meta, LogVisibility.DEV, context); }
    
    // 专门用于战斗面板记录的方法
    public game(msg: string, meta?: any, visibility: LogVisibility = LogVisibility.PLAYER, context?: { tick?: number; sceneId?: string }) {
        this.log(LogLevel.GAME, msg, meta, visibility, context);
    }
}