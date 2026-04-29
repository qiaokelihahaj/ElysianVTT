# @hard-vtt/frontend

**ElysianVTT** 的前端表现层。这是一个基于 WebGL 的高性能渲染与 UI 交互模块，负责将后端连续时间轴（Tick System）推演出的抽象状态具象化呈现给玩家或 GM。

## 🛠 技术栈

*   **UI 框架**: React 19 + TypeScript + Vite 8
*   **图形渲染**: PixiJS 8 (原生命令式挂载)
*   **状态管理**: Zustand 5 + Immer
*   **样式与组件**: Tailwind CSS 4 + shadcn/ui (Radix UI)
*   **网络通信**: Socket.io Client

## 🏗 核心架构设计

为了满足战术角色扮演游戏 (TRPG) 所需的频繁、深层状态变更与大量实体同屏的高性能渲染，我们在前端采用了**状态响应与命令式渲染相隔离**的设计模式。

### 1. 状态管理层 (State + Immer)
游戏核心状态（如实体位置、血量、存活状态等）统一存储在 Zustand 的 `gameStore` 中。
引擎后端的 `STATE_MUTATED` 事件推送的是**扁平化状态差分**（例如 `{"resources.current.hp": 10}`）。
在这里，我们利用 **Immer** 在 Zustand 层通过深层路径解析 (`setNestedProperty`) 接收并合并差分包，实现了“精准且低开销”的数据补丁（Patch）更新。

### 2. 画布渲染层 (PixiJS + Command Pattern)
针对战棋游戏的密集性能要求，我们故意放弃了使用 `@pixi/react` 这类声明式绑定，而是采取通过 `useRef` 获取 DOM Canvas，在外部使用原生的 `RendererManager.ts` 进行**命令式**（Imperative）托管。
`RendererManager` 内部监听 Zustand 的部分状态；一旦发生实体坐标 (`transform.coords`) 变换等影响画面表现的变动，通过纯 TypeScript 直接操控 Sprite 属性。这样最大程度隔绝了因地图更新而导致的 React 大规模重渲染。

### 3. 外围界面层 (React UI)
血条、动作条等 HUD 层通过 React 与 Zustand 做绑定，覆盖在绝对定位的 `div` 上。采用了 `shadcn/ui` 元件加速开发。

## 📂 目录结构

```text
src/
├── assets/          # 静态资源 (图标、图片等)
├── canvas/          # WebGL 渲染核心
│   ├── GameCanvas.tsx     # 承接 PixiAPP 的 React 桥接组件
│   └── RendererManager.ts # PixiJS 原生命令式单例管理器
├── network/         # 通信层
│   └── socketClient.ts    # Socket.io 客户端封装，负责处理共享类型的交互
├── store/           # 状态管理
│   └── gameStore.ts       # 基于 Zustand + Immer 的实体与场景树
├── ui/              # React 玩家界面
│   └── HUD.tsx            # 浮层血条、动作指令栏
├── utils/           # 辅助工具
│   └── objectUtils.ts     # 对象路径深度解析等工具
├── App.tsx          # 前端根组件（容器编排）
├── index.css        # Tailwind 核心与全局样式
└── main.tsx         # 挂载入口
```

## 🚀 启动与开发

*由于本项目依赖 Monorepo 下的 `@hard-vtt/shared`，请确保在根目录或使用 `--filter` 确保依赖已成功构建。*

```bash
# 安装依赖 (自项目根目录)
pnpm install

# 单独启动前端开发服务器 (监听在 http://localhost:5173)
pnpm --filter @hard-vtt/frontend dev

# 前端构建
pnpm --filter @hard-vtt/frontend build
```

## 🗺 当前进度与下一步计划

- [x] 搭建基础 React + Vite + Tailwind 配置
- [x] 注入 `@hard-vtt/shared` 类型依赖
- [x] 配置基于 Zustand 与 Immer 的深层补丁状态树
- [x] 基于原生 PixiJS `Application` 的命令式渲染器隔离
- [x] Mock 数据映射与基础 HUD 测试
- [x] （正在进行）在渲染层实现 `Tick` 状态间的**线性插值平滑移动（Interpolation）**
- [x] （正在进行）`VISUAL_FX` 全局事件拦截器，渲染跳字（伤害/治疗文本）、技能光效
- [ ] （下一步）构建基于指令意图（`IntentDispatcher`）的前端交互指令发送模块