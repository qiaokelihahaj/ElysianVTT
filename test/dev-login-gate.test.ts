import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../packages/backend/src/app.js';
import { AuthenticationService } from '../packages/backend/src/auth/AuthenticationService.js';

async function main(): Promise<void> {
  const originalMode = process.env.NODE_ENV;
  const originalFlag = process.env.ELYSIAN_ENABLE_DEV_LOGIN;
  const server = createServer(createApp());
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    for (const [mode, flag, allowed] of [
      ['test', undefined, false], ['development', '0', false],
      ['production', '1', false], ['test', '1', true],
    ] as const) {
      process.env.NODE_ENV = mode;
      if (flag === undefined) delete process.env.ELYSIAN_ENABLE_DEV_LOGIN;
      else process.env.ELYSIAN_ENABLE_DEV_LOGIN = flag;
      const response = await fetch(`http://127.0.0.1:${address.port}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'gate-test', role: 'GM' }),
      });
      const body = await response.json() as { code?: string; data?: { sessionId: string } };
      assert.equal(response.status, allowed ? 200 : 403, `${mode}/${flag}`);
      if (allowed) {
        assert.ok(body.data);
        AuthenticationService.revoke(body.data.sessionId);
      } else assert.equal(body.code, 'DEV_LOGIN_DISABLED');
    }
    console.log('dev-login-gate: default denial, production denial and explicit development opt-in passed');
  } finally {
    if (originalMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalMode;
    if (originalFlag === undefined) delete process.env.ELYSIAN_ENABLE_DEV_LOGIN; else process.env.ELYSIAN_ENABLE_DEV_LOGIN = originalFlag;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
