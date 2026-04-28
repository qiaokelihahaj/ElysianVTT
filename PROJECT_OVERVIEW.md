# ElysianVTT 项目概要

> 面向架构师与开发人员的快速入门文档。涵盖项目定位、顶层架构、模块清单、类型体系、数据库模型、网络协议、引擎机制、启动流程、当前进度及下一步建议。

---

## 一、项目定位与核心理念

**ElysianVTT** 是一个基于「连续时间轴（Tick System）」与「多资源池博弈」的硬核战术动作类 TRPG 虚拟桌面引擎。

**与同类产品的差异：** 传统回合制 VTT 由客户端 UI 驱动，ElysianVTT 由**后端优先队列离散事件模拟**驱动——时间轴不再被回合划分，而是由动作的前摇(Startup)、判定(Active)、收招(Recovery) 三阶段精确编排。这意味着「打断」「同时相杀」「半路拦截弹道」等机制天然成立。

**核心设计哲学：**

| 原则 | 说明 |
|------|------|
| 数据驱动 | 引擎不含任何硬编码游戏规则（武器伤害、技能效果等），全部从数据库 JSON/DSL 模板加载 |
| 内存优先 | 战斗期间状态仅在内存中推演，不做数据库写入，结束后由 SettlementService 统一落库 |
| 增量广播 | 引擎只向客户端推送**状态差分**（哪个实体的哪个属性变成了什么），不推送完整对象 |
| 纯函数结算 | 规则求值通过 mathjs 沙箱执行，禁止 `eval()` |

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
                                                                  
  ──JOIN_SCENE───►  SocketServer                                  Prisma
                    └─► CampaignManager.getOrCreateEngine() ──► findMany()
                          └─► new CombatEngine()                   │
                                └─► mountEntities() ◄── 注水数据 ◄─┘
  ◄─JOIN_SUCCESS──                                   

  ──CLIENT_INTENT─► SocketServer
                    └─► CampaignManager.getEngine()
                          └─► engine.receiveIntent()
                                └─► PriorityQueue.push()  (前摇事件)
                                      │
                            processQueue() ◄── 时间跃迁至 targetTick
                                │
                                ├─► resolveEvent(STARTUP)
                                │     └─► EffectSystem.applyAction()
                                │           └─► RuleEvaluator.evaluate()
                                │
                                ├─► 广播 STATE_MUTATED ◄── 推到房间所有客户端
                                │
                                ├─► PriorityQueue.push()  (收招事件)
                                │
                                └─► resolveEvent(RECOVERY) ─► 广播 STATE_MUTATED
                                                                  
  战斗结束                                                         
  SettlementService ◄── EVENT_EMIT ──  CombatEngine ──► prisma.upsert()
```

### 2.3 关键设计约束

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
| 类型定义 | `src/index.ts` | ✅ | 151 行，5 大类 18 个接口/类型（详见第四章） |

### 3.3 后端 (`packages/backend/`)

#### 核心层 (`src/core/`)

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| 优先队列 | `engine/PriorityQueue.ts` | ✅ | 二叉最小堆，支持 push/pop/peek，O(log n) |
| Tick 循环 | `engine/TickLoop.ts` | ⬜ | 空桩，规划中 |
| 碰撞池 | `engine/ClashPool.ts` | ⬜ | 空桩，同 Tick 并发结算 |
| 实体基类 | `entities/BaseEntity.ts` | ⬜ | 空桩 |
| Actor 实体 | `entities/Actor.ts` | ⬜ | 空桩 |
| 弹道实体 | `entities/Projectile.ts` | ⬜ | 空桩 |
| 战斗系统 | `systems/CombatSystem.ts` | ⬜ | 空桩 |
| 空间系统 | `systems/SpatialSystem.ts` | ⬜ | 空桩 |
| 规则求值器 | `systems/RuleEvaluator.ts` | ✅ | mathjs 沙箱 + NdM 掷骰宏预处理 |
| 效果系统 | `systems/EffectSystem.ts` | 🚧 | DAMAGE/HEAL 完整，APPLY_BUFF 仅日志，PUSH/INTERRUPT 未实现 |
| 动作事件 | `events/ActionEvents.ts` | ⬜ | 空桩 |
| 事件工厂 | `events/EventFactory.ts` | ⬜ | 空桩 |

#### 战役层 (`src/campaigns/`)

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| 战役管理器 | `CampaignManager.ts` | ✅ | 多场景引擎管理，实体注水，STATE_MUTATED 转发 |
| 战斗引擎 | `engines/CombatEngine.ts` | ✅ | Tick 驱动，三阶段动作，墓碑删除，差分收集与广播 |
| 探索引擎 | `engines/ExploreEngine.ts` | ⬜ | 空桩，即时结算 |
| 场景容器 | `Scene.ts` | ⬜ | 空桩 |
| 结算服务 | `SettlementService.ts` | ⬜ | 空桩 |

#### 网络层 (`src/network/`)

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| Socket 服务器 | `SocketServer.ts` | ✅ | Socket.io 连接管理，JOIN_SCENE/CLIENT_INTENT 路由 |
| 指令路由 | `IntentRouter.ts` | ⬜ | 空桩 |
| 状态广播 | `StateBroadcaster.ts` | ⬜ | 空桩 |
| 可见性过滤 | `VisibilityFilter.ts` | ⬜ | 空桩 |

#### 数据库层 (`src/db/`)

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| Prisma 客户端 | `prisma.ts` | ✅ | 单例导出 |
| 规则字典 | `Dictionary.ts` | ✅ | 启动时从 DB 加载 ActionTemplate 到内存 Map |
| 数据仓库 | `Repository.ts` | ⬜ | 空桩 |
| 种子数据 | `seed.ts` | ✅ | 预置 HEAVY_STRIKE 技能、战士、哥布林 |

#### 工具 (`src/utils/`)

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| ID 生成器 | `IdGenerator.ts` | ✅ | UUID v4 生成 |
| 骰子模拟 | `DiceRoller.ts` | ⬜ | 空桩，目前 NdM 由 RuleEvaluator 内联处理 |
| 日志系统 | `Logger.ts` | ⬜ | 空桩 |
| 向量运算 | `VectorMath.ts` | ⬜ | 空桩 |

#### 其他

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| 启动入口 | `index.ts` | ✅ | bootstrap() 引导程序 |
| Express 配置 | `app.ts` | ⬜ | 空桩，当前 Express 配置内联在 index.ts |
| Prisma Schema | `prisma/schema.prisma` | ✅ | ActionTemplate + CharacterSheet 两个模型 |

### 3.4 前端 (`packages/frontend/`)

| 模块 | 状态 | 说明 |
|------|------|------|
| 全部源码 | ⬜ | 当前仍是 Vite + React 初始模板（计数器 demo），未集成 PixiJS / Zustand / socket.io-client |

### 3.5 统计

| 状态 | 数量 |
|------|------|
| ✅ 已实现 | 11 个模块 |
| 🚧 部分实现 | 1 个模块 |
| ⬜ 空桩/未实现 | 21 个模块 |

---

## 四、类型体系（`@hard-vtt/shared`）

所有类型定义位于 `packages/shared/src/index.ts`（151 行），分为 5 大类。

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
        actionId: string
        phase: 'STARTUP' | 'ACTIVE' | 'RECOVERY'
        resolveTick: number
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
}

interface ActionEffectPayload {
    type: 'DAMAGE' | 'HEAL' | 'APPLY_BUFF' | 'PUSH' | 'INTERRUPT'
    targetSelector: 'PRIMARY' | 'ALL_IN_AOE' | 'SELF'
    conditions?: ExpressionString[]     // 触发条件
    parameters: Record<string, any>     // 效果参数 {"resource": "hp", "amountExpr": "actor.str + 2d6"}
}
```

使用位置：`Dictionary.actions`（内存缓存）、`EffectSystem.applyAction()` 效果遍历、`RuleEvaluator.evaluate()` 表达式求值

### 4.4 引擎核心调度

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
}
```

使用位置：`CombatEngine` implements `IEngineInstance`，`CampaignManager` 管理引擎实例

### 4.5 网络通讯协议

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
        eventType: 'FX_SPAWN' | 'ANIM_PLAY' | 'SOUND_PLAY' | 'UI_FLOATING_TEXT'
        sourceId: EntityId
        targetId?: EntityId
        targetCoords?: Vector3D
        fxTemplateId: string
        durationMs?: number
        text?: string                   // 浮动文字内容
    }>
}
```

使用位置：`SocketServer` 接收 `ClientIntent`，`CombatEngine` 广播 `StateMutationPayload`

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
  tagsJson        String?              // 标签数组 JSON
  resourceCostJson String?             // 资源消耗 JSON
  rangeJson       String?              // 范围配置 JSON
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
| ActionTemplate | `HEAVY_STRIKE` | startupTicks=10, recoveryTicks=5, 两个 DAMAGE 效果（hp: `actor.str + 2d6`，poise: `5`） |
| CharacterSheet | `actor_warrior` | HP=100, poise=50, str=15, 坐标(0,0,0), 质量70, 在 `room_1` |
| CharacterSheet | `target_goblin` | HP=30, poise=10, 坐标(0,2,0), 质量30, 在 `room_1` |

### 5.3 数据流向

```
启动时:
  Dictionary.loadAllFromDb() ──► prisma.actionTemplate.findMany()
                                    └─► 转换 JSON → ActionTemplate 对象存入内存 Map

加入场景时:
  CampaignManager.getOrCreateEngine() ──► prisma.characterSheet.findMany({ currentSceneId })
                                            └─► 转换 JSON → Entity 对象 mountEntities()

战斗结束后 (规划中):
  SettlementService ──► prisma.characterSheet.upsert() (写入 XP/掉落)
```

---

## 六、网络协议

### 6.1 事件表

| 事件名 | 方向 | 触发时机 | 数据结构 |
|--------|------|----------|----------|
| `JOIN_SCENE` | Client → Server | 玩家进入场景 | `{ sceneId, actorId }` |
| `JOIN_SUCCESS` | Server → Client | 场景加入成功 | `{ sceneId, serverTime, message }` |
| `CLIENT_INTENT` | Client → Server | 玩家执行动作 | `{ sceneId, intent: ClientIntent }` |
| `STATE_MUTATED` | Server → Client | 每个 Tick 结算后 | `StateMutationPayload` |
| `VISUAL_FX` | Server → Client | 需要前端播放特效 | `VisualEventPayload` (规划中) |
| `ERROR` | Server → Client | 操作失败 | `{ code, message }` |
| `disconnect` | Client → Server | 连接断开 | 无 |

### 6.2 典型交互流程

```
1. Client ──JOIN_SCENE──► Server
                         └─► CampaignManager 从 DB 注水实体
                         └─► socket.join(sceneId)
   Client ◄──JOIN_SUCCESS─── Server

2. Client ──CLIENT_INTENT──► Server
                             └─► CampaignManager.getEngine(sceneId)
                                   └─► engine.receiveIntent(intent)
                                         └─► processQueue()
                                               ├─► resolveEvent(STARTUP)
                                               │     └─► EffectSystem.applyAction()
                                               │           └─► RuleEvaluator.evaluate()
                                               ├─► broadcastMutations()
                                               └─► resolveEvent(RECOVERY)
   Client ◄──STATE_MUTATED─── Server  (推送到房间内所有客户端)
```

---

## 七、引擎核心机制

### 7.1 Tick 系统（离散事件模拟）

**驱动方式：** 二叉最小堆（`PriorityQueue`），按 `targetTick` 排序。

```
Event Queue (Min-Heap by targetTick)
  ◄── push(event)      O(log n)
  ◄── pop()            O(log n)
  ◄── peek()           O(1)

时间跃迁流程:
  while (queue.size > 0) {
    event = queue.peek()
    if (event.targetTick > currentTick)
      broadcastMutations()     // 先把之前的差分发出去
    queue.pop()
    if (event.status === CANCELLED) continue  // 墓碑删除
    currentTick = event.targetTick            // ⚡ 时间直接跃迁
    resolveEvent(event)
  }
  broadcastMutations()
```

**墓碑删除（Tombstone）：** 当动作被打断时，不遍历堆删除旧事件（O(n)），而是将旧事件的 `status` 设为 `CANCELLED`。旧事件上升到堆顶时被静默丢弃。

### 7.2 三阶段动作系统

```
Client Intent (CAST_ACTION)
    │
    ├─► 阶段 1: STARTUP (前摇)
    │     targetTick = currentTick + startupTicks
    │     可被 INTERRUPT 打断
    │
    ├─► 阶段 2: ACTIVE (判定) [当前与 STARTUP 在同一 Tick 触发]
    │     EffectSystem.applyAction(template, actor, targets)
    │     RuleEvaluator.evaluate(expression, { actor, target })
    │     写入 pendingMutations
    │
    └─► 阶段 3: RECOVERY (收招)
          targetTick = currentTick + recoveryTicks
          期间无法执行新动作
          完成后 currentActionContext = undefined
```

### 7.3 效果系统（`EffectSystem`）

当前实现的效果类型：

| 效果 | 实现状态 | 逻辑 |
|------|----------|------|
| `DAMAGE` | ✅ 完整 | `newVal = max(0, current - amount)`，amount 由 RuleEvaluator 动态计算 |
| `HEAL` | ✅ 完整 | `newVal = min(max, current + amount)` |
| `APPLY_BUFF` | 🚧 仅日志 | 标记日志输出，完整 Buff 挂载逻辑待实现 |
| `PUSH` | ⬜ 未实现 | 位移效果 |
| `INTERRUPT` | ⬜ 未实现 | 打断目标动作 |

目标选择器支持：
- `SELF` — 施法者自身
- `PRIMARY` — 指向 `targetIds` 中的实体

### 7.4 规则求值器（`RuleEvaluator`）

**安全机制：**
- 使用 mathjs 沙箱（禁用 `import`、`createUnit`、`simplify`、`derivative` 等危险函数）
- 严禁 JS `eval()`
- 求值失败返回 `0`，防止引擎崩溃

**作用域构建：**
- `actor.[attr]` → 从 `actor.resources.current` 展开属性（如 `actor.str`、`actor.hp`）
- `target.[attr]` → 从 `target.resources.current` 展开属性

**掷骰宏预处理：**
- 正则 `/^(\d+)d(\d+)$/` 匹配 `NdM` 格式
- 如 `2d6` → `Math.floor(Math.random() * 6) + 1` 执行 N 次求和
- 返回确定数值后注入表达式再求值

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
  │
  ├─► 2. express() + createServer(app)
  │
  ├─► 3. new SocketServer(httpServer)
  │     ├─► new Server(httpServer, { cors })       Socket.io 初始化
  │     ├─► new CampaignManager(io)                战役管理器创建
  │     └─► setupListeners()                       注册 JOIN_SCENE / CLIENT_INTENT / disconnect
  │
  ├─► 4. app.get('/health', ...)                   健康检查端点
  │
  └─► 5. httpServer.listen(PORT)                   开始监听 3000 端口
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
| 时间轴 | PriorityQueue ✅、时间跃迁 ✅、墓碑删除 ✅ | TickLoop（抽象封装）、ClashPool（同 Tick 并发结算） |
| 动作系统 | STARTUP → ACTIVE → RECOVERY 三阶段 ✅ | INTERRUPT 打断机制 |
| 效果系统 | DAMAGE ✅、HEAL ✅ | APPLY_BUFF 完整实现、PUSH、INTERRUPT |
| 规则求值 | mathjs 沙箱 ✅、NdM 掷骰 ✅ | 复杂条件表达式、优势/劣势骰子 |
| 网络层 | JOIN_SCENE ✅、CLIENT_INTENT ✅、STATE_MUTATED ✅ | VISUAL_FX 事件、断线托管、状态全量同步 |
| 数据库 | Prisma Schema ✅、种子数据 ✅、Dictionary 加载 ✅ | Repository 抽象、SettlementService 回写 |
| 前端 | 类型依赖已引入 | **完全未开发**（仍是 Vite 模板） |

### 9.2 推荐下一步开发顺序

| 优先级 | 任务 | 原因 |
|--------|------|------|
| 🔴 1 | **修复 `CampaignManager.ts` 双重 `mountEntities` 调用** | 当前行 43 和 49 各调用一次，导致实体重复挂载，是代码 Bug |
| 🔴 2 | **创建前端最小可用版本** | 目前零前端代码，无法端到端验证。需要：PixiJS 画布渲染、Zustand 状态订阅 WebSocket、简单的角色/网格渲染 |
| 🟡 3 | **实现 `DiceRoller.ts`** | 将 `RuleEvaluator` 中内联的 NdM 逻辑抽取到独立工具模块，支持优势/劣势 |
| 🟡 4 | **实现 `Logger.ts`** | 统一日志输出，替换散落的 `console.log` |
| 🟡 5 | **实现 `ClashPool.ts`（简化版）** | 同 Tick 多个事件按 actionPriority / speed / entityId 稳定排序 |
| 🟢 6 | **填充 `app.ts` 空桩** | 将 Express 配置从 `index.ts` 内联代码迁移到 `app.ts` |
| 🟢 7 | **实现 `ExploreEngine.ts`** | 探索模式即时结算引擎（移动引擎），支持无缝切战 |

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
npx tsx core-test.ts
```

独立测试文件在不依赖完整后端的情况下，直接实例化 `PriorityQueue`、`CombatEngine`（mock）、`RuleEvaluator`，验证：
- 最小堆 push/pop 正确性
- STARTUP/RECOVERY 三阶段动作流程
- `"actor.str + 2d6"` 表达式求值
- STATE_MUTATED 差分广播

## 附录 C：项目文件关键路径速查

| 用途 | 路径 |
|------|------|
| 共享类型定义 | `packages/shared/src/index.ts` |
| 后端入口 | `packages/backend/src/index.ts` |
| 后端架构文档 | `packages/backend/src/README.md` |
| 战斗引擎 | `packages/backend/src/campaigns/engines/CombatEngine.ts` |
| 优先队列 | `packages/backend/src/core/engine/PriorityQueue.ts` |
| 效果系统 | `packages/backend/src/core/systems/EffectSystem.ts` |
| 规则求值器 | `packages/backend/src/core/systems/RuleEvaluator.ts` |
| Socket 服务器 | `packages/backend/src/network/SocketServer.ts` |
| 战役管理器 | `packages/backend/src/campaigns/CampaignManager.ts` |
| 规则字典 | `packages/backend/src/db/Dictionary.ts` |
| 数据库 Schema | `packages/backend/prisma/schema.prisma` |
| 种子数据 | `packages/backend/src/db/seed.ts` |
| 集成测试 | `test/core-test.ts` |
| Docker 编排 | `docker-compose.yml` |
| 环境检查 | `verify-env.js` |
| 环境变量模板 | `.env.example` |
| 审计报告 | `AUDIT.md` |
