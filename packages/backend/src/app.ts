import express from 'express';
import { healthRouter } from './network/routes/index.js';
import { AuthenticationService } from './auth/AuthenticationService.js';
import { Logger } from './utils/Logger.js';
import { LogRepository } from './db/LogRepository.js';
import { VisibilityFilter } from './network/VisibilityFilter.js';
import { PermissionService } from './permissions/PermissionService.js';
import { PermissionGrantRepository } from './db/PermissionGrantRepository.js';

const logger = Logger.create('App');

export function createApp(): express.Express {
    const app = express();

    app.use(express.json());

    app.use('/health', healthRouter);

    app.post('/auth/login', (req: express.Request, res: express.Response) => {
        try {
            const { userId, role } = req.body;

            if (!userId) {
                res.status(400).json({
                    ok: false,
                    code: 'INVALID_REQUEST',
                    message: 'userId is required'
                });
                return;
            }

            const loginResponse = AuthenticationService.login({
                userId,
                role: role ?? 'PL'
            });

            logger.info(`User ${userId} logged in via HTTP`, { userId, role: loginResponse.role });

            res.json({
                ok: true,
                data: loginResponse
            });
        } catch (error) {
            logger.error('Login endpoint error', error);
            res.status(500).json({
                ok: false,
                code: 'LOGIN_FAILED',
                message: '登录失败'
            });
        }
    });

    app.post('/auth/logout', (req: express.Request, res: express.Response) => {
        try {
            const { sessionId } = req.body;

            if (!sessionId) {
                res.status(400).json({
                    ok: false,
                    code: 'INVALID_REQUEST',
                    message: 'sessionId is required'
                });
                return;
            }

            AuthenticationService.revoke(sessionId);

            logger.info(`Session ${sessionId} revoked via HTTP`, { sessionId });

            res.json({
                ok: true,
                message: '登出成功'
            });
        } catch (error) {
            logger.error('Logout endpoint error', error);
            res.status(500).json({
                ok: false,
                code: 'LOGOUT_FAILED',
                message: '登出失败'
            });
        }
    });

    /**
     * GET /permissions/me - 返回当前会话的权限上下文
     * Query params:
     *   - token: JWT token
     */
    app.get('/permissions/me', async (req: express.Request, res: express.Response) => {
        try {
            const token = req.query.token;

            if (!token || typeof token !== 'string') {
                res.status(401).json({
                    ok: false,
                    code: 'UNAUTHENTICATED',
                    message: '需要提供有效的认证令牌'
                });
                return;
            }

            const verified = AuthenticationService.verify(token);

            if (!verified.valid || !verified.token) {
                res.status(401).json({
                    ok: false,
                    code: 'INVALID_TOKEN',
                    message: verified.error || '令牌无效'
                });
                return;
            }

            const session = AuthenticationService.getSession(verified.token.sessionId);
            
            const activeGrants = await PermissionGrantRepository.getActiveGrantsForUser(verified.token.userId);
            const delegatedEntities = activeGrants
                .filter(g => g.scopeType === 'entity' && g.scopeId)
                .map(g => g.scopeId!);
            const extraCapabilities = activeGrants.map(g => g.capability);
            const baseControlledEntities = session ? [session.userId] : [];

            const subject = PermissionService.createSubject({
                sessionId: verified.token.sessionId,
                userId: verified.token.userId,
                role: verified.token.role,
                controlledEntityIds: [...baseControlledEntities, ...delegatedEntities],
                visibleEntityIds: [...baseControlledEntities, ...delegatedEntities],
                allowedSceneIds: [],
                permissionSnapshotVersion: verified.token.version
            });

            const snapshot = PermissionService.buildSnapshot(subject);
            
            if (extraCapabilities.length > 0) {
                snapshot.capabilities = Array.from(new Set([...snapshot.capabilities, ...extraCapabilities])) as any;
            }

            res.json({
                ok: true,
                data: {
                    userId: snapshot.userId,
                    role: snapshot.role,
                    sessionId: snapshot.sessionId,
                    controlledEntityIds: snapshot.controllableEntities,
                    delegatedEntities: delegatedEntities, // Add delegated entities to the response exposing ABAC
                    visibleEntityIds: snapshot.visibleEntities,
                    allowedSceneIds: snapshot.currentSceneIds,
                    capabilities: snapshot.capabilities,
                    snapshotVersion: snapshot.version,
                    expiresAt: snapshot.expiresAt
                }
            });
        } catch (error) {
            logger.error('Permissions me endpoint error', error);
            res.status(500).json({
                ok: false,
                code: 'INTERNAL_ERROR',
                message: '权限查询失败'
            });
        }
    });

    /**
     * GET /logs - 查询日志（支持权限过滤）
     * Query params:
     *   - sceneId: 场景 ID
     *   - visibility: 日志可见性等级
     *   - level: 日志级别
     *   - limit: 返回数量（默认50）
     *   - offset: 偏移量（默认0）
     *   - token: JWT token（用于权限检查）
     */
    app.get('/logs', async (req: express.Request, res: express.Response) => {
        try {
            const { token, sceneId, visibility, limit, offset } = req.query;

            // 验证令牌
            if (!token || typeof token !== 'string') {
                res.status(401).json({
                    ok: false,
                    code: 'UNAUTHENTICATED',
                    message: '需要提供有效的认证令牌'
                });
                return;
            }

            let authToken;
            try {
                authToken = AuthenticationService.verify(token);
            } catch (error) {
                res.status(401).json({
                    ok: false,
                    code: 'INVALID_TOKEN',
                    message: '令牌无效或已过期'
                });
                return;
            }

            if (!authToken.valid || !authToken.token) {
                res.status(401).json({
                    ok: false,
                    code: 'INVALID_TOKEN',
                    message: authToken.error || '令牌无效'
                });
                return;
            }

            const decoded = authToken.token;

            // 构建权限主体用于过滤
            const subject = PermissionService.createSubject({
                sessionId: decoded.sessionId,
                userId: decoded.userId,
                role: decoded.role,
                allowedSceneIds: sceneId ? [sceneId as string] : []
            });

            // 查询日志
            const logs = await LogRepository.queryLogs({
                sceneId: sceneId as string | undefined,
                visibility: visibility as string | undefined,
                limit: parseInt(String(limit)) || 50,
                offset: parseInt(String(offset)) || 0
            });

            // 根据权限过滤日志
            const filteredLogs = VisibilityFilter.filterLogs(subject, logs);

            logger.info(`Logs queried by ${decoded.userId}`, { 
                userId: decoded.userId, 
                total: logs.length,
                filtered: filteredLogs.length
            });

            res.json({
                ok: true,
                data: filteredLogs,
                meta: {
                    total: filteredLogs.length,
                    limit: parseInt(String(limit)) || 50,
                    offset: parseInt(String(offset)) || 0
                }
            });
        } catch (error) {
            logger.error('Logs query endpoint error', error);
            res.status(500).json({
                ok: false,
                code: 'INTERNAL_ERROR',
                message: '日志查询失败'
            });
        }
    });

    /**
     * POST /permissions/grant - GM 动态授予权限
     */
    app.post('/permissions/grant', async (req: express.Request, res: express.Response) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) {
                res.status(401).json({ ok: false, code: 'UNAUTHENTICATED' });
                return;
            }

            const verified = AuthenticationService.verify(token);
            if (!verified.valid || !verified.token) {
                res.status(401).json({ ok: false, code: 'INVALID_TOKEN' });
                return;
            }

            if (verified.token.role !== 'GM') {
                res.status(403).json({ ok: false, code: 'UNAUTHORIZED', message: '只有 GM 可以授予权限' });
                return;
            }

            const { grantedToUserId, capability, scopeType, scopeId, sceneId, expiresAt, reason } = req.body;

            const grant = await PermissionGrantRepository.createGrant({
                grantedByUserId: verified.token.userId,
                grantedToUserId,
                capability,
                scopeType,
                scopeId,
                sceneId,
                expiresAt: expiresAt ? new Date(expiresAt) : null,
                reason
            });

            res.json({ ok: true, data: grant });
        } catch (error) {
            logger.error('Failed to create permission grant', error);
            res.status(500).json({ ok: false, code: 'INTERNAL_ERROR' });
        }
    });

    /**
     * POST /permissions/revoke - 撤销权限
     */
    app.post('/permissions/revoke', async (req: express.Request, res: express.Response) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) {
                res.status(401).json({ ok: false, code: 'UNAUTHENTICATED' });
                return;
            }

            const verified = AuthenticationService.verify(token);
            if (!verified.valid || !verified.token) {
                res.status(401).json({ ok: false, code: 'INVALID_TOKEN' });
                return;
            }

            if (verified.token.role !== 'GM') {
                res.status(403).json({ ok: false, code: 'UNAUTHORIZED', message: '只有 GM 可以撤销权限' });
                return;
            }

            const { grantId } = req.body;
            if (!grantId) {
                res.status(400).json({ ok: false, code: 'MISSING_GRANT_ID' });
                return;
            }

            const grant = await PermissionGrantRepository.revokeGrant(grantId, verified.token.userId);

            res.json({ ok: true, data: grant });
        } catch (error) {
            logger.error('Failed to revoke permission grant', error);
            res.status(500).json({ ok: false, code: 'INTERNAL_ERROR' });
        }
    });

    return app;
}
