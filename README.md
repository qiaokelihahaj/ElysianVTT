# 🎲 ElysianVTT

空间战术整合场景 **「断桥堡垒」**：运行 `pnpm demo:tactics`，默认打开 `http://127.0.0.1:3001`。支持一名 GM 独立演练或 1 GM + 3 玩家，串联冲刺、触及、背刺、弹道、掩体、护卫、封锁、范围攻击与部位破坏。使用独立 `.demo-tactics` 存档；[游玩说明](docs/SPATIAL_TACTICS_DEMO.md)列出操作路线与验证范围。

局域网 **1 GM + 3 玩家战术遭遇 Demo**：运行 `pnpm demo`，按[启动与游玩说明](docs/DEMO_QUICKSTART.md)入场。Demo 使用独立存档与正式主持/玩家入口；[实施与验收记录](docs/DEMO_IMPLEMENTATION.md)列出本轮通过项及剩余限制。

**ElysianVTT** 是一个基于「连续时间轴（Tick System）」与「多资源池博弈（韧性/专注）」的硬核战术动作类 TRPG（跑团）虚拟桌面引擎。

ElysianVTT 采用**后端主导的离散事件模拟**，由 Tick 与事件堆驱动战斗。当前可玩入口是 React + Zustand + SVG 六边形战场的 DemoApp；仓库同时保留 PixiJS 通用渲染模块。

局域网 Demo 使用独立的 `node:sqlite` 存档（默认 `.demo/demo.db`），在开局、明确检查点和结算时保存。通用开发服务另用 Prisma + SQLite，两者目前不共用认证、网络协议或存档。

局域网链路的会话、遭遇编排、网络服务和 SQLite 存储已从 Demo 提取到正式模块；`demo/` 提供示例内容、启动配置及旧导入兼容层。模块职责、组合方式和保留边界见[局域网模块架构](docs/LAN_MODULES.md)。

遭遇编排内的动作计划、决策窗口和 GM 修正分别由独立服务负责；正式遭遇与引擎使用实例规则目录，允许不同遭遇复用相同动作 ID 而互不覆盖。

遭遇前端采用[模块化战术工作台](docs/WORKSPACE_UI.md)：地图铺满底层桌面，时间轴、行动/反应、日志与 GM 工具支持浮动、拖动、缩放、折叠和布局记忆，窄屏保持浮窗并限制在可见范围。

第四阶段提供可重复的网络体积、状态应用次数和 Tick 推进耗时测量，详见[性能测量与同步决策](docs/LAN_PERFORMANCE.md)。当前保留过滤后的完整快照协议；测量结果用于评估扩规模成本，不代表真实路由器或弱网性能认证。

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
| SVG / PixiJS v8 | 当前 Demo 六边形战场 / 保留的通用 WebGL 渲染模块 |
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
│   │   │   ├── network/     # EncounterServer；保留旧 SocketServer 等通用开发模块
│   │   │   ├── sessions/    # LanSessionService：会话和逐连接生命周期
│   │   │   ├── encounters/  # EncounterCoordinator：遭遇编排、决策与日志桥
│   │   │   ├── rules/       # ActionCatalog：每个遭遇/引擎的独立动作目录
│   │   │   ├── persistence/ # EncounterRepository 接口与 SQLite 适配器
│   │   │   ├── demo/        # 示例规则、启动配置和旧导入兼容层
│   │   │   ├── db/          # Prisma 客户端、Dictionary、Repository、种子数据
│   │   │   └── utils/       # IdGenerator、dice/ (掷骰系统)、Logger、VectorMath、SafeJsonParser
│   │   └── src/README.md    # 后端架构详细文档
│   └── frontend/            # 表现层：React UI + PixiJS 画布 + Zustand 状态树
│       └── src/
│           ├── main.tsx     # React 入口
│           └── App.tsx      # 根组件
├── test/                    # 独立集成测试（含测试套件 README）
├── docs/                    # 📚 项目文档
│   ├── README.md            # 文档总索引
│   ├── PROJECT_OVERVIEW.md  # 项目概要（架构/模块/类型/数据库）
│   ├── permissions/         # 权限系统设计文稿（架构/矩阵/接口/数据模型）
│   ├── review/              # 代码审查报告与问题清单
│   └── reports/             # 实现报告（权限修复/评审）
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
pnpm check
```
需要：Node.js v22.x、pnpm v10.x、Docker（可选，用于容器化开发）。

### Docker 通用开发环境（非局域网可玩入口）

```bash
docker-compose up
```
- 本机前端：`http://127.0.0.1:5173`；后端 3000 端口不发布到宿主机。
- 前后端共享容器网络命名空间，Vite 通过回环地址代理 API 与 Socket。
- 当前 DemoApp 的可玩服务请使用 `pnpm demo`；通用开发服务不提供 Demo 协议。

通用后端固定监听 `127.0.0.1`，`/auth/login` 默认返回 `403 DEV_LOGIN_DISABLED`。仅本机通用开发夹具可显式设置 `ELYSIAN_ENABLE_DEV_LOGIN=1`，生产模式始终禁止该登录。该入口仍有未完成的认证与广播可见性边界，不能作为正式多人服务开放。

两个服务均挂载项目目录，支持热更新。

### 手动启动

```bash
# 1. 安装依赖并检查环境
pnpm install
pnpm check

# 2. 生成 Prisma Client、推送 Schema 并灌入种子数据
pnpm db:generate
pnpm db:push
pnpm db:seed

# 3. 启动后端（监听 + 自动重启）
pnpm dev:backend

# 4. 启动前端（另开终端）
pnpm dev:frontend
```

### 运行测试

```bash
pnpm test                 # smoke 测试
pnpm test:unit            # 战斗核心 unit 测试
pnpm test:integration     # 引擎集成测试
pnpm test:security        # 认证、权限与安全回归
pnpm test:audit           # 日常跑团缺陷审计回归
pnpm test:audit:browser   # 前端异步与组件生命周期回归
```

首期局域网 Demo 的隔离服务回归与真实浏览器验收：

```bash
pnpm test:lan             # 显式 Demo/认证/权限清单，使用临时 SQLite
pnpm test:lan:browser     # 构建产物上的四 context Chromium UI 验收
pnpm test:lan:perf        # 隔离运行网络、Tick 与客户端状态应用性能测量
pnpm verify:lan           # build → frontend lint → service → browser
```

浏览器验收、证据脱敏、退出码和已知认证边界见 [`docs/LAN_BROWSER_ACCEPTANCE.md`](docs/LAN_BROWSER_ACCEPTANCE.md)。

### 生产构建

```bash
pnpm build                # shared → backend → frontend
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

## 📚 文档

完整文档见 [`docs/`](./docs/README.md)，包括：
- 项目概要、权限系统设计、认证流程
- 代码审查报告与问题清单
- 实现报告

---

## 📄 许可证

MIT — Copyright 2026 hahaj
