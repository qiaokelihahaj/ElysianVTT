# 2026-10-01 代码审计与修复

本次按日常跑团场景审阅 `packages` 下 137 个 TypeScript/TSX 源文件（backend 82、frontend 51、shared 4），并检查测试入口、环境检查及构建配置。重点是状态正确性、动作生命周期、多标签和重连、隐藏信息、存档缓存与界面资源释放；未扩展公网认证设计或做高并发压力测试。

开始时工作区已有大量未提交改动。修复对照本轮源码基线实施，没有回滚已有工作，没有删除同名未跟踪 `.js`，没有改 Prisma schema 或开发数据库。

## 修复的主要问题

| 模块 | 问题与修复 |
| --- | --- |
| Tick/队列 | 已过期事件会让队列不能前进；现在消费迟到事件而不倒退时间。队列快照不再暴露可改写的堆数组，TickLoop 使用公开队列接口。 |
| 动作生命周期 | DODGE/MICRO_EVADE 的恢复事件与上下文 ID 不一致；内置姿态事件被模板查找拦截；取消意图没有进入实现。修复恢复、姿态和取消路径，ACTIVE 保持不可逆。战斗转向沿用现有角速度和 Tick 成本排队，忙碌角色不能被覆盖。 |
| Hook/探索 | 同 ID 预设追加旧版本、坐标系混用、TTL 边界不一致；探索先更新前位置而漏掉区域进入，途经陷阱与 cooldown 被忽略。现在逐路径段检测并沿用一次性/冷却语义，拒绝地图外格子。 |
| 空间/迷雾/弹道 | 修复多人视野互相覆盖、非观察者揭雾、卸载后遗留视野、首次探索记录、投射物跳过首航点与不同高度直射终点。寻路支持低成本瓦片与可行走门；移动时间轴按模板、地形与冲刺的实际耗时预测。 |
| 资源/公式 | 治疗将明确的零上限当作无限制；非有限公式结果能污染资源。修复零值语义，按现有求值失败契约处理 NaN/Infinity；骰子覆盖保留原始骰面，并以索引遍历替代队列反复 shift。 |
| 角色持久化 | 修复查询顺序随缓存命中改变、多个角色共享默认对象、运行中实体修改污染缓存，以及转场/删除/结算未刷新缓存。返回独立快照，集中清理受影响缓存。 |
| 规则加载/日志 | 拒绝非法规则数组元素、字段类型和动作时序，重载字典会移除已删除模板。日志保留 Tick 0、同时应用上下界，单条损坏的 metadata 不再导致整页日志消失。 |
| 网络/决策 | 使用认证主体的控制与场景授权；注销后拒绝继续操作。多标签按 socket 计数，切场景移除旧 room。断线释放连接接战所有权，协调遭遇保留原选择 deadline 以便重连；取消源动作同时释放反应预订。场景广播按引擎事件顺序发送，防止异步查找连接导致结束通知先于开启通知。 |
| 可见性 | 初始同步、重连和增量共用接收者过滤，隐藏实体、嵌套引用、投射物轨迹及其他角色的决策均在服务器边界处理；保留公开敌人与纯 Tick 推进。 |
| GM 修正 | 声明与编辑共用目标校验。资源修改会刷新结算状态，位置修正通知空间系统；界面清除目标发送空数组，调整隐藏实体数值不会意外将其公开。 |
| 前端状态/异步 | 完整同步、删除实体、切会话清理旧动作/移动/决策/UI；HTTP 与 socket 快照统一版本检查。迟到请求不能在退出、切会话或卸载后恢复旧连接/角色/保存状态。旧技能结果的定时器不会清掉新结果；同模板动作按当前 actionId 匹配。 |
| Pixi/工具配置 | 取消卸载期间的初始化，重新挂载重建图层，清理特效计时器与缓存。环境检查诊断失败时返回非零退出码。 |

## 冗余剪裁与测试入口

- `backend-utils`、`fow`、`frontend-store` 三份默认测试改为导入生产实现，共减少 741 行；校正战斗集成与双角色测试对真实决策窗口和 eager processing 的时序假设。
- 移除无调用的裸广播 API、无用 session hash/静态代理、死变量和重复探索 Hook/区域包装；合并初始同步与重连路径、动作目标校验、缓存失效与特效闪屏处理。
- 默认 smoke/unit/integration/security 以及旧安全测试入口均使用已有隔离 runner：优先当前 TS、每文件临时 SQLite，并检查开发库/schema 哈希。
- 测试不再每次重复生成 Prisma Client。首次安装或 schema 变化后需显式执行 `pnpm db:generate`。
- 新增 `pnpm test:audit` 与 `pnpm test:audit:browser`，前者聚合本轮生产源码回归，后者用实际 Chromium/React 验证异步生命周期。

## 已运行验证

| 验证 | 实测结果 |
| --- | --- |
| `pnpm test` | 4 文件通过 |
| `pnpm test:unit` | 3 文件通过，双角色 79/79 |
| `pnpm test:integration` | 106/106 |
| `pnpm test:security`、安全兼容入口 `pnpm exec tsx test/security-suite.runner.ts` | 均为 4 文件通过 |
| `pnpm test:audit` | 13 文件通过 |
| `pnpm test:lan` | 52 文件通过 |
| `pnpm test:tactics` | 5 文件通过 |
| `pnpm test:audit:browser` | 实际 Chromium/React 生命周期回归通过 |
| `pnpm test:lan:browser` | 四客户端的 16 场景通过，清理无错误 |
| `pnpm test:tactics:browser` | 空间战术实际界面通过 |
| shared build、backend `exec tsc`、frontend build | 均通过 |
| frontend lint | 通过 |

所有数据库回归使用临时库，执行器确认开发数据库与 schema 的 SHA-256 未变化。日志和本轮基线在 `.tmp/code-audit-20261001/`。

最终代码检查对照本轮基线：56 个已有文件有任务相关变更，新增 14 个审计测试和本报告；无基线文件被删除，新增 diff 空白检查通过。多人浏览器证据在 `.tmp/lan-browser-1790801975583/report.json`，战术界面证据在 `.tmp/spatial-tactics-browser/`。

`pnpm build` 的 backend prebuild 在 `prisma generate` 阶段遇到 Windows `query_engine-windows.dll.node` 被占用的 EPERM。未终止用户进程；schema 没有变化，因此使用现有客户端单独完成 shared → backend → frontend 构建验证。

## 范围边界

- 公网 HTTP 身份认证重设计仍是既有提案，本轮没有迁移 Cookie、用户/战役成员表或认证协议；历史 HTTP 攻击边界测试未作为本轮必过验收。
- `GAMBIT_PRESET` 仍是未实现的功能占位，没有为审计扩展玩法。
- 历史 InteractionPanel 的检定仍是本地模拟，HookEditor 的 `ACTION_PHASE_DELAY` / `ENEMY_CASTS_SPELL` 仍缺执行实现；保留原型入口，没有扩展玩法。
- 仍有历史测试使用内联模拟（例如 `core.test.ts`）；本轮缺陷验证使用真实生产源码回归，未将这些模拟视为修复证据。
