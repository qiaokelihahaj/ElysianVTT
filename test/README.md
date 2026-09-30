# ElysianVTT 测试套件

本目录包含全栈的单元测试，分别覆盖后端核心逻辑和前端功能模块。

## 代码审计回归

从根目录运行 `pnpm test:audit` 验证引擎生命周期、角色缓存、规则加载、网络决策、可见性及前端状态；`pnpm test:audit:browser` 验证前端异步会话、计时器和组件清理。

默认的 `pnpm test`、`pnpm test:unit`、`pnpm test:integration` 和 `pnpm test:security` 也使用隔离 runner，优先读取当前 TypeScript，使用临时 SQLite，并核对开发数据库不变。首次安装或 Prisma schema 变化后先运行 `pnpm db:generate`；测试入口不再每次重复生成客户端，避免 Windows 正在使用数据库客户端时 DLL 被锁定。

## 空间战术 Demo 验收

`pnpm test:tactics` 通过隔离 runner 验证当前生产 TypeScript：空间动作与移动、直射/抛射、标签微避、三个 Socket 的权限与重复请求、真实战斗胜利/保存/重开和空间界面。`pnpm build` 后运行 `pnpm test:tactics:browser`，通过实际界面验证单人 GM 入场、姿态/护卫/转向、爆弹落点选择及键盘焦点；证据保存在 `.tmp/spatial-tactics-browser/`。游玩路线与边界见[空间战术 Demo](../docs/SPATIAL_TACTICS_DEMO.md)。

## 认证边界隔离验证

从仓库根目录运行以下命令（Node.js 22.19 或兼容版本，使用已有依赖）：

```bash
# 先证明真实 Prisma 只访问临时数据库
pnpm exec tsx test/auth-isolated.runner.ts auth-isolation.test.ts

# 当前认证、权限与日志的既有回归测试
pnpm exec tsx test/auth-isolated.runner.ts auth.test.ts permission.test.ts visibility-and-logs.test.ts security-regression.test.ts

# 以安全边界为期望的 HTTP / 真实双客户端 Socket 测试
pnpm exec tsx test/auth-isolated.runner.ts auth-boundary-http.test.ts auth-boundary-socket.test.ts
```

执行器为每个文件创建独立空白 SQLite，用现有 Prisma schema 生成表结构，只替换测试中的 Prisma datasource；认证、HTTP、Socket、权限服务使用真实当前实现。它优先加载 `.ts` 源码及 shared 源码，避免同名旧 `.js` 产物影响结果，并校验开发数据库/schema 的哈希未变化。临时库与 bundle 在执行后自动清理；不需要 `db:push`、seed 或重置开发库。

退出码 `0` 表示本次执行通过，`1` 表示测试期望未满足，`2` 表示隔离环境、超时或 fixture 失败。当前[认证边界设计](../docs/AUTHENTICATION_BOUNDARY_DESIGN.md)尚未实施，新增安全测试可以因现有缺口返回 `1`；这不应被改写成成功，也不代表构建或浏览器 Cookie 策略已验证。不要直接执行新增边界测试文件，必须通过隔离执行器运行。

## 首期 LAN Demo 验收

多阵营回归：`pnpm exec tsx test/auth-isolated.runner.ts encounter-faction-contract.test.ts encounter-factions.test.ts encounter-factions-network.test.ts demo-factions-ui.test.ts demo-entity-roster-ui.test.ts`。覆盖自定义归属、独立实体、相对关系、多方结算、控制权、广播可见性和存档兼容。浏览器密度场景使用八个不同阵营及两个独立实体，检查十行资源与身份信息能同时显示。

第二阶段模块提取回归也纳入 `test:lan`：`lan-module-boundaries.test.ts` 检查正式模块不依赖 Demo，`formal-storage-boundaries.test.ts` 检查兼容导出，`encounter-content-injection.test.ts` 验证独立内容的移动与实体生成，`encounter-server-modules.test.ts` 用独立内容组合正式服务器并验证存档重开。旧 Demo 测试继续验证兼容导入与原玩法。

第三阶段增加 `action-catalog-isolation.test.ts`、`combat-rule-pipeline-isolation.test.ts`、`encounter-rule-isolation.test.ts` 和 `engine-rulepack-isolation.test.ts`，覆盖同名动作在不同目录/遭遇中的时序、资源、效果与反应隔离，以及数据库 RulePack 加载。数据库用例必须通过隔离 runner 执行。现有弹道提取、ACTIVE 窗口和时间线回归也纳入默认列表；不依赖人工确认。

从仓库根目录运行：

```powershell
pnpm test:lan
pnpm test:lan:browser
pnpm test:lan:perf
```

`test:lan` 的文件列表在根目录 `package.json` 中显式维护，并通过隔离 runner 执行；它包含 Demo 的认证、多人屏障、网络增量、反应、控制权、可见性、GM 修正和存档回归，同时包含 `dev-login-gate.test.ts` 与 `demo-broadcast-once.test.ts`。人工通用的 `combat-browser.test.ts` 和当前已知失败的 `auth-boundary-http.test.ts` 不在默认 LAN 必过列表中。

`test:lan:browser` 运行生产构建上的真实 DemoServer 和四个隔离 Chromium context，覆盖四人入场、角色分配、战斗屏障、反应断线重连与超时、GM 调整、结算保存以及同目录停止/重启恢复。浏览器驱动使用 Playwright、`tsx` 和 Node `assert`，不引入测试框架；失败证据和退出码说明见 [`docs/LAN_BROWSER_ACCEPTANCE.md`](../docs/LAN_BROWSER_ACCEPTANCE.md)。

工作台 UI 的最小回归可运行 `pnpm exec tsx test/auth-isolated.runner.ts workspace-layout.test.ts demo-action-status-ui.test.ts demo-entity-roster-ui.test.ts demo-timeline-ui.test.ts demo-targeting-ui.test.ts demo-frontend-regression.test.ts`。其中实体列表覆盖资源、提交/等待/收招、暂停/倒下、GM 托管、缺槽位与非角色实体，并检查旧布局补充新窗口；行动提示覆盖暂停、倒下、收招、已提交、其他角色反应及多角色控制；布局覆盖 1280×720、1366×768 下两个默认主面板不重叠。行动提示回归已加入 `test:demo` 和 `test:lan`。浏览器验收另检查笔记本视口中的按钮与棋子可达性、时间轴密度切换，以及窄屏选择技能后定位地图。

第四阶段增加 `lan-performance.test.ts` 和 `lan-client-update-profile.test.ts`，均纳入 `test:lan`，也可用 `pnpm test:lan:perf` 单独执行。测量区分 Socket 消息体积、状态应用次数及 Tick 处理耗时；耗时分位数作为性能证据，不设机器相关的硬性通过阈值。浏览器报告另附只读 Socket 消息聚合计数，不能等同于 React 渲染次数。工作负载和统计口径见[性能测量说明](../docs/LAN_PERFORMANCE.md)。

## � 目录

- [快速开始](#快速开始)
- [测试文件清单](#📋-测试文件清单)
- [测试覆盖范围](#📊-测试覆盖范围)
- [运行方式](#🚀-运行方式)
- [编写新测试](#✍️-编写新测试)
- [故障排查](#🔍-故障排查)
- [最佳实践](#⭐-最佳实践)
- [环境要求](#🔧-环境要求)

## 快速开始

### 1. 安装依赖
```bash
# 从项目根目录
pnpm install
```

### 2. 运行 LAN 回归套件
```bash
# 从仓库根目录
pnpm test:lan
```

### 3. 运行特定测试
```bash
# 后端测试
pnpm exec tsx test/auth-isolated.runner.ts core.test.ts
pnpm exec tsx test/auth-isolated.runner.ts backend-utils.test.ts

# 前端测试
pnpm exec tsx test/auth-isolated.runner.ts frontend-utils.test.ts
pnpm exec tsx test/auth-isolated.runner.ts frontend-intent.test.ts
pnpm exec tsx test/auth-isolated.runner.ts frontend-store.test.ts
```

---

## 📋 测试文件清单

### 后端测试 — 引擎核心

| 文件 | 目的 | 覆盖范围 | 用例数 |
|------|------|--------|-------|
| **`core.test.ts`** | 引擎核心逻辑 | PriorityQueue、RuleEvaluator、CombatEngine、DiceRolling | ~30+ |
| **`backend-utils.test.ts`** | 工具函数 | PriorityQueue、SafeJsonParser、IdGenerator | ~10+ |
| **`tickloop.test.ts`** | TickLoop 步进器 | 单步/多步/空堆/取消事件 | ~15+ |
| **`clashpool.test.ts`** | 同 Tick 冲突池 | 优先级分组、相杀二阶段提交 | ~20+ |
| **`interrupt.test.ts`** | 动作打断 | 打断条件、消耗计算 | ~15+ |
| **`channel.test.ts`** | Channeling 引导 | 每脉冲消耗、中断 | ~10+ |
| **`movement.test.ts`** | 移动系统 | 路径规划、插值、碰撞 | ~15+ |
| **`engine.integration.test.ts`** | 引擎集成 | 完整战斗流程、批量施法 | ~20+ |
| **`two-characters.test.ts`** | 双角色时间轴 | 双角色并发动作、时间轴重叠 | ~15+ |

### 后端测试 — 战斗博弈系统

| 文件 | 目的 | 覆盖范围 | 用例数 |
|------|------|--------|-------|
| **`dr.test.ts`** | DR 装甲减伤 | 物理伤害减免计算 | ~10+ |
| **`parry.test.ts`** | 招架偏转 (DEF) | 招架成功/失败、资源变化 | ~10+ |
| **`dodge.test.ts`** | 主动闪避 | 位移距离、范围伤害豁免 | ~10+ |
| **`whiff.test.ts`** | 差合/挥空惩罚 | 距离判定、Recovery 延长、确反加成 | ~10+ |
| **`reaction.test.ts`** | 反应动作 | 打断闯入、有效拦截 | ~10+ |
| **`micro-evasion.test.ts`** | 微避系统 | Tag 匹配/不匹配四场景 | ~10+ |
| **`reaction-countdown-integration.test.ts`** | 反应倒计时集成 | 决策窗口生命周期 | ~10+ |
| **`decision-countdown.test.ts`** | 决策倒计时 | 决策轮询/超时/响应 | ~10+ |
| **`decision-countdown-lifecycle.test.ts`** | 决策生命周期 | 完整决策流状态转换 | ~10+ |
| **`firestorm-timeline.test.ts`** | 火焰风暴时间轴 | 多脉冲引导动作 | ~10+ |

### 后端测试 — Hook 系统

| 文件 | 目的 | 覆盖范围 | 用例数 |
|------|------|--------|-------|
| **`hook-timing.test.ts`** | Hook 时序 | 断点注入、精确中断触发 | ~15+ |
| **`socket-hook-e2e.test.ts`** | Hook E2E | WebSocket 层 Hook 端到端 | ~10+ |
| **`socket-hook-lifecycle-e2e.test.ts`** | Hook 生命周期 | Hook 注册/触发/消亡全流程 | ~10+ |
| **`socket-hook-edge-e2e.test.ts`** | Hook 边界 | Hook 竞态、并发、取消 | ~10+ |
| **`socket-hook-range-e2e.test.ts`** | Hook 范围 | 范围触发、距离判定 | ~10+ |

### 后端测试 — 基础设施

| 文件 | 目的 | 覆盖范围 | 用例数 |
|------|------|--------|-------|
| **`auth.test.ts`** | 认证系统 | Token 生成/验证/登出 | ~15+ |
| **`permission.test.ts`** | 权限系统 | GM/PL/OB 授权规则 + 快照持久化 | ~25+ |
| **`rulepack.test.ts`** | RulePack 加载 | 规则包数据架构、Loader | ~10+ |
| **`visibility-and-logs.test.ts`** | 可见性与日志 | VisibilityFilter、日志审计 | ~10+ |
| **`security-regression.test.ts`** | 安全回归 | 权限端点、Token 失效 | ~10+ |
| **`performance-stress.test.ts`** | 性能压力 | 大量并发事件、长战斗 | ~10+ |
| **`network.test.ts`** | 网络层 | Socket 事件收发 | ~10+ |
| **`socket-e2e.test.ts`** | Socket E2E | 客户端-服务端完整通信 | ~10+ |

### 前端测试

| 文件 | 目的 | 关键模块 | 用例数 |
|------|------|--------|-------|
| **`frontend-utils.test.ts`** | 工具函数验证 | `setNestedProperty`、游戏状态差分 | 14 |
| **`frontend-intent.test.ts`** | 意图系统 | MOVE、CAST_ACTION、INTERACT 意图构建 | 29 |
| **`frontend-store.test.ts`** | 生产 Zustand/Immer 状态管理 | 场景、选中、差分、快照与 UI 清理 | 见文件断言 |

---

## 📊 测试覆盖范围

### 前端工具函数 (`frontend-utils.test.ts`) — 14 个用例

**核心功能：深层路径赋值 (`setNestedProperty`)**

| 用例 | 场景说明 |
|------|---------|
| ✅ 一级路径赋值 | 简单属性设置：`obj.name = value` |
| ✅ 多级路径赋值（已存在） | 修改已存在的深层对象 |
| ✅ 多级路径赋值（新建） | 自动创建中间层级路径 |
| ✅ 深层创建 | 多级嵌套结构自动生成 |
| ✅ 覆盖已有值 | 保持兄弟节点不变 |
| ✅ null 值设置 | 正确处理 null 赋值 |
| ✅ 布尔值设置 | 布尔类型保留 |
| ✅ 数组值设置 | 复杂数据类型支持 |
| 🎮 **游戏状态差分** | 实体坐标与血量同时变更应用 |

### 前端意图分发器 (`frontend-intent.test.ts`) — 29 个用例

**核心功能：玩家操作意图构建与同步**

| 意图类型 | 覆盖场景 | 用例数 |
|---------|---------|-------|
| 🔵 **MOVE** | 坐标验证、clientTick 同步 | ~8 |
| 🔴 **CAST_ACTION** | 无目标、带目标 ID、带坐标 | ~12 |
| 🟡 **INTERACT** | 目标验证、范围检查 | ~6 |
| 📊 **多意图** | 历史记录、Tick 变化追踪 | ~3 |

**关键特性：**
- ✅ 完全隔离的 Mock（socketClient、gameStore）
- ✅ clientTick 自动同步验证
- ✅ 参数验证与边界检查

### 前端游戏状态 (`frontend-store.test.ts`)

**核心功能：全局游戏状态管理**

测试直接导入生产 store，覆盖初始状态、整场景替换、选中与删除、差分应用、Immer 快照保留与 UI 模式重置；执行后恢复 store。决策、动作和移动清理的新增回归见 `audit-frontend-state.test.ts`。

---

## 🚀 运行方式

### 基础运行

```bash
# 从仓库根目录运行 LAN 回归套件
pnpm test:lan

# 运行单个测试文件
pnpm exec tsx test/auth-isolated.runner.ts core.test.ts
pnpm exec tsx test/auth-isolated.runner.ts frontend-utils.test.ts

# 运行多个测试文件
pnpm exec tsx test/auth-isolated.runner.ts core.test.ts backend-utils.test.ts frontend-utils.test.ts
```

### 安装依赖（如需）
```bash
# 从仓库根目录安装工作区依赖
pnpm install
```

### 运行安全测试
```bash
# 安全测试统一入口（依次执行 auth / permission / visibility / security）
pnpm test:security
```

### 命令别名

```bash
# 通过 test/package.json 运行
pnpm test:unit          # clashpool + interrupt + two-characters
pnpm test:integration   # engine.integration
pnpm test:security      # 安全测试入口
```

---

## ✍️ 编写新测试

### 测试文件结构

遵循以下模式创建新测试文件：

```typescript
// myfeature.test.ts
import assert from 'assert';

console.log('🧪 测试套件：MyFeature');

// 测试分组
console.log('\n📋 分组 1：基础功能');

// 单个测试用例
let testCount = 0;
let passCount = 0;

const test = (name: string, fn: () => void) => {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err}`);
  }
};

// 编写测试
test('应该正确初始化', () => {
  const obj = new MyClass();
  assert.strictEqual(obj.value, 0);
});

test('应该更新状态', () => {
  const obj = new MyClass();
  obj.setValue(5);
  assert.strictEqual(obj.value, 5);
});

// 总结
console.log(`\n📊 结果：${passCount}/${testCount} 通过`);
if (passCount < testCount) process.exit(1);
```

### 最佳实践

1. **命名规范**
   - 文件名：`featurename.test.ts`
   - 用例描述：使用"应该"或"验证"开头
   
   ```typescript
   test('应该正确处理空输入', () => {...});
   test('验证错误场景下的防守', () => {...});
   ```

2. **测试分组**
   ```typescript
   console.log('\n📋 分组：功能名称');
   // 相关的 10 个测试用例放在一起
   ```

3. **断言**
   - 使用 Node.js 内置 `assert` 模块
   - 优先使用 `assert.strictEqual()` 或 `assert.deepStrictEqual()`
   
   ```typescript
   assert.strictEqual(actual, expected);
   assert.deepStrictEqual(obj1, obj2);
   assert.throws(() => fn(), Error);
   assert.ok(condition);
   ```

4. **Mock 对象**
   - 为外部依赖创建简单的 Mock
   
   ```typescript
   const mockSocket = {
     emit: (event: string, data: any) => {
       // 记录调用
       emittedEvents.push({ event, data });
     }
   };
   ```

5. **快照测试**
   - 对复杂对象使用结构化比较
   
   ```typescript
   const expectedState = { id: 1, name: 'Test', items: [] };
   assert.deepStrictEqual(store.getState(), expectedState);
   ```

---

## 🔍 故障排查

### 问题 1：找不到模块 `tsx`

**原因：** 未安装依赖或未在项目根目录运行

**解决：**
```bash
# 在项目根目录
pnpm install

# 然后在 test 目录运行
cd test
pnpm exec tsx test/auth-isolated.runner.ts core.test.ts
```

### 问题 2：TypeScript 编译错误

**原因：** 类型定义不完整或版本不匹配

**检查步骤：**
```bash
# 查看 TypeScript 版本
pnpm exec tsc --version

# 验证 tsconfig.json
cat tsconfig.json
```

**预期版本：** TypeScript 6.0+

### 问题 3：测试失败但本地代码正确

**可能原因：**
- 修改了源代码但未重新编译
- 类型导入不匹配（相对路径 vs 包导入）
- 异步操作未等待

**调试方法：**
```typescript
// 添加日志输出
console.log('当前值：', actualValue);
console.log('预期值：', expectedValue);
console.log('完整对象：', JSON.stringify(obj, null, 2));

// 运行单个测试
pnpm exec tsx test/auth-isolated.runner.ts core.test.ts 2>&1 | head -50
```

### 问题 4：`process.exit(1)` 导致半途中断

**原因：** 某个测试文件失败，后续文件未执行

**运行单个文件：**
```bash
# 逐个测试
pnpm exec tsx test/auth-isolated.runner.ts core.test.ts
pnpm exec tsx test/auth-isolated.runner.ts frontend-utils.test.ts
# ...
```

---

## ⭐ 最佳实践

### 1. 测试独立性
- 每个测试应该独立运行
- 不依赖其他测试的结果
- 每个测试清理自己的状态

```typescript
// ❌ 错误：依赖前一个测试
let globalValue = 0;
test('设置值', () => { globalValue = 5; });
test('验证值', () => { assert.strictEqual(globalValue, 5); });

// ✅ 正确：完全独立
test('设置值', () => {
  const state = {};
  state.value = 5;
  assert.strictEqual(state.value, 5);
});
```

### 2. 清晰的失败信息
```typescript
// ❌ 不清楚的错误
assert.ok(result);

// ✅ 清晰的错误信息
assert.strictEqual(
  result.status,
  'success',
  `Expected success but got ${result.status}`
);
```

### 3. 聚焦单一职责
```typescript
// ❌ 一个测试测试多个功能
test('完整流程', () => {
  const obj = new MyClass();
  obj.init();
  obj.update();
  obj.cleanup();
  assert.ok(obj.isClean);
});

// ✅ 分离关注点
test('应该初始化', () => { /* ... */ });
test('应该更新', () => { /* ... */ });
test('应该清理', () => { /* ... */ });
```

### 4. 包含边界情况测试
```typescript
test('应该处理空数组', () => {
  assert.deepStrictEqual(processArray([]), []);
});

test('应该处理单元素', () => {
  assert.deepStrictEqual(processArray([1]), [1]);
});

test('应该处理大数据', () => {
  const largeArray = Array(10000).fill(0);
  assert.ok(processArray(largeArray).length > 0);
});
```

### 5. 维护和更新
- 当代码改变时更新相关测试
- 添加新功能时补充测试
- 定期重构过长的测试用例

---

## 🔧 环境要求

| 要求 | 最低版本 | 推荐版本 |
|------|---------|--------|
| **Node.js** | 20.0 | 22.0+ |
| **TypeScript** | 5.5 | 6.0+ |
| **tsx** | 4.0 | 4.21+ |

### 验证环境

```bash
# 检查版本
node --version
pnpm exec tsc --version
pnpm exec tsx --version

# 输出示例
v22.x.x
Version 6.0.3
v4.21.0
```

---

## 📞 常见问题

**Q: 我应该多频繁运行测试？**  
A: 推荐在每次代码变更后、提交前运行。

**Q: 如何调试测试？**  
A: 添加 `console.log()` 语句，或运行单个测试文件。

**Q: 测试覆盖率要求？**  
A: 目标是关键路径 100%，工具函数 90%+。

**Q: 可以跳过某个测试吗？**  
A: 可以注释掉 `test()` 调用，但不建议在提交代码时跳过。
- **执行器**：tsx (类型安全的 TS 执行)
- **断言风格**：纯函数式 assert（无外部测试框架依赖）

## ✅ 当前状态

> 注：此表为上次确认时的状态快照，实际运行结果以最新测试输出为准。

| 测试套件 | 状态 | 通过率 |
|---------|------|-------|
| `core.test.ts` | ✅ | 100% |
| `backend-utils.test.ts` | ✅ | 100% |
| `clashpool.test.ts` | ✅ | 100% |
| `tickloop.test.ts` | ✅ | 100% |
| `interrupt.test.ts` | ✅ | 100% |
| `channel.test.ts` | ✅ | 100% |
| `movement.test.ts` | ✅ | 100% |
| `engine.integration.test.ts` | ✅ | 100% |
| `two-characters.test.ts` | ✅ | 100% |
| `dr.test.ts` | ✅ | 100% |
| `parry.test.ts` | ✅ | 100% |
| `dodge.test.ts` | ✅ | 100% |
| `whiff.test.ts` | ✅ | 100% |
| `reaction.test.ts` | ✅ | 100% |
| `micro-evasion.test.ts` | ✅ | 100% |
| `hook-timing.test.ts` | ✅ | 100% |
| `rulepack.test.ts` | ✅ | 100% |
| `auth.test.ts` | ✅ | 100% |
| `permission.test.ts` | ✅ | 100% |
| `visibility-and-logs.test.ts` | ✅ | 100% |
| `security-regression.test.ts` | ✅ | 100% |
| `frontend-utils.test.ts` | ✅ | 14/14 |
| `frontend-intent.test.ts` | ✅ | 29/29 |
| `frontend-store.test.ts` | ✅ | 25/25 |

## 📝 开发指南

### 添加新测试
1. 在对应的 `*.test.ts` 文件中添加测试代码
2. 使用 `section(title)` 分组，`assert(condition, label)` 断言
3. 运行 `pnpm exec tsx test/auth-isolated.runner.ts file.test.ts` 验证

### Mock 策略
- **MockSocketClient**：捕获所有发送的意图并记录
- **mockGameStoreTick**：模拟全局 Tick 状态
- **createGameStore()**：独立 store 实例，避免测试污染

### 命名约定
- 测试文件：`<domain>-<purpose>.test.ts`
- 测试组：`section('功能名称')`
- 测试用例：`assert(condition, 'expectation')`
