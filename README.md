# 🎲 ElysianVTT

**ElysianVTT** 是一个基于「连续时间轴（Tick System）」与「多资源池博弈（韧性/专注）」的硬核战术动作类 TRPG（跑团）虚拟桌面引擎。

不同于传统的回合制 VTT，ElysianVTT 采用**后端主导的离散事件模拟**，Tick 与动作堆循环驱动战斗，结合前端 WebGL (PixiJS) 实现平滑渲染与状态同步。

---

## 🛠 技术栈

全栈 **TypeScript** + **pnpm Monorepo** 架构，确保前后端在强类型（Action/State/Tick Payload）上的绝对对齐。

### 基础设施

| 组件 | 技术 |
|------|------|
| 运行时 | Node.js v22.x |
| 包管理器 | pnpm v10.x (workspace) |
| DevOps | Docker + Docker Compose |

### 后端 (`@hard-vtt/backend`)

| 技术 | 用途 |
|------|------|
| Node.js + Express v5 | HTTP 服务框架 |
| Socket.io v4 | 实时 WebSocket 通信 |
| Prisma v6 + SQLite | ORM / 数据库 |
| mathjs v15 | 安全数学表达式求值（伤害公式、掷骰） |
| ts-node + nodemon | 开发工具链 |

### 前端 (`@hard-vtt/frontend`)

| 技术 | 用途 |
|------|------|
| React v19 + TypeScript | UI 框架 |
| Vite v8 | 构建工具与开发服务器 |
| PixiJS v8 | WebGL 渲染引擎 |
| Zustand v5 | 状态管理 |
| Tailwind CSS v4 | 原子化 CSS |

### 共享层 (`@hard-vtt/shared`)

前后端共享的 TypeScript 类型、接口与枚举定义。

---

## 📂 项目结构

```text
ElysianVTT/
├── packages/
│   ├── shared/              # 灵魂层：前后端共享的类型定义
│   │   └── src/index.ts     # ActionPayload, CharacterState 等
│   ├── backend/             # 引擎层：Tick 循环推演、Socket 广播、Prisma 持久化
│   │   ├── prisma/          # 数据库 Schema (SQLite) 与迁移
│   │   ├── src/
│   │   │   ├── core/        # 游戏引擎核心
│   │   │   │   ├── engine/  # PriorityQueue（最小堆）、TickLoop、ClashPool
│   │   │   │   ├── entities/# 实体类（Actor、Projectile）
│   │   │   │   ├── systems/ # CombatSystem、EffectSystem、RuleEvaluator、SpatialSystem
│   │   │   │   └── events/  # ActionEvents、EventFactory
│   │   │   ├── campaigns/   # CampaignManager、CombatEngine、ExploreEngine、SettlementService
│   │   │   ├── network/     # SocketServer、IntentRouter、StateBroadcaster、VisibilityFilter
│   │   │   ├── db/          # Prisma 客户端、Dictionary、Repository、种子数据
│   │   │   └── utils/       # IdGenerator、DiceRoller、Logger、VectorMath
│   │   └── src/README.md    # 后端架构详细文档
│   └── frontend/            # 表现层：React UI + PixiJS 画布 + Zustand 状态树
│       └── src/
│           ├── main.tsx     # React 入口
│           └── App.tsx      # 根组件
├── test/                    # 独立集成测试
│   └── core-test.ts         # 战斗引擎集成测试
├── docker-compose.yml       # 容器编排
├── pnpm-workspace.yaml      # Monorepo 工作区定义
├── verify-env.js            # 环境健康检查脚本
└── LICENSE.txt              # MIT 许可证
```

---

## 🚀 快速开始

### 环境要求

运行环境检查：
```bash
node verify-env.js
```
需要：Node.js v22.x、pnpm v10.x、Docker（可选，用于容器化开发）。

### Docker 一键启动

```bash
docker-compose up
```
- 后端：`http://localhost:3000`
- 前端：`http://localhost:5173`

两个服务均挂载项目目录，支持热更新。

### 手动启动

```bash
# 1. 安装依赖
pnpm install

# 2. 构建共享包
pnpm --filter @hard-vtt/shared build

# 3. 初始化数据库
cd packages/backend
pnpm db:push                        # 推送 Schema 到 SQLite
npx ts-node src/db/seed.ts          # 灌入种子数据
cd ../..

# 4. 启动后端（监听 + 自动重启）
pnpm --filter @hard-vtt/backend dev

# 5. 启动前端（另开终端）
pnpm --filter @hard-vtt/frontend dev
```

### 运行测试

```bash
cd test
npx tsx core-test.ts
```

### 生产构建

```bash
pnpm --filter @hard-vtt/shared build
pnpm --filter @hard-vtt/backend build
pnpm --filter @hard-vtt/frontend build     # tsc -b && vite build
```

---

## 🎮 核心架构

### Tick 系统（离散事件模拟）

战斗引擎由**二叉最小堆优先队列**驱动，而非 `setInterval` 帧循环。引擎直接跳到下一个事件的 `targetTick`，跳过空闲 Tick。

- **时间跳跃**：从事件到事件，不做无意义的轮询
- **墓碑删除**：被取消的事件标记为 `CANCELLED`，在堆顶被弹出时静默丢弃——避免 O(n) 的堆内删除
- **Clash Pool**：同一 Tick 上的并发事件同时结算（规划中）

### 三阶段动作系统

每个动作拥有三个有序阶段：

| 阶段 | 说明 |
|------|------|
| **STARTUP（前摇）** | 动作起手阶段，可被打断 |
| **ACTIVE（判定）** | 效果生效瞬间（伤害/治疗/增益） |
| **RECOVERY（收招）** | 动作后摇，无法行动 |

### 数据驱动规则

引擎是一个**纯粹物理与时间演算容器**——不含任何硬编码游戏规则。武器伤害、技能效果、动作模板全部从数据库的 JSON/DSL 中加载。

- `RuleEvaluator` 使用 **mathjs** 在沙箱作用域中安全执行表达式，如 `"actor.str + 2d6"`
- `EffectSystem` 动态处理效果：`DAMAGE`、`HEAL`、`APPLY_BUFF`、`PUSH`、`INTERRUPT`

### 多模态场景管理

一个 `Scene` 可同时承载多个引擎实例——`CombatEngine`（Tick 驱动，严格一致性）与 `ExploreEngine`（即时结算，无时间轴）——支持实体动态挂载，实现「无缝切战」。

### 内存演算与增量广播

所有战斗状态变更**仅在内存中**进行（战斗期间不写数据库）。每个 Tick 的事件结算完成后，计算**状态差异**（`StateMutationPayload`）并通过 WebSocket 广播给房间内的所有客户端。数据库仅在战斗结束后由 `SettlementService` 写入（经验/战利品）。

### 网络协议

| 事件 | 方向 | 说明 |
|------|------|------|
| `JOIN_SCENE` | 客户端 → 服务端 | 加入场景房间，引擎从数据库水合 |
| `CLIENT_INTENT` | 客户端 → 服务端 | 发送动作意图（施法/移动/交互） |
| `STATE_MUTATED` | 服务端 → 客户端 | 实体状态增量推送到房间 |
| `VISUAL_FX` | 服务端 → 客户端 | 视觉与动画事件 |

---

## 🗺 开发路线图

| 阶段 | 状态 | 重点 |
|------|------|------|
| **阶段一 (MVP)** | 🚧 进行中 | 可玩战斗核心：Tick 系统、基础动作、伤害/治疗/Buff、状态同步 |
| 阶段二 | 规划中 | 多引擎分离、ExploreEngine、简化版 Clash Pool |
| 阶段三 | 规划中 | 空间系统、弹道、射线检测、边界事件 |
| 阶段四 | 规划中 | 完整效果系统（PUSH、INTERRUPT）、完整 Clash Pool、增强表达式 |
| 阶段五 | 可选 | 脚本语言、DSL、MOD 支持 |

---

## 📄 许可证

MIT — Copyright 2026 hahaj
