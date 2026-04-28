# 🎲 ElysianVTT 

**ElysianVTT** 是一个基于“连续时间轴（Tick System）”与“多资源池博弈（韧性/专注）”的硬核战术动作类 TRPG（跑团）虚拟桌面引擎。

不同于传统的回合制 VTT，ElysianVTT 采用了后端主导的离散事件模拟，Tick和动作堆循环驱动战斗，结合 WebGL (PixiJS) 实现前端的平滑渲染与状态同步。

---

## 🛠 技术栈 (Tech Stack)

本项目采用全栈 **TypeScript** + **pnpm Monorepo** 架构，确保前后端在强类型（Action/State/Tick Payload）上的绝对对齐。

### 基础设施 & 环境
- **Runtime**: Node.js (v22.x)
- **Package Manager**: pnpm (v10.x) + pnpm-workspace
- **DevOps**: Docker + Docker Compose (全容器化热更新开发环境)

### 后端 (@hard-vtt/backend)
- **核心**: Node.js + Express
- **实时通信**: Socket.io (WebSocket 广播与 Tick 推送)
- **数据库/ORM**: Prisma + SQLite (初期开发)
- **架构设计**: 内存级优先队列推演 + 离散事件循环 (Event Loop)

### 前端 (@hard-vtt/frontend)
- **框架**: React 18 + TypeScript + Vite
- **渲染引擎**: PixiJS (WebGL 硬核网格与特效渲染)
- **状态管理**: Zustand (订阅 WebSocket 推送)
- **UI 样式**: Tailwind CSS

---

## 📂 架构与目录说明 (Monorepo)

```text
ElysianVTT/
├── packages/
│   ├── shared/      # 灵魂层：前后端共享的类型、接口、枚举 (ActionPayload, CharacterState)
│   ├── backend/     # 引擎层：Tick 循环推演、Socket 广播、Prisma 数据持久化
│   └── frontend/    # 表现层：React UI + PixiJS 画布 + Zustand 状态树
├── docker-compose.yml  # 容器编排 (联调环境)
├── pnpm-workspace.yaml # Monorepo 工作区定义
└── verify-env.js       # 环境与脚手架自动化体检脚本