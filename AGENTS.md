# AGENTS.md

本文件适用于仓库根目录及所有子目录，供在 ElysianVTT 中工作的自动化开发 Agent 使用。

## 项目概览

ElysianVTT 是一个后端主导的硬核战术 TRPG 虚拟桌面引擎。核心是离散 Tick 时间轴、多阶段动作、资源博弈、Hook 决策窗口，以及通过 Socket.io 进行的增量状态同步。

仓库是 pnpm workspace 管理的全栈 TypeScript monorepo：

- `packages/shared`：前后端共享协议、类型、枚举和数据结构。
- `packages/backend`：Express、Socket.io、战斗/探索引擎、Prisma 持久化。
- `packages/frontend`：React、Vite、PixiJS、Zustand 和 Tailwind CSS。
- `test`：以 `tsx` + Node.js `assert` 直接执行的测试脚本。
- `docs`：架构、认证和实现说明。文档可能是阶段性快照；与代码冲突时，以当前配置、类型和实现为准。

## 开发环境与命令

- 使用 Node.js 22.x、pnpm 10.x；不要改用 npm 或 yarn 管理根工作区。
- 在仓库根目录安装依赖：`pnpm install`。
- 环境/脚手架检查：`pnpm check`。该脚本当前也检查 Docker 是否可用。
- 完整构建：`pnpm build`，固定顺序为 shared → backend → frontend。
- 分包构建：`pnpm build:shared`、`pnpm build:backend`、`pnpm build:frontend`。
- 开发服务：`pnpm dev:backend` 与 `pnpm dev:frontend`，分别监听 3000 和 5173 端口。
- 前端 lint：`pnpm --filter @hard-vtt/frontend lint`。
- Smoke 测试：`pnpm test`。
- 单元、集成、安全测试：`pnpm test:unit`、`pnpm test:integration`、`pnpm test:security`。
- 单文件测试：`pnpm exec tsx test/<name>.test.ts`。

只运行与改动范围相称的最小测试集，提交前再扩大验证范围。长时间运行的开发服务或测试应使用当前环境提供的持久会话；在 WSL2 中预计超过 30 秒的命令使用 tmux，并在完成后清理会话。

## 源码与生成物

- 只编辑 `*.ts`、`*.tsx` 及明确的配置/文档源文件。
- NodeNext 后端源码中的相对导入保留 `.js` 后缀，例如 `./PriorityQueue.js`；这是 TypeScript ESM/NodeNext 的解析约定，不代表应编辑同目录的 JavaScript 文件。
- `dist/`、`build/`、`*.tsbuildinfo`、覆盖率目录均为生成物，不要手工修改或提交。
- `packages/backend/src`、`packages/shared/src` 和 `test` 中与 TypeScript 同名的未跟踪 `.js` 文件不是源码，不要编辑或纳入提交。也不要擅自删除已有未跟踪文件；只有任务明确要求清理时才处理。
- 不要修改 `node_modules`。
- 仓库可能已有用户的未提交改动。开始和结束时检查 `git status --short`，只触碰本任务所需文件，不覆盖或回滚无关改动。

## 架构不变量

### 离散 Tick 引擎

- 时间由最小堆事件队列驱动，直接跃迁到下一事件的 `targetTick`；不要改造成 `setInterval` 或逐 Tick 空轮询。
- 取消事件采用墓碑语义：标记 `CANCELLED`，在出堆时跳过；避免 O(n) 堆内删除。
- 同 Tick 事件进入 Clash Pool，并保持二阶段提交与优先级结算语义。
- 动作生命周期为 DELAY → STARTUP → ACTIVE → RECOVERY，并支持 CHANNELING 多脉冲。ACTIVE 阶段不可逆；打断后进入 Recovery，而不是直接回到 Idle。

### 数据驱动规则

- 引擎保持 rule-agnostic。伤害公式、效果、动作模板和 RulePack 应来自共享契约或数据库定义，不要把具体游戏规则散落硬编码到通用引擎。
- 表达式求值使用 `RuleEvaluator`/mathjs 的受限作用域；严禁 `eval`、`Function` 构造器或执行来自客户端/数据库的任意代码。
- 新增或修改跨端 payload、事件、实体字段时，先更新 `packages/shared/src/index.ts`，再同步后端生产者、前端消费者和测试。

### 状态、持久化与网络

- 服务端是战斗状态的权威来源；客户端发送 intent，不直接决定结算结果。
- 战斗中的高频状态只在内存中演算，每个 Tick 后广播 `StateMutationPayload`；持久化集中在结算或明确的存档边界，避免 Tick 内高频写数据库。
- Socket 输入视为不可信数据。涉及身份、权限或实体控制权的入口必须先认证、授权并校验 payload，再改变引擎状态。
- VisibilityFilter 必须在广播边界保护不可见信息；不要把完整服务端状态先发给客户端再由前端隐藏。
- Hook/决策窗口按 socket 独立追踪。多标签页或多连接场景不得用仅按用户/实体去重的 `Set` 代替连接级映射；断线、超时和重复响应都必须正确清理且不能让计数器变为负数。
- 修改网络协议时兼顾 `SCENE_SYNC`、增量广播、重连恢复与旧的可选字段；新增字段优先保持向后兼容。

## 实现约定

- 保持 TypeScript strict 通过；优先使用明确类型，避免新增 `any`、不必要的断言和 `@ts-ignore`。
- 后端共享的接口放在 `@hard-vtt/shared`，不要在前后端复制一套近似类型。
- 沿用相邻代码的格式、命名和中英文注释风格；不要为无关代码做大规模格式化。
- 函数保持单一职责。新增逻辑优先放入对应 system/service，而不是继续扩大 `CombatEngine`、`App.tsx` 等高耦合文件。
- 前端 Zustand store 使用 Immer draft 更新；store 外不要直接修改共享状态对象。PixiJS 对象生命周期由 canvas/renderer 层管理，React UI 不应直接持有引擎权威状态。
- 公共边界应进行运行时校验并返回稳定、可诊断的错误；不要泄露 token、密钥、完整权限快照或仅服务端可见数据。
- 禁止硬编码凭据。使用环境变量，并只在 `.env.example` 中放无敏感信息的示例值。

## Prisma 与数据库

- Prisma schema 位于 `packages/backend/prisma/schema.prisma`；本地开发数据库为 `packages/backend/prisma/dev.db`。
- 生成客户端：`pnpm db:generate`；推送 schema：`pnpm db:push`；种子数据：`pnpm db:seed`。
- `db:push`、seed 和测试可能修改本地数据库。只有任务需要时才运行，并先确认不会覆盖用户需要保留的数据。
- schema 变化后至少重新生成 Prisma Client，并运行相关 repository、认证、权限或集成测试。
- 数据库返回的 JSON/规则配置必须经现有安全解析和规则加载路径处理，不要直接信任类型断言。

## 测试约定

- 测试文件命名为 `<feature>.test.ts`，放在 `test/`，使用 `tsx` 和 Node.js `assert`；不要仅为一个用例引入新的测试框架。
- 修复缺陷时先添加能复现问题的最小回归测试，再修改实现。
- 测试应可单独执行、相互隔离，并清理 socket、计时器、数据库记录和全局状态。
- 涉及随机骰值时注入或固定随机源，避免概率性失败。
- 网络、Hook、认证或可见性改动至少覆盖成功路径、拒绝路径、重复/超时/断线路径；多客户端逻辑应覆盖两个独立 socket。
- 前端类型或 UI 改动至少运行前端 build 与 lint；共享协议改动至少构建 shared，并验证相关后端和前端消费者。

## 完成标准

完成任务前：

1. 检查 diff，确认只包含任务相关改动且未混入生成物、数据库变化或调试日志。
2. 运行最小相关测试；跨包改动按 shared → backend → frontend 顺序构建。
3. 对认证、权限、表达式执行、可见性和数据库变更执行对应安全/集成测试。
4. 更新因行为或命令变化而失真的 README/docs，但不要把未经验证的测试结果写成当前事实。
5. 在交付说明中列出已运行的验证和任何未运行项及原因。
