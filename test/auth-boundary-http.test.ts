import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../packages/backend/src/app.js';
import { AuthenticationService } from '../packages/backend/src/auth/AuthenticationService.js';
import { prisma } from '../packages/backend/src/db/prisma.js';

const isolatedDatabaseUrl = process.env.ELYSIAN_AUTH_TEST_DB;

interface JsonObject {
    [key: string]: unknown;
}

interface HttpResult {
    response: Response;
    payload: JsonObject;
}

interface LegacySessionFixture {
    accessToken: string;
    sessionId: string;
    expiresAt: number;
}

let assertionCount = 0;
let passedCount = 0;
const failures: string[] = [];

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getData(payload: JsonObject): JsonObject | undefined {
    return isJsonObject(payload.data) ? payload.data : undefined;
}

function check(condition: boolean, label: string): void {
    assertionCount++;

    try {
        assert.equal(condition, true, label);
        passedCount++;
        console.log(`  ✅ ${label}`);
    } catch {
        failures.push(label);
        console.error(`  ❌ FAIL: ${label}`);
    }
}

async function runCase(label: string, test: () => Promise<void>): Promise<void> {
    try {
        await test();
    } catch {
        // 请求超时、连接失败或 JSON 解析失败是环境/fixture 错误，不是安全断言失败。
        throw new Error(`AUTH_TEST_ENVIRONMENT_ERROR: ${label} HTTP request failed`);
    }
}

async function requestJson(
    baseUrl: string,
    path: string,
    init?: RequestInit
): Promise<HttpResult> {
    const requestInit: RequestInit = { ...init };
    if (!requestInit.signal) {
        requestInit.signal = AbortSignal.timeout(5000);
    }

    const response = await fetch(`${baseUrl}${path}`, requestInit);
    const body: unknown = await response.json();

    if (!isJsonObject(body)) {
        throw new Error('Expected a JSON object response');
    }

    return { response, payload: body };
}

async function postJson(
    baseUrl: string,
    path: string,
    body: JsonObject,
    headers: Record<string, string> = {}
): Promise<HttpResult> {
    return requestJson(baseUrl, path, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...headers
        },
        body: JSON.stringify(body)
    });
}

async function startServer(): Promise<{ server: http.Server; baseUrl: string }> {
    const app = createApp();

    return await new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to bind isolated HTTP test server'));
                return;
            }

            resolve({
                server,
                baseUrl: `http://127.0.0.1:${address.port}`
            });
        });

        server.on('error', reject);
    });
}

async function createLegacySession(
    baseUrl: string,
    userId: string,
    sessions: string[]
): Promise<LegacySessionFixture> {
    const result = await postJson(baseUrl, '/auth/login', { userId, role: 'PL' });
    const data = getData(result.payload);
    const accessToken = typeof data?.accessToken === 'string' ? data.accessToken : undefined;
    const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : undefined;
    const expiresAt = typeof data?.expiresAt === 'number' ? data.expiresAt : undefined;

    if (result.response.status !== 200 || result.payload.ok !== true || !accessToken || !sessionId || expiresAt === undefined) {
        throw new Error('AUTH_TEST_ENVIRONMENT_ERROR: legacy HTTP fixture login unavailable');
    }

    sessions.push(sessionId);
    return { accessToken, sessionId, expiresAt };
}

function assertIsolatedEnvironment(): void {
    if (!isolatedDatabaseUrl || !isolatedDatabaseUrl.startsWith('file:') || !isolatedDatabaseUrl.includes('elysian-auth-test-')) {
        throw new Error('AUTH_TEST_ENVIRONMENT_ERROR: missing isolated test database');
    }
}

async function closeServer(server: http.Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close(error => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

async function main(): Promise<void> {
    assertIsolatedEnvironment();

    let server: http.Server | undefined;
    const sessions: string[] = [];
    const originalDateNow = Date.now;

    try {
        const started = await startServer();
        server = started.server;
        const { baseUrl } = started;

        // 真实 HTTP fixture 只建立当前源码仍支持的最小 PL 会话；不写入数据库。
        const victim = await createLegacySession(baseUrl, 'http_boundary_victim', sessions);
        const urlTokenFixture = await createLegacySession(baseUrl, 'http_boundary_url', sessions);
        const expiryFixture = await createLegacySession(baseUrl, 'http_boundary_expiry', sessions);

        await runCase('匿名敏感访问 /permissions/me', async () => {
            const result = await requestJson(baseUrl, '/permissions/me');
            check(result.response.status === 401 && result.payload.ok === false && result.payload.code === 'UNAUTHENTICATED',
                '匿名访问 /permissions/me 返回 401/UNAUTHENTICATED');
        });

        await runCase('匿名敏感访问 /logs', async () => {
            const result = await requestJson(baseUrl, '/logs?sceneId=scene_boundary');
            check(result.response.status === 401 && result.payload.ok === false && result.payload.code === 'UNAUTHENTICATED',
                '匿名访问 /logs 返回 401/UNAUTHENTICATED');
        });

        await runCase('匿名敏感访问 /permissions/grant', async () => {
            const result = await postJson(baseUrl, '/permissions/grant', {});
            check(result.response.status === 401 && result.payload.ok === false && result.payload.code === 'UNAUTHENTICATED',
                '匿名访问 /permissions/grant 返回 401/UNAUTHENTICATED');
        });

        await runCase('无凭据客户端指定 GM', async () => {
            const result = await postJson(baseUrl, '/auth/login', {
                userId: 'http_boundary_attacker',
                role: 'GM'
            });
            const data = getData(result.payload);
            const attackerSessionId = typeof data?.sessionId === 'string' ? data.sessionId : undefined;
            if (attackerSessionId) sessions.push(attackerSessionId);

            check(result.response.status >= 400 && result.response.status < 500,
                '无凭据且指定 GM 的登录请求返回 4xx');
            check(result.payload.ok === false,
                '无凭据且指定 GM 的登录请求返回失败响应');
            check(!data?.accessToken,
                '无凭据且指定 GM 的登录请求不返回 accessToken');
        });

        await runCase('匿名仅凭 sessionId 登出他人会话', async () => {
            const result = await postJson(baseUrl, '/auth/logout', { sessionId: victim.sessionId });

            check(result.response.status >= 400 && result.response.status < 500,
                '无凭据登出他人 sessionId 返回 4xx');
            check(result.payload.ok === false,
                '无凭据登出他人 sessionId 返回失败响应');

            const victimStillAuthenticated = await postJson(
                baseUrl,
                '/permissions/revoke',
                {},
                { authorization: `Bearer ${victim.accessToken}` }
            );
            check(victimStillAuthenticated.response.status === 403 && victimStillAuthenticated.payload.code === 'UNAUTHORIZED',
                '被攻击会话未因匿名 logout 而失效');
        });

        await runCase('敏感入口拒绝 URL token /permissions/me', async () => {
            const result = await requestJson(
                baseUrl,
                `/permissions/me?token=${encodeURIComponent(urlTokenFixture.accessToken)}`
            );

            console.log(`  ℹ️ /permissions/me URL token observed status=${result.response.status} code=${String(result.payload.code ?? '<none>')}`);
            check(result.response.status !== 200 && result.payload.ok === false && result.payload.code === 'TOKEN_IN_URL_DISABLED',
                '有效 token 放入 /permissions/me URL 返回 TOKEN_IN_URL_DISABLED');
        });

        await runCase('敏感入口拒绝 URL token /logs', async () => {
            const result = await requestJson(
                baseUrl,
                `/logs?sceneId=scene_boundary&token=${encodeURIComponent(urlTokenFixture.accessToken)}`
            );

            console.log(`  ℹ️ /logs URL token observed status=${result.response.status} code=${String(result.payload.code ?? '<none>')}`);
            check(result.response.status !== 200 && result.payload.ok === false && result.payload.code === 'TOKEN_IN_URL_DISABLED',
                '有效 token 放入 /logs URL 返回 TOKEN_IN_URL_DISABLED');
        });

        await runCase('会话真实过期', async () => {
            const beforeExpiry = await postJson(
                baseUrl,
                '/permissions/grant',
                {},
                { authorization: `Bearer ${expiryFixture.accessToken}` }
            );
            check(beforeExpiry.response.status === 403 && beforeExpiry.payload.code === 'UNAUTHORIZED',
                '过期前 Bearer 会话仍被识别为已认证 PL');

            try {
                Date.now = () => expiryFixture.expiresAt + 1;
                const afterExpiry = await postJson(
                    baseUrl,
                    '/permissions/grant',
                    {},
                    { authorization: `Bearer ${expiryFixture.accessToken}` }
                );
                check(afterExpiry.response.status === 401 && afterExpiry.payload.code === 'INVALID_TOKEN',
                    '推进受控时钟越过 expiresAt 后敏感请求返回 401/INVALID_TOKEN');
            } finally {
                Date.now = originalDateNow;
            }

            const afterClockRestore = await postJson(
                baseUrl,
                '/permissions/grant',
                {},
                { authorization: `Bearer ${expiryFixture.accessToken}` }
            );
            check(afterClockRestore.response.status === 403 && afterClockRestore.payload.code === 'UNAUTHORIZED',
                '恢复 Date.now 后原会话仍按真实时间有效');
        });
    } finally {
        Date.now = originalDateNow;

        for (const sessionId of sessions) {
            AuthenticationService.revoke(sessionId);
        }

        if (server) {
            await closeServer(server);
        }

        await prisma.$disconnect();
    }

    console.log(`\n✅ 通过: ${passedCount}/${assertionCount}`);
    console.log(`❌ 失败: ${failures.length}`);

    if (failures.length > 0) {
        process.exitCode = 1;
    }
}

main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith('AUTH_TEST_ENVIRONMENT_ERROR:')
        ? message
        : `AUTH_TEST_ENVIRONMENT_ERROR: ${message}`);
    process.exitCode = 2;
});
