# 首个多人遭遇 Demo：实现与验收记录

首个可玩 Demo 已完成实现与本轮验收。启动方式见 [DEMO_QUICKSTART.md](DEMO_QUICKSTART.md)。

## 目标

局域网 1 GM + 3 PL，通过正式界面完成入场、角色分配、多人行动、连锁反应、GM 裁决、阵营结算与重开。沿用现有 CombatEngine、事件堆、RuleEvaluator 和 ClashPool，不创建模拟战斗替代路径。

## 已确认规则

- 主行动按当前可行动实体收集，全部就绪后统一提交，主行动无自动超时。
- WAIT 延迟下一次主行动 5 Tick，保留待机反应资格，不恢复资源。
- 普通反应仅 IDLE 可用、占用行动槽；10 秒接入、60 秒选择，由服务器计时。暂停冻结期限，断线不重置期限。
- 反应按实际 Tick 速度生效。每实体每条触发链至多一次反应，正耗时防止零 Tick 循环。
- 同 Tick 优先级容差为 0，同组深快照计算、统一提交，ACTIVE 效果不可撤销。
- STARTUP 维持资源 < 0 时打断，= 0 保留当前一击；引导所需专注 <= 0 停止未来脉冲。
- GM 可控制任意实体、刷怪、修正状态、暂停/单步、改未结算动作与优先级、代决和重开。接管递增控制版本；历史结果只追加修正，不回滚。
- 同步和日志按接收者过滤；服务器决定身份、控制权、动作合法性和全部结算结果。
- 使用独立 demo 数据库，在开局、结算及明确存档边界持久化；不修改开发数据库。

## 实施分工

由 Luna（max）实现有明确边界的核心、网络/存档、前端模块，主智能体负责环境、接口整合、独立回归与真实浏览器验收。每个阶段发现的问题反馈到原模块继续修订。

## 基线（2026-09-12）

- Node.js 22.19.0；pnpm 10.33.0。
- 开始时工作区已有大量未提交改动和同名未跟踪 JavaScript 文件；保留，不删除或回滚。
- 开发数据库 SHA-256：`04445C5BCCBBC5C6B1DE6C16F663D582818A74885D42A322FBE06A671B77EAE8`。
- `pnpm exec tsx test/auth-isolated.runner.ts combat-decision-ownership.test.ts socket-hook-lifecycle-e2e.test.ts`：2 文件通过，环境错误 0；数据库和 schema 哈希未变化。
- 沙箱内 pnpm/tsx 受系统信息访问限制；上述基线在获准的沙箱外环境执行，使用临时 SQLite 与当前 TypeScript 源码。
- 前端 lint 基线为 41 个错误，原始结果保存到本地 `.demo/verification/lint-baseline.json`；后续记录新增与既有问题，不能用旧文档代替本轮结果。

## 完成门槛

1. GM + 三名玩家以及同一玩家第二个 socket，验证就绪屏障、到达顺序独立、越权拒绝、重复/失效请求。
2. 三人反应链的及时/迟到打断、同 Tick 分组和相杀、资源 -1/0/1、引导中断与 Recovery。
3. 暂停/继续/断点/单步、断线/刷新、多窗口期限恢复与控制版本。
4. 隐藏实体、动作、反应与日志不出现在未授权客户端载荷。
5. 正式 UI 全部 GM 操作；一场胜利和一场失败/双方覆灭；结算保存、失败重试与重开。
6. 定向测试、shared → backend → frontend 构建、frontend lint、相关安全/集成和多浏览器验收；再次核对开发数据库。

下面保留实施过程和首次失败记录；最新验证结果以文末交付复验为准。

## 实施中的独立回归

以下运行使用当前 TypeScript 生产实现和 `auth-isolated.runner.ts`，不是内联复制引擎：

- `demo-clash-regression.test.ts`：6 场景通过；覆盖同组表达式读取初始状态、多人伤害叠加、延迟打断回调、韧性为 0 不判死亡、同级相杀、微小优先级差异打断 STARTUP 且保留 ACTIVE。
- `demo-session-regression.test.ts`：4 场景通过；覆盖两个 socket、退出释放名额、断线过期释放名额、连接重认证。首次运行 3 场景失败，修复后复验通过。
- `demo-persistence-regression.test.ts`：5 场景通过；覆盖独立存档与损坏结构拒绝。
- 以上各次运行均确认开发数据库和 schema SHA-256 未变化。
- `pnpm build:shared` 已通过当前共享协议构建。

`demo-acceptance.test.ts` 独立 HTTP/Socket 黑盒验收已通过：1 GM + 3 PL + 同玩家第二连接、正式认证/分配、并发等待、幂等请求、5 Tick 屏障、接管版本、隐藏载荷、重连、主动结束及重开。

`demo-combat-acceptance.test.ts` 首次运行发现反应开启过晚，修复后已通过：Tick 0 声明窗口、Tick 2 命中、Tick 5 Recovery 完成，等待屏障保持稳定。开始遭遇按钮空实体 ID、开局未广播、地图无法切换操控实体也已在正式界面复验修复。

新增独立测试 `demo-gm-correction.test.ts` 已通过：非法修正全量拒绝、无部分修改、原型路径及非法数值拒绝、负维持资源保留、请求幂等。资源负值归零、反应未收齐提前扣费、已接战断线超时后引擎计数未释放，均曾由独立回归复现，修复后的结果列于下文。

## 正式浏览器试玩记录

使用编译后的 `node packages/backend/dist/demo/index.js`，同源地址 `http://127.0.0.1:3187`，隔离存档目录 `.demo/browser-acceptance`。通过浏览器界面操作四个独立标签页，身份为 GM、先锋玩家、游侠玩家、引导玩家。

- 完成四身份登录、GM 分配、四标签页刷新恢复、控制权接管/释放、暂停/继续、GM 调整 HP 和从模板战中刷怪。
- 三名玩家及 GM 操作的三名怪物全部提交 WAIT：最后一个槽位之前 Tick 0；全部提交后所有玩家显示 Tick 5。
- 重启测试服务后旧会话失效，重新登录恢复 Tick 0 开局的六个实体，没有错误地把中途精确续战当作支持功能。
- 胜利场：GM 在大厅把三个怪物 HP 调为 1，并填写短战斗验收原因；三名独立玩家各提交一次远程射击，GM 三怪等待。9 个并发反应窗口在服务端接入超时后推进，真实伤害于 Tick 3 产生 VICTORY，三名玩家都看到胜利。只读 SQLite 查询确认 VICTORY 与玩家幸存、怪物阵亡结果已保存。
- 胜利后通过 UI 重开至 Tick 0。发现重开后大厅分配显示与核心控制权不一致，已反馈修复，不能把这项报为通过。
- 失败场：GM 在新大厅将玩家 HP 设为 1，GM 为玩家代提交 WAIT 并操作三怪射击；Tick 0 的 9 窗口暂停后批量 PASS，继续后 Tick 3 产生 DEFEAT，玩家同步看到失败。只读 SQLite 查询确认 DEFEAT 与怪物幸存、玩家阵亡结果已保存。

此时尚未完成的连锁、编辑、单步及重开验证，后续结果如下。

### 后续复验

- 当前源码下 `demo-reaction-regression` 的四项（包括不同来源窗口只能预留一个行动槽）、`demo-resource-lifecycle` 的四项、`demo-chain-acceptance` 的七项全部通过。
- 新增 `demo-movement-recovery`：移动在主行动屏障前不改变坐标、正 Tick 到达、等待不恢复资源、资源为 0 时仍可执行耗时恢复，均通过。`demo-gm-correction` 额外验证正式快照包含 GM、原因及修改前后值。
- `pnpm build` 已按 shared → backend → frontend 完整通过，包括 Prisma Client 生成。全前端 lint 仍为 25 项既有错误，比开始时 41 项减少 16 项；Demo 目录无新增错误。
- 重新编译后四标签页实际完成三名玩家 A 近战声明、B 打断 A、C 再打断 B。C 的优先级低于 B，B 的已生效打断保留；各玩家各付一次反应费用。
- GM 明确结束、保存并重开后，三名原玩家各自在原标签页成功提交 WAIT，控制权恢复已复验通过。
- GM 在正式界面暂停已提交的远程攻击，将目标从先锋改为游侠，生效 Tick 从 3 改到 8、优先级改为 30。单步到 Tick 3 时双方均未受伤；下一 Tick 断点在 Tick 5 停住、日志说明下一结算 Tick 为 8。继续并收齐玩家 WAIT 后，先锋 HP 保持 60，游侠 HP 从 60 变为 46，证实编辑改变真实事件队列与目标。
- 试玩发现旧 WAIT 边界会被其他角色的新屏障清除，修复后 `demo-gm-boundaries` 验证 Tick 4 的新屏障仍保留其他角色 WAIT 至 Tick 5，并拒绝其提前主行动。

## 交付复验

- `pnpm test:demo`：20 个测试文件通过，失败 0，环境错误 0；覆盖多人屏障、真实 HTTP/Socket 反应链及到达顺序、版本/越权/伪造速度、期限/断线、多标签页、GM 编辑/取消/修正/移除、资源临界值、移动恢复、存档与日志。
- `pnpm build`：shared → backend → frontend 全部通过。`pnpm exec eslint src/App.tsx src/demo`（frontend 目录）通过；全量 lint 的 25 项既有问题仍保留，未新增 Demo 错误。
- 相关集成回归：`combat-decision-ownership`、`socket-hook-lifecycle-e2e`、`visibility-and-logs` 通过，其中可见性/日志 33/33。旧认证入口的已知失败见下节，未冒充通过。
- 最终正式页面：GM 暂停后逐个代选 PARRY，原 14 HP 伤害变为 7；再取消一项 STARTUP 攻击，实体进入 Recovery、费用保留、关联窗口消失。时间轴展示实际阶段与生效 Tick，反应动作不再出现在主行动栏。
- 最终四客户端胜利复验：游侠射击、先锋/引导者/怪物等待，Tick 3 命中，Tick 5 的等待到期不再阻塞终局，Tick 6 收招完成后四页显示“玩家阵营胜利 / 结算状态：已保存”。刷新四页仍恢复该终局，随后重开至 Tick 0。
- `demo-settlement-drain` 独立验证上述 T3/T5/T6 终局边界只发出一次 SETTLED。`demo-log-bridge` 验证日志只在提交后进入快照、场景隔离、DEV 信息不升级公开、深层循环 metadata 截断及关闭时监听清理。
- 最终数据库复核发现重连带来的 revision 变化会重复追加历史，已改为每次 START 独立 runId 与稳定结果键。真实 HTTP/Socket 回归确认四轮刷新/重连不新增历史，重开后的新结算才新增；终局后的 GM 追加修正保存到最新快照与审计日志，不重写或重复原结果。相关网络、存档、多人验收回归重新通过。
- 最终开发数据库 SHA-256 与开始时相同；Prisma schema 未修改。已有用户改动、未跟踪 JavaScript 均保留。隔离试玩历史位于 `.demo/browser-acceptance`，默认新局使用 `.demo/demo.db`。

验证使用本机四个独立会话的真实浏览器页面及独立 Socket 客户端；未使用第二台物理设备验证 Windows 防火墙。Demo 默认监听所有网卡并输出局域网加入地址。未执行公网部署、旧认证入口迁移、精确崩溃续战或规则包外内容扩展。

## 关联安全回归（本轮实际运行）

- `demo-network.test.ts`、`combat-decision-ownership.test.ts`、`socket-hook-lifecycle-e2e.test.ts`：3 文件通过，环境错误 0。
- `visibility-and-logs.test.ts`：33/33 通过。
- `auth-boundary-http.test.ts`：6/14 通过，8 失败；`auth-boundary-socket.test.ts`：3 通过、3 安全失败。失败分别涉及旧入口自报 GM/匿名撤销/URL token，以及旧 Socket 的角色与场景授权、撤销后 RESYNC。这与仓库此前 `AUTH_TEST_HTTP_RESULTS.md`、`AUTH_TEST_SOCKET_RESULTS.md` 中已有失败一致，不能报为通过。
- Demo 使用新的独立 `demo/index.ts` 启动入口，不挂载旧 `/auth/login`、旧 JOIN_SCENE/RESYNC；黑盒测试确认旧登录路径为 404，Demo 的凭据、角色、撤销与控制版本需通过它自己的真实入口验证。旧入口安全改造不在本次 Demo 的实现文件中。
- 本轮上述隔离执行均确认开发库及 schema 哈希不变。


## Hex grid restoration (2026-09-12)

Demo and Pixi share flat-top odd-q projection. Entity/intent x/y remain offset column/row; tile q/r are axial. Odd columns shift down half a hex. Facing 0 degrees points right. SVG polygon hit testing retains column/row coordinates under scaling. Map generation converts the 10x6 offset rectangle to axial tiles.

Validation: demo-hex-grid, demo-frontend-regression and demo-movement-recovery passed in isolated databases; development DB/schema hashes unchanged. Shared build, backend TypeScript build and frontend production build passed. Frontend lint retains the same 25 existing errors. The live production page displays hexes with centered tokens; clicking the bottom-right cell returns (9,5), and the existing encounter remains at Tick 6. No move/spawn commands were sent into the user's active encounter. The backend was kept running; corrected map generation loads on the next normal service start.


## Action-first targeting UX (2026-09-12)

The new flow is actor -> action -> legal target click. Main-action cards no longer require a previously selected target. An ephemeral Zustand/Immer selection tracks preview loading, entity/cell selection and submission; target clicks never reuse GM placement coordinates. Esc, the cancel button and map right-click cancel selection. Snapshot/control changes invalidate selection; refresh does not restore or replay an intent. Waiting and recovery submit without old targets. PL defaults to its assigned actor and can inspect other visible entities without switching control.

POST /api/demo/action-preview is authenticated and read-only. Catalog capabilities.actionPreview enables the new UI; an older running server retains the original picker with an explicit update message. Preview reuses existing range/resource checks and filters candidates by recipient. Random cost/range expressions are not previewed; current Demo actions use deterministic costs/ranges. Authoritative commands revalidate on submission.

Validation: demo-action-preview, demo-targeting-ui, demo-frontend-regression, demo-movement-recovery, demo-hex-grid and demo-network passed with isolated SQLite; development DB/schema hashes unchanged. Shared/backend TypeScript and frontend production builds passed. Targeted Demo/App lint passed; full frontend lint retains the 25 existing errors. Tests were added to test:demo.

Two real browser sessions on an isolated 3188 server verified PL auto-selection, action-first melee, out-of-range rejection without submission, switching to movement, moving to an entity's occupied cell, GM ranged attack, keyboard Enter healing, Esc/right-click cancellation, pause invalidation, direct recovery/wait, and refresh without replay. Mouse/keyboard checks used the production bundle. Automated delayed-ACK/late-preview injection and a phone-sized browser viewport were not exercised. The existing user encounter on port 3000 was neither commanded nor restarted; new backend capabilities load at the next normal service start.
