# LAN 首期浏览器验收

这套验收针对构建后的 ElysianVTT Demo。它启动真实 `DemoServer` 子进程和生产前端，使用 loopback 动态端口以及本次运行专用临时存档；浏览器驱动通过正式登录、角色分配、动作、反应和 GM 控件完成场景，不调用 store 或引擎接口。

## 命令

在仓库根目录使用 Node.js 22.x、pnpm 10.x：

```powershell
pnpm install
pnpm test:lan
pnpm --filter test exec playwright install chromium
pnpm test:lan:browser
pnpm verify:lan
```

`test:lan` 通过 `test/auth-isolated.runner.ts` 依次运行显式的认证、权限、可见性、Demo 网络、控制权、反应、结算和重连回归文件。执行器为每个文件创建临时 SQLite，并校验 `packages/backend/prisma/dev.db` 与 schema 的哈希没有变化。人工通用服务器夹具 `combat-browser.test.ts` 保留为单独测试，不属于这个清单。

`test:lan:browser` 需要已经存在的 shared、backend 和 frontend 构建产物，以及通过 `pnpm --filter test exec playwright install chromium` 安装的 Chromium。默认使用 headless Chromium；传入 `--headed` 可显示窗口。脚本只等待服务实际就绪，不重试失败场景。它覆盖四个隔离 Chromium context：GM、先锋玩家、游侠玩家和引导玩家；同一玩家的第二个 Socket 在独立页面中验证连接计数。

浏览器场景依次覆盖：

1. 四身份通过 UI 登录，GM 分配三个角色并开始遭遇。
2. 玩家移动、全员行动屏障和近战攻击；玩家页面只能看到服务器过滤后的可见信息。
3. 反应接入与选择，其中一个玩家在决策期间断线并用相同 context 重连；其他窗口等待超时后自动继续。
4. GM 通过裁决台调整资源并追加修正，明确结束遭遇，等待结算保存。
5. 真正停止 DemoServer 子进程，在同一数据目录重新启动并通过 UI 重新登录；用持久化接口确认已保存结果，而不是把 `GM_RESTART` 当作进程重启。

结果写入仓库根目录 `.tmp/lan-browser-<timestamp>/`：成功运行生成 `report.json` 与 `diagnostics.log`，失败时另外生成敏感控件已处理的截图和经过重写的 Playwright trace。原始 trace 只存在于系统临时目录，并在退出路径清理；凭据、加入码、Authorization 和 session token 会在文本与图像证据中遮盖。浏览器、服务进程、Socket 与本次临时数据目录均在退出路径清理。

退出码按失败类型区分：`1` 为场景断言或超时，`2` 为环境失败。环境错误消息使用 `BUILD_MISSING`、`BROWSER_MISSING`、`SERVER_START_FAILED` 等具体前缀；失败诊断不会通过重试掩盖问题。

## 已知边界测试

`auth-boundary-http.test.ts` 当前 14 个断言中通过 6 个、失败 8 个；失败来自旧通用认证入口的既有凭据、匿名 logout 和 URL token 问题。它不加入默认 `test:lan` 必过清单，仍可单独通过隔离 runner 执行并保留失败结果。该问题与 Demo 独立入口的本期验收分开记录。

## 数据库基线

本轮开始前开发数据库 `packages/backend/prisma/dev.db` 的 SHA-256 为：

`04445C5BCCBBC5C6B1DE6C16F663D582818A74885D42A322FBE06A671B77EAE8`

浏览器验收使用临时数据目录，不应修改这个文件；交付时应再次计算并报告相同哈希。

## 本轮验证结果（2026-09-18）

`pnpm verify:lan` 实际运行通过：shared → backend → frontend 构建、前端 lint、31 个隔离服务回归文件及 9 个浏览器场景均通过。浏览器报告确认 `cleanupErrors: []`、`databaseUnchanged: true`。新增浏览器脚本另通过 TypeScript strict 检查。

浏览器缺失路径也已验证：仅对测试进程设置不存在的 `PLAYWRIGHT_BROWSERS_PATH` 后，命令报告 `BROWSER_MISSING` 并返回退出码 `2`；不会跳过或误报通过。根 browser 命令直接调用 `tsx`，避免额外的包管理器包装改变退出码。

`docker compose config --quiet` 解析通过，但本轮未启动 Docker 容器。浏览器使用同机四个独立 context，不代表已验证真实路由器、跨设备或弱网性能。服务重启后验证既有结算记录与开局布局保留，并重新登录大厅；不承诺战斗中任意 Tick 的精确续局。
