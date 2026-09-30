# 认证边界测试汇总

日期：2026-09-11。对象：当前工作区 TS 源码；[认证边界设计](./AUTHENTICATION_BOUNDARY_DESIGN.md)仍是未实施提案。

## 结果

| 测试 | 结果 | 说明 |
| --- | --- | --- |
| 隔离工具自检 | 3/3 通过 | 真实 Prisma、空白库、临时写入 |
| auth.test.ts | 27/27 通过 | 当前认证服务行为 |
| permission.test.ts | 30/30 通过 | 包含全局 GM 进入任意场景的旧语义 |
| visibility-and-logs.test.ts | 33/33 通过 | 过滤器单元行为，不等同于真实广播安全 |
| security-regression.test.ts | exit 0 | 当前 HTTP 回归；不以源码 assert 数量冒充运行器统计 |
| 新增 HTTP 边界 | 6/14 通过，8 项失败 | 3 类边界缺口；环境错误 0 |
| 新增 Socket 边界 | 3/6 通过，3 项失败 | 真实双客户端；环境错误 0 |

新增边界测试共20项断言，9项通过、11项失败；11项失败不是11个独立漏洞。旧四套件全部通过仍不能说明目标认证边界安全。

## 已复现的缺口

1. 无凭据请求能指定 GM 角色登录并得到 accessToken。
2. 匿名请求仅提交他人的 sessionId 即可撤销该会话。
3. 有效 token 放入 /permissions/me 和 /logs URL 仍返回 HTTP 200；这证明凭据入口开放，不代表本次空库泄露了具体日志。
4. PL 能选择授权快照之外的 actor 加入场景；本次没有继续发送战斗动作。
5. PL 能进入没有场景授权的场景。
6. HTTP 已确认会话撤销（401），已连接 Socket 仍能 RESYNC 获取场景数据。

建议实施时优先关闭任意身份/角色登录和未授权 JOIN，再让会话撤销作用于全部 Socket 输入与出站路径，同时迁移 logout 和 URL 凭据接口。此次只测试和记录，未实施修复。

## 可复现命令

以下命令本日已分别执行，新增安全测试退出码1表示期望未满足，不是环境错误。

```text
pnpm exec tsx test/auth-isolated.runner.ts auth-isolation.test.ts auth.test.ts permission.test.ts visibility-and-logs.test.ts security-regression.test.ts
pnpm exec tsx test/auth-isolated.runner.ts auth-boundary-http.test.ts
pnpm exec tsx test/auth-isolated.runner.ts auth-boundary-socket.test.ts
```

隔离执行器为每个文件建立空白临时 SQLite，只替换 Prisma datasource，使用真实服务与当前 TS/shared 源码，避开遗留同名 JS。临时库、bundle、服务器与连接均在执行后清理；各次运行报告开发 dev.db/schema SHA-256 未变化。未运行原 test:security 入口，因为它没有这套数据库隔离措施。

Luna（max）完成 HTTP 测试编写与复测、Socket 脚本编写；Socket 代理因用量限制中断后，由主代理校正事件监听时序并执行。主代理还完成隔离工具及本日旧套件复核。不是全部结果都由子代理独立执行。

详细证据与限制见 [HTTP 报告](./AUTH_TEST_HTTP_RESULTS.md)、[Socket 报告](./AUTH_TEST_SOCKET_RESULTS.md)。尚未验证所有广播/决策事件、浏览器 Cookie/CSRF/CORS、多标签页与完整设计验收；未执行全项目构建、前端 lint 或无关战斗测试。本轮遵循 Karpathy 技能的最小改动与可验证结果原则，保留安全失败断言，没有为通过测试修改生产逻辑。
