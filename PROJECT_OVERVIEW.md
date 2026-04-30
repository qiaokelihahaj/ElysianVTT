# ElysianVTT 项目概要

> 面向架构师与开发人员的快速入门文档。涵盖项目定位、顶层架构、模块清单、类型体系、数据库模型、网络协议、引擎机制、启动流程、当前进度及下一步建议。

---

## 一、项目定位与核心理念

**ElysianVTT** 是一个基于「连续时间轴（Tick System）」与「多资源池博弈」的硬核战术动作类 TRPG 虚拟桌面引擎。当前已具备**可运行的战斗闭环 MVP**：后端 Tick 推演 + ClashPool 同 Tick 并发结算 + WebSocket 差分同步，前端 PixiJS 渲染 + 增量状态合并均已落地。

**与同类产品的差异：** 传统回合制 VTT 由客户端 UI 驱动，ElysianVTT 由**后端优先队列离散事件模拟**驱动——时间轴不再被回合划分，而是由动作的前摇(Startup)、判定(Active)、收招(Recovery) 三阶段精确编排。这意味着「打断」「同时相杀」「半路拦截弹道」等机制天然成立。

**核心设计哲学：**

| 原则 | 说明 |
|------|------|
| 数据驱动 | 引擎不含任何硬编码游戏规则（武器伤害、技能效果等），全部从数据库 JSON/DSL 模板加载 |
| 内存优先 | 战斗期间状态仅在内存中推演，不做数据库写入，结束后由 SettlementService 统一落库 |
| 增量广播 | 引擎只向客户端推送**状态差分**（哪个实体的哪个属性变成了什么），不推送完整对象 |
| 纯函数结算 | 规则求值通过 mathjs 沙箱执行，禁止 `eval()` |
| 骰池预编译 | 骰子规则（爆炸骰/重投/暴击标签）编译为 O(1) 原生比较函数，支持千级骰子高效推演 |

---

## 二、顶层架构

### 2.1 三层架构

```
┌─────────────────────────────────────────────────────┐
│                  @hard-vtt/frontend                  │
│  React + PixiJS(WebGL) + Zustand + socket.io-client │
│              表现层：渲染与用户输入                    │
└────────────────────────┬────────────────────────────┘
                         │ WebSocket (Socket.io)
┌────────────────────────┴────────────────────────────┐
│                  @hard-vtt/backend                   │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐          │
│  │Campaign  │ │  Network │ │   Core    │          │
│  │Manager   │ │  Server  │ │  Engine   │          │
│  └──────────┘ └──────────┘ └───────────┘          │
│              引擎层：时间轴推演与状态同步              │
└────────────────────────┬────────────────────────────┘
                         │ Prisma Client
┌────────────────────────┴────────────────────────────┐
│                  @hard-vtt/shared                    │
│     TypeScript 类型定义 (Entity, TickEvent, ...)     │
│                 共享层：强类型契约                     │
└─────────────────────────────────────────────────────┘
```

### 2.2 数据流向

```
Client (WebSocket)                Backend                         Database
═════════════════ ═══════════════════════════════════════════════ ════════

  ──JOIN_SCENE───►  SocketServer
                    └─► CampaignManager.getOrCreateEngine()
                          └─► new CombatEngine()
                                └─► CharacterSheetRepository.findBySceneId() ──► Prisma
                                └─► engine.mountEntities()  ◄── 注水数据 ◄────┘
   ◄──SCENE_SYNC───                                  (发送全量状态)
   ◄──JOIN_SUCCESS──

  ──CLIENT_INTENT─► SocketServer
                    └─► CampaignManager.getEngine()
                          └─► engine.receiveIntent()
                                ├─► 解析意图 → 创建 ActionExecutionEvent
                                ├─► PriorityQueue.push()  (STARTUP 事件)
                                │
                            processQueue() ◄── TickLoop.step() 跃迁至 targetTick
                                │
                                ├─► ClashPool.resolve()  (同 Tick 并发结算)
                                │     └─► EffectSystem.applyAction()
                                │           └─► RuleEvaluator.evaluate()
                                ├─► 广播 STATE_MUTATED ◄── 推到房间所有客户端
                                │
                                └─► 递归 pushNextPulse / pushRecovery

  战斗结束
  SettlementService ◄── COMBAT_END ──  CombatEngine ──► CharacterSheetRepository.upsertCombatResults()
```

### 2.3 后端入口链路

```
index.ts  →  Dictionary.loadAllFromDb()      加载动作模板进内存
          →  createApp()  (app.ts)           配置 Express
          →  createServer(app)               创建 HTTP Server
          →  new SocketServer(httpServer)     Socket.io + CampaignManager 初始化
          →  httpServer.listen(PORT)         开始监听
```

### 2.4 关键设计约束

| 约束 | 说明 |
|------|------|
| 引擎内严禁数据库 I/O | `core/engines/` 下的代码不得出现任何 `await prisma.*` |
| 严禁 `eval()` | 表达式解析必须通过安全的 mathjs 沙箱 |
| 惰性删除 | 打断动作时修改旧事件 status 为 `CANCELLED`，在堆顶静默丢弃，不遍历堆删除 |
| 差分广播 | 仅推送扁平化属性路径变更（如 `resources.current.hp`），不推送完整 Entity |

---

## 三、模块清单与实现状态

### 3.1 包依赖关系

```
@hard-vtt/shared (workspace:*)     ← 被 backend 和 frontend 依赖
@hard-vtt/backend (workspace:*)    ← 依赖 shared
@hard-vtt/frontend (workspace:*)   ← 依赖 shared
```

### 3.2 共享层 (`packages/shared/`)

| 模块 | 文件 | 状态 | 说明 |
|------|------|------|------|
| 类型定义 | `src/index.ts` | ✅ | 244 行，7 大类接口/类型（详见第四章） |

### 3.3 后端 (`packages/backend/`)

#### 核心层 (`src/core/`)

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| 优先队列 | `engine/PriorityQueue.ts` | ✅ | 二叉最小堆，支持 push/pop/peek，O(log n) |
| Tick 循环 | `engine/TickLoop.ts` | ✅ | 时间跃迁驱动，收集同 Tick 事件批次，peekSameTickEvents |
| 碰撞池 | `engine/ClashPool.ts` | ✅ | 同 Tick 并发结算：优先级求值 → 分组 → 快照预计算 → 一次性提交 + 死亡检测 + 相杀判决 |
| 实体基类 | `entities/BaseEntity.ts` | ⬜ | 待实现 |
| Actor 实体 | `entities/Actor.ts` | ⬜ | 待实现 |
| 弹道实体 | `entities/Projectile.ts` | ⬜ | 待实现 |
| 战斗系统 | `systems/CombatSystem.ts` | ⬜ | 待实现 |
| 空间系统 | `systems/SpatialSystem.ts` | ✅ | 航点规划、MovementStepEvent 生成、网格距离、移动耗时计算 |
| 规则求值器 | `systems/RuleEvaluator.ts` | ✅ | mathjs 沙箱 + NdM 掷骰宏预处理 |
| 效果系统 | `systems/EffectSystem.ts` | 🚧 | DAMAGE/HEAL 完整，INTERRUPT 已接入回调，APPLY_BUFF 仅日志，PUSH 待实现 |
| 动作事件 | `events/ActionEvents.ts` | 🚧 | 重导出入口：EventFactory（已实现）、EventBus（已实现） |
| 事件工厂 | `events/EventFactory.ts` | ✅ | createActionPhaseEvent / createMovementStepEvent |

#### 战役层 (`src/campaigns/`)

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| 战役管理器 | `CampaignManager.ts` | ✅ | 多场景引擎管理，实体注水，STATE_MUTATED/VISUAL_FX/ACTION_SCHEDULED/COMBAT_END 广播 |
| 战斗引擎 | `engines/CombatEngine.ts` | ✅ | Tick 驱动 + ClashPool 集成，三阶段动作 + Channel 递归调度，移动递归调度，墓碑删除，差分收集与广播，sustain/打断判定 |
| 探索引擎 | `engines/ExploreEngine.ts` | ⬜ | 待实现（即时结算模式） |
| 场景容器 | `Scene.ts` | ✅ | 场景生命周期（CREATED→LOADING→ACTIVE→ENDING→DESTROYED），玩家引用计数，空闲超时自动回收 |
| 结算服务 | `SettlementService.ts` | ✅ | 战斗结束后通过 CharacterSheetRepository 批量 upsert 结果 |

#### 网络层 (`src/network/`)

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| Socket 服务器 | `SocketServer.ts` | ✅ | Socket.io 连接管理，JOIN_SCENE/CLIENT_INTENT/LEAVE_SCENE/disconnect 路由 |
| 指令路由 | `IntentRouter.ts` | ✅ | ClientIntent 校验 + 路由转发（已实现但当前 SocketServer 内联处理 intent） |
| 状态广播 | `StateBroadcaster.ts` | ✅ | 绑定 CombatEngine 事件流到 Socket.io 房间广播，含 CombatEnd → SettlementService |
| 可见性过滤 | `VisibilityFilter.ts` | 🚧 | 当前为直通模式（无过滤逻辑），供扩展时接入视野/FoW 系统 |

#### 数据库层 (`src/db/`)

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| Prisma 客户端 | `prisma.ts` | ✅ | 单例导出 |
| 规则字典 | `Dictionary.ts` | ✅ | 启动时从 DB 加载 ActionTemplate 到内存 Map，含 priorityExpr/sustainResources/channelOptions 字段 |
| 角色仓库 | `CharacterSheetRepository.ts` | ✅ | 场景实体查询 + 内存缓存 + 批量 upsert + 按 ID 查询 |
| 实体映射 | `EntityMapper.ts` | ✅ | CharacterSheet DB 行 → Entity 对象转换 |
| 数据仓库 | `Repository.ts` | 🚧 | 当前仅重导出 CharacterSheetRepository + EntityMapper |
| 种子数据 | `seed.ts` | ✅ | 预置 HEAVY_STRIKE、FIRE_STORM（3段 Channel AOE）、SYNC_TEST（ClashPool 测试用）技能模板 + 战士 + 哥布林 |

#### 工具 (`src/utils/`)

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| ID 生成器 | `IdGenerator.ts` | ✅ | UUID v4 生成 |
| 骰子内核 | `dice/DiceProcessor.ts`<br>`dice/DiceGenerator.ts` | ✅ | 独立的高效 NdM 骰池流水线，支持暴击标签、爆炸骰、重投策略及玩家介入改值。引入规则预编译(AST)机制，将数千颗骰子的运算降至 O(1) 原生比较复杂度 |
| 日志系统 | `Logger.ts` | ✅ | 基于 shared 协议实现终端高亮、上下文透传的结构化日志 |
| 向量运算 | `VectorMath.ts` | ✅ | 三维向量距离、归一化、方向、步进、加减缩放 |
| JSON 解析 | `SafeJsonParser.ts` | ✅ | 安全 JSON 解析，防止脏数据崩溃 |

#### 其他

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| 启动入口 | `index.ts` | ✅ | bootstrap() 引导程序：加载字典 → 创建 Express App → 启动 SocketServer |
| Express 配置 | `app.ts` | ✅ | 创建 Express 实例，挂载 healthRouter，不内联于 index.ts |
| Prisma Schema | `prisma/schema.prisma` | ✅ | ActionTemplate（含 priorityExpr/sustainResourcesJson/channelOptionsJson）+ CharacterSheet 两个模型 |

### 3.4 前端 (`packages/frontend/`)

#### 入口与根组件

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| React 入口 | `src/main.tsx` | ✅ | 挂载 `<App />` |
| 根组件 | `src/App.tsx` | ✅ | WS 连接生命周期管理，订阅 STATE_MUTATED / VISUAL_FX / SCENE_SYNC / ACTION_SCHEDULED，组装 Canvas + HUD |

#### 资产系统 (`src/assets/`)

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| 资产管理器 | `AssetManager.ts` | ✅ | 精灵图 / SVG 预加载与缓存 |
| 资产目录 | `assetCatalog.ts` | ✅ | 实体视觉定义（ACTOR/PROP/PROJECTILE 的几何形状、颜色、选中态）+ 视觉特效定义（damage/heal/mutual_kill/interrupted 的浮动文字颜色、闪光颜色） |
| 静态资源 | `hero.png`、`react.svg`、`vite.svg` | ✅ | 预置图像资源 |

#### 画布渲染层 (`src/canvas/`)

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| React 画布组件 | `GameCanvas.tsx` | ✅ | 桥接 React ↔ PixiJS Application，处理 resize 与销毁 |
| 渲染管理器 | `RendererManager.ts` | ✅ | PixiJS 单例，管理四层容器（map/entity/fx/preview），实体精灵/Sprite 渲染，网格绘制，选中态高亮，浮动文字动画（FloatingText），lerp 平滑插值，幻影预览（phantom preview），MUTUAL_KILL / INTERRUPTED 视觉特效处理 |

#### 网络层 (`src/network/`)

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| WebSocket 客户端 | `socketClient.ts` | ✅ | Socket.io 客户端包装，支持 connect/disconnect/joinScene/sendIntent，监听 STATE_MUTATED / VISUAL_FX / SCENE_SYNC / ACTION_SCHEDULED |
| 指令分发器 | `IntentDispatcher.ts` | ✅ | 构建 ClientIntent：dispatchMove / dispatchCastAction / dispatchInteract |

#### 状态管理 (`src/store/`)

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| Zustand Store | `gameStore.ts` | ✅ | Zustand + Immer，管理 entities Map、tick、selectedEntityId、uiState（IDLE / SELECT_MOVE_TARGET / SELECT_ACTION_TARGET）、movementTargets 本地预测坐标、scheduledActions 时间轴数据，支持全量场景同步 (setInitialScene) 和增量差分合并 (applyStateMutation) |

#### UI 组件 (`src/ui/`)

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| HUD 叠加层 | `HUD.tsx` | ✅ | 浮动面板：HP 血量条、当前 Tick 显示、动作按钮栏（移动/技能/攻击），SELECT_MOVE_TARGET 模式叠加层 |

#### 工具 (`src/utils/`)

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| 对象工具 | `objectUtils.ts` | ✅ | setNestedProperty 深层路径写入，用于差分状态合并（如 `"resources.current.hp"`） |

## 四、类型体系（`@hard-vtt/shared`）

所有类型定义位于 `packages/shared/src/index.ts`（244 行），分为 7 大类。

### 4.1 空间与物理基础

```typescript
type PlaneId = string                    // 平面标识（地图层/高度层）

interface Vector3D {
    x: number; y: number; z: number     // 三维坐标
}

interface Transform {
    coords: Vector3D                    // 位置
    planeId: PlaneId                    // 所在平面
    facing: number                      // 朝向角度
}

interface PhysicsBody {
    scaleClass: number                  // 尺度级别 (0:微观, 1:常规, 2:巨物)
    collisionRadius: number             // 碰撞半径
    mass: number                        // 质量基数
    movementModes: string[]             // 移动模式 ["WALK", "FLY"]
}
```

使用位置：`Entity.transform`、`Entity.physics`

### 4.2 游戏实体与资源

```typescript
type EntityId = string

interface ResourcePool {
    current: Record<string, number>     // 当前值 {"hp": 80, "poise": 30}
    max: Record<string, number>         // 最大值 {"hp": 100, "poise": 50}
}

interface AppliedEffect {
    instanceId: string
    templateId: string                  // 指向 ActionTemplate
    sourceEntityId: EntityId            // 施加者
    remainingTicks: number              // 剩余 Tick，-1 为永久
    stacks: number                      // 堆叠层数
}

interface Entity {
    id: EntityId
    templateId: string                  // DB 字典引用
    type: 'ACTOR' | 'PROP' | 'PROJECTILE'
    transform: Transform
    physics: PhysicsBody
    resources: ResourcePool
    activeEffects: AppliedEffect[]
    currentActionContext?: {            // 动作状态机上下文
        type: 'CASTING' | 'MOVING'
        actionId: string
        actionTemplateId?: string
        phase: 'STARTUP' | 'CHANNELING' | 'RECOVERY'
        resolveTick: number
        pulseCount?: number
        waypoints?: Vector3D[]
        currentWaypointIndex?: number
    }
}
```

使用位置：`CombatEngine.entities`（Map）、`EffectSystem.applyAction()` 参数、`RuleEvaluator.evaluate()` 上下文

### 4.3 数据驱动模板

```typescript
type ExpressionString = string          // 可求值表达式，如 "actor.str + 2d6"

interface ActionTemplate {
    id: string                          // 如 "HEAVY_STRIKE"
    tags: string[]                      // 标签 ["ATTACK", "MELEE", "HEAVY"]
    timeCost: {
        startupTicks: number            // 前摇 Tick 数
        recoveryTicks: number           // 收招 Tick 数
    }
    resourceCost: Record<string, ExpressionString>  // 消耗 {"mp": "actor.str * 0.5"}
    range: {
        type: string                    // "MELEE" | "RANGED" | "AOE"
        distanceExpr: ExpressionString  // 距离表达式
        radiusExpr?: ExpressionString   // AOE 范围表达式
    }
    effects: ActionEffectPayload[]      // 效果数组
    diceRules?: DiceRule[]              // 关联掷骰规则
    priorityExpr?: ExpressionString     // 动态判定优先级公式（ClashPool 求值时用）
    sustainResources?: string[]         // STARTUP 阶段必须维持 >0 的资源列表
    channelOptions?: {                  // 持续引导/多段动作配置
        intervalTicks: number           // 每段判定之间的 Tick 间隔
        maxPulses?: number              // 最大触发次数
        pulseResourceCost?: Record<string, ExpressionString>  // 每次脉冲额外消耗
    }
}

interface ActionEffectPayload {
    type: 'DAMAGE' | 'HEAL' | 'APPLY_BUFF' | 'PUSH' | 'INTERRUPT'
    targetSelector: 'PRIMARY' | 'ALL_IN_AOE' | 'SELF'
    conditions?: ExpressionString[]     // 触发条件
    parameters: Record<string, any>     // 效果参数
}
```

使用位置：`Dictionary.actions`（内存缓存）、`EffectSystem.applyAction()` 效果遍历、`RuleEvaluator.evaluate()` 表达式求值、`ClashPool.decorateEvents()` 优先级求值、`CombatEngine` channelOptions 递归调度

### 4.4 掷骰系统

```typescript
interface RawDie {
    id: string; sides: number; faceValue: number
}

interface DiceRule {
    condition: string                              // 触发条件，如 "faceValue == sides"
    actionType: 'ADD_TAG' | 'EXPLODE' | 'REROLL'   // 爆炸骰 / 重投 / 暴击标签
    actionPayload?: string
}

interface ProcessedDie extends RawDie {
    finalValue: number                              // 经过规则处理后的最终结果
    tags: string[]                                  // 累积标签（如 "CRIT"）
    isOverridden: boolean                           // 是否被玩家/技能直接改值
}

interface DicePoolResult {
    total: number                                   // 骰池总和
    dice: ProcessedDie[]                            // 每颗骰子的处理结果
    poolTags: string[]                              // 骰池全局标签
}
```

使用位置：`DiceGenerator` 生成 `RawDie`，`DiceProcessor` 预编译规则 → `DicePoolResult`，`RuleEvaluator.evaluate()` 注入表达式

### 4.5 日志协议

```typescript
enum LogLevel {
    DEBUG = 0,    // 引擎底层推演（堆排序、事件压入）
    INFO = 1,     // 常规流程（连接建立、引擎初始化）
    WARN = 2,     // 异常但可恢复（未找到目标）
    ERROR = 3,    // 引擎错误（沙箱执行崩溃）
    GAME = 4      // 游戏内核心事件（造成伤害、施加Buff），用于前端展示和回放
}

enum LogVisibility {
    DEV = 'DEV',         // 仅开发者可见
    GM = 'GM',           // 开发者 + GM 可见
    PLAYER = 'PLAYER'    // 所有人可见（战斗记录面板）
}

interface LogPayload {
    timestamp: number; sceneId?: string; tick?: number
    namespace: string; level: LogLevel; visibility: LogVisibility
    message: string; meta?: any
}
```

使用位置：`Logger.ts` 实现结构化日志输出（ANSI 终端高亮），支持 sceneId / tick 上下文透传

### 4.6 引擎核心调度

```typescript
type Tick = number

interface TickEvent {
    eventId: string
    targetTick: Tick                    // 目标触发时刻
    status: 'PENDING' | 'RESOLVED' | 'CANCELLED'
}

interface ActionExecutionEvent extends TickEvent {
    eventType: 'ACTION_PHASE'
    actorId: EntityId
    targetIds?: EntityId[]
    actionTemplateId: string
    phase: 'STARTUP' | 'ACTIVE' | 'RECOVERY'
}

interface MovementStepEvent extends TickEvent {
    eventType: 'MOVEMENT_STEP'
    actorId: EntityId
    currentCoords: Vector3D            // 本次到达的坐标
    targetCoords: Vector3D             // 最终终点
    isLastStep: boolean                // 是否最后一步
}

interface IEngineInstance {
    engineId: string
    engineType: 'COMBAT' | 'EXPLORE'
    currentTick: Tick
    mountEntities(entities: Entity[]): void
    unmountEntities(entityIds: EntityId[]): Entity[]
    receiveIntent(intent: ClientIntent): void
    on(event: 'STATE_MUTATED', listener: (diff: StateMutationPayload) => void): void
    on(event: 'VISUAL_FX', listener: (fx: VisualEventPayload) => void): void
    on(event: 'ENTITY_DIED', listener: (entity: Entity) => void): void
    on(event: 'ACTION_SCHEDULED', listener: (payload: ActionScheduledPayload) => void): void
}
```

使用位置：`CombatEngine` implements `IEngineInstance`，`CampaignManager` 管理引擎实例

### 4.7 网络通讯协议

```typescript
interface ClientIntent {
    actorId: EntityId
    intentType: 'CAST_ACTION' | 'MOVE' | 'INTERACT'
    clientTick: Tick
    payload: {
        actionTemplateId?: string      // CAST_ACTION 时必填
        targetIds?: EntityId[]         // 目标实体
        targetCoords?: Vector3D        // MOVE 时的目标坐标
    }
}

interface StateMutationPayload {
    tick: Tick
    mutations: Array<{
        entityId: EntityId
        changes: Record<string, any>   // 扁平化差分 {"resources.current.hp": 10}
    }>
}

interface VisualEventPayload {
    tick: Tick
    events: Array<{
        eventId: string
        eventType: 'FX_SPAWN' | 'ANIM_PLAY' | 'SOUND_PLAY' | 'UI_FLOATING_TEXT' | 'MUTUAL_KILL' | 'INTERRUPTED'
        sourceId: EntityId
        targetId?: EntityId
        targetCoords?: Vector3D
        fxTemplateId: string
        durationMs?: number
        text?: string                   // 浮动文字内容
    }>
}

interface ActionScheduledPayload {
    entityId: EntityId
    actionId: string
    actionName: string
    timeline: {
        start: Tick                     // 意图发出时刻
        startupEnd: Tick                // 前摇结束（第一个 ACTIVE 帧）
        recoveryStart: Tick             // 收招开始（最后一个 ACTIVE + 1）
        end: Tick                       // 收招结束
        pulseTicks?: number[]           // 每个判定帧的具体 Tick（用于帧数条高亮）
    }
    tags?: string[]
}
```

使用位置：`SocketServer` 接收 `ClientIntent`，`CombatEngine` 广播 `StateMutationPayload` / `ActionScheduledPayload` / `VisualEventPayload`，`gameStore` 消费 `ActionScheduledPayload` 渲染时间轴

---

## 五、数据库模型（Prisma + SQLite）

### 5.1 Schema 定义

```prisma
datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model ActionTemplate {
  id              String  @id           // 技能 ID，如 "HEAVY_STRIKE"
  name            String               // 技能名称
  startupTicks    Int                  // 前摇 Tick 数
  recoveryTicks   Int                  // 收招 Tick 数
  effectsJson     String               // ActionEffectPayload[] JSON
  priorityExpr    String?              // ClashPool 动态优先级公式
  sustainResourcesJson String?         // 维持资源列表 JSON
  channelOptionsJson String?           // Channel 引导配置 JSON
  tagsJson        String?
  resourceCostJson String?
  rangeJson       String?
}

model CharacterSheet {
  id              String  @id          // 实体 ID，如 "actor_warrior"
  name            String               // 角色名
  type            String               // 'ACTOR' | 'PROP' | 'PROJECTILE'
  resourcesJson   String               // ResourcePool JSON
  currentSceneId  String?              // 当前所在场景 ID
  transformJson   String               // Transform JSON
  physicsJson     String               // PhysicsBody JSON
}
```

### 5.2 种子数据

| 表 | ID | 关键数据 |
|----|----|----|
| ActionTemplate | `HEAVY_STRIKE` | startupTicks=10, recoveryTicks=5, 两个 DAMAGE 效果（hp: `actor.str + 2d6`，poise: `5`）, priorityExpr=`actor.str + 10`, sustainResources=`["poise"]` |
| ActionTemplate | `FIRE_STORM` | startupTicks=15, recoveryTicks=10, DAMAGE(hp: `10 + 2d6`), 3 段 Channel AOE（intervalTicks=8, maxPulses=3）, sustainResources=`["concentration","poise"]`, priorityExpr=`actor.agi + 5` |
| ActionTemplate | `SYNC_TEST` | startupTicks=10, recoveryTicks=5, DAMAGE(hp: `25` + poise: `10`), 用于 ClashPool 同 Tick 并发测试, priorityExpr=`actor.str * 0.5 + 10` |
| CharacterSheet | `actor_warrior` | HP=100, poise=50, str=15, 坐标(0,0,0), 质量70, 在 `room_1` |
| CharacterSheet | `target_goblin` | HP=30, poise=10, 坐标(0,2,0), 质量30, 在 `room_1` |

### 5.3 数据流向

```
启动时:
  Dictionary.loadAllFromDb() ──► prisma.actionTemplate.findMany()
                                    └─► 转换 JSON → ActionTemplate 存入内存 Map
                                    └─► 字段含 priorityExpr / sustainResources / channelOptions

加入场景时:
  CampaignManager.getOrCreateEngine() ──► CharacterSheetRepository.findBySceneId(sceneId)
                                            └─► EntityMapper.sheetToEntity() → Entity[]
                                            └─► engine.mountEntities()

战斗结束后:
  SettlementService.settleCombat() ──► CharacterSheetRepository.upsertCombatResults(entities, casualties, sceneId)
```

---

## 六、网络协议

### 6.1 事件表

| 事件名 | 方向 | 触发时机 | 数据结构 |
|--------|------|----------|----------|
| `JOIN_SCENE` | Client → Server | 玩家进入场景 | `{ sceneId, actorId }` |
| `JOIN_SUCCESS` | Server → Client | 场景加入成功 | `{ sceneId, serverTime, message }` |
| `CLIENT_INTENT` | Client → Server | 玩家执行动作 | `{ sceneId, intent: ClientIntent }` |
| `SCENE_SYNC` | Server → Client | 场景全量状态同步 | `{ tick, entities: Entity[] }` |
| `STATE_MUTATED` | Server → Client | 每个 Tick 结算后 | `StateMutationPayload` |
| `VISUAL_FX` | Server → Client | 需要前端播放特效 | `VisualEventPayload` (含 MUTUAL_KILL/INTERRUPTED) |
| `ACTION_SCHEDULED` | Server → Client | 动作被排入时间轴 | `ActionScheduledPayload` (含 pulseTicks 时间线) |
| `ENTITY_DIED` | Server → Client | 实体死亡 | `{ entityId }` |
| `COMBAT_END` | Server → Client | 战斗结束 | `{ sceneId, tick, survivors, casualties, entities }` |
| `ERROR` | Server → Client | 操作失败 | `{ code, message }` |
| `disconnect` | Client → Server | 连接断开 | 无 |

### 6.2 典型交互流程

```
1. Client ──JOIN_SCENE──► Server
                         └─► CampaignManager 从 DB 注水实体
                         └─► socket.join(sceneId)
   Client ◄──SCENE_SYNC──── Server  (全量实体状态 → Zustand store)
   Client ◄──JOIN_SUCCESS── Server

2. Client ──CLIENT_INTENT──► Server
                             └─► CampaignManager.getEngine(sceneId)
                                   └─► engine.receiveIntent(intent)
                                         ├─► 创建 STARTUP 事件 → PriorityQueue.push()
                                         ├─► emit ACTION_SCHEDULED (时间轴数据)
                                         └─► processQueue()
                                               ├─► TickLoop.step() 收集同 Tick 批次
                                               ├─► ClashPool.resolve() (并发冲突结算)
                                               │     └─► EffectSystem.applyAction()
                                               │           └─► RuleEvaluator.evaluate()
                                               ├─► broadcastMutations()
                                               ├─► 递归 pushNextPulse (Channel) / pushRecovery
                                               └─► 最终 emit COMBAT_END
   Client ◄──ACTION_SCHEDULED── Server  (时间轴渲染数据)
   Client ◄──STATE_MUTATED── Server    (推送到房间内所有客户端)
   Client ◄──VISUAL_FX── Server        (MUTUAL_KILL / INTERRUPTED 等特效)
```

---

## 七、引擎核心机制

### 7.1 Tick 系统（离散事件模拟）

**驱动方式：** 二叉最小堆（`PriorityQueue`），按 `targetTick` 排序。`TickLoop` 负责收集同 Tick 批次供 `ClashPool` 处理。

```
Event Queue (Min-Heap by targetTick)
  ◄── push(event)      O(log n)
  ◄── pop()            O(log n)
  ◄── peek()           O(1)

时间跃迁流程:
  TickLoop.step():
    1. peek next event → 时间直接跃迁至 targetTick
    2. 收集同 Tick 所有事件 → 返回批次 { tick, events[] }
  CombatEngine.processQueue():
    3. 过滤 CANCELLED 事件（墓碑删除）
    4. 分离 ClashPool 候选（≥2 个 ACTIVE 事件 → 并发结算）
    5. 剩余事件逐条结算
    6. broadcastMutations() 广播差分
    7. 递归处理下一批次直至队列为空
```

**墓碑删除（Tombstone）：** 当动作被打断时，不遍历堆删除旧事件（O(n)），而是将旧事件的 `status` 设为 `CANCELLED`。旧事件上升到堆顶时被静默丢弃。

### 7.2 三阶段动作系统（含 Channel 递归）

```
Client Intent (CAST_ACTION)
    │
    ├─► 阶段 1: STARTUP (前摇)
    │     targetTick = currentTick + startupTicks
    │     可被 INTERRUPT 打断
    │
    ├─► 阶段 2: ACTIVE (判定) — 递归脉冲
    │     EffectSystem.applyAction(template, actor, targets)
    │     RuleEvaluator.evaluate(expression, { actor, target })
    │     写入 pendingMutations
    │     ├─► 若有 channelOptions 且未达 maxPulses: pushNextPulse(intervalTicks)
    │     │     (扣除 pulseResourceCost，进入 CHANNELING 状态)
    │     └─► 否则: pushRecovery(recoveryTicks)
    │
    └─► 阶段 3: RECOVERY (收招)
          targetTick = currentTick + recoveryTicks
          期间无法执行新动作
          完成后 currentActionContext = undefined
```

### 7.3 ClashPool 并发结算

当同一 Tick 有 ≥2 个 ACTIVE 判定事件时，ClashPool 接管结算：

```
ClashPool.resolve():
  Step 1: Evaluate & Decorate — 为每个事件求值 priorityExpr，赋予 calculatedPriority
  Step 2: Group & Sort — 按优先级降序排序 + 容差合并分组
  Step 3: Resolve Group — 每组内：
            Phase 1: 创建实体快照 → 预计算差分（不修改真实内存）
            Phase 2: 一次性提交到真实实体
            Phase 3: 死亡/Poise Break 检测 + 相杀判决
  Result: → 差分 mutations + 死亡列表 + MUTUAL_KILL 事件
```

### 7.4 效果系统（`EffectSystem`）

当前实现的效果类型：

| 效果 | 实现状态 | 逻辑 |
|------|----------|------|
| `DAMAGE` | ✅ 完整 | `newVal = max(0, current - amount)`，amount 由 RuleEvaluator 动态计算 |
| `HEAL` | ✅ 完整 | `newVal = min(max, current + amount)` |
| `APPLY_BUFF` | 🚧 仅日志 | 标记日志输出，完整 Buff 挂载逻辑待实现 |
| `PUSH` | ⬜ 未实现 | 位移效果 |
| `INTERRUPT` | ✅ 已接入 | 通过回调 `cancelCurrentAction(target)` 取消目标动作 + sustain 资源清空 + VISUAL_FX 广播 |

目标选择器支持：
- `SELF` — 施法者自身
- `PRIMARY` — 指向 `targetIds` 中的实体

### 7.5 规则求值器（`RuleEvaluator`）

**安全机制：**
- 使用 mathjs 沙箱（禁用 `import`、`createUnit`、`simplify`、`derivative` 等危险函数）
- 严禁 JS `eval()`
- 求值失败返回 `0`，防止引擎崩溃

**作用域构建：**
- `actor.[attr]` → 从 `actor.resources.current` 展开属性（如 `actor.str`、`actor.hp`）
- `target.[attr]` → 从 `target.resources.current` 展开属性

**掷骰系统：**
- 正则 `/^(\d+)d(\d+)$/` 匹配 `NdM` 格式，如 `2d6` → N 次随机取面求和
- `DiceGenerator` 独立生成原始骰子 `RawDie[]`
- `DiceProcessor` 预编译规则为 AST（O(1) 比较函数），支持：
  - **EXPLODE** 爆炸骰（掷出最大面值追加一颗骰子，可链式触发）
  - **REROLL** 重投（满足条件时重新掷骰）
  - **ADD_TAG** 暴击标签（如 `faceValue == sides → CRIT`）
  - **override** 玩家介入改值（如消耗资源直接修定骰值）
- 结果输出 `DicePoolResult`，其 `total` 注入 mathjs 表达式

### 7.6 Sustain 与打断机制

- **sustainResources** 配置：STARTUP / CHANNELING 阶段必须维持 >0 的资源（如 `poise`、`concentration`）
- 每次差分生效后检查受影响的实体是否满足 sustain 条件
- 不满足 → `triggerInterrupt()` → 取消动作 + 清空 sustain 资源 + 广播 `INTERRUPTED` 视觉事件
- 外部 INTERRUPT 效果同理，通过 `cancelCurrentAction` 回调实现

**示例：**
```
表达式: "actor.str + 2d6"
actor.resources.current.str = 15
预处理: "15 + 9"          (2d6 → 随机值 9)
结果: 24
```

---

## 八、启动流程

### 8.1 入口：`packages/backend/src/index.ts`

```
bootstrap()
  │
  ├─► 1. Dictionary.loadAllFromDb()
  │     └─► prisma.actionTemplate.findMany()
  │           └─► 解析 JSON → ActionTemplate 存入内存 Map
  │           └─► 字段含 priorityExpr / sustainResources / channelOptions
  │
  ├─► 2. createApp()  (来自 app.ts)
  │     └─► express() + JSON 中间件 + /health 路由
  │
  ├─► 3. createServer(app) → new SocketServer(httpServer)
  │     ├─► new Server(httpServer, { cors })       Socket.io 初始化
  │     ├─► new CampaignManager(io)                战役管理器创建
  │     └─► setupListeners()                       注册 JOIN_SCENE / CLIENT_INTENT / LEAVE_SCENE / disconnect
  │
  ├─► 4. httpServer.listen(PORT)                   开始监听 3000 端口
```

### 8.2 开发环境启动命令

| 方式 | 命令 |
|------|------|
| Docker (推荐) | `docker-compose up` |
| 手动 | `pnpm install && pnpm --filter @hard-vtt/shared build && (cd packages/backend && pnpm db:push && npx ts-node src/db/seed.ts) && pnpm --filter @hard-vtt/backend dev && pnpm --filter @hard-vtt/frontend dev` |

---

## 九、当前进度与下一步开发建议

### 9.1 MVP 阶段完成情况

| 子系统 | 完成项 | 待完成项 |
|--------|--------|----------|
| 时间轴 | PriorityQueue ✅、TickLoop ✅（收集同 Tick 批次）、墓碑删除 ✅ | — |
| 并发结算 | ClashPool ✅（优先级求值 + 分组 + 快照预计算 + 相杀判决） | — |
| 动作系统 | STARTUP → ACTIVE → RECOVERY 三阶段 ✅、Channel 递归调度（FIRE_STORM 3 段）✅、MOVE 递归调度 ✅ | — |
| 效果系统 | DAMAGE ✅、HEAL ✅、INTERRUPT ✅（回调中断 + sustain 检测） | APPLY_BUFF 完整实现、PUSH |
| 规则求值 | mathjs 沙箱 ✅、NdM 掷骰 ✅、骰池预编译 ✅（EXPLODE/REROLL/CRIT/override） | 复杂条件表达式、优势/劣势骰子 |
| 网络层 | JOIN_SCENE ✅、CLIENT_INTENT ✅、STATE_MUTATED ✅、SCENE_SYNC ✅、VISUAL_FX ✅（含 MUTUAL_KILL/INTERRUPTED）、ACTION_SCHEDULED ✅、COMBAT_END ✅ | 断线托管、断线重连全量同步 |
| 数据库 | Prisma Schema ✅（含 priorityExpr/sustainResources/channelOptions 字段）、种子数据 ✅（HEAVY_STRIKE/FIRE_STORM/SYNC_TEST）、Dictionary 加载 ✅ | Repository 抽象层完善 |
| 日志协议 | LogPayload ✅、LogVisibility ✅、Logger.ts ✅ | 可视化调试面板、Replay 回放系统 |
| **前端** | **PixiJS 画布 ✅、实体渲染（Sprite/Graphics） ✅、网格 ✅、浮动文字动画 ✅、lerp 平滑插值 ✅、幻影预览 ✅** | 精灵图动画帧控制 |
| **前端** | **资产系统 ✅（assetCatalog 实体视觉 + 特效视觉定义、AssetManager 预加载）** | — |
| **前端** | **选中态 ✅（几何高亮 + 缩放）、HUD 面板 ✅（HP/Tick/动作按钮）** | 技能面板选择、目标选择可视化 |
| **前端** | **WebSocket 客户端 ✅、STATE_MUTATED 增量合并 ✅、SCENE_SYNC 全量同步 ✅、ACTION_SCHEDULED 时间轴 ✅** | 断线重连 UI |
| **前端** | **Zustand 状态管理 ✅（增量差分 + 时间轴数据 + 本地预测坐标）** | — |
| **前端** | **IntentDispatcher（MOVE/CAST_ACTION/INTERACT） ✅** | 交互物品逻辑 |

**各模块粗略完成度：**
- Shared 类型层：~95%
- Backend 引擎层：~75%
- Frontend 表现层：~55%
- 测试：~60%
- 整体 MVP：~70%

### 9.2 推荐下一步开发顺序

| 优先级 | 任务 | 原因 |
|--------|------|------|
| 🔴 1 | **Implement ExploreEngine.ts** | 探索模式即时结算引擎（移动引擎），支持无缝切战，是目前缺失的关键模式 |
| 🔴 2 | **完善 Scene 生命周期管理** | 扩展 Scene 的 Loading/Active/Paused/Ending 过渡流程，增加持久化与恢复能力 |
| 🟡 3 | **Repository 抽象层** | 统一数据访问接口（当前分散在 Dictionary / CharacterSheetRepository 中），便于后续切换 DB 实现 |
| 🟡 4 | **断线重连 / 托管机制** | 客户端断线后短暂托管角色自动战斗或挂起，重连时全量同步 + 追赶事件队列 |
| 🟡 5 | **更完整的 Buff / Push / Interrupt** | APPLY_BUFF 完整 Buff 挂载/倒计时/堆叠逻辑；PUSH 位移效果实现 |
| 🟡 6 | **更完整的空间与弹道扩展** | Projectile 实体支持、AOE 范围判定、ALL_IN_AOE targetSelector 实现 |
| 🟢 7 | **解耦事件监听与广播** | 将 Socket 广播逻辑从 Engine 初始化中进一步模块化，便于扩展 AI 观察者或 Replay 回放系统 |
| 🟢 8 | **优势/劣势骰子** | 在 DiceProcessor 中扩展 D&D 规则集的双骰取高取低逻辑 |
| 🟢 9 | **领域迁移与 DB 回写优化** | 优化 SettlementService upsert 粒度，支持增量战斗结果持久化、展开 XP/掉落计算 |
| 🟢 10 | **前端技能面板与目标选择可视化** | 为 CAST_ACTION 提供技能菜单、范围高亮、目标指示器等交互组件 |

---

## 附录 A：开发环境要求

| 组件 | 版本要求 |
|------|----------|
| Node.js | v22.x |
| pnpm | v10.x |
| Docker | 任意（容器化开发时必选） |

验证命令：`node verify-env.js`

## 附录 B：测试

```bash
cd test
npx tsx core.test.ts                    # 战斗引擎集成测试（三阶段动作、差分广播、实体生命周期）
npx tsx clashpool.test.ts               # ClashPool 并发结算测试（优先级分组、快照、相杀判决）
npx tsx engine.integration.test.ts      # 引擎完整集成测试（意图 → 事件 → 结算 → 广播全链路）
npx tsx tickloop.test.ts                # TickLoop 时间跃迁与批次收集测试
npx tsx movement.test.ts                # 移动递归航点调度测试
npx tsx channel.test.ts                 # Channel 多段引导动作测试
npx tsx interrupt.test.ts               # Interrupt 打断 + sustain 检测测试
npx tsx frontend-store.test.ts          # Zustand gameStore 单元测试（增量合并 / 全量同步）
npx tsx frontend-intent.test.ts         # IntentDispatcher 指令构建测试
npx tsx frontend-utils.test.ts          # objectUtils 工具测试
npx tsx backend-utils.test.ts           # 后端工具测试（ID 生成、日志、JSON 解析）
```

独立测试文件在不依赖完整后端的情况下，直接实例化 `PriorityQueue`、`CombatEngine`（mock）、`RuleEvaluator`，验证：
- 最小堆 push/pop 正确性
- TickLoop.step() 时间跃迁与同 Tick 批次收集
- ClashPool 优先级求值 → 分组 → 快照预计算 → 相杀判决
- STARTUP/ACTIVE/RECOVERY 三阶段 + Channel 递归调度
- MOVE 递归航点移动调度
- INTERRUPT 打断 + sustainResource 机制
- `"actor.str + 2d6"` 表达式求值
- DiceGenerator / DiceProcessor（EXPLODE/REROLL/CRIT/override）全流程
- STATE_MUTATED 差分广播
- Zustand store 增量合并 / 全量同步 / 时间轴数据正确性
- IntentDispatcher 指令构建完整性

## 附录 C：项目文件关键路径速查

| 用途 | 路径 |
|------|------|
| 共享类型定义 | `packages/shared/src/index.ts` |
| 后端入口 | `packages/backend/src/index.ts` |
| Express 配置 | `packages/backend/src/app.ts` |
| 后端架构文档 | `packages/backend/src/README.md` |
| 战斗引擎 | `packages/backend/src/campaigns/engines/CombatEngine.ts` |
| Tick 循环 | `packages/backend/src/core/engine/TickLoop.ts` |
| 优先队列 | `packages/backend/src/core/engine/PriorityQueue.ts` |
| 碰撞池 | `packages/backend/src/core/engine/ClashPool.ts` |
| 效果系统 | `packages/backend/src/core/systems/EffectSystem.ts` |
| 规则求值器 | `packages/backend/src/core/systems/RuleEvaluator.ts` |
| 空间系统 | `packages/backend/src/core/systems/SpatialSystem.ts` |
| 事件工厂 | `packages/backend/src/core/events/EventFactory.ts` |
| 骰子处理器 | `packages/backend/src/utils/dice/DiceProcessor.ts` |
| 骰子生成器 | `packages/backend/src/utils/dice/DiceGenerator.ts` |
| 向量运算 | `packages/backend/src/utils/VectorMath.ts` |
| Socket 服务器 | `packages/backend/src/network/SocketServer.ts` |
| 状态广播器 | `packages/backend/src/network/StateBroadcaster.ts` |
| 战役管理器 | `packages/backend/src/campaigns/CampaignManager.ts` |
| 场景容器 | `packages/backend/src/campaigns/Scene.ts` |
| 结算服务 | `packages/backend/src/campaigns/SettlementService.ts` |
| 规则字典 | `packages/backend/src/db/Dictionary.ts` |
| 角色仓库 | `packages/backend/src/db/CharacterSheetRepository.ts` |
| 数据库 Schema | `packages/backend/prisma/schema.prisma` |
| 种子数据 | `packages/backend/src/db/seed.ts` |
| **前端根组件** | `packages/frontend/src/App.tsx` |
| **PixiJS 渲染管理器** | `packages/frontend/src/canvas/RendererManager.ts` |
| **资产目录** | `packages/frontend/src/assets/assetCatalog.ts` |
| **资产管理器** | `packages/frontend/src/assets/AssetManager.ts` |
| **WebSocket 客户端** | `packages/frontend/src/network/socketClient.ts` |
| **指令分发器** | `packages/frontend/src/network/IntentDispatcher.ts` |
| **Zustand 状态管理** | `packages/frontend/src/store/gameStore.ts` |
| **HUD 面板** | `packages/frontend/src/ui/HUD.tsx` |
| 集成测试（核心） | `test/core.test.ts` |
| 集成测试（碰撞池） | `test/clashpool.test.ts` |
| 集成测试（引擎全链路） | `test/engine.integration.test.ts` |
| Docker 编排 | `docker-compose.yml` |
| 环境检查 | `verify-env.js` |
| 环境变量模板 | `.env.example` |
