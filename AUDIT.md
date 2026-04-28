# 审计报告：冗余与环境问题

> 生成日期：2026-04-28 | 更新日期：2026-04-28（修复后）

---

## ✅ 已修复

| 问题 | 修复内容 |
|------|----------|
| 锁文件冲突 | 删除根目录 `package-lock.json`（pnpm 项目不应有 npm 锁文件） |
| 缺失 `.env.example` | 创建 `/.env.example`，包含 DATABASE_URL 等环境变量模板 |
| TypeScript 版本不一致 | frontend `typescript` 由 `~6.0.2` 统一为 `^6.0.3` |
| @types/node 版本不一致 | frontend `@types/node` 由 `^24.12.2` 升级为 `^25.6.0` |
| packageManager 字段缺失 | root、frontend 新增 `"packageManager": "pnpm@10.33.0"` |
| root 无意义依赖 | root `package.json` 删除 `socket.io-client` 依赖 |

---

## 一、锁文件（残留）

| 文件 | 问题 | 建议 |
|------|------|------|
| `test/package-lock.json` | `test/` 目录独立使用 npm，未纳入 pnpm workspace | 统一为 pnpm 或从 workspace 移除 |

---

## 二、空配置文件

| 文件 | 问题 | 建议 |
|------|------|------|
| `.gitignore` | 0 字节 | 填充 node_modules/、dist/、.env、*.db 等忽略规则 |
| `.prettierrc` | 0 字节 | 填充格式化规则或删除 |

---

## 三、空桩文件（backend，共 21 个）

这些文件只有文件名，不含任何代码。当前没有任何活跃代码导入它们。

| 文件路径 | 建议 |
|----------|------|
| `packages/backend/src/app.ts` | 实现或删除 |
| `packages/backend/prisma/prisma.ts` | 实现或删除 |
| `packages/backend/src/core/engine/TickLoop.ts` | 实现或删除 |
| `packages/backend/src/core/engine/ClashPool.ts` | 实现或删除 |
| `packages/backend/src/core/entities/BaseEntity.ts` | 实现或删除 |
| `packages/backend/src/core/entities/Actor.ts` | 实现或删除 |
| `packages/backend/src/core/entities/Projectile.ts` | 实现或删除 |
| `packages/backend/src/core/systems/CombatSystem.ts` | 实现或删除 |
| `packages/backend/src/core/systems/SpatialSystem.ts` | 实现或删除 |
| `packages/backend/src/core/events/ActionEvents.ts` | 实现或删除 |
| `packages/backend/src/core/events/EventFactory.ts` | 实现或删除 |
| `packages/backend/src/campaigns/Scene.ts` | 实现或删除 |
| `packages/backend/src/campaigns/SettlementService.ts` | 实现或删除 |
| `packages/backend/src/campaigns/engines/ExploreEngine.ts` | 实现或删除 |
| `packages/backend/src/network/IntentRouter.ts` | 实现或删除 |
| `packages/backend/src/network/StateBroadcaster.ts` | 实现或删除 |
| `packages/backend/src/network/VisibilityFilter.ts` | 实现或删除 |
| `packages/backend/src/db/Repository.ts` | 实现或删除 |
| `packages/backend/src/utils/DiceRoller.ts` | 实现或删除 |
| `packages/backend/src/utils/Logger.ts` | 实现或删除 |
| `packages/backend/src/utils/VectorMath.ts` | 实现或删除 |

---

## 四、声明但未使用的依赖

### backend (`packages/backend/package.json`)

| 包名 | 类型 | 原因 | 建议 |
|------|------|------|------|
| `cors` | dependencies | Socket.io 使用内置 CORS，未导入 `cors` 包 | 删除 |
| `@types/cors` | devDependencies | 随 `cors` 连带冗余 | 删除 |
| `nodemon` | devDependencies | dev script 使用 Node.js 内建 `--watch` | 删除 |
| `ts-node` | devDependencies | 未在任何 npm scripts 中调用，seed.ts 通过 `npx` 执行 | 删除 |

### frontend (`packages/frontend/package.json`)

| 包名 | 类型 | 原因 | 建议 |
|------|------|------|------|
| `pixi.js` | dependencies | 前端源码 100% Vite 模板代码，零引用 | 保留待用或删除 |
| `zustand` | dependencies | 同上，零引用 | 保留待用或删除 |
| `socket.io-client` | dependencies | 同上，零引用 | 保留待用或删除 |
| `tailwindcss` | devDependencies | `index.css` 无 Tailwind 指令，未配置插件 | 配置使用或删除 |
| `postcss` | devDependencies | 无 `postcss.config.*` 文件 | 删除 |
| `autoprefixer` | devDependencies | 无 PostCSS 配置调用它 | 删除 |

---

## 五、Vite 模板残留文件

`packages/frontend/` 完全是 `create vite` 初始模板，尚未定制。

| 文件 | 问题 | 建议 |
|------|------|------|
| `src/App.tsx` | Vite 默认计数器 demo | 实现为游戏根组件 |
| `src/App.css` | 模板样式（hero/counter 布局） | 替换为项目样式 |
| `src/index.css` | 模板设计系统（max-width 1126px 等） | 替换为项目设计系统 |
| `src/assets/react.svg` | React logo | 删除 |
| `src/assets/vite.svg` | Vite logo | 删除 |
| `src/assets/hero.png` | Vite 模板装饰图 | 删除 |
| `public/favicon.svg` | Vite 紫色三角 logo | 替换为项目 favicon |
| `public/icons.svg` | Vite 模板社交图标雪碧图 | 删除 |
| `README.md` | Vite + React 默认模板文档 | 替换为前端项目说明 |
| `index.html` | title 为 `"frontend"` | 改为 `"ElysianVTT"` |

---

## 六、代码质量问题

| 文件 | 行号 | 问题 | 建议 |
|------|------|------|------|
| `CampaignManager.ts` | 43 & 49 | `mountEntities()` 被调用了两次（if 块内一次 + 无条件一次） | 修复为只调用一次 |
| `CombatEngine.ts` | 12 | 被注释掉的重复 import 语句 | 删除死代码 |

---

## 优先级建议

| 优先级 | 处理项 |
|--------|--------|
| 🔴 高 | 代码 Bug（`CampaignManager.ts` 双重调用） |
| 🟡 中 | 填充 `.gitignore` / `.prettierrc`、清理未使用依赖（`cors`、`nodemon`、`ts-node` 等） |
| 🟢 低 | 空桩文件（随功能开发逐步填充）、模板残留（进入前端开发时清理）、`test/package-lock.json` |
