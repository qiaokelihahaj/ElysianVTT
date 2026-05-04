// ==========================================
// 认证系统单元测试
// 覆盖: AuthenticationService (JWT 签发、验证、会话管理)
// ==========================================

import { AuthenticationService, type AuthToken, type LoginResponse } from '../packages/backend/src/auth/AuthenticationService.js';

// ==========================================
// 测试工具
// ==========================================
let testCount = 0;
let passCount = 0;

function assert(condition: boolean, label: string): void {
    testCount++;
    if (condition) {
        passCount++;
        console.log(`  ✅ ${label}`);
    } else {
        console.error(`  ❌ FAIL: ${label}`);
        process.exitCode = 1;
    }
}

function section(title: string): void {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${title}`);
    console.log(`${'='.repeat(60)}`);
}

// ==========================================
// 测试: AuthenticationService
// ==========================================

section('AuthenticationService (认证与会话管理)');

// 1. 登录生成 token
{
    const response = AuthenticationService.login({
        userId: 'alice',
        role: 'PL'
    });

    assert(response.accessToken !== undefined, '登录返回 accessToken');
    assert(response.sessionId !== undefined, '登录返回 sessionId');
    assert(response.userId === 'alice', '登录返回正确的 userId');
    assert(response.role === 'PL', '登录返回正确的 role');
    assert(response.expiresIn > 0, '登录返回正确的 expiresIn');
}

// 2. 验证有效 token
{
    const login = AuthenticationService.login({
        userId: 'bob',
        role: 'GM'
    });

    const verification = AuthenticationService.verify(login.accessToken);
    assert(verification.valid === true, 'Token 验证成功');
    assert(verification.token !== undefined, '验证返回解码的 token');
    assert(verification.token?.userId === 'bob', 'Token 包含正确的 userId');
    assert(verification.token?.role === 'GM', 'Token 包含正确的 role');
}

// 3. 无效 token 验证失败
{
    const verification = AuthenticationService.verify('invalid.token.here');
    assert(verification.valid === false, '无效 token 验证失败');
    assert(verification.error !== undefined, '返回错误信息');
}

// 4. 篡改 token 验证失败
{
    const login = AuthenticationService.login({
        userId: 'charlie',
        role: 'OB'
    });

    const tamperedToken = login.accessToken.substring(0, login.accessToken.length - 5) + 'xxxxx';
    const verification = AuthenticationService.verify(tamperedToken);
    assert(verification.valid === false, '篡改的 token 验证失败');
}

// 5. 撤销会话
{
    const login = AuthenticationService.login({
        userId: 'dave',
        role: 'PL'
    });

    let verification = AuthenticationService.verify(login.accessToken);
    assert(verification.valid === true, '撤销前 token 有效');

    AuthenticationService.revoke(login.sessionId);

    verification = AuthenticationService.verify(login.accessToken);
    assert(verification.valid === false, '撤销后 token 无效');
    assert(verification.error?.includes('revoked'), '错误信息提及撤销');
}

// 6. 多个并发登录不互相影响
{
    const login1 = AuthenticationService.login({
        userId: 'user1',
        role: 'PL'
    });

    const login2 = AuthenticationService.login({
        userId: 'user2',
        role: 'PL'
    });

    const verify1 = AuthenticationService.verify(login1.accessToken);
    const verify2 = AuthenticationService.verify(login2.accessToken);

    assert(verify1.valid === true && verify1.token?.userId === 'user1', '第一个会话独立有效');
    assert(verify2.valid === true && verify2.token?.userId === 'user2', '第二个会话独立有效');
}

// 7. token 过期检查（模拟）
{
    // 注：实际过期检查在生成的 expiresAt 时间后触发
    // 这里只验证 token 结构包含过期时间
    const login = AuthenticationService.login({
        userId: 'eve',
        role: 'PL'
    });

    const verification = AuthenticationService.verify(login.accessToken);
    assert(verification.token?.expiresAt !== undefined, 'Token 包含 expiresAt');
    assert(verification.token!.expiresAt > Date.now(), 'Token 尚未过期');
}

// 8. 会话查询
{
    const login = AuthenticationService.login({
        userId: 'frank',
        role: 'GM'
    });

    const session = AuthenticationService.getSession(login.sessionId);
    assert(session !== undefined, '能查询到已登录的会话');
    assert(session?.userId === 'frank', '会话包含正确的 userId');
    assert(session?.role === 'GM', '会话包含正确的 role');
    assert(session?.revokedAt === undefined, '未撤销的会话 revokedAt 为空');
}

// 9. 查询不存在的会话
{
    const session = AuthenticationService.getSession('nonexistent_session_id');
    assert(session === undefined, '查询不存在的会话返回 undefined');
}

// 10. 多个角色的登录
{
    const gmLogin = AuthenticationService.login({
        userId: 'gm_user',
        role: 'GM'
    });

    const plLogin = AuthenticationService.login({
        userId: 'pl_user',
        role: 'PL'
    });

    const obLogin = AuthenticationService.login({
        userId: 'ob_user',
        role: 'OB'
    });

    const gmToken = AuthenticationService.verify(gmLogin.accessToken);
    const plToken = AuthenticationService.verify(plLogin.accessToken);
    const obToken = AuthenticationService.verify(obLogin.accessToken);

    assert(gmToken.token?.role === 'GM', 'GM 角色正确');
    assert(plToken.token?.role === 'PL', 'PL 角色正确');
    assert(obToken.token?.role === 'OB', 'OB 角色正确');
}

// ==========================================
// 测试汇总
// ==========================================
console.log(`\n${'='.repeat(60)}`);
console.log(`✅ 通过: ${passCount}/${testCount}`);
console.log(`❌ 失败: ${testCount - passCount}`);
console.log(`${'='.repeat(60)}\n`);

if ((testCount - passCount) > 0) {
    process.exit(1);
}
