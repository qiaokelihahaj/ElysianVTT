# 基本战斗闭环联调（2026-09-12）

## 已验证路径

此前及本轮复验均使用 TypeScript 后端、实际前端生产构建、临时 SQLite。未使用开发数据库进行战斗。

1. 浏览器打开 `http://localhost:3000`，自动登录为测试 GM，进入 `room_1`，显示两个角色。
2. 选择勇者，打开 Move，在画布选择相邻格并确认：坐标从 `(0,0,0)` 变为 `(1,0,0)`，Tick 到 16。
3. 选择 Heavy Strike，再点击实体列表中的对手：HP 从 50 变为 25，出现决策倒计时；自动跳过后完成收招，Tick 到 22。
4. 再次选择 Heavy Strike 和对手：HP 变为 0，显示“战斗结束·已结算”，终局 Tick 为 25，存活 1、倒下 1。动作栏禁用，决策和动作时间线清空。
5. 刷新页面重新认证/入场，仍显示终局摘要、相同位置与 HP，动作栏保持禁用。
6. 从测试服务读取真实 SQLite：勇者 HP=50、对手 HP=0。测试服务通过正常退出流程清理。

以上是实际浏览器操作，不是直接调用 store 模拟点击。独立自动化测试另覆盖两个真实 Socket、HTTP 登录、IntentRouter、引擎广播、RESYNC 和持久化。

此前第一轮真实浏览器闭环是在本轮 `triggerInterrupt` 中断修复之前完成的，作为历史证据保留。本轮修复后，主进程已再次完成以下真实浏览器闭环复验：

1. `Move`：坐标从 `(0,0,0)` 变为 `(1,0,0)`，Tick 到 16。
2. 第一击 `Heavy Strike`：HP 从 50 变为 25；决策倒计时自动跳过后完成收招，Tick 到 22。
3. 第二击 `Heavy Strike`：HP 变为 0，Tick 到 25，显示“战斗结束·已结算”；动作栏禁用。
4. 刷新页面重新认证/入场：仍显示相同终局、位置与 HP。
5. 通过 `/__test/result` 读取实际数据库：敌人 HP=0、勇者 HP=50；随后调用 `/__test/finish`，测试服务正常关闭。

## 闭环实现记录（对应上述此前浏览器验证）

- 其他连接的自动跳过不再提前消耗已接战窗口的响应资格。
- 动作栏接入选目标模式；画布与实体列表共用目标选择逻辑，保留施法者。
- 前端接收 COMBAT_END，显示结算摘要并清理临时交互状态。
- SCENE_SYNC 加入可选终局摘要，兼容旧客户端；战斗结束后拒绝新行动意图。

## 当前已验收的独立验证记录

- 当前最终代码的真实 `engine.integration` 与 `interrupt/channel` 验收通过：`files=3`、`failing=0`、`environmentErrors=0`。
- 真实 `engine.integration` 已覆盖 `Recovery tick<null tick`、`resolveTick` 等于清理 tick、正常两击、三脉冲，以及死亡不复活。
- 六个隔离回归全部通过：`authenticated-loop`、`decision-ownership`、`extraction`、`hook-timing`、`socket-e2e`、`socket-hook-lifecycle`。
- 隔离运行期间开发数据库与 schema 的 SHA256 保持不变。
- Luna 实现已完成并通过上述验收，不再标记为待修复。
- shared、backend 与 frontend 构建通过；frontend build 仍有两个无效动态 import 警告。
- `frontend-combat-result` 与 `frontend-resource-display` 两个前端回归通过；后者为 10 个 assertions。
- 定向 lint 通过：`HUD`、`ActionBar`、`EntityList`、`IntentDispatcher`、`RendererManager`、`resourceDisplay`。
- 全量 lint 仍有 41 个错误。

## 复现命令（仓库根目录）

```powershell
pnpm exec tsc -b packages/shared packages/backend
pnpm --filter @hard-vtt/frontend build
pnpm exec tsx test/auth-isolated.runner.ts combat-authenticated-loop.test.ts combat-decision-ownership.test.ts combat-extraction.test.ts hook-timing.test.ts socket-e2e.test.ts socket-hook-lifecycle-e2e.test.ts engine.integration.test.ts interrupt.test.ts channel.test.ts
pnpm exec tsx test/frontend-combat-result.test.ts
pnpm exec tsx test/frontend-resource-display.test.ts
```

浏览器夹具（先构建前端，确保 3000 端口空闲）：

```powershell
pnpm exec tsx test/auth-isolated.runner.ts --browser combat-browser.test.ts
# 浏览器打开 http://localhost:3000；不是 127.0.0.1，以匹配默认前端 API 地址。
# 验证结束：
Invoke-RestMethod -Method Post http://localhost:3000/__test/finish
```

夹具只监听 loopback、最多运行 30 分钟；重击使用固定 25 伤害模板。普通测试仍保持 60 秒超时。夹具的 ready/exit 不代表人工 UI 检查自动通过。

## 范围与剩余问题

- 基本本地 GM 战斗闭环已验证；以上结果只证明已列出的局部路径，不代表全部技能、复杂多人权限、生产安全或整个战斗系统已验收。
- 旧 `interrupt.test` 使用内联模拟，不能证明生产 `triggerInterrupt` 的行为。
- 全量前端 lint 仍有 41 个错误；仅上述定向 lint 已通过。
- 认证边界的既有安全问题、接战中断线超时、后端进程重启后的终局恢复，以及多阵营胜负条件仍需独立完善。这里验证的是同一服务进程内的浏览器刷新恢复。
