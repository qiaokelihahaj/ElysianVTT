import { Logger } from '../utils/Logger.js';

const logger = Logger.create('Auth:AuthenticationService');

export interface AuthToken {
    userId: string;
    role: 'GM' | 'PL' | 'OB';
    sessionId: string;
    issuedAt: number;
    expiresAt: number;
    version: number;
}

export interface SessionRecord {
    sessionId: string;
    userId: string;
    role: 'GM' | 'PL' | 'OB';
    token: string;
    issuedAt: number;
    expiresAt: number;
    revokedAt?: number;
    version: number;
}

export interface LoginRequest {
    userId: string;
    role?: 'GM' | 'PL' | 'OB';
}

export interface LoginResponse {
    accessToken: string;
    sessionId: string;
    userId: string;
    role: 'GM' | 'PL' | 'OB';
    expiresIn: number;
    expiresAt: number;
}

export interface VerifyResult {
    valid: boolean;
    token?: AuthToken;
    error?: string;
}

const SECRET_KEY = process.env.JWT_SECRET || 'dev-secret-key-change-in-prod';
const TOKEN_EXPIRY_MS = 3600 * 1000; // 1 hour
const SESSION_POOL = new Map<string, SessionRecord>();

export class AuthenticationService {
    static login(request: LoginRequest): LoginResponse {
        const sessionId = this.generateSessionId();
        const userId = request.userId;
        const role = request.role ?? 'PL';
        const now = Date.now();
        const expiresAt = now + TOKEN_EXPIRY_MS;

        const token: AuthToken = {
            userId,
            role,
            sessionId,
            issuedAt: now,
            expiresAt,
            version: 1
        };

        const encodedToken = this.encodeToken(token);

        const session: SessionRecord = {
            sessionId,
            userId,
            role,
            token: encodedToken,
            issuedAt: now,
            expiresAt,
            version: 1
        };

        SESSION_POOL.set(sessionId, session);

        logger.info(`User ${userId} logged in with session ${sessionId}`, { userId, sessionId, role });

        return {
            accessToken: encodedToken,
            sessionId,
            userId,
            role,
            expiresIn: TOKEN_EXPIRY_MS / 1000,
            expiresAt
        };
    }

    static verify(token: string): VerifyResult {
        try {
            const decoded = this.decodeToken(token);
            if (!decoded) {
                return { valid: false, error: 'Invalid token format' };
            }

            const session = SESSION_POOL.get(decoded.sessionId);
            if (!session) {
                return { valid: false, error: 'Session not found' };
            }

            if (session.revokedAt) {
                return { valid: false, error: 'Session revoked' };
            }

            if (decoded.expiresAt < Date.now()) {
                return { valid: false, error: 'Token expired' };
            }

            if (session.version !== decoded.version) {
                return { valid: false, error: 'Token version mismatch (session was refreshed)' };
            }

            return { valid: true, token: decoded };
        } catch (e) {
            logger.warn(`Token verification failed: ${(e as Error).message}`);
            return { valid: false, error: (e as Error).message };
        }
    }

    static revoke(sessionId: string): void {
        const session = SESSION_POOL.get(sessionId);
        if (session) {
            session.revokedAt = Date.now();
            logger.info(`Session ${sessionId} revoked`, { sessionId });
        }
    }

    static getSession(sessionId: string): SessionRecord | undefined {
        return SESSION_POOL.get(sessionId);
    }

    private static generateSessionId(): string {
        return `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    private static encodeToken(token: AuthToken): string {
        const payload = JSON.stringify(token);
        const signature = this.sign(payload);
        return `${Buffer.from(payload).toString('base64')}.${signature}`;
    }

    private static decodeToken(token: string): AuthToken | null {
        try {
            const [payload, signature] = token.split('.');
            if (!payload || !signature) {
                return null;
            }

            const decoded = Buffer.from(payload, 'base64').toString('utf-8');
            const expectedSignature = this.sign(decoded);

            if (signature !== expectedSignature) {
                logger.warn('Token signature mismatch');
                return null;
            }

            return JSON.parse(decoded) as AuthToken;
        } catch (e) {
            logger.warn(`Failed to decode token: ${(e as Error).message}`);
            return null;
        }
    }

    private static sign(payload: string): string {
        const crypto = require('crypto');
        return crypto
            .createHmac('sha256', SECRET_KEY)
            .update(payload)
            .digest('hex')
            .substring(0, 16);
    }
}
