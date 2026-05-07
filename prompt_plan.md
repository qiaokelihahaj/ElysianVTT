# ElysianVTT — 全环节 VTT 开发计划

> 本计划遵循"规则无关（Rule-Agnostic）"架构原则：
> - 引擎是纯粹的物理与时间演算容器
> - 所有游戏规则以数据形式定义（DB/JSON/DSL）
> - 优先适配伊利塞昂规则书，同时保障未来可接入其他规则体系
>
> 架构参考：PlanarAlly (空间/渲染/同步模式) + Fari App (角色卡/离线/叙事模式)

```
Legend: [ ] 待开始  [/] 进行中  [x] 已完成
======================================================================
 Phase 1: 规则引擎基础 + 战斗骨架     Phase 4: 探索环节
 Phase 2: 战斗核心博弈                 Phase 5: 叙事环节 + 战役管理
 Phase 3: 战斗系统完整                 Phase 6: 模组系统 + 开放框架
======================================================================
```

---

## Phase 1: 规则引擎基础 + 战斗骨架（当前阶段）

**目标**：让规则引擎具有运行伊利塞昂规则"最小可用战斗"的能力。

### 1.1 双轨资源系统补齐 [ ]

- [ ] 在 `ResourcePool` 类型中明确 PP(韧性) 和 FP(专注) 的语义
- [ ] 种子数据中为所有角色添加 `poise` 和 `focus` 属性（含当前值/最大值）
- [ ] 在 `handleActionIntent` 中解析 `ActionTemplate.resourceCost` 并执行扣除
- [ ] 在 `resolveActionPulse` 中添加持续资源消耗（Channeling 时的每脉冲消耗）
- [ ] 修改 `checkSustainAfterMutations`：打断条件 `<= 0` → `< 0`（=0 时保留惯性）
- [ ] 测试：资源消耗正确性、归零不打断场景、双资源耗尽场景

**关键文件**：`shared/src/index.ts`, `CombatEngine.ts`, `EffectSystem.ts`, `seed.ts`
**验收条件**：角色释放动作时正确扣除 PP/FP，=0 不打断，<0 才打断

### 1.2 动作五阶段状态机扩展 [ ]

- [ ] 在 `ActionExecutionEvent.phase` 和 `currentActionContext.phase` 中加入 `DELAY`
- [ ] 修改 `EventFactory.createActionPhaseEvent` 按 DELAY→STARTUP→ACTIVE→RECOVERY 顺序生成
- [ ] 在 `CombatEngine` 中独立处理 `DELAY` 阶段（可 Cancel 窗口）
- [ ] 在 `CombatEngine` 中独立生成并处理 `ACTIVE` 阶段（绝对不可逆）
- [ ] 打断后跳转到 Recovery 而非直接回 Idle
- [ ] 修改前端 `gameStore.ts` 和 UI 模式支持五阶段展示
- [ ] 测试：五阶段完整生命周期、ACTIVE 不可逆、打断回 Recovery

**关键文件**：`shared/src/index.ts`, `CombatEngine.ts`, `EventFactory.ts`, `gameStore.ts`
**验收条件**：动作按 Delay→Startup→Active→Recovery 完整流转，Active 阶段不可打断

### 1.3 RulePack 数据架构 [x]

- [x] 设计并实现 `RulePack` 数据库表（属性定义、资源定义、阶段定义、防御模型）
- [x] 将现有 `ActionTemplate` 从种子数据提取为按 `rulePackId` 加载
- [x] 实现 `RulePackLoader` — 从 DB 加载全套规则定义
- [x] 扩展 `RuleEvaluator` 支持规则包中的自定义变量和函数
- [x] `CombatEngine` 初始化时通过 `rulePackId` 绑定规则

**关键文件**：`schema.prisma`, `Dictionary.ts`, `RulePackLoader.ts`(new), `RuleEvaluator.ts`
**验收条件**：可通过切换 rulePackId 加载不同的动作模板集和属性定义

### 1.4 打断与假动作机制 [ ]

- [ ] 在 `ClientIntent` 中加入 `CANCEL_ACTION` / `FEINT` 类型
- [ ] 在 `IntentRouter` 中添加取消意图的验证和路由
- [ ] 实现 `playerCancelAction` — 消耗 PP/FP 强制回到 Idle
- [ ] 延迟态取消代价低，发生态取消代价高
- [ ] 测试：取消动作品消耗正确、延迟态 vs 发生态代价差异

**关键文件**：`shared/src/index.ts`, `IntentRouter.ts`, `CombatEngine.ts`
**验收条件**：玩家可通过发送 CANCEL_ACTION 消耗资源取消当前动作

### 1.5 空间网格基础 [ ]

- [ ] 在类型系统中加入六边形网格坐标 `HexCoord { q: number; r: number }`
- [ ] 添加 `hexDistance(a, b)` 和 `hexNeighbors(coord)` 工具函数（参考 PlanarAlly / Red Blob Games 算法）
- [ ] 支持坐标转换：`Vector3D` ↔ `HexCoord`（暂保留连续坐标兼容）
- [ ] 测试：六边形距离计算、邻居查找

**关键文件**：`shared/src/index.ts`, `SpatialSystem.ts`, `VectorMath.ts`
**验收条件**：后端可计算六边形网格距离和邻近格子

### 1.6 空文件填充 [ ]

- [ ] `Actor.ts` — 角色实体类（关联 RulePack、资源管理、状态机）
- [ ] `BaseEntity.ts` — 基础实体抽象类（坐标、朝向、标签、持有规则包 ID）
- [ ] `CombatSystem.ts` — 集成战斗控制器（协调 CombatEngine + EffectSystem）
- [ ] `Projectile.ts` — 弹道实体类（轨迹、速度、碰撞回调）

**关键文件**：上述 4 个 0 行文件
**验收条件**：TypeScript 编译通过

---

## Phase 2: 战斗核心博弈

**目标**：实现伊利塞昂规则的核心"立回"博弈循环。

### 2.1 DR 装甲减伤系统 [x]

- [x] 在类型中加入 `armor.dr` 字段或 `defenses.dr: number`
- [x] 在 `EffectSystem` DAMAGE 分支中插入 DR 计算层
- [x] DR 专用减免公式（可被规则 DSL 覆盖）
- [x] 测试：物理伤害被 DR 减免的正确计算

### 2.2 招架偏转系统 (DEF) [x]

- [x] 在 `ClientIntent` 中加入 `DEFEND` 意图类型
- [x] 创建招架动作模板（消耗 PP、短 Startup、短 Recovery）
- [x] 实现招架判定：攻击值(attackValue) vs 格挡值(defendValue)
- [x] 成功招架：伤害大幅减免（由 DR 二次处理）
- [x] 失败招架：PP 消耗增加、可附加破防效果
- [x] 测试：招架成功/失败的资源变化

### 2.3 差合/挥空惩罚系统 [x]

- [x] 在 `resolveActionPulse` 中加入命中判定：检查目标是否在 `range` 内
- [x] 若命中失败 → 触发 whiff 标记
- [x] whiff 标记 → Recovery 时间强制延长（倍数由规则 DSL 定义）
- [x] whiff 标记 → 角色进入"无力化"状态（不可 DEF 不可 Dodge）
- [x] 确反窗口：对手在 whiff 后 Recovery 期间攻击获得额外加成
- [x] 测试：距离判定、Recovery 延长、确反加成

### 2.4 主动闪避系统 (Dodge) [x]

- [x] 在 `ClientIntent` 中加入 `DODGE` 意图类型
- [x] 创建闪避动作模板（消耗 FP、极短 Startup、短位移）
- [x] 闪避是物理位移——被闪避的攻击触发 whiff
- [x] 范围伤害依然命中（无无敌帧）
- [x] 测试：闪避位移距离、范围伤害豁免判定

### 2.5 Reaction 反应动作系统 [x]

- [x] 在引擎中加入"反应窗口"事件机制
- [x] 在 `ClientIntent` 中加入 `REACTION` 意图类型
- [x] 网络协议中加入 `REACTION_AVAILABLE` 服务端→客户端通知
- [ ] 前端加入反应动作选择 UI
- [x] 测试：打断者闯入 + 有效拦截

### 2.6 微避系统 (Micro-Evasion) [x]

- [x] 在 `ActionTemplate.tags` 中添加 `AttackTag` 枚举（`HIGH | LOW | LINEAR`）
- [x] 在 `ClientIntent` 中加入 `MICRO_EVADE` 意图（含 Duck/Hop/Slip 子类型）
- [x] 微避动作属性：极快 Startup（2-3 Tick）、较长 Recovery（8-10 Tick）
- [x] Tag 匹配判定：微避类型匹配攻击 Tag → 成功（触发 whiff）
- [x] Tag 不匹配 → 微避失败（全额受伤）
- [x] 测试：四组 Tag 匹配/不匹配场景

---

## Phase 3: 战斗系统完整

**目标**：完成伊利塞昂规则的全部战斗机制。

### 3.1 部位破坏与重击系统 [ ]

- [ ] 在类型中加入 `BodyPart`, `DamageCap`, `HitLocation` 定义
- [ ] 实现部位判定骰（d100/d20 部位随机表，由 RulePack 定义）
- [ ] 实现"要害优先"路线：高重击倍率 + 部位上限截断 + 已破坏=打空
- [ ] 实现"损伤优先"路线：无部位判定 + 全额伤害 + 无上限截断
- [ ] 残废 Debuff 系统（部位被破坏后附加的惩罚效果）
- [ ] 测试：要害/损伤两条路线、伤害截断计算、残废效果

### 3.2 实体弹道系统 [ ]

- [ ] `Projectile.ts` 实现 — 弹道实体（坐标、速度、轨迹类型、碰撞回调）
- [ ] 直射弹道：贴地平飞、不穿透掩体、逐网格推进
- [ ] 抛物线弹道：升弧段/降弧段、越障、最小射程盲区
- [ ] 边界事件预计算：用射线算法预计算路径，压入边界事件
- [ ] 盲目碰撞检定（d20 碰撞骰 + 体型阈值）
- [ ] 混沌命中（Chaotic Impact）：流弹击中的部位随机结算
- [ ] 测试：弹道飞行、碰撞检测、边界事件触发

### 3.3 掩体系统与战术姿态 [ ]

- [ ] 在类型中加入 `CoverDef`（半掩体/全掩体、Cover DR、Blast Shadow）
- [ ] 命中判定时检查目标掩体状态
- [ ] 战术姿态：架枪(ADS) vs 撩枪(Blind-fire)切换
- [ ] 架枪：稳定射击但有部位暴露风险
- [ ] 撩枪：安全但有弹着点偏移
- [ ] 测试：掩体 DR 计算、姿态切换时间消耗

### 3.4 空间战术元素 [ ]

- [ ] 武器触及距离（Reach）和极限距离死角惩罚
- [ ] 冲刺动量（连续移动加速，每格耗时递减）
- [ ] 朝向与转身耗时
- [ ] 背刺判定（目标背面攻击无视 DEF）
- [ ] 弃武器/副武器切换
- [ ] 测试：触及判定、冲刺加速、背刺判定

### 3.5 阵型与团队协作 [ ]

- [ ] 物理空间拦截：实体占据网格阻挡移动
- [ ] Active Interception：护卫角色主动拦截
- [ ] 封锁区域：范围武器封锁必经路径
- [ ] 测试：阻挡路径、拦截触发

### 3.6 AOE 与爆炸结算 [ ]

- [ ] AOE 目标选择器（圆形、锥形、线形范围）
- [ ] 爆炸范围 + 衰减伤害
- [ ] 爆风阴影（掩体后的安全区域计算）
- [ ] 友军伤害（无免伤，球状爆破计算）
- [ ] 测试：AOE 覆盖、衰减、阴影

---

## Phase 4: 探索环节

**目标**：实现六边形网格地图的探索能力（参考 PlanarAlly 空间模式 + Fari App Index Card 场景）。

### 4.1 六边形地图引擎 [ ]

- [ ] ExploreEngine 实现（无时间轴、即时结算）
- [ ] 地图加载（瓦片数据、TileSet 定义）
- [ ] 六边形网格渲染（前端 PixiJS，参考 PlanarAlly 的轴向坐标 + Red Blob Games 算法）
- [ ] 实体在地图上的放置和移动
- [ ] 格子类型（地面/墙壁/水域/障碍/门）+ 行走消耗
- [ ] 图层顺序实现（自底向上）：地形→网格→物件→Token→GM 标注→FOW→绘制→光照

### 4.2 战争迷雾系统 [ ]

- [ ] 视野计算（基于实体位置和视野范围）
- [ ] 迷雾状态：未探索 / 已探索 / 当前可见
- [ ] **安全约束**：迷雾信息由服务端 `VisibilityFilter` 计算并过滤，非仅客户端遮挡
- [ ] 增量迷雾广播（探索过的区域增量同步）
- [ ] 前端迷雾渲染（暗色覆盖层）

### 4.3 区域触发系统 [ ]

- [ ] 区域触发器定义（位置 + 范围 + 事件类型）
- [ ] 战斗触发器：进入区域触发 CombatEngine 挂载
- [ ] 对话触发器：进入区域触发对话树（参考 Fari App Index Card）
- [ ] 陷阱触发器：进入区域触发检定

### 4.4 交互与检定 [ ]

- [ ] 原地交互动作（搜索、撬锁、调查等）
- [ ] 检定面板：规则 DSL 驱动的属性/技能检定
- [ ] 成功/失败分支处理

### 4.5 实体渲染解耦（参考 PlanarAlly ActiveShapeStore） [ ]

- [ ] 前端 `EntityRenderStore` 实现——缓存战斗实体的插值位置/旋转
- [ ] 高频更新（每 Tick 坐标微移）走渲染 store，不触发 React 重渲染
- [ ] 独立于 Zustand 的渲染管线

---

## Phase 5: 叙事环节 + 战役管理

**目标**：实现文本/CG 推送和完整的 GM 工具链（参考 Fari App 场景系统）。

### 5.1 叙事引擎 [ ]

- [ ] NarrativeEngine 实现
- [ ] 基于 Index Card 的场景管理（参考 Fari App 的卡片式场景切换）
- [ ] 文本推送协议（NARRATIVE_PUSH 事件）
- [ ] CG/插画展示（前端全屏图片 + 角色立绘叠加）
- [ ] 对话树渲染（前端多分支选择 UI）
- [ ] 条件分支（基于角色状态/进度判断）
- [ ] 场景过渡动画（淡入淡出、打字机效果）

### 5.2 日志与回放 [ ]

- [ ] 战斗日志（结构化事件记录）
- [ ] 剧情回放（按场景播放已记录的叙事数据）
- [ ] 战报生成（战斗统计：伤害统计、命中率、资源消耗）

### 5.3 GM 工具箱 [ ]

- [ ] GM 控制面板（实体编辑、状态修改、即时掷骰）
- [ ] NPC 托管控制器
- [ ] 场景快速切换（Combat↔Explore↔Narrative）
- [ ] 强制触发事件
- [ ] 自由掷骰面板（参考 Fari App 的 rollGroups 多命令组合）

### 5.4 断线重连 [ ]

- [ ] 方案 A（Phase 5 首选）：服务端维护状态快照，重连时全量推送
- [ ] 方案 B（后续优化，参考 Fari App localStorage+CRDT）：客户端 localStorage 缓存 + 差异同步
- [ ] 断线恢复协议（RECONNECT + BACKFILL_STATE）
- [ ] 托管机制（断线后默认行为/AI 托管）

### 5.5 高频广播优化（参考 PlanarAlly `temporary`） [ ]

- [ ] 在 `StateMutationPayload` 中加入 `isTransient` 标记
- [ ] `isTransient: true` — 高频/插值状态（坐标微移、视觉效果）仅广播不落盘
- [ ] `isTransient: false` — 关键状态（HP 变化、动作开始/结束、BUFF 生效）全链路持久化
- [ ] 测试：高频广播不产生 DB 写入、关键状态不丢失

---

## Phase 6: 模组系统 + 开放框架

**目标**：让第三方可以定义自己的规则系统（参考 Fari App Block 化架构）。

### 6.1 角色卡 Block 系统（参考 Fari App） [ ]

- [ ] 前端 Block 渲染器：text / numeric / skill / dicePool / pointCounter / slotTracker / image / link / separator
- [ ] Block 注册表：RulePack 加载时动态注册 Block 类型和布局
- [ ] Block 值绑定：每个 Block 的值可映射到角色数据或表达式计算结果
- [ ] 角色卡布局编辑器（GM 可拖拽排列 Block）

### 6.2 DSL 表达式增强 [ ]

- [ ] 扩展 DSL 支持条件表达式（if-then-else）
- [ ] DSL 支持变量定义和函数组合
- [ ] DSL 沙箱安全审查

### 6.3 规则包编辑器 [ ]

- [ ] 属性定义编辑器（Block 化界面）
- [ ] 动作模板编辑器（拖拽式时间轴配置）
- [ ] 效果模板编辑器
- [ ] 状态机编辑器

### 6.4 插件系统 [ ]

- [ ] 插件接口定义（生命周期钩子：onInit, onTick, onEvent, onSettlement）
- [ ] WASM 插件载入器（可选）
- [ ] JavaScript 沙箱插件（isolated-vm / vm2）

### 6.5 规则市场 [ ]

- [ ] 规则包打包/发布格式
- [ ] 规则包依赖管理
- [ ] 版本兼容性检查

---

## 依赖关系图

```
Phase 1 ───────────────────────────────────────────────────────
  │  1.1 双轨资源      (← 必须在 1.2 之前)
  │  1.2 五阶段状态机  (← 依赖 1.1 的资源扣除)
  │  1.3 RulePack      (← 依赖 1.1 的类型定义)
  │  1.4 打断与假动作  (← 依赖 1.2 的状态机)
  │  1.5 网格基础      (可并行 1.1-1.4)
  │  1.6 空文件填充    (可并行)
  │
Phase 2 ───────────────────────────────────────────────────────
  │  2.1 DR 系统       (← 依赖 1.1)
  │  2.2 招架系统      (← 依赖 1.1 + 1.4)
  │  2.3 差合系统      (← 依赖 1.2 + 1.5)
  │  2.4 主动闪避      (← 依赖 1.1 + 1.5)
  │  2.5 反应动作      (← 依赖 2.3)
  │  2.6 微避系统      (← 依赖 1.5)
  │
Phase 3 ───────────────────────────────────────────────────────
  │  3.1 部位破坏      (← 依赖 2.3)
  │  3.2 实体弹道      (← 依赖 1.5 + 2.5)
  │  3.3 掩体系统      (← 依赖 3.2)
  │  3.4 空间战术      (← 依赖 3.2)
  │  3.5 阵型协作      (← 依赖 3.4)
  │  3.6 AOE 结算      (← 依赖 3.1 + 3.2)
  │
Phase 4 ───────────────────────────────────────────────────────
  │  4.1-4.4 可并行于 Phase 2-3（共享空间系统和渲染管线）
  │  4.5 渲染解耦      (可并行 4.1-4.4)
  │
Phase 5 ───────────────────────────────────────────────────────
  │  (独立于战斗系统，依赖 Phase 4 的战役管理)
  │
Phase 6 ───────────────────────────────────────────────────────
  │  6.1 Block 系统    (依赖 Phase 5 的角色系统)
  │  6.2-6.5 所有 Phase 完成后，作为开放框架层
```

---

## 风险点与缓解策略

| 风险 | 影响 | 缓解 |
|------|------|------|
| CombatEngine 692 行过于庞大 | 维护困难、Bug 率高 | Phase 1 开始前拆分为 Engine/Arbiter/Resolver 三个子模块 |
| `processQueue` 同步递归阻塞事件循环 | 长战斗卡死服务器 | 改为异步分批（每步 yield），或限制单次 Tick 数 |
| 规则 DSL 表达力不足 | 新规则无法实现 | 优先保证 mathjs 表达式可扩展，保留 WASM 方案 |
| 六边形网格渲染性能 | 大地图卡顿 | 视口裁剪 + Tile LOD + ActiveShapeStore 解耦高频更新（参考 PlanarAlly） |
| 战争迷雾安全泄露 | 客户端篡改看到隐藏实体 | 服务端 VisibilityFilter 强制过滤，非仅客户端遮挡（PlanarAlly 的教训） |
| 前端状态复杂度超限 | Zustand store 混乱 | 按模块拆分 store（combat/explore/narrative/campaign），叙事模块可参考 Fari App Context+actions |
| 从三阶段到五阶段的 API 断裂 | 现有逻辑需重写 | 共享层类型扩展时保留旧阶段别名，逐步迁移 |
| 规则热切换的数据清洗 | 不同规则的兼容性问题 | 每个状态实体标记 rulePackId，切换时做映射转换 |
| 高频广播导致 DB 写压力 | 性能瓶颈 | `isTransient` 标记分离广播/持久化路径（参考 PlanarAlly `temporary`） |
| 角色卡字段硬编码 | 新规则需改前端代码 | Block 化渲染器 + RulePack 动态注册（参考 Fari App Block 架构） |

---

## 当前里程碑

```
[✓] Phase 1.1 双轨资源系统          [  已完成   ]
[✓] Phase 1.2 动作五阶段状态机       [  已完成   ]
[✓] Phase 1.3 RulePack 数据架构     [  已完成   ]
[✓] Phase 1.4 打断与假动作机制       [  已完成   ]
[✓] Phase 1.5 空间网格基础           [  已完成   ]
[✓] Phase 1.6 空文件填充             [  已完成   ]
[✓] Phase 2.1 DR 装甲减伤系统        [  已完成   ]
[✓] Phase 2.2 招架偏转系统 (DEF)     [  已完成   ]
[✓] Phase 2.3 差合/挥空惩罚系统      [  已完成   ]
[✓] Phase 2.4 主动闪避系统 (Dodge)   [  已完成   ]
[✓] Phase 2.5 Reaction 反应动作系统   [  已完成   ]
[✓] Phase 2.6 微避系统 (Micro-Evasion) [已完成 ]
```

> **当前状态**: Phase 1 全部完成！Phase 2 (战斗核心博弈) 全部完成！
> - 双轨资源 (PP/FP) 正确扣除，归零不打断
> - 动作生命周期: DELAY→STARTUP→ACTIVE→RECOVERY
> - CANCEL_ACTION 意图支持，不同阶段不同消耗
> - RulePack 数据架构：Prisma 表 + 共享类型 + Loader + Engine 绑定
> - 六边形网格坐标与工具函数
> - 空实体文件已填充

开始工作后，用 `[x]` 标记完成项，用 `[#]` 标记进行项。
