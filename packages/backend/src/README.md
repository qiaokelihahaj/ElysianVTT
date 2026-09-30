# ElysianVTT Backend Architecture & Context Guide

当前局域网可玩链路：`demo/index.ts` → `demo/DemoServer.ts`（示例组合根）→ `network/EncounterServer.ts` → `encounters/EncounterCoordinator.ts` → `CombatEngine`。会话在 `sessions/LanSessionService.ts`，存储经 `persistence/EncounterRepository.ts` 注入，SQLite 实现在 `SqliteEncounterRepository.ts`。旧 `demo/` 导入保留薄兼容层。详见[局域网模块架构](../../../docs/LAN_MODULES.md)。

当前 Demo 广播以 `DEMO_INCREMENT` 携带过滤后的完整 snapshot，并非真正的字段级差分；初连与重连使用 `DEMO_SNAPSHOT`。示例规则由 Demo 内容配置注入，通用引擎不包含示例规则。

第三阶段将待提交计划/历史移入 `ActionPlanService`，将反应窗口/选择/资源预留移入 `DecisionWindowService`，将 GM 实体修正和审计移入 `GmCommandService`。正式遭遇复制内容并创建实例 `ActionCatalog`；CombatEngine、ClashPool、时间线和投射物均通过注入目录查询动作。旧未指定规则的引擎保留全局 Dictionary 兼容适配，正式遭遇不使用该适配。

## 1. 系统概述 (System Overview)
ElysianVTT 是一个面向硬核战术跑团的虚拟桌面（VTT）后端引擎。
本后端**不包含任何具体的游戏业务规则（如武器伤害、法术效果、特定武技）**。所有规则均由数据库加载的 JSON/DSL 模板定义。
后端的核心职责是作为一个**“纯粹的物理与时间演算容器”**，负责：
1. **时间轴调度：** 基于最小堆（Min-Heap）的离散事件模拟（Tick System）。
2. **多模态场景管理：** 并发处理探索（无时间轴）与战斗（强制时间轴）的平滑切换。
3. **状态同步：** 在内存中极速推演状态突变（State Mutation），并通过 WebSocket 以增量差分（Diff）广播至前端。

### 战斗引擎职责边界

- `campaigns/engines/CombatEngine.ts`：公开 intent/event 接口、Tick 队列、Clash 结算、Hook 决策与统一状态广播。
- `campaigns/engines/CombatProjectileRuntime.ts`：每个引擎独立的投射物追踪与障碍物配置，负责发射、边界事件处理和结束清理；通过回调接入主引擎队列及广播，不独立推进时间。
- `campaigns/engines/CombatActionTimeline.ts`：根据实际脉冲历史预测剩余移动/引导脉冲并生成时间线补丁；不修改实体、不调度或广播。移动时序参数由主引擎传入，避免重复常量。

拆分回归测试：`pnpm exec tsx test/auth-isolated.runner.ts combat-extraction.test.ts hook-timing.test.ts engine.integration.test.ts`。该 runner 优先使用当前 TypeScript 源码，并使用临时 SQLite，不连接开发数据库。

## 2. 必须硬编码的核心机制 (Hardcoded Core Mechanics)
在开发具体模块时，必须严格实现以下底层机制，切勿与具体游戏规则耦合：

### A. 离散事件与优先队列 (Discrete Event Simulation)
- 战斗引擎 (`CombatEngine`) 必须由一个**最小堆 (Min-Heap)** 驱动。
- **时间跃迁：** 引擎不使用 `setInterval` 轮询每一帧，而是直接弹出堆顶事件，将 `currentTick` 跃迁至该事件的 `targetTick`。
- **惰性删除 (Tombstone)：** 当动作被打断或修改时，**绝对不**去堆中遍历查找并删除旧事件。而是修改原始事件的 `status` 为 `CANCELLED`（或对比版本号），当旧事件到达堆顶时，引擎自动丢弃它。

### B. 多模态路由 (Multi-modal Routing)
- 一个 `Scene` (地图场景) 下可以挂载多个 `EngineInstance`。
- 玩家发送 `ClientIntent` 时，`Scene` 必须能够根据 `actorId` 路由到正确的引擎（如正在跑图交由 `ExploreEngine` 立刻结算；正在打架交由对应的 `CombatEngine` 进入优先队列）。
- 支持实体的动态挂载/卸载 (`mountEntities` / `unmountEntities`)，实现“无缝拉入战斗”。

### C. 内存演算与差分广播 (In-Memory & Delta Broadcast)
- 战斗/探索期间，实体的状态读写**仅在内存 (RAM)** 中进行，严禁高频操作数据库 (Prisma)。
- 每次引擎处理完一个 Tick 的所有并发事件后，必须比对状态树，提取**状态差分 (State Mutation Payload)**（例如 `{"resources.current.hp": 15}` 扁平化路径），广播给该房间的客户端。

#### D. 同Tick相杀与碰撞池 (Simultaneous Resolution & Clash Pool)
- **机制要求：** 在真实时间轴中，极易出现两个实体在**同一个 Tick（如 Tick 15）**同时命中对方的情况。引擎**绝对不能**依赖数组弹出的随机顺序或时间戳的微小差异来进行“先到先得”的结算。
- **硬编码逻辑：** 当主循环从 Min-Heap 弹出事件时，如果发现有多个事件的 `targetTick` 完全相同且存在交叉影响（例如互相攻击、争夺同一网格），必须将它们放入一个临时的**“碰撞池 (Clash Pool)”**。根据动作模板的隐藏优先级（如“防守反击”>“轻击”>“重击”）或属性比拼进行子帧排序（Sub-tick Sorting）并同时结算伤害。

#### E. 动态弹道与边界事件预计算 (Trajectory & Boundary Raycasting)
- **机制要求：** 对于火球术、箭矢等跨越多个网格的飞行物，**严禁**每个 Tick 轮询计算一次坐标。
- **硬编码逻辑：** 当发射弹道时，使用 3D 射线算法（如 Bresenham 算法）预计算其穿过的每一个网格。向 Min-Heap 中只压入极少量的**边界事件 (Boundary Events)**（例：`Tick 12 进入格子A`，`Tick 14 进入格子B`）。当时间到达触发边界事件时，系统仅需检测那一瞬间该格子里是否有活体实体，从而支持“半路拦截”或“闪避”。

---

## 3. 核心契约：TypeScript 共享接口规范

以下是 `@hard-vtt/shared` 包的核心接口定义。后端的所有系统（Systems）必须基于此数据结构进行硬编码逻辑开发。

```typescript
// ==========================================
// 1. 空间与物理基础 (Spatial & Physics)
// ==========================================
export type PlaneId = string; 

export interface Vector3D {
    x: number;
    y: number;
    z: number; 
}

export interface Transform {
    coords: Vector3D;
    planeId: PlaneId;       
    facing: number;         
}

export interface PhysicsBody {
    scaleClass: number;      // 尺度级别 (0:微观, 1:常规, 2:巨物)
    collisionRadius: number; // 碰撞半径
    mass: number;            // 质量基数
    movementModes: string[]; 
}

// ==========================================
// 2. 游戏实体与资源 (Entity & Resources)
// ==========================================
export type EntityId = string;

export interface ResourcePool {
    current: Record<string, number>; 
    max: Record<string, number>;
}

export interface AppliedEffect {
    instanceId: string;
    templateId: string;      
    sourceEntityId: EntityId;
    remainingTicks: number;  // -1 为永久
    stacks: number;
}

export interface Entity {
    id: EntityId;
    templateId: string;      // 指向数据库字典，后端不关心具体内容
    type: 'ACTOR' | 'PROP' | 'PROJECTILE'; 
    
    transform: Transform;
    physics: PhysicsBody;
    resources: ResourcePool;
    activeEffects: AppliedEffect[];
    
    // 状态机上下文：记录当前正在执行的长前摇动作或移动
    currentActionContext?: {
        type: 'CASTING' | 'MOVING';
        actionId: string;                              // 当前压入优先队列的事件 ID
        actionTemplateId?: string;                     // CASTING 时存储技能模板 ID
        phase: 'DELAY' | 'STARTUP' | 'ACTIVE' | 'CHANNELING' | 'RECOVERY';
        resolveTick: number;
        pulseCount?: number;                           // CHANNELING 时记录已执行的脉冲次数
        eventIds?: string[];
        waypoints?: Vector3D[];                        // MOVING 时存储所有航点坐标
        currentWaypointIndex?: number;
    };
}

// ==========================================
// 3. 数据驱动模板 (Data-Driven Rules Definition)
// 后端负责解析以下结构，不负责写死具体业务
// ==========================================
export type ExpressionString = string;

export interface ActionTemplate {
    id: string;              
    tags: string[];          
    timeCost: { startupTicks: number; recoveryTicks: number; };
    resourceCost: Record<string, ExpressionString>; 
    range: { type: string; distanceExpr: ExpressionString; radiusExpr?: ExpressionString; };
    effects: ActionEffectPayload[];
}

export interface ActionEffectPayload {
    type: 'DAMAGE' | 'HEAL' | 'APPLY_BUFF' | 'PUSH' | 'INTERRUPT';
    targetSelector: 'PRIMARY' | 'ALL_IN_AOE' | 'SELF';
    conditions?: ExpressionString[]; 
    parameters: Record<string, any>;
}

// ==========================================
// 4. 引擎核心调度 (Engine & Tick Queue)
// ==========================================
export type Tick = number;

export interface TickEvent {
    eventId: string;
    targetTick: Tick;
    status: 'PENDING' | 'RESOLVED' | 'CANCELLED'; 
}

export interface ActionExecutionEvent extends TickEvent {
    eventType: 'ACTION_PHASE';
    actorId: EntityId;
    targetIds?: EntityId[];
    actionTemplateId: string;
    phase: 'STARTUP' | 'ACTIVE' | 'RECOVERY';
}

export interface IEngineInstance {
    engineId: string;
    engineType: 'COMBAT' | 'EXPLORE';
    currentTick: Tick;
    
    mountEntities(entities: Entity[]): void;
    unmountEntities(entityIds: EntityId[]): Entity[];
    receiveIntent(intent: ClientIntent): void;
    
    // 引擎输出事件流，供 Scene 或 SettlementService 订阅
    on(event: 'STATE_MUTATED', listener: (diff: StateMutationPayload) => void): void;
    on(event: 'VISUAL_FX', listener: (fx: VisualEventPayload) => void): void;
    on(event: 'ENTITY_DIED', listener: (entity: Entity) => void): void;
}

// ==========================================
// 5. 网络通讯协议 (WebSocket I/O)
// ==========================================
export interface ClientIntent {
    actorId: EntityId;
    intentType: 'CAST_ACTION' | 'MOVE' | 'INTERACT' | 'CANCEL_ACTION' | 'BATCH_CAST'
        | 'DEFEND' | 'DODGE' | 'REACTION' | 'MICRO_EVADE'
        | 'PRIORITY_TOGGLE' | 'GAMBIT_PRESET' | 'HOOK_PRESET';
    clientTick: Tick;
    payload: {
        actionTemplateId?: string;
        targetIds?: EntityId[];
        targetCoords?: Vector3D;
        cancelSubType?: 'DELAY_CANCEL' | 'FORCE_CANCEL';
        batchIntents?: Array<{ actorId: EntityId; actionTemplateId: string; targetIds?: EntityId[] }>;
        defendSubType?: 'PARRY' | 'BLOCK';
        evadeSubType?: 'DUCK' | 'HOP' | 'SLIP';
        reactionTargetId?: EntityId;
        toggleMode?: PlayerPriorityToggle;
        hookPreset?: HookPreset;
        gambitPreset?: { actionTemplateId: string; condition: HookTrigger };
    };
}

export interface StateMutationPayload {
    tick: Tick;
    mutations: Array<{
        entityId: EntityId;
        changes: Record<string, any>; // 扁平化状态差分，例 {"resources.current.hp": 10}
    }>;
}

export interface VisualEventPayload {
    tick: Tick;
    events: Array<{
        eventId: string;
        eventType: 'FX_SPAWN' | 'ANIM_PLAY' | 'SOUND_PLAY' | 'UI_FLOATING_TEXT'
            | 'MUTUAL_KILL' | 'INTERRUPTED' | 'REACTION_AVAILABLE' | 'WHIFF' | 'DECISION_POLL';
        sourceId: EntityId;
        targetId?: EntityId;
        targetCoords?: Vector3D;
        fxTemplateId: string; 
        durationMs?: number;
        text?: string;        
    }>;
}

// ==========================================
// 6. 日志协议与服务端输出 (Log Protocol)
// ==========================================
export enum LogLevel {
    DEBUG = 0,   // 引擎底层推演
    INFO = 1,    // 常规流程
    WARN = 2,    // 异常但可恢复
    ERROR = 3,   // 引擎错误崩溃
    GAME = 4     // 游戏内核心事件（前端战斗面板展示）
}

export enum LogVisibility {
    DEV = 'DEV',
    GM = 'GM',
    PLAYER = 'PLAYER'
}

export interface LogPayload {
    timestamp: number;          
    sceneId?: string;           
    tick?: number;              
    namespace: string;          
    level: LogLevel;
    visibility: LogVisibility;
    message: string;            
    meta?: any;                 
}
```

---

## 4. 后端开发启动原则

当 AI Agent 读取此文档后，后续的代码生成与架构实现需严格遵循以下准则：
1. **禁用业务 Hardcode：** 编写 `CombatSystem` 时，不要判断 `if (action === 'fireball')`，而是编写一个通用的效果解析器：读取 `ActionTemplate.effects` 数组，遇到 `type: 'DAMAGE'` 时，执行动态表达式计算扣除对应的资源池。
2. **时间轴推进逻辑：** `GameLoop` 模块必须通过操作 `TickEvent` 的最小堆来实现。打断（Interrupt）机制的实现方式是：修改 `Entity.currentActionContext.resolveTick`，并向堆中插入带有新 `targetTick` 的事件，将旧事件标记为 `CANCELLED`。
3. **数据安全性：** 暴露给前端的 `StateMutationPayload` 和 `VisualEventPayload` 必须由后端统一构造。严禁直接将完整的 `Entity` 对象未经清洗地全量推给前端（防外挂与数据过载）。
4. **数据库解耦：** `PrismaClient` 只允许存在于 `db/` 或 `SettlementService` 相关的模块中。在 `core/engines` 的主循环内部，严禁出现任何数据库 `await` 操作。
5. **动态表达式安全解析:** 在解析 `ActionTemplate` 中的诸如 `"3d6 + actor.str"` 或 `"target.poise == 0"` 的公式时，**绝对禁止使用 JS 原生的 `eval()`**（存在安全漏洞且性能极差）。Agent 必须引入或实现一个安全的、基于抽象语法树（AST）的数学与逻辑解析器（如 `mathjs` 或手写的小型 Parser）来处理资源消耗和伤害结算。
6. **事件驱动的结算解耦:** 当一个 `CombatEngine` 中的所有敌对实体死亡，战斗结束时，该 Engine 实例必须**立刻停止运算并自我销毁**。它不负责分发经验和战利品。它只需通过事件总线（Event Bus）抛出一个 `COMBAT_ENDED` 事件，交由宏观的 `SettlementService` 去与 Prisma/数据库交互并保存数据，随后将玩家平滑交接回 `ExploreEngine`。

---

## 5. 后端目录架构

```text
packages/backend/src/
├── index.ts                # 启动入口：初始化数据库、加载全局规则字典、启动服务器
├── app.ts                  # Express 与 Socket.io 的基础配置与中间件挂载
│
├── core/                   # 🚀 核心逻辑层 (纯粹的游戏引擎，不依赖 HTTP/Socket)
│   ├── engine/             # 时间轴驱动控制
│   │   ├── PriorityQueue.ts # 基于最小堆(Min-Heap)的事件队列 (支持惰性删除)
│   │   ├── TickLoop.ts     # 核心时间轴推进器 (跃迁式推进算法)
│   │   └── ClashPool.ts    # 同 Tick 相杀/碰撞池结算逻辑 (二阶段提交+优先级排序)
│   │
│   ├── entities/           # 内存态游戏实体 (面向对象封装)
│   │   ├── BaseEntity.ts   # 实体基类 (Transform, Physics, Resources)
│   │   ├── Actor.ts        # 角色实体 (战斗资源、状态机、五阶段动作上下文)
│   │   └── Projectile.ts   # 弹道实体 (存储轨迹方程、版本号、发射源)
│   │
│   ├── systems/            # 规则演算系统 (Data-Driven 解析器)
│   │   ├── CombatSystem.ts # HEMA 战斗判定、重量级压制、相杀结果结算
│   │   ├── SpatialSystem.ts # N维空间碰撞检测、六边形网格、射线预计算
│   │   ├── RuleEvaluator.ts # 安全的数学表达式解析器 (mathjs 沙箱，解析 "3d6 + actor.str")
│   │   └── EffectSystem.ts  # 动作副作用执行器 (DAMAGE, HEAL, BUFF, PUSH, INTERRUPT)
│   │
│   └── events/             # 离散事件定义
│       ├── EventBus.ts     # 事件总线 (引擎间解耦通信)
│       ├── EventFactory.ts # 意图拆解器 (将 ClientIntent 拆分为 DELAY/STARTUP/ACTIVE/RECOVERY 事件)
│       └── ActionEvents.ts # 各类 TickEvent 的具体子类定义
│
├── campaigns/              # 🗺️ 宏观战役与场景管理
│   ├── CampaignManager.ts  # 多战役会话管理 (全局单例)
│   ├── Scene.ts            # 场景容器 (一个场景可同时运行多个 Engine 实例)
│   ├── engines/            # 模态引擎实现
│   │   ├── CombatEngine.ts # Tick 循环、Clash、决策与状态广播
│   │   ├── CombatProjectileRuntime.ts # 投射物生命周期与边界事件
│   │   ├── CombatActionTimeline.ts # 移动/引导时间线预测
│   │   ├── ExploreEngine.ts # 自由探索即时引擎 (无时间轴结算)
│   │   └── HookRegistry.ts # Hook 断点注入注册表 (系统钩子+玩家预设，支持 6 种触发类型)
│   └── SettlementService.ts # 💰 独立结算服务 (监听实体死亡事件，处理 XP/掉落并写入 DB)
│
├── network/                # 🌐 通讯与表现层
│   ├── SocketServer.ts     # Socket.io 事件监听与连接池管理
│   ├── IntentRouter.ts     # 指令路由 (将前端 Intent 转发至正确的 Scene/Engine)
│   ├── StateBroadcaster.ts # 状态广播器 (计算增量差分并下发)
│   └── VisibilityFilter.ts # 🚀 信息盲盒过滤器 (抹除或混淆客户端不可见的数据字段)
│
├── db/                     # 🗄️ 持久化层
│   ├── prisma.ts           # Prisma Client 实例
│   ├── Dictionary.ts       # 规则字典缓存 (启动时加载 ActionTemplates 到内存)
│   ├── RulePackLoader.ts   # RulePack 加载器 (从 DB 加载全套规则定义并绑定到 Engine)
│   ├── Repository.ts       # 数据读写仓库 (冷数据持久化/注水/脱水)
│   ├── CharacterSheetRepository.ts  # 角色卡持久化
│   ├── LogRepository.ts    # 日志持久化
│   ├── PermissionGrantRepository.ts    # 权限授权持久化
│   ├── PermissionSnapshotRepository.ts # 权限快照持久化
│   ├── EntityMapper.ts     # 实体映射
│   └── seed.ts             # 种子数据
│
├── auth/                   # 🔐 认证服务
│   └── AuthenticationService.ts
│
├── permissions/            # 🛡️ 权限系统
│   └── PermissionService.ts
│
├── network/routes/         # HTTP 路由
│   ├── index.ts
│   └── health.ts
│
└── utils/                  # 🛠️ 通用工具
    ├── VectorMath.ts       # N 维向量 + 六边形坐标运算工具
    ├── dice/               # 🎲 高性能掷骰与规则系统
    │   ├── DiceGenerator.ts # 伪随机数生成工厂支持
    │   └── DiceProcessor.ts # 预编译规则(爆炸骰/重投)的极速评估引擎，支持玩家强行改值干预
    ├── Logger.ts           # 结构化日志系统
    ├── SafeJsonParser.ts   # 安全 JSON 解析工具 (防止 DB 脏数据崩溃)
    └── IdGenerator.ts      # 全局唯一实体/事件 ID 生成器
```

---

## 6. 渐进式开发计划 (Progressive Development Roadmap)

本项目采用**”架构完整，逐步实现”**的开发策略。
即：**不削弱已有设计抽象，仅在实现层面分阶段降级复杂度**，确保未来扩展时无需大规模重构。

> **当前状态**: 阶段 1-4 核心能力已实现，阶段 5（脚本化/扩展生态）待启动。
> 实际开发遵循 `prompt_plan.md` 中的 Phase 1-6 规划，与本 README 的阶段划分有重叠但不完全对应。

---

### ✅ 阶段 1：MVP - 可运行战斗核心 (Playable Combat Core)

**状态：已完成**（对应 prompt_plan.md Phase 1）

* Min-Heap 优先队列 (`PriorityQueue`) + Tick 跃迁 + 惰性删除
* 五阶段动作系统：DELAY → STARTUP → ACTIVE → RECOVERY（+ CHANNELING 引导模式）
* 双轨资源系统：PP(韧性/poise) + FP(专注/focus)
* Effect System：DAMAGE, HEAL, APPLY_BUFF, PUSH, INTERRUPT 全部实现
* RulePack 数据架构：Prisma 表 + RulePackLoader + Engine 绑定
* 六边形网格坐标：HexCoord + hexDistance + hexNeighbors
* CANCEL_ACTION / FEINT 打断与假动作机制
* BATCH_CAST 批量施法支持

---

### ✅ 阶段 2：多引擎分离与基础并发 (Engine Separation)

**状态：已完成**（对应 prompt_plan.md Phase 1-2）

* `CombatEngine`（Tick 驱动）+ `ExploreEngine`（即时结算）引擎拆分
* Scene 根据 `actorId` 路由 Intent，支持实体动态挂载/卸载
* Clash Pool 完整版：二阶段提交 + 优先级排序 + 同 Tick 同时结算

---

### ✅ 阶段 3：战斗核心博弈系统

**状态：已完成**（对应 prompt_plan.md Phase 2）

* DR 装甲减伤系统
* DEF 招架偏转系统（PARRY / BLOCK）
* 差合/挥空惩罚系统（whiff → Recovery 延长 → 确反窗口）
* 主动闪避系统（Dodge — 物理位移，范围伤害豁免）
* Reaction 反应动作系统（打断闯入 + 有效拦截）
* 微避系统（Micro-Evasion — HIGH/LOW/LINEAR Tag 匹配）
* Hook 断点注入系统（6 种触发类型 + 决策窗口）
* 决策倒计时系统（ReactionCountdown + TacticalDecisionPanel）

---

### ✅ 阶段 4：空间系统与弹道 (Spatial & Projectile)

**状态：骨架完成，弹道预计算待实现**

* `Projectile` 实体已定义
* `SpatialSystem` 基础能力：六边形网格、碰撞检测
* 弹道射线预计算（Raycasting）+ Boundary Event → **待实现**

---

### ⏳ 阶段 5（可选）：脚本化与扩展生态

**状态：待启动**（对应 prompt_plan.md Phase 6）

* 引入脚本语言（如轻量 DSL / Lua / WASM）
* 动作模板预编译（AST → bytecode）
* 模组化规则系统（Mod Support）
* Block 化角色卡渲染器
