# ElysianVTT

## 概述

ElysianVTT 是一个基于「连续时间轴（Tick System）」与「多资源池博弈（韧性/专注）」的硬核战术动作类 TRPG 虚拟桌面引擎。不同于传统回合制 VTT，采用**后端主导的离散事件模拟**，Tick 与动作堆循环驱动战斗，结合前端 WebGL (PixiJS) 实现平滑渲染与状态同步。

## 技术栈

- **全栈 TypeScript** + **pnpm Monorepo**（workspace）
- **运行时**: Node.js v22+
- **包管理器**: pnpm v10+

| 层 | 包 | 核心技术 |
|-----|---------|--------|
| 后端 | `@hard-vtt/backend` | Express v5, Socket.io v4, Prisma v6 (SQLite), mathjs v15 |
| 前端 | `@hard-vtt/frontend` | React v19, Vite v8, PixiJS v8, Zustand v5, Tailwind v4 |
| 共享 | `@hard-vtt/shared` | TypeScript 类型/接口/枚举定义 |

## 构建 & 测试

```bash
# 安装依赖
pnpm install

# 构建共享包（前后端依赖）
pnpm --filter @hard-vtt/shared build

# 后端
pnpm --filter @hard-vtt/backend build          # tsc
pnpm --filter @hard-vtt/backend dev            # tsc --watch & node --watch

# 前端
pnpm --filter @hard-vtt/frontend build          # tsc -b && vite build
pnpm --filter @hard-vtt/frontend dev            # vite dev server
pnpm --filter @hard-vtt/frontend lint           # eslint

# 数据库
cd packages/backend && pnpm db:push            # Prisma Schema → SQLite
npx ts-node src/db/seed.ts                     # 种子数据

# 测试（test/ 目录）
cd test && npx tsx *.test.ts                    # 运行全部
cd test && npx tsx core.test.ts                 # 单个
cd test && pnpm test:unit                       # 单元测试
cd test && pnpm test:integration                # 集成测试
cd test && pnpm test:security                   # 安全测试

# Docker
docker-compose up                               # 一键启动前后端
```

## 目录结构

```
packages/
  shared/       # 前后端共享类型定义（ActionPayload, CharacterState 等）
  backend/      # 引擎层：Tick 循环、Socket 广播、Prisma 持久化
    src/
      core/     # 游戏引擎核心（PriorityQueue, TickLoop, ClashPool, entities, systems, events）
      campaigns/#  CampaignManager, CombatEngine, ExploreEngine, SettlementService
      network/  # SocketServer, IntentRouter, StateBroadcaster, VisibilityFilter
      db/       # Prisma 客户端, Dictionary, Repository, 种子数据
      auth/     # 认证服务
      permissions/ # 权限系统
      utils/    # IdGenerator, dice, Logger, VectorMath, SafeJsonParser
  frontend/     # 表现层：React UI + PixiJS 画布 + Zustand 状态树
test/           # 独立集成测试（18 个测试文件，使用 tsx + assert 运行）
docs/           # 项目文档（权限系统、审查报告、认证流程等）
```

## 核心架构约定

### Tick 系统（离散事件模拟）
- 二叉最小堆优先队列驱动，非 setInterval 帧循环
- 引擎直接跳到下一个事件的 targetTick，跳过空闲 Tick
- 墓碑删除：被取消的事件标记 CANCELLED，堆顶弹出时静默丢弃
- Clash Pool：同一 Tick 并发事件同时结算

### 三阶段动作系统
每个动作有三个有序阶段：STARTUP（前摇）→ ACTIVE（判定）→ RECOVERY（收招）

### 数据驱动规则
- 引擎是纯粹的物理与时间演算容器，不含硬编码游戏规则
- RuleEvaluator 使用 mathjs 在沙箱作用域中安全执行表达式
- EffectSystem 动态处理效果：DAMAGE, HEAL, APPLY_BUFF, PUSH, INTERRUPT

### 内存演算与增量广播
- 战斗期间所有状态变更仅在内存中进行，不写数据库
- 每个 Tick 结算后计算 StateMutationPayload，通过 WebSocket 广播
- 数据库仅在战斗结束后由 SettlementService 写入

## 编码规范

- TypeScript strict 模式，所有类型在 shared 包中集中定义
- 不可变数据模式（创建新对象，不修改原对象）
- 文件上限 800 行，函数上限 50 行
- 测试：使用 Node.js 内置 assert，测试文件命名 `<domain>-<purpose>.test.ts`
- 输入验证使用 zod schema（系统边界处）
- 禁止硬编码密钥，全部使用环境变量
- 优先小文件、少文件耦合
