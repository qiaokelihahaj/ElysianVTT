import { prisma } from './prisma.js';
import { Logger } from '../utils/Logger.js';

const logger = Logger.create('DB:PermissionGrantRepository');

export interface CreateGrantInput {
    grantedByUserId: string;
    grantedToUserId: string;
    capability: string;
    scopeType: string;
    scopeId?: string;
    sceneId?: string;
    expiresAt?: Date | null;
    reason?: string;
}

export class PermissionGrantRepository {
    static async createGrant(input: CreateGrantInput) {
        try {
            const grant = await prisma.permissionGrant.create({
                data: {
                    id: `grant_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    ...input
                }
            });
            logger.info(`Permission granted to user ${input.grantedToUserId} for ${input.capability}`);
            return grant;
        } catch (error) {
            logger.error('Failed to create permission grant:', error);
            throw error;
        }
    }

    static async revokeGrant(grantId: string, revokedByUserId: string) {
        try {
            const grant = await prisma.permissionGrant.update({
                where: { id: grantId },
                data: {
                    revokedAt: new Date(),
                    revokedByUserId
                }
            });
            logger.info(`Permission grant ${grantId} revoked by ${revokedByUserId}`);
            return grant;
        } catch (error) {
            logger.error(`Failed to revoke permission grant ${grantId}:`, error);
            throw error;
        }
    }

    static async getActiveGrantsForUser(userId: string) {
        try {
            return await prisma.permissionGrant.findMany({
                where: {
                    grantedToUserId: userId,
                    revokedAt: null,
                    OR: [
                        { expiresAt: null },
                        { expiresAt: { gt: new Date() } }
                    ]
                }
            });
        } catch (error) {
            logger.error(`Failed to fetch active grants for user ${userId}:`, error);
            throw error;
        }
    }
}
