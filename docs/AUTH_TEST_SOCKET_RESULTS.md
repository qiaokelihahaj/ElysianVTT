# Socket 认证边界测试结果

实测日期：2026-09-11。Luna（gpt-5.6-luna，max）子代理编写测试，因用量限制中断；主代理完成撤销事件监听时序修正、实际执行和本报告。未修改运行时认证逻辑。

## 执行结果

```text
pnpm exec tsx test/auth-isolated.runner.ts auth-boundary-socket.test.ts

[socket-summary] passed=3 securityFailures=3 environmentErrors=0
[result] auth-boundary-socket.test.ts exit=1
[isolation] development DB and schema SHA-256 unchanged
[summary] files=1 failing=1 environmentErrors=0
```

共四个独立 fixture，每个建立两个真实 socket.io-client，连接真实 createApp/SocketServer/PermissionService。绑定 127.0.0.1 随机端口，使用 WebSocket transport。认证通过真实 HTTP 登录与 AUTHENTICATE；数据库授权来自临时 SQLite，未直接设置 socket.data 或替换鉴权逻辑。测试包包含 47 个当前 TS 输入；仅数据库 datasource 被替换为临时库。

| 安全期望或正向对照 | 实际观察 | 结果 |
| --- | --- | --- |
| 未认证连接不能 JOIN | 明确收到 ERROR / UNAUTHENTICATED | 通过 |
| PL 不能选择授权快照之外的 actor 加入场景 | 收到 SCENE_SYNC，服务器记录所选未授权 actor 已加入 | 失败 |
| PL 不能进入没有 scene grant 的场景 | 收到 SCENE_SYNC，服务器新建并激活请求场景 | 失败 |
| 撤销前两个会话均可 RESYNC | 返回包含获授权 actor 的 SCENE_SYNC | 通过 |
| 会话撤销后不能通过 RESYNC 取数据 | HTTP 已返回 401，但该 Socket 仍收到包含 actor 的 SCENE_SYNC | 失败 |
| 撤销一个会话不影响另一有效会话 | 第二个 Socket 仍正常 RESYNC | 通过 |

每个 fixture 还验证第二个 Socket 的登录、认证、JOIN 和 RESYNC 正向链路。超时、fixture 不成立、连接错误和清理失败按环境错误处理，不用无响应充当安全通过。

## 定位与影响

- `packages/backend/src/network/SocketServer.ts` 的 JOIN_SCENE（约160行）使用客户端 sceneId/actorId 创建主体并进入场景，未先据已有授权拒绝上述请求。本测试证实越权入场/选择角色；没有进一步发送战斗动作，不能把结果扩大为已验证的完整战斗控制。
- 同文件 RESYNC（约300行）只检查 currentSceneId，随后直接返回场景数据。HTTP logout 已撤销会话，现有连接仍可获取该数据；HTTP 的令牌校验通过不能证明 Socket 会话生命周期安全。
- 所谓“未授权场景”在 fixture 中没有授予该用户 join_scene 的记录，且不是已有生产战役。当前持久化模型没有 CampaignMember，本测试不声称已覆盖完整跨战役隔离。

## 清理与限制

测试使用内部 io/campaignManager 仅关闭服务器、销毁测试场景与空闲计时器；未用内部访问篡改授权。每个 fixture 清理临时授权、角色、快照和连接，撤销测试会话，最后断开 Prisma。执行器自动删除本次临时数据库和 bundle，开发库/schema 哈希未变。

撤销监听在 HTTP logout 前安装，避免正确实现立即踢出连接时漏掉事件。本次实际观察到的是撤销后仍返回 SCENE_SYNC，而非仅凭超时推断缺陷。

未覆盖：所有主动广播类型、隐藏字段/FOV 的完整过滤、决策事件越权、Socket 到期计时、并发 JOIN/re-auth、同一会话的浏览器多标签页、polling transport、浏览器 Cookie/CSRF/CORS。测试采用两份不同的 PL 会话，不等价于同一 Cookie 的两个标签页。新设计尚未实施，本次没有修改生产代码以使失败断言转绿。
