import { prisma } from './prisma.js';
import { PermissionSnapshot } from '../permissions/PermissionService.js';
import { Logger } from '../utils/Logger.js';

const logger = Logger.create('DB:PermissionSnapshotService');

export class PermissionSnapshotRepository {
    static async createSnapshot(sessionId: string, snapshot: PermissionSnapshot): Promise<void> {
        try {
            await prisma.permissionSnapshot.create({
                data: {
                    id: `snap_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    sessionId,
                    userId: snapshot.userId,
                    roleSnapshot: snapshot.role,
                    version: snapshot.version,
                    controllableEntitiesJson: JSON.stringify(snapshot.controllableEntities),
                    visibleEntitiesJson: JSON.stringify(snapshot.visibleEntities),
                    capabilitiesJson: JSON.stringify(snapshot.capabilities),
                    currentSceneIdsJson: JSON.stringify(snapshot.currentSceneIds),
                    issuedAt: new Date(snapshot.issuedAt),
                    expiresAt: snapshot.expiresAt ? new Date(snapshot.expiresAt) : null,
                    refreshedAt: new Date(snapshot.refreshedAt)
                }
            });

            logger.info(`Snapshot created for session ${sessionId}`, {
                sessionId,
                userId: snapshot.userId,
                role: snapshot.role,
                version: snapshot.version
            });
        } catch (error) {
            logger.error(`Failed to create snapshot for session ${sessionId}:`, error);
            throw error;
        }
    }

    static async getLatestSnapshot(sessionId: string): Promise<PermissionSnapshot | undefined> {
        try {
            const record = await prisma.permissionSnapshot.findFirst({
                where: { sessionId },
                orderBy: { issuedAt: 'desc' }
            });

            if (!record) {
                return undefined;
            }

            const expiresAt = record.expiresAt?.getTime();
            if (expiresAt && expiresAt < Date.now()) {
                logger.warn(`Snapshot for session ${sessionId} has expired`, { sessionId });
                return undefined;
            }

            return {
                sessionId: record.sessionId,
                userId: record.userId,
                role: record.roleSnapshot as 'GM' | 'PL' | 'OB',
                version: record.version,
                controllableEntities: JSON.parse(record.controllableEntitiesJson),
                visibleEntities: JSON.parse(record.visibleEntitiesJson),
                capabilities: JSON.parse(record.capabilitiesJson),
                currentSceneIds: JSON.parse(record.currentSceneIdsJson),
                issuedAt: record.issuedAt.getTime(),
                expiresAt,
                refreshedAt: (record.refreshedAt ?? record.issuedAt).getTime()
            };
        } catch (error) {
            logger.error(`Failed to get snapshot for session ${sessionId}:`, error);
            return undefined;
        }
    }

    static async refreshSnapshot(sessionId: string, newSnapshot: PermissionSnapshot): Promise<void> {
        try {
            await this.createSnapshot(sessionId, newSnapshot);

            logger.info(`Snapshot refreshed for session ${sessionId}`, {
                sessionId,
                version: newSnapshot.version
            });
        } catch (error) {
            logger.error(`Failed to refresh snapshot for session ${sessionId}:`, error);
            throw error;
        }
    }

    static async revokeSnapshot(sessionId: string): Promise<void> {
        try {
            await prisma.permissionSnapshot.deleteMany({
                where: { sessionId }
            });

            logger.info(`Snapshot revoked for session ${sessionId}`, { sessionId });
        } catch (error) {
            logger.error(`Failed to revoke snapshot for session ${sessionId}:`, error);
            throw error;
        }
    }

    static async cleanupExpiredSnapshots(): Promise<number> {
        try {
            const result = await prisma.permissionSnapshot.deleteMany({
                where: {
                    expiresAt: {
                        lt: new Date()
                    }
                }
            });

            if (result.count > 0) {
                logger.info(`Cleaned up ${result.count} expired snapshots`);
            }

            return result.count;
        } catch (error) {
            logger.error('Failed to cleanup expired snapshots:', error);
            return 0;
        }
    }
}
