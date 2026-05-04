/**
 * LogRepository - 日志数据库操作
 */

import { prisma } from '../db/prisma.js';
import type { LogPayload } from '@hard-vtt/shared';
import { Logger } from '../utils/Logger.js';

import type { LogLevel } from '@hard-vtt/shared';
import { generateId } from '../utils/IdGenerator.js';
import type { LogVisibility } from '@hard-vtt/shared';
const logger = Logger.create('DB:LogRepository');

export class LogRepository {
    /**
     * 保存日志到数据库
     */
    static async createLog(sceneId: string | undefined, payload: LogPayload): Promise<void> {
        try {
            await prisma.logEntry.create({
                data: {
                    id: generateId(),
                    sceneId: sceneId || undefined,
                    tick: payload.tick,
                    namespace: payload.namespace,
                    level: String(payload.level),
                    visibility: String(payload.visibility),
                    message: payload.message,
                    metaJson: payload.meta ? JSON.stringify(payload.meta) : undefined,
                    createdAt: new Date(payload.timestamp)
                }
            });
        } catch (error) {
            logger.error('Failed to create log', error);
        }
    }

    /**
     * 查询日志
     */
    static async queryLogs(options: {
        sceneId?: string;
        visibility?: string;
        level?: number;
        limit?: number;
        offset?: number;
        beforeTick?: number;
        afterTick?: number;
    }): Promise<LogPayload[]> {
        try {
            const {
                sceneId,
                visibility,
                level,
                limit = 100,
                offset = 0,
                beforeTick,
                afterTick
            } = options;

            const logs = await prisma.logEntry.findMany({
                where: {
                    ...(sceneId && { sceneId }),
                    ...(visibility && { visibility }),
                    ...(level !== undefined && { level: String(level) }),
                    ...(beforeTick !== undefined && { tick: { lte: beforeTick } }),
                    ...(afterTick !== undefined && { tick: { gte: afterTick } })
                },
                orderBy: { createdAt: 'desc' },
                take: limit,
                skip: offset
            });

            return logs.map(log => ({
                timestamp: log.createdAt.getTime(),
                namespace: log.namespace,
                level: parseInt(log.level) as LogLevel,
                visibility: log.visibility as LogVisibility,
                message: log.message,
                sceneId: log.sceneId || undefined,
                tick: log.tick || undefined,
                meta: log.metaJson ? JSON.parse(log.metaJson) : undefined
            }));
        } catch (error) {
            logger.error('Failed to query logs', error);
            return [];
        }
    }

    /**
     * 获取特定场景的最近日志
     */
    static async getRecentLogs(sceneId: string, limit: number = 50): Promise<LogPayload[]> {
        return this.queryLogs({ sceneId, limit });
    }

    /**
     * 清理过期日志（7天前）
     */
    static async cleanupOldLogs(daysOld: number = 7): Promise<number> {
        try {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - daysOld);

            const result = await prisma.logEntry.deleteMany({
                where: {
                    createdAt: { lt: cutoffDate }
                }
            });

            logger.info(`Cleaned up ${result.count} old log entries`);
            return result.count;
        } catch (error) {
            logger.error('Failed to cleanup old logs', error);
            return 0;
        }
    }
}
