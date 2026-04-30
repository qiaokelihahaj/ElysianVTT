# ElysianVTT 问题清单 - 按模块分类

**生成日期**: 2026年4月30日  
**总问题数**: 58个（去重统一）

---

## 📊 按模块分类统计

| 模块 | Critical | High | Medium | Low | 总计 | 总工作量 |
|------|----------|------|--------|-----|------|---------|
| 后端核心引擎 | 6 | 7 | 10 | 3 | 26 | 64h |
| 网络 | 3 | 3 | 3 | 1 | 10 | 18h |
| 业务逻辑 | 1 | 3 | 0 | 0 | 4 | 7h |
| 前端 | 0 | 4 | 8 | 2 | 14 | 25h |
| 数据库 | 0 | 1 | 0 | 4 | 5 | 8h |
| 测试 | 0 | 0 | 2 | 0 | 2 | 7h |
| 基础设施 | 0 | 0 | 0 | 1 | 1 | 2h |
| **总计** | **11** | **18** | **23** | **11** | **58** | **158h** |

---

# 1. 后端核心引擎 (26 issues, 64h)

## Critical (6 issues, 26h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| CR-005 | 🔴 | CombatEngine.processQueue() 实现不完整 | 8h | CombatEngine.ts |
| CR-006 | 🔴 | CombatEngine 缺少战斗结束逻辑 | 3h | CombatEngine.ts |
| CR-007 | 🔴 | CombatEngine 动作取消性能 O(n) | 5h | CombatEngine.ts |
| CR-008 | 🔴 | CombatEngine 缺少并发控制 | 4h | CombatEngine.ts |
| CR-010 | 🔴 | ClashPool decorateEvents() 过滤过严 | 1h | ClashPool.ts |
| CR-011 | 🔴 | INTERACT意图处理缺失 | 2h | CombatEngine.ts |

## High Priority (7 issues, 19h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| HP-007 | 🟡 | ClashPool tolerance 硬编码 | 1h | ClashPool.ts |
| HP-008 | 🟡 | ClashPool 缺少死亡检查 | 2h | ClashPool.ts |
| HP-009 | 🟡 | RuleEvaluator 缺少表达式编译缓存 | 3h | RuleEvaluator.ts |
| HP-010 | 🟡 | EffectSystem APPLY_BUFF 未实现 | 4h | EffectSystem.ts |
| HP-011 | 🟡 | EffectSystem 条件判定未使用 | 2h | EffectSystem.ts |
| HP-012 | 🟡 | SpatialSystem 缺少碰撞检测 | 4h | SpatialSystem.ts |
| HP-013 | 🟡 | SpatialSystem 缺少寻路逻辑 | 5h | SpatialSystem.ts |

## Medium Priority (10 issues, 14h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| MP-001 | 🟢 | PriorityQueue 缺少堆序列化 | 2h | PriorityQueue.ts |
| MP-002 | 🟢 | PriorityQueue 没有buildHeap() | 2h | PriorityQueue.ts |
| MP-003 | 🟢 | RuleEvaluator DICE_REGEX不规范 | 0.5h | RuleEvaluator.ts |
| MP-004 | 🟢 | RuleEvaluator 异常处理过于通用 | 1h | RuleEvaluator.ts |
| MP-005 | 🟢 | RuleEvaluator 缺少递归深度限制 | 2h | RuleEvaluator.ts |
| MP-006 | 🟢 | EffectSystem 缺少效果链支持 | 3h | EffectSystem.ts |
| MP-007 | 🟢 | SpatialSystem stepSize与单位不对应 | 1h | SpatialSystem.ts |
| MP-008 | 🟢 | CombatEngine currentTick 无上界 | 1h | CombatEngine.ts |

## Low Priority (3 issues, 4.5h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| LP-001 | 🟣 | ClashPool 内存分配低效 | 1h | ClashPool.ts |
| LP-002 | 🟣 | EffectSystem 护盾等中间层缺失 | 2h | EffectSystem.ts |
| LP-003 | 🟣 | PriorityQueue 缺少越界保护日志 | 0.5h | PriorityQueue.ts |

### 关键文件清单 (后端核心引擎)
- ✅ **PriorityQueue.ts** - 5个问题 (5.5h)
- ✅ **ClashPool.ts** - 4个问题 (4h)
- ✅ **RuleEvaluator.ts** - 6个问题 (6.5h)
- ✅ **EffectSystem.ts** - 4个问题 (10h)
- ✅ **SpatialSystem.ts** - 3个问题 (10h)
- ✅ **CombatEngine.ts** - 6个问题 (25h)

---

# 2. 网络层 (10 issues, 18h)

## Critical (3 issues, 17h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| CR-002 | 🔴 | Socket 无玩家认证机制 | 12h | SocketServer.ts |
| CR-003 | 🔴 | SocketServer CORS 过于宽松 | 2h | SocketServer.ts |
| CR-004 | 🔴 | Socket 无权限检查 | 3h | SocketServer.ts |

## High Priority (3 issues, 10h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| HP-001 | 🟡 | IntentRouter 文件为空 | 4h | IntentRouter.ts |
| HP-002 | 🟡 | StateBroadcaster 文件为空 | 3h | StateBroadcaster.ts |
| HP-006 | 🟡 | Socket disconnect 处理不完整 | 3h | SocketServer.ts |

## Medium Priority (3 issues, 3h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| MP-009 | 🟢 | SocketServer 没有速率限制 | 2h | SocketServer.ts |
| MP-010 | 🟢 | CLIENT_INTENT 缺少错误回调 | 1h | SocketServer.ts |

## Low Priority (1 issue, 3h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| LP-009 | 🟣 | Socket 没有消息加密 | 3h | SocketServer.ts |

### 关键文件清单 (网络层)
- ⚠️ **SocketServer.ts** - 7个问题 (22h) - **优先处理**
- 📝 **IntentRouter.ts** - 1个问题 (4h) - **空文件**
- 📝 **StateBroadcaster.ts** - 1个问题 (3h) - **空文件**
- 📝 **VisibilityFilter.ts** - 1个问题 (8h) - **空文件** (详见CR-009)

---

# 3. 业务逻辑 (4 issues, 7h)

## Critical (1 issue, 12h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| CR-001 | 🔴 | SettlementService 文件为空 | 12h | SettlementService.ts |

## High Priority (3 issues, 6h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| HP-004 | 🟡 | CampaignManager 无生命周期管理 | 3h | CampaignManager.ts |
| HP-005 | 🟡 | CampaignManager 缺少Settlement集成 | 1h | CampaignManager.ts |
| HP-018 | 🟡 | Scene 文件为空 | 2h | Scene.ts |

### 关键文件清单 (业务逻辑)
- 📝 **SettlementService.ts** - 1个问题 (12h) - **空文件**
- ⚠️ **CampaignManager.ts** - 2个问题 (4h)
- 📝 **Scene.ts** - 1个问题 (2h) - **空文件**

---

# 4. 前端 (14 issues, 25h)

## High Priority (4 issues, 8h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| HP-014 | 🟡 | GameStore 缺少entityId验证 | 1h | gameStore.ts |
| HP-015 | 🟡 | SocketClient 缺少自动重连 | 3h | socketClient.ts |
| HP-016 | 🟡 | RendererManager 缺少Culling优化 | 4h | RendererManager.ts |

## Medium Priority (8 issues, 15h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| MP-011 | 🟢 | GameStore 缺少乐观更新回滚 | 3h | gameStore.ts |
| MP-012 | 🟢 | GameStore movementTargets用途不清 | 1h | gameStore.ts |
| MP-013 | 🟢 | SocketClient 缺少连接状态查询 | 1h | socketClient.ts |
| MP-014 | 🟢 | SocketClient 缺少心跳检测 | 1h | socketClient.ts |
| MP-015 | 🟢 | RendererManager 缺少摄像头系统 | 3h | RendererManager.ts |
| MP-016 | 🟢 | RendererManager 每帧更新所有实体 | 2h | RendererManager.ts |
| MP-017 | 🟢 | RendererManager Phantom逻辑欠缺 | 1h | RendererManager.ts |

## Low Priority (2 issues, 2h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| LP-004 | 🟣 | GameCanvas 缺少错误边界 | 1h | GameCanvas.tsx |
| LP-005 | 🟣 | GameCanvas 没有加载状态 | 1h | GameCanvas.tsx |

### 关键文件清单 (前端)
- ⚠️ **RendererManager.ts** - 5个问题 (10h) - **性能瓶颈**
- ⚠️ **gameStore.ts** - 4个问题 (5h)
- ⚠️ **socketClient.ts** - 4个问题 (5h)
- 🟢 **GameCanvas.tsx** - 2个问题 (2h)

---

# 5. 数据库 (5 issues, 8h)

## High Priority (1 issue, 4h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| HP-017 | 🟡 | 数据库缺少关键表 | 4h | schema.prisma |

## Low Priority (4 issues, 4h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| LP-006 | 🟣 | 数据库缺少索引 | 1h | schema.prisma |
| LP-007 | 🟣 | 数据库无JSON Schema验证 | 2h | schema.prisma |
| LP-008 | 🟣 | 数据库缺少时间戳 | 1h | schema.prisma |

### 关键缺失表
- ❌ **Player** - 玩家账户管理
- ❌ **Scene** - 场景管理
- ❌ **BattleLog** - 战斗历史
- ❌ **AppliedEffect** - 应用效果追踪
- ❌ **Inventory** - 物品管理

---

# 6. 测试 (2 issues, 7h)

## Medium Priority (2 issues, 7h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| MP-018 | 🟢 | 缺少集成测试 | 4h | test/ |
| MP-019 | 🟢 | 缺少并发和性能测试 | 3h | test/ |

---

# 7. 基础设施 (1 issue, 2h)

## Low Priority (1 issue, 2h)

| ID | 优先级 | 问题 | 工作量 | 文件 |
|----|--------|------|--------|------|
| LP-010 | 🟣 | Logger日志聚合缺失 | 2h | Logger.ts |

---

## 🚨 7个需要立即解决的空文件

按优先级排序：

| # | 文件 | 模块 | 优先级 | 工作量 | 描述 |
|---|------|------|--------|--------|------|
| 1 | SettlementService.ts | 业务逻辑 | 🔴 CRITICAL | 12h | MVP Phase 1 无法完成 |
| 2 | VisibilityFilter.ts | 网络 | 🔴 CRITICAL | 8h | FoW/LoS系统必需 |
| 3 | IntentRouter.ts | 网络 | 🟡 HIGH | 4h | 代码组织 |
| 4 | StateBroadcaster.ts | 网络 | 🟡 HIGH | 3h | 代码组织 |
| 5 | Repository.ts | 数据库 | 🟡 HIGH | 3h | 测试可维护性 |
| 6 | Scene.ts | 业务逻辑 | 🟡 HIGH | 2h | 场景管理 |

---

## ⚠️ 最高优先级的修复顺序

### 第一天 (16h)
1. **CR-001**: SettlementService 实现 (12h)
2. **CR-002/003/004**: SocketServer 认证和权限 (5h之内搞定)

### 第二天 (14h)
3. **CR-005/006/007/008**: CombatEngine 修复 (20h)
   - 先做processQueue() (8h)
   - 再做战斗结束和并发 (8h)
   - 再做取消优化 (4h)

### 第三天及以后
4. **CR-009**: VisibilityFilter 实现 (8h)
5. **CR-010/011**: ClashPool 和 INTERACT (3h)
6. 其他高优先级问题...

---

## 📈 优先级热力图

```
Critical Issues Heat Map (按工作量):
┌────────────────────────────────┐
│ CR-005: 8h  ██████████████     │  CombatEngine.processQueue()
│ CR-002: 12h █████████████████  │  Socket认证
│ CR-001: 12h █████████████████  │  SettlementService
│ CR-009: 8h  ██████████████     │  VisibilityFilter
│ CR-007: 5h  ████████           │  CombatEngine取消
│ CR-008: 4h  ███████            │  CombatEngine并发
│ CR-006: 3h  █████              │  战斗结束
│ CR-004: 3h  █████              │  权限检查
│ CR-003: 2h  ███                │  CORS修复
│ CR-011: 2h  ███                │  INTERACT
│ CR-010: 1h  ██                 │  ClashPool过滤
└────────────────────────────────┘
Total: 52h (本周必须)
```

---

生成日期: 2026年4月30日
