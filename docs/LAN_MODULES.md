# 局域网正式模块与职责划分（行动路径第二、三阶段）

可玩入口仍是 `pnpm demo` / `pnpm demo:start`。Demo 组合根现在调用正式模块，前端继续使用现有 React、Zustand、SVG 界面。

| 模块 | 职责 |
| --- | --- |
| `sessions/LanSessionService.ts` | 主持/玩家登录、会话、控制权记录与逐 socket 连接生命周期 |
| `encounters/EncounterCoordinator.ts` | 组合遭遇服务，维护连接/控制权、总体生命周期、版本、Tick 推进与状态发布 |
| `encounters/ActionPlanService.ts` | 动作提交校验、待提交计划和历史、屏障到引擎 intent 的转换 |
| `encounters/DecisionWindowService.ts` | 决策窗口、响应收集、资源预留、触发链与期限处理 |
| `encounters/GmCommandService.ts` | GM 实体/控制权修正及审计；暂停、结束、重开仍由编排器协调 |
| `rules/ActionCatalog.ts` | 动作目录接口、实例内存实现与共享模板校验 |
| `encounters/EncounterGameLogBridge.ts` | 引擎事件转为遭遇日志 |
| `encounters/GmCorrectionValidation.ts` | GM 修正的运行时校验 |
| `network/EncounterServer.ts` | HTTP、Socket、逐连接可见性过滤、命令 ACK、存档协调 |
| `persistence/EncounterRepository.ts` | 开局、检查点、结算和历史读取的业务存储接口 |
| `persistence/SqliteEncounterRepository.ts` | 现有 SQLite 存档格式的实现 |
| `demo/DemoServer.ts`、`demo/index.ts`、`demo/DemoContent.ts` | 组合服务、配置 LAN 启动、提供示例规则与角色 |

上述路径相对于 `packages/backend/src/`。正式模块不导入 `demo/`；旧 Demo 模块是薄包装或重导出，共用一份实现。

## 组合方式

`createEncounterServer` 要求显式提供 `content: EncounterRulePack`、`entities: EncounterEntity[]` 和 `persistence: EncounterRepository`，可传入自定义 coordinator factory。动作目录与可生成实体目录来自注入内容，移动动作按规则模板的移动语义识别。正式服务默认监听回环地址；Demo 组合根继续默认监听 LAN 地址。

调用者负责创建存储适配器，服务器成功创建后拥有其生命周期，`close()` 会关闭 socket、编排器、会话与存储。构造失败时，调用者应关闭自己创建的存储；Demo 包装已经处理这一情况。

## 兼容与边界

- `/api/demo/*`、`DEMO_*` 事件和共享的 `Demo*` payload 类型继续作为现有线协议使用，避免同时迁移客户端。
- `.demo/demo.db` 的默认位置、SQLite 表名与存档语义保持兼容；没有数据库迁移，也不承诺任意 Tick 精确续局。
- `demo/` 旧导入路径继续可用；无参数 Demo coordinator 仍提供示例内容，正式 coordinator 使用显式注入内容。
- Prisma 通用开发链路仍保持隔离，没有把旧认证或未完成的广播过滤接入局域网入口。
- 正式遭遇使用实例规则目录；未显式指定规则的旧 `CombatEngine` 调用仍使用 `DictionaryActionCatalog` 兼容适配。第四阶段的测量及保留完整快照的决策见[性能测量说明](LAN_PERFORMANCE.md)。

## 第三阶段：规则与状态归属

正式遭遇在构造时复制传入内容，建立自己的 `InMemoryActionCatalog`，并让动作提交、预览、反应及 CombatEngine 使用同一份目录。相同动作 ID 可以在两个遭遇中具有不同耗费、时序和效果；修改调用者原始内容或全局 Dictionary 不会改变已构造的正式遭遇。

CombatEngine 将目录继续传入同 Tick 的 ClashPool、时间线计算和投射物命中路径。独立引擎可通过第三个构造参数传入目录；显式加载数据库 RulePack 的调用方应 `await engine.ready()`，加载错误可被捕获。`bindActionCatalog` 只允许没有活动战斗工作的引擎更换目录。

正常 Demo 组合使用无全局副作用的 `createDemoContent()`。`installDemoContent()` 保留为旧独立引擎测试/调用的兼容帮助函数，仍会写全局 Dictionary，不能用它实现多规则实例隔离。

动作计划和反应集合分别由对应服务持有，GM 服务持有修正记录。Coordinator 通过明确的依赖端口协调这些服务，保留连接、控制权和全局遭遇生命周期；CombatEngine 保留权威实体、事件队列与规则结算。决策唤醒使用原有 deadline timer，Tick 推进仍按事件堆跳跃，没有改成逐 Tick 轮询。

## 验证

`pnpm verify:lan` 执行顺序构建、前端 lint、隔离服务测试和四浏览器上下文自动验收。第二阶段新增正式模块组合测试，使用非 Demo 内容验证内容注入和存储重开；原 Demo 回归继续验证旧导入与玩法兼容。浏览器验收仍包含真正跨进程重启。

第二阶段验证：完整 `verify:lan` 通过（34 个隔离测试文件、9 个浏览器场景）；随后完成的 `encounter-content-injection.test.ts` 单独通过隔离 runner，并加入默认列表。开发数据库与 schema 哈希保持不变。浏览器报告位于 `.tmp/lan-browser-1789685794458/report.json`，完整命令日志位于 `.tmp/verify-lan-phase2.log`，均为本地验收产物。

第三阶段验证：完整 `pnpm verify:lan` 通过，包含 shared → backend → frontend 构建、前端 lint、43 个隔离测试文件和 9 个浏览器场景。新增回归覆盖实例目录、完整动作结算链、遭遇及数据库 RulePack 的同名规则隔离。开发数据库与 schema 哈希保持不变；浏览器报告确认数据库未改变且无清理错误。浏览器报告位于 `.tmp/lan-browser-1789687563100/report.json`，完整命令日志位于 `.tmp/verify-lan-phase3.log`，均为本地验收产物。此验证使用同机四个浏览器上下文，不代表跨设备或弱网性能认证。

第四阶段验证：完整 `pnpm verify:lan` 通过，包含顺序构建、前端 lint、45 个隔离测试文件及 9 个浏览器场景。新增网络/Tick 基准与真实前端 store 重放可通过 `pnpm test:lan:perf` 单独复测；浏览器报告增加只读消息聚合统计。开发数据库与 schema 哈希不变，浏览器清理无错误。日志为 `.tmp/verify-lan-phase4.log`，性能结果为 `.tmp/lan-performance.json`，浏览器报告为 `.tmp/lan-browser-1789689908635/report.json`。本阶段完成测量与同步策略决策，没有实施真正增量协议或修改战斗规则。
