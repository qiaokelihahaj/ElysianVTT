# ElysianVTT 测试套件

本目录包含全栈的单元测试，分别覆盖后端核心逻辑和前端功能模块。

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

### 2. 运行所有测试
```bash
# 从 test 目录
cd test
npx tsx *.test.ts
```

### 3. 运行特定测试
```bash
# 后端测试
npx tsx core-test.ts
npx tsx unit-test.ts

# 前端测试
npx tsx frontend-utils.test.ts
npx tsx frontend-intent.test.ts
npx tsx frontend-store.test.ts
```

---

## 📋 测试文件清单

### 后端测试

| 文件 | 目的 | 覆盖范围 | 用例数 |
|------|------|--------|-------|
| **`core-test.ts`** | 引擎核心逻辑 | PriorityQueue、RuleEvaluator、CombatEngine、DiceRolling | ~30+ |
| **`unit-test.ts`** | 工具函数 | SafeJsonParser、IdGenerator | ~10+ |

### 前端测试

| 文件 | 目的 | 关键模块 | 用例数 |
|------|------|--------|-------|
| **`frontend-utils.test.ts`** | 工具函数验证 | `setNestedProperty`、游戏状态差分 | 14 |
| **`frontend-intent.test.ts`** | 意图系统 | MOVE、CAST_ACTION、INTERACT 意图构建 | 29 |
| **`frontend-store.test.ts`** | 全局状态管理 | GameStore 生命周期、选中系统、UI 管理 | 25 |

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

### 前端游戏状态 (`frontend-store.test.ts`) — 25 个用例

**核心功能：全局游戏状态管理**

| 功能模块 | 用例数 | 覆盖内容 |
|---------|-------|--------|
| 📌 初始状态 | 5 | 店铺初始化、场景、实体 |
| 🎬 场景初始化 | 4 | 加载场景、重置状态 |
| 🎯 选中系统 | 2 | 实体选中、显示血条 |
| 👥 实体管理 | 3 | 添加、删除、更新实体 |
| 🔄 状态变更 | 3 | 部分更新、差分应用 |
| 🖼️ UI 模式 | 4 | 模式切换、界面显示 |
| 🔁 UI 重置 | 2 | 选中清除、模式重置 |
| 🔗 集成场景 | 2 | **选中 → 显示血条 → 接收差分** |

---

## 🚀 运行方式

### 基础运行

```bash
# 运行所有测试
npx tsx *.test.ts

# 运行单个测试文件
npx tsx core-test.ts
npx tsx frontend-utils.test.ts

# 运行多个测试文件
npx tsx core-test.ts unit-test.ts frontend-utils.test.ts
```

### 安装依赖（如需）
```bash
# 在 test 目录初始化
cd test
npm install
# 或使用 pnpm
pnpm install
```

### 命令别名建议

在 `package.json` 中添加 npm scripts（可选）：
```json
{
  "scripts": {
    "test": "tsx *.test.ts",
    "test:backend": "tsx core-test.ts unit-test.ts",
    "test:frontend": "tsx frontend-*.test.ts",
    "test:watch": "tsx --watch *.test.ts",
    "test:core": "tsx core-test.ts",
    "test:utils": "tsx frontend-utils.test.ts",
    "test:intent": "tsx frontend-intent.test.ts",
    "test:store": "tsx frontend-store.test.ts"
  }
}
```

然后运行：
```bash
npm run test          # 运行所有
npm run test:backend  # 仅后端
npm run test:frontend # 仅前端
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
npx tsx core-test.ts
```

### 问题 2：TypeScript 编译错误

**原因：** 类型定义不完整或版本不匹配

**检查步骤：**
```bash
# 查看 TypeScript 版本
npx tsc --version

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
npx tsx core-test.ts 2>&1 | head -50
```

### 问题 4：`process.exit(1)` 导致半途中断

**原因：** 某个测试文件失败，后续文件未执行

**运行单个文件：**
```bash
# 逐个测试
npx tsx core-test.ts
npx tsx frontend-utils.test.ts
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
npx tsc --version
npx tsx --version

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

| 测试套件 | 状态 | 通过率 |
|---------|------|-------|
| `core-test.ts` | ✅ | 100% |
| `unit-test.ts` | ✅ | 100% |
| `frontend-utils.test.ts` | ✅ | 14/14 |
| `frontend-intent.test.ts` | ✅ | 29/29 |
| `frontend-store.test.ts` | ✅ | 25/25 |

## 📝 开发指南

### 添加新测试
1. 在对应的 `*.test.ts` 文件中添加测试代码
2. 使用 `section(title)` 分组，`assert(condition, label)` 断言
3. 运行 `npx tsx file.test.ts` 验证

### Mock 策略
- **MockSocketClient**：捕获所有发送的意图并记录
- **mockGameStoreTick**：模拟全局 Tick 状态
- **createGameStore()**：独立 store 实例，避免测试污染

### 命名约定
- 测试文件：`<domain>-<purpose>.test.ts`
- 测试组：`section('功能名称')`
- 测试用例：`assert(condition, 'expectation')`
