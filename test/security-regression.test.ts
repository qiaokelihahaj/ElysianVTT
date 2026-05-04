// ==========================================
// 安全回归测试
// 覆盖: /permissions/me、/logs、logout 后令牌失效
// ==========================================

import http from 'http';
import assert from 'node:assert/strict';
import { createApp } from '../packages/backend/src/app.js';

const PORT = 0;

interface TestResult {
    ok: boolean;
    code?: string;
    message?: string;
    data?: any;
}

async function startServer(): Promise<{ server: http.Server; baseUrl: string }> {
    const app = createApp();

    return await new Promise((resolve, reject) => {
        const server = app.listen(PORT, () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to bind test server'));
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

async function readJson(response: Response): Promise<TestResult> {
    return await response.json();
}

function printHeader(title: string): void {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${title}`);
    console.log(`${'='.repeat(60)}`);
}

(async () => {
    let server: http.Server | undefined;

    try {
        const started = await startServer();
        server = started.server;
        const baseUrl = started.baseUrl;

        printHeader('安全回归测试');

        // 1. 未认证访问 /permissions/me 必须拒绝
        {
            const response = await fetch(`${baseUrl}/permissions/me`);
            const payload = await readJson(response);

            assert.equal(response.status, 401, '未认证访问 /permissions/me 返回 401');
            assert.equal(payload.ok, false, '未认证访问 /permissions/me 返回失败响应');
            assert.equal(payload.code, 'UNAUTHENTICATED', '未认证访问 /permissions/me 返回正确错误码');
            console.log('  ✅ /permissions/me 拒绝未认证请求');
        }

        // 2. 登录后可拉取权限上下文
        const loginResponse = await fetch(`${baseUrl}/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userId: 'alice', role: 'PL' })
        });
        const loginPayload = await readJson(loginResponse);

        assert.equal(loginResponse.status, 200, '登录接口返回 200');
        assert.equal(loginPayload.ok, true, '登录接口返回 ok');
        assert.ok(loginPayload.data?.accessToken, '登录返回 accessToken');
        assert.ok(loginPayload.data?.sessionId, '登录返回 sessionId');
        console.log('  ✅ /auth/login 返回 token 与 session');

        const accessToken = loginPayload.data.accessToken as string;
        const sessionId = loginPayload.data.sessionId as string;

        const permissionsResponse = await fetch(`${baseUrl}/permissions/me?token=${encodeURIComponent(accessToken)}`);
        const permissionsPayload = await readJson(permissionsResponse);

        assert.equal(permissionsResponse.status, 200, '权限自查接口返回 200');
        assert.equal(permissionsPayload.ok, true, '权限自查接口返回 ok');
        assert.equal(permissionsPayload.data?.role, 'PL', '权限自查返回正确角色');
        assert.equal(permissionsPayload.data?.sessionId, sessionId, '权限自查返回正确会话');
        assert.ok(Array.isArray(permissionsPayload.data?.capabilities), '权限自查返回能力列表');
        console.log('  ✅ /permissions/me 返回当前权限上下文');

        // 3. 未认证访问 /logs 必须拒绝
        {
            const response = await fetch(`${baseUrl}/logs`);
            const payload = await readJson(response);

            assert.equal(response.status, 401, '/logs 未认证访问返回 401');
            assert.equal(payload.code, 'UNAUTHENTICATED', '/logs 未认证访问返回正确错误码');
            console.log('  ✅ /logs 拒绝未认证请求');
        }

        // 4. 登出后旧 token 失效
        const logoutResponse = await fetch(`${baseUrl}/auth/logout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId })
        });
        const logoutPayload = await readJson(logoutResponse);

        assert.equal(logoutResponse.status, 200, '登出接口返回 200');
        assert.equal(logoutPayload.ok, true, '登出接口返回 ok');
        console.log('  ✅ /auth/logout 成功撤销会话');

        const permissionsAfterLogout = await fetch(`${baseUrl}/permissions/me?token=${encodeURIComponent(accessToken)}`);
        const afterLogoutPayload = await readJson(permissionsAfterLogout);

        assert.equal(permissionsAfterLogout.status, 401, '登出后权限自查返回 401');
        assert.equal(afterLogoutPayload.ok, false, '登出后权限自查返回失败响应');
        assert.equal(afterLogoutPayload.code, 'INVALID_TOKEN', '登出后权限自查返回正确错误码');
        console.log('  ✅ 登出后旧 token 失效');

        // 5. 受限日志接口在无 token 下不会泄露内容
        {
            const response = await fetch(`${baseUrl}/logs?sceneId=scene_1`);
            const payload = await readJson(response);

            assert.equal(response.status, 401, '/logs 带查询参数但无 token 仍返回 401');
            assert.equal(payload.code, 'UNAUTHENTICATED', '日志接口未认证错误码正确');
            console.log('  ✅ 日志接口拒绝未认证查询');
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log('✅ 安全回归测试通过');
        console.log(`${'='.repeat(60)}\n`);
    } catch (error) {
        console.error('\n安全回归测试失败:', error);
        process.exitCode = 1;
    } finally {
        if (server) {
            await new Promise<void>((resolve) => server!.close(() => resolve()));
        }
    }
})();
