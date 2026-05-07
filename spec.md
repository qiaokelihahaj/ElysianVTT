# ElysianVTT — 全环节 VTT 平台功能规格

## 设计哲学

> **规则无关（Rule-Agnostic）** — 引擎是不含硬编码游戏规则的"物理与时间演算容器"。
> 所有战斗规则、伤害公式、状态机流转均以数据形式定义（DB/JSON/DSL）。
> 引擎核心不变，规则可插拔替换。

### 架构参考来源

本设计参考了以下成熟 VTT 项目的架构经验：

| 项目 | 提取模式 | 应用章节 |
|------|---------|---------|
| PlanarAlly | `temporary` 广播标记、ActiveShapeStore 实体渲染解耦、轴向六边形网格、图层顺序 | 1.6, 4.1, 4.2, 9 |
| Fari App | Block 化角色卡、Context+actions 状态管理、localStorage+CRDT 离线优先、Index Card 场景 | 6, 4.4, 5.1, 5.4 |

> PlanarAlly 提供了空间渲染和网络同步的最佳实践，Fari App 提供了数据驱动的角色卡和离线韧性的参考。

---

## 第一章：系统分层架构

```
┌──────────────────────────────────────────────────────────┐
│                    表现层 (Presentation)                   │
│  React UI / PixiJS 画布 / CG渲染器 / 地图编辑器          │
│  └─ ActiveShapeStore 模式：高频实体与 UI Store 解耦      │
├──────────────────────────────────────────────────────────┤
│                    会话层 (Session)                       │
│  WebSocket 状态同步 / 房间管理 / 断线重连 / 可见性过滤    │
│  └─ temporary 广播标记：高频操作只广播不落盘             │
├──────────────────────────────────────────────────────────┤
│                  场景编排层 (Orchestration)                │
│  场景路由 / 引擎挂载 / 实体迁移 / GM工具箱               │
├──────────┬──────────┬──────────┬──────────┬──────────────┤
│ Combat   │ Explore  │Narrative │ Minigame │ 第三方引擎   │
│ Engine   │ Engine   │ Engine   │ Engine   │ (插件)       │
├──────────┴──────────┴──────────┴──────────┴──────────────┤
│                    规则引擎层 (Rule Engine)                │
│  RuleEvaluator / 状态机模板 / EffectSystem / RulePack    │
├──────────────────────────────────────────────────────────┤
│                    基础层 (Foundation)                    │
│  TickLoop / PriorityQueue / 实体系统 / 空间系统          │
├──────────────────────────────────────────────────────────┤
│                    持久化层 (Persistence)                 │
│  Prisma ORM / 内存演算 / 差分广播 / 战报存档             │
└──────────────────────────────────────────────────────────┘
```

### 1.6 跨项目模式集成

#### PlanarAlly 模式

| 模式 | 原始实现 | ElysianVTT 适配 |
|------|---------|----------------|
| `temporary` 广播标记 | Python dict `isTemporary` 控制落盘 | 在 `StateMutationPayload` 中加入 `isTransient`，广播但跳过 DB |
| ActiveShapeStore | Vuex store + shape 活跃集，高频位置/旋转脱离 Vue reactivity | 前端 `EntityRenderStore` 缓存战斗实体的插值位置，独立于 Zustand |
| 轴向六边形网格 | `{q, r}` + Red Blob Games 算法 | `HexCoord` 类型 + `hexDistance`/`hexNeighbors` |
| 图层顺序 | Map→Grid→Token→DM→FOW→Draw→Lighting | Explore 场景的 PixiJS 图层渲染管线 |
| Socket.IO 命名空间 | `/campaign`, `/combat` 隔离 | 参考其 namespace 分离模式 |

#### Fari App 模式

| 模式 | 原始实现 | ElysianVTT 适配 |
|------|---------|----------------|
| Block 化角色卡 | 9 种 Block 类型（Text/Numeric/Skill/DicePool/…） | 角色卡字段由 RulePack 动态驱动，前端按 Block 类型渲染 |
| Context+actions | React Context + useReducer，不依赖外部状态库 | 叙事/探索等非战斗模块可参考此轻量模式 |
| localStorage+CRDT | localStorage 主存储 + Liveblocks CRDT 同步 | 断线重连的本地缓存层 + 差异同步 |
| Index Card 场景 | 卡片式场景，切换即切换渲染上下文 | 叙事场景的 Scene 切换实现模式 |
| `rollGroups` | 多骰子命令组合，并行结算 | 表达式 DSL 中多公式组合结算 |

---

## 第二章：规则无关引擎设计

### 2.1 规则抽象层（RulePack）

所有规则集以 `RulePack` 为单位组织：

```typescript
interface RulePack {
  id: string;           // "elysian-v1", "dnd-5e", "custom-wuxia"
  name: string;
  version: string;
  
  // 基础属性定义
  attributes: AttributeDef[];    // { name: 'str', label: '力量', range: [1,30] }
  resources: ResourceDef[];      // { name: 'hp', label: '生命值', autoRecover: false }
  
  // 状态机模板
  actionPhases: PhaseDef[];      // Idle→Delay→Startup→Active→Recovery
  
  // 动作模板（来自数据库）
  actionTemplates: ActionTemplate[];
  
  // 效果处理器
  effectDefinitions: EffectDef[];
  
  // 表达式上下文
  expressionScope: { variables: string[], functions: string[] };
  
  // 防御模型
  defenseModel: DefenseModelDef;
  
  // 空间模型
  spatialModel: 'hex' | 'square' | 'continuous';
}
```

### 2.2 数据驱动核心接口

| 组件 | 硬编码（不变） | 数据驱动（规则定义） |
|------|---------------|-------------------|
| TickLoop | 堆排序 + 事件跳跃 | 动作时间消耗、阶段周期 |
| EffectSystem | DAMAGE/HEAL/BUFF 执行顺序 | 伤害公式、DR 计算、效果参数 |
| RuleEvaluator | mathjs 沙箱 + 骰子管线 | 表达式字符串、变量映射 |
| PhaseMachine | 阶段流转（硬编码骨架） | 阶段定义、打断条件、恢复逻辑 |
| DefenseSystem | 防御判定链路 | DR 数值、格挡公式、闪避公式 |
| SpatialSystem | 路径规划 + 碰撞检测 | 网格类型、移动消耗、阻挡规则 |

### 2.3 规则热切换

- 每个 `Campaign` 绑定一个 `RulePack`
- 加载时从 DB 提取全套动作模板、属性定义、表达式配置
- 切换规则 = 切换数据库查询的 `rulePackId`
- 运行时不可切换（需结束当前战斗后加载新规则）

---

## 第三章：战斗环节（Combat Module）

### 目标
实现战斗规则大纲.md 描述的伊利塞昂完整战斗系统，同时保持引擎与规则解耦。

### 关键子系统

| 子系统 | 职责 | 实现程度 |
|--------|------|---------|
| 事件堆调度 | PriorityQueue + TickLoop 离散事件 | 已完成 ✓ |
| 同 Tick 冲突 | ClashPool 两阶段提交 + 相杀 | 已完成 ✓ |
| 表达式求值 | RuleEvaluator mathjs 沙箱 | 已完成 ✓ |
| 效果系统 | EffectSystem DAMAGE/HEAL/BUFF | 已完成 ✓ |
| 空间系统 | SpatialSystem 路径规划 | 骨架完成 |
| 五阶段状态机 | Idle→Delay→Startup→Active→Recovery | **待扩展** |
| 双轨资源系统 | HP / PP(韧性) / FP(专注) | **待实现** |
| 五道防线 | DR / DEF / Dodge / MicroEvasion / Saves | **待实现** |
| 差合系统 | 挥空判定 + 后摇延长 + 确反 | **待实现** |
| 假动作 | Cancel/Feint 主动取消 | **待实现** |
| 部位破坏 | Damage Cap + 要害/损伤优先 | **待实现** |
| 实体弹道 | 直射/抛物线 + 碰撞 + 掩体 | **待实现** |
| 反应插队 | 第三方反应动作窗口 | **待实现** |

---

## 第四章：探索环节（Explore Module）

### 4.1 六边形网格地图

基于 PlanarAlly 的轴向坐标（Red Blob Games 算法）实现：

```typescript
interface ExploreScene {
  gridType: 'hex';
  radius: number;         // 六边形网格半径
  tiles: Map<string, TileData>;  // "q,r" → Tile
  fogOfWar: FogState;
  entities: Entity[];
  triggers: TriggerDef[];
}

// 轴向坐标 (Red Blob Games 标准)
interface HexCoord {
  q: number;
  r: number;
}

// 立方体坐标（用于计算）
interface CubeCoord {
  q: number;
  r: number;
  s: number;  // s = -q - r
}
```

### 4.2 渲染图层顺序（参考 PlanarAlly）

```
自底向上:
  1. 基础地形层 (Ground/Grass)
  2. 网格线层 (Grid)
  3. 物件层 (Objects/Walls)
  4. Token/实体层 (Token)
  5. GM 标注层 (DM)
  6. 战争迷雾层 (FOW) — 服务端过滤，非仅客户端遮挡
  7. 绘制层 (Draw — 临时标记)
  8. 光照层 (Lighting — 可选)
```

### 4.3 战争迷雾（安全注意）

> **关键安全约束**：PlanarAlly 的 FOW 仅是客户端遮挡，未在服务端过滤视野外实体。
> ElysianVTT 的迷雾信息必须由服务端 `VisibilityFilter` 计算并过滤后广播，
> 防止客户端篡改看到隐藏实体。

### 4.4 叙事触发器（参考 Fari App Index Card）

叙事场景可使用 Index Card 模式管理：

```typescript
interface IndexCardScene {
  id: string;
  type: 'combat' | 'explore' | 'narrative' | 'rest';
  cards: IndexCard[];
  visibility: 'public' | 'gm-only' | 'conditional';
}

interface IndexCard {
  id: string;
  title: string;
  content: string;       // Markdown 格式
  conditions?: ExpressionDef[];  // 显示条件
  effects?: EffectDef[];  // 激活时效果
}
```

### 4.5 区域触发系统

- [ ] 区域触发器定义（位置 + 范围 + 事件类型）
- [ ] 战斗触发器：进入区域触发 CombatEngine 挂载
- [ ] 对话触发器：进入区域触发对话树
- [ ] 陷阱触发器：进入区域触发检定

### 4.6 交互与检定

- [ ] 原地交互动作（搜索、撬锁、调查等）
- [ ] 检定面板：规则 DSL 驱动的属性/技能检定
- [ ] 成功/失败分支处理

---

## 第五章：叙事环节（Narrative Module）

### 5.1 叙事引擎（参考 Fari App 场景系统）

叙事场景基于 Fari App 的 Index Card 模式构建，配合对话树：

- 场景 = 一组有序/条件化的卡片
- 每张卡片包含文本、CG、选项、条件、效果
- 切换场景 = 切换卡片集合

### 功能需求

| 功能 | 描述 |
|------|------|
| 文本推送 | GM 发送剧情文本，分角色对话格式化输出 |
| CG/插画展示 | 全屏 CG、角色立绘、场景背景切换 |
| 对话树 | 分支对话、条件触发、选项后效果 |
| 日志系统 | 战斗日志、剧情回放、历史查询 |
| 条件分支 | 基于角色属性/进度的剧情条件判断 |
| 场景过渡 | CG 淡入淡出、文本逐行展示 |

### 数据模型

```typescript
interface NarrativeScene {
  type: 'text' | 'cg' | 'dialogue' | 'mixed';
  background: string;       // 背景图 URL
  characters: CgCharacter[];
  dialogueTree: DialogueNode[];
}

interface DialogueNode {
  id: string;
  speaker: string;
  text: string;
  condition?: ExpressionDef;
  options: DialogueOption[];
  effects?: EffectDef[];    // 选择后的效果
}
```

---

## 第六章：角色系统（Character Module）

### 6.1 Block 化角色卡（参考 Fari App）

> 角色卡不硬编码字段。每个字段是一个"Block"，由 RulePack 定义类型和渲染方式。

#### Block 类型

| Block 类型 | 用途 | 渲染 |
|-----------|------|------|
| `text` | 角色名、背景故事 | 文本输入框 |
| `numeric` | 属性值（STR/DEX） | 数字输入 + 加减 |
| `skill` | 技能列表 | 名称 + 等级 + 骰子按钮 |
| `dicePool` | 骰池（D&D 风格） | 骰子图标 + 数量选择 |
| `pointCounter` | HP/PP/FP 资源条 | 进度条 + 当前/最大值 |
| `slotTracker` | 装备槽/弹药 | 格子勾选 |
| `image` | 角色头像/CG | 图片显示 |
| `link` | 外部引用 | 超链接 |
| `separator` | 视觉分隔 | 分割线 |

#### 数据模型

```typescript
interface CharacterBlock {
  id: string;
  type: BlockType;
  label: string;
  rulePackId: string;
  config: Record<string, any>;  // Block 类型特定配置
  value: any;
  sortOrder: number;
}

interface CharacterSheet {
  id: string;
  rulePackId: string;
  blocks: CharacterBlock[];
  computed: Record<string, string>;  // 计算字段: 表达式
}
```

### 6.2 装备栏

武器、护甲、饰品、道具（由 RulePack 定义有效装备类型）

### 6.3 专长/天赋

被动能力和主动能力树（由 RulePack 定义）

### 6.4 背包

物品管理、掉落、交易

### 6.5 属性计算

基础属性 + 装备修正 + Buff 叠加（由 RuleEvaluator 执行）

> 注：角色卡的所有字段类型和布局由当前绑定的 RulePack 动态定义。
> 引擎和前端 Block 渲染器是通用的，不依赖具体规则。

---

## 第七章：战役管理（Campaign Module）

| 功能 | 描述 |
|------|------|
| 房间管理 | 创建/加入/离开战役房间 |
| GM 工具箱 | 掷骰面板、NPC 控制、事件触发、状态编辑 |
| 场记/战报 | 战斗结束后自动生成的战损统计和回放 |
| 场景切换 | Combat → Explore → Narrative 无缝切换 |
| 托管系统 | 玩家断线时角色由 GM 或 AI 代为操作 |

---

## 第八章：模组与自定义规则（Modding Module）

### 设计原则

- 规则 = 数据，不是代码
- 表达式 DSL 覆盖伤害公式、条件判断、效果逻辑
- 插件接口允许未来接入 WASM 或沙箱脚本引擎

### 可扩展维度

| 维度 | 配置方式 | 示例 |
|------|---------|------|
| 属性定义 | Block 化 + DB 配置 | Block 定义从 DB 加载，无需改代码 |
| 动作模板 | DB 配置 | 疾风斩: {startup:8, active:2, recovery:12} |
| 伤害公式 | DSL 表达式 | `actor.str * 1.5 + dice(2d6)` |
| 状态机 | DB 配置 | Idle→Delay→Startup→Active→Recovery |
| 防御模型 | DB 配置 | DR>DEF>Dodge>MicroEvasion>Saves |
| 装备效果 | DB 配置 | `{effect: DAMAGE, resource: 'hp', expr: '2d4+2'}` |
| 专长天赋 | DB 配置 | `{trigger: 'onParry', effect: 'counterAttack'}` |

---

## 第九章：网络与多人协议

### 9.1 事件清单

| 事件 | 方向 | 协议 | 状态 |
|------|------|------|------|
| JOIN_CAMPAIGN | C→S | Socket.io | 已实现 ✓ |
| CLIENT_INTENT | C→S | Socket.io | 已实现 ✓ |
| STATE_MUTATED | S→C | Socket.io | 已实现 ✓ |
| VISUAL_FX | S→C | Socket.io | 已实现 ✓ |
| REACTION_AVAILABLE | S→C | Socket.io | **待实现** |
| NARRATIVE_PUSH | S→C | Socket.io | **待实现** |
| RECONNECT | C→S | Socket.io | **待实现** |
| BACKFILL_STATE | C→S | Socket.io | **待实现** |

### 9.2 `isTransient` 广播标记（参考 PlanarAlly）

高频状态变更（如每 Tick 的坐标微移、动画插值）不需要写入数据库：

```typescript
interface StateMutationPayload {
  entityId: string;
  changes: Partial<EntityState>;
  isTransient: boolean;     // true = 仅广播，不落盘
  timestamp: number;
}
```

- `isTransient: true` — 高频或插值状态（坐标微移、视觉效果）
- `isTransient: false` — 关键状态变更（HP 变化、动作开始/结束、BUFF 生效）

### 9.3 断线重连与离线韧性（参考 Fari App）

Fari App 的 localStorage-first + CRDT 模式为断线重连提供参考：

```typescript
interface ReconnectStrategy {
  // 方案 A（轻量）：服务端维护状态快照，重连时全量推送
  snapshot: () => CampaignState;
  
  // 方案 B（进阶）：客户端 localStorage 缓存 + 差异同步
  localCache: {
    storage: localStorage;
    lastSync: number;
    pendingChanges: ClientIntent[];
  };
}
```

方案 A 为 Phase 5 首选，方案 B 作为后续优化。

---

## 第十章：验收标准

### Phase 可交付物验收

| Phase | 验收标准 |
|-------|---------|
| P1 规则引擎 | 可通过 DB 加载/切换两个不同的 RulePack，动作模板完全数据驱动 |
| P2 战斗核心 | 五阶段状态机运行 + PP/FP 扣除 + 中断判定正确（<0 才中断） |
| P3 战斗完整 | 五道防线 + 差合系统 + 假动作 + 部位破坏 可运行 |
| P4 探索环节 | 六边形地图可渲染、实体可移动、区域可触发 |
| P5 叙事环节 | 文本推送 + CG + 对话树 端到端可用 |
| P6 模组系统 | 第三方可通过 DSL 定义新动作、新效果、新状态机 |
