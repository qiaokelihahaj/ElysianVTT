# ElysianVTT 认证边界测试报告

实测日期：2026-09-11（Asia/Shanghai）。本报告的 HTTP 结果来自今日单文件实测；旧套件记录另标来源。

结论：当前 TS 源码的匿名拒绝和会话过期路径通过；客户端自选 GM、仅凭 `sessionId` 登出他人会话、敏感 URL token 三项目标安全契约仍未实施。新增 HTTP 测试因此按安全预期以 `exit=1` 结束，不把当前漏洞行为记为通过。

## 测试范围与隔离

- 只使用当前 `.ts` 源码；隔离 runner 的 esbuild 输入检查显示未引入 `packages/backend/src` 或 `packages/shared/src` 下的 `.js` 源码产物。
- 真实调用 `createApp()`，监听 `127.0.0.1` 随机端口；未连接已运行服务器。新增测试位置：`test/auth-boundary-http.test.ts:94-112`。
- 新测试显式检查 `ELYSIAN_AUTH_TEST_DB` 为带 `elysian-auth-test-` 的 `file:` URL（`test/auth-boundary-http.test.ts:134-138`），并导入真实 Prisma client（`test/auth-boundary-http.test.ts:5`）。新增测试没有写入数据库，只在空隔离 schema 上执行真实 repository 查询。
- 今日 HTTP 运行由 runner 新建临时 SQLite，并使用真实 Prisma datasource override，结束后自动清理。runner 输出确认开发 `dev.db` 与 schema SHA-256 未变化。runner 会读取文件字节计算哈希，但测试 Prisma 不连接开发库，也不写入开发库。
- 安全断言失败使用 `exit=1`；隔离/fixture/runner 环境错误使用 `exit=2`。本次没有环境错误。
- 三处修正今日核对已落盘，无需再修改测试：独立 `urlTokenFixture` 在第 166 行建立，第 225、236 行使用；通信/JSON 解析异常由 `runCase` 第 49-55 行转为 `AUTH_TEST_ENVIRONMENT_ERROR`，顶层第 304 行设置 `exitCode=2`；第 65 行使用 `AbortSignal.timeout(5000)`。本次正常通信，未额外注入环境故障验证该分支。

## 实际命令与结果

### 四个现有 TS 测试（2026-09-07 历史记录）

以下为此前已完成的运行记录，今日本代理没有重跑。历史执行命令：

```text
pnpm exec tsx test/auth-isolated.runner.ts auth.test.ts permission.test.ts visibility-and-logs.test.ts security-regression.test.ts
```

该命令退出码：`0`。runner 输出：`files=4 failing=0 environmentErrors=0`。

| 文件 | 退出码 | 通过统计 |
| --- | ---: | ---: |
| `test/auth.test.ts` | 0 | 27/27 |
| `test/permission.test.ts` | 0 | 30/30 |
| `test/visibility-and-logs.test.ts` | 0 | 33/33 |
| `test/security-regression.test.ts` | 0 | 21/21（该文件未打印汇总，按源码中的 21 个 `assert` 调用统计） |

旧测试的语义限制仍存在：`test/auth.test.ts:120-132` 只检查 `expiresAt` 在未来，没有真正推进时间；`test/permission.test.ts:132-134` 仍将 GM 进入任意场景作为成功语义；`test/security-regression.test.ts:88-96` 使用 URL token，`test/security-regression.test.ts:108-126` 的 logout 只提交 `sessionId`。这些文件未修改。

主代理于 2026-09-11 回报今日独立复核：`auth-isolation` 3/3、`auth.test` 27/27、`permission` 30/30、`visibility` 33/33、`security-regression exit=0`；五文件 runner 汇总 `files=5 failing=0 environmentErrors=0`，开发库/schema SHA-256 不变。此段是主代理提供的结果，不计入本代理今日执行次数，也不补写未收到的完整命令。

### 新增 HTTP 边界测试

2026-09-11 实际执行命令（仅此一个文件）：

```text
pnpm exec tsx test/auth-isolated.runner.ts auth-boundary-http.test.ts
```

结果：命令退出码 `1`；runner 报告 `current TS inputs=15`、`fresh SQLite`、`real Prisma datasource override`，并输出 `files=1 failing=1 environmentErrors=0`。测试本身共 14 个断言：通过 `6`，失败 `8`。

通过的断言（6/14）：

- `test/auth-boundary-http.test.ts:169-184`：匿名访问 `/permissions/me`、`/logs`、`/permissions/grant` 均返回 `401/UNAUTHENTICATED`。
- `test/auth-boundary-http.test.ts:244-275`：在真实 HTTP Bearer 路径上，过期前会话按已认证 PL 处理；受控 `Date.now` 推进到 `expiresAt + 1` 后返回 `401/INVALID_TOKEN`；恢复 `Date.now` 后会话按真实时间恢复有效。

失败的安全断言（8/14）：

- `test/auth-boundary-http.test.ts:187-202` 的 3 个断言：无凭据请求却指定 `role: GM` 未返回 4xx、未返回失败响应，并返回了 `accessToken`。当前实际行为是接受客户端提交的身份字段并成功登录。
- `test/auth-boundary-http.test.ts:204-220` 的 3 个断言：无凭据仅提交他人 `sessionId` 的 logout 未返回 4xx、未返回失败响应，且后续受害会话已失效。当前实际行为是匿名请求直接撤销该 session。
- `test/auth-boundary-http.test.ts:222-242` 的 2 个断言：独立、未被 logout 撤销的会话 token 放入 `/permissions/me` 或 `/logs` URL，均未返回设计要求的 `TOKEN_IN_URL_DISABLED`。实际输出如下，不包含 token 或 sessionId：

| URL 入口（省略凭据） | 实际 HTTP status | 实际 code |
| --- | ---: | --- |
| `/permissions/me` | 200 | 无该字段（输出为 `<none>`） |
| `/logs` | 200 | 无该字段（输出为 `<none>`） |

这次独立会话的实测替代早期复用已撤销 victim 的 URL 检查；早期结果不足以证明有效 URL token 被接受。当前 `/logs` 使用空隔离库，因此只证明入口接受 URL 凭据，不证明泄露了具体日志内容。

## 当前实现与设计差距

1. **登录身份可由客户端指定。** `packages/backend/src/app.ts:24-40` 从请求体读取 `userId` 和 `role`，并直接传给 `AuthenticationService.login()`；`packages/backend/src/auth/AuthenticationService.ts:49-78` 没有凭据或数据库用户校验，直接把请求角色写入会话。因此新增测试观察到无凭据 GM 登录成功。

2. **logout 没有当前会话证明。** `packages/backend/src/app.ts:58-73` 只检查 body 中的 `sessionId` 并调用 revoke；`packages/backend/src/auth/AuthenticationService.ts:123-128` 对该 ID 做进程内撤销。因此匿名请求可以撤销别人的会话，新增测试的后续 Bearer 请求随之变成无效。

3. **敏感入口接受 query token。** `/permissions/me` 在 `packages/backend/src/app.ts:94-107` 读取 `req.query.token`，`/logs` 在 `packages/backend/src/app.ts:178-204` 同样读取 query token。设计提案要求任意敏感 `?token=...` 返回稳定的 `TOKEN_IN_URL_DISABLED`（`docs/AUTHENTICATION_BOUNDARY_DESIGN.md:105-110`、`139-151`）；当前实现仍会验证并使用有效 URL token。

4. **过期检查当前路径有效，但仍是内存会话。** `packages/backend/src/auth/AuthenticationService.ts:47` 使用进程内 `SESSION_POOL`，`packages/backend/src/auth/AuthenticationService.ts:99-116` 检查 session、撤销、版本和 `Date.now()`。新增测试用受控时钟证明了当前 HTTP Bearer 路径在超过 `expiresAt` 后拒绝请求；这不等同于数据库权威会话、Cookie 会话或 Socket 过期广播已经实现。

5. **提案中的 Cookie、CSRF 和新认证入口尚未实施。** 设计文档明确标注“提案，尚未实施”（`docs/AUTHENTICATION_BOUNDARY_DESIGN.md:3`），目标登录契约为 `loginName/password`（`:93`），目标会话为安全 Cookie（`:95`），并要求 CSRF/Origin 边界（`:105-112`）。本次没有把 `/auth/csrf`、`/auth/me`、Cookie 属性、CSRF nonce、Origin 拒绝或 `TOKEN_IN_URL_DISABLED` 的未来实现当成当前已存在功能。

## 限制与未覆盖项

- 新测试使用当前仍存在的 HTTP `userId/role` 登录接口创建最小 PL 会话 fixture；fixture 只服务于测试 logout、URL token 和过期路径，不代表该登录流程安全。未来登录接口切换为真实凭据后，应替换为隔离账号/凭据 fixture。
- 新测试未写入隔离数据库；因此未覆盖真实用户密码、成员资格、campaign/scene 关系或 grant 作用域。空库查询只用于让真实 repository 路径保持启用。
- 未启动或连接 `SocketServer`，也未声称覆盖 Socket Origin、AUTHENTICATE、JOIN、撤销后的出站广播或多连接生命周期。Cookie 的 `HttpOnly/Secure/SameSite`、浏览器 CORS/CSRF 行为也不能由 Node `fetch` 证明。
- 未运行 `pnpm test:security`，避免其旧 runner 直接使用原数据库；本报告只记录上述隔离 runner 命令。
- 未修改运行时代码、依赖、Prisma schema、`dev.db`、未跟踪 `.js` 或主代理的 runner。
- 今日只执行上述 HTTP 单文件命令；未执行旧四套件、构建、lint、Socket 或浏览器测试，因为本次范围仅为既有 HTTP 测试核对及报告更新。HTTP 测试代码已有要求的修正，本轮仅更新本报告。
