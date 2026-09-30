# ElysianVTT

## 概述

基于「连续时间轴（Tick System）」与「多资源池博弈」的硬核战术动作 TRPG 虚拟桌面引擎。后端主导的离散事件模拟 — Tick 与动作堆循环驱动战斗，前端 PixiJS (WebGL) 平滑渲染。


## 技术栈

- **全栈 TypeScript** + **pnpm Monorepo**（Node.js v22+, pnpm v10+）

| 层 | 包 | 核心技术 |
|-----|---------|--------|
| 后端 | `@hard-vtt/backend` | Express v5, Socket.io v4, Prisma v6 (SQLite), mathjs v15 |
| 前端 | `@hard-vtt/frontend` | React v19, Vite v8, PixiJS v8, Zustand v5, Tailwind v4 |
| 共享 | `@hard-vtt/shared` | TypeScript 类型/接口定义（所有类型集中于此） |

## 常用命令

```bash
pnpm install
pnpm --filter @hard-vtt/shared build

# 后端
pnpm --filter @hard-vtt/backend dev            # tsc --watch & node --watch

# 前端
pnpm --filter @hard-vtt/frontend dev            # vite dev server

# 数据库
cd packages/backend && pnpm db:push            # Prisma Schema → SQLite

# 测试
cd test && npx tsx *.test.ts                    # 运行全部
cd test && npx tsx <name>.test.ts               # 单个
cd test && pnpm test:unit                       # 单元测试
cd test && pnpm test:integration                # 集成测试
```

## 命令执行规范  tmux MANDATORY

> **WSL2 环境下，所有耗时 >30s 的命令必须通过 tmux 执行**，防止终端断连导致进程丢失。

| 什么时候必须 tmux | 什么时候可以跳过 |
|---|---|
| `pnpm install`, `pnpm dev`, 测试套件 | `git status`, `which`, `cat`, `ls` |
| DB 迁移, `pnpm db:push` | 单文件读取/写入 |
| 任何 spawn 子 Agent（Claude Code / Codex 等） | 预计 <30s 的简单命令 |

**命名规范**：`cc-<task>`，如 `cc-refactor-auth`、`cc-build-frontend`、`cc-test-suite`

**基础模式**：
```bash
# 一次性任务
tmux new-session -d -s cc-build -x 140 -y 40 "cd /home/hahaj/ElysianVTT && pnpm install && echo 'DONE'"
while tmux has-session -t cc-build 2>/dev/null; do sleep 10; done
tmux capture-pane -t cc-build -p -S -50

# 交互式子 Agent
tmux new-session -d -s cc-task -x 140 -y 40
tmux send-keys -t cc-task "cd /home/hahaj/ElysianVTT && claude" Enter
sleep 5 && tmux send-keys -t cc-task Enter        # 信任弹窗
tmux send-keys -t cc-task "你的任务" Enter
# 监控: tmux capture-pane -t cc-task -p -S -50
# 清理: tmux send-keys -t cc-task "/exit" Enter; sleep 3; tmux kill-session -t cc-task
```

**任务完成后必须清理**：`tmux-agent kill <name>` 或手动 `tmux kill-session`，最后 `tmux-agent list` 确认无残留。

## 目录结构

```
packages/
  shared/src/       # 共享类型：Entity, ActionTemplate, ClientIntent, HookPreset 等
  backend/src/
    core/           # 引擎核心：PriorityQueue, TickLoop, ClashPool, entities, systems, events
    campaigns/      # CombatEngine, ExploreEngine, HookRegistry, SettlementService
    network/        # SocketServer, IntentRouter, StateBroadcaster, VisibilityFilter
    db/             # Prisma, Dictionary, RulePackLoader, Repository, seed
    auth/           # AuthenticationService
    permissions/    # PermissionService
    utils/          # dice, Logger, VectorMath, IdGenerator
  frontend/src/
    canvas/         # GameCanvas, RendererManager (PixiJS WebGL)
    network/        # IntentDispatcher, socketClient
    store/          # gameStore (Zustand)
    ui/             # HUD, TickMeter, ActionBar, ReactionCountdown, TacticalDecisionPanel 等
    utils/          # DiceRoller, objectUtils
test/               # 独立集成测试（25+ 文件，tsx + assert）
docs/               # 认证流程、文档索引
```

## 核心架构约定（不可妥协）

### Tick 离散事件模拟
- 二叉最小堆驱动，**非 setInterval**；引擎跳跃到堆顶事件的 targetTick
- 墓碑删除：取消的事件标记 CANCELLED，堆顶弹出时静默丢弃
- Clash Pool：同 Tick 并发事件同时结算（二阶段提交 + 优先级排序）

### 五阶段动作系统
- DELAY → STARTUP → ACTIVE → RECOVERY（+ CHANNELING 多脉冲模式）
- DELAY 可低成本取消，ACTIVE 绝对不可逆，打断后进 Recovery 而非直接 Idle

### 数据驱动规则（Rule-Agnostic）
- 引擎不含硬编码游戏规则 — 所有伤害公式/状态机/效果从 DB 加载
- RuleEvaluator 使用 mathjs 沙箱执行表达式，**严禁 eval()**
- EffectSystem 动态处理：DAMAGE, HEAL, APPLY_BUFF, PUSH, INTERRUPT
- RulePack 绑定到 Campaign，RulePackLoader 运行时加载

### 内存演算 + 增量广播
- 战斗期间状态变更只在内存中进行，**严禁高频写 DB**
- 每 Tick 结算后增量广播 StateMutationPayload（WebSocket）
- 战斗结束后 SettlementService 统一落盘

### Hook 断点注入
- 触发后精确中断引擎，推送 DECISION_POLL，前端 ReactionCountdown 倒计时
- 多客户端按 socket 独立追踪决策状态（Map<key, socketId>，非 Set）

## 编码规范

- TypeScript strict，所有类型在 `shared` 包集中定义
- **不可变数据**：创建新对象，不修改原对象
- 文件上限 800 行，函数上限 50 行
- 输入验证用 zod schema（系统边界处）
- 禁止硬编码密钥，全部走环境变量

## 调试

### 流程

1. **复现**：在 `test/` 写最小失败用例（`tsx + assert`，无测试框架）
2. **隔离**：缩小到单个引擎/系统，排除网络层干扰
3. **修复**：改代码，验证红绿循环（先 revert 确认测试失败，再恢复确认修复）
4. **清理**：删临时 debug 日志，把边界条件固化为测试用例

### 多客户端

- WebSocket 广播功能**至少两个浏览器标签页**测试
- socket 身份状态用 `Map<key, socketId>`，禁止 `Set<key>`（跨标签页相互污染）
- 决策倒计时按 socket 独立追踪，确认断线时 cleanup
