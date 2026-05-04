# ElysianVTT 问题清单 - 快速参考指南

**生成日期**: 2026年4月30日  
**工作量总计**: 139小时 | **问题总数**: 53个（已移除已修复项）

---

## � 架构规划残留问题（延后处理）

依据《权限系统架构与开发计划.md》，目前已经完成基于 RBAC 与基本 ABAC 动态授权的基础架构搭建。以下是剩余的高级特性，将于以后阶段进行解决：

1. **底层审计表与骰子改值防篡改 (Audit & Dice Overrides)**:
   - 虽然相关的 Prisma 表 (`AuditEvent`, `DiceRoll`) 已经预置，但在 `IntentRouter` 和底层操作中，并未强关联写入审计链。
   - `OVERRIDE_DICE` 尚未开放对应路由与持久化实现。

2. **特权通道与引擎生命周期控制 (Engine Lifecycle Control)**:
   - 包含：暂停场景、开启场景、冻结引擎与恢复引擎。
   - 目前受限于前端界面设计，这些管理功能暂无 API 和 Intent 入口。

---

## �🔴 Critical Issues 优先级排序 (34h 本周必须完成)

### 1️⃣ 最紧急: SocketServer 安全修复 (17h)
```
CR-002: Socket 无玩家认证机制 ........... 12h ⚠️ 生产环境严重风险
CR-003: SocketServer CORS 过于宽松 ...... 2h  XSS/CSRF风险
CR-004: Socket 无权限检查 ............... 3h  玩家可控制他人角色
```
**文件**: `packages/backend/src/network/SocketServer.ts`  
**影响**: 所有网络通信，安全边界被打破  
**必需的修复**:
- 实现JWT/OAuth认证
- 限制CORS到特定域名
- 添加权限验证(玩家只能控制自己的角色)

---

### 2️⃣ 第二紧急: CombatEngine 核心修复 (17h)
```
CR-005: CombatEngine.processQueue() 不完整 ... 8h 🔴 引擎无法运行
CR-007: CombatEngine 动作取消 O(n) ........ 5h  性能严重下降
CR-008: CombatEngine 缺少并发控制 ........ 4h  多玩家竞态条件
```
**文件**: `packages/backend/src/campaigns/engines/CombatEngine.ts`  
**影响**: 整个战斗流程无法运行  
**关键实现**:
- [ ] 完整的processQueue()事件循环
- [ ] 动作取消优化(eventIdToHeapIndex映射)
- [ ] 并发控制和同步

---

### 4️⃣ VisibilityFilter 实现 (8h)
```
CR-009: VisibilityFilter 文件为空 ....... 8h 🔴 FoW/隐身系统必需
```
**文件**: `packages/backend/src/network/VisibilityFilter.ts`  
**影响**: 无法隐藏不应该看到的信息  
**必需的实现**:
- 视线(LoS)检测
- 战争迷雾(FoW)实现
- 隐身机制支持
- 状态差分过滤

---

## 🟡 High Priority 第一周任务 (51h)

### 优先顺序
1. **HP-001/002/003**: 空文件填充 (10h)
   - IntentRouter, StateBroadcaster, Repository

2. **HP-004**: CampaignManager 生命周期 (3h)
   - 添加引擎超期清理

3. **HP-006**: Socket disconnect 处理 (3h)
   - 实现playerDisconnect处理
   - 幽灵玩家清理

4. **HP-007/008**: ClashPool 细节修复 (3h)
   - tolerance从配置读取
   - 添加死亡检查

5. **HP-009**: RuleEvaluator 表达式缓存 (3h)
   - 添加compiled expression缓存
   - 性能提升15-20%

6. **HP-010/011**: EffectSystem 完善 (6h)
   - 实现APPLY_BUFF
   - 使用conditions判定

7. **HP-012/013**: SpatialSystem 碰撞/寻路 (9h)
   - 添加碰撞检测
   - 实现A*寻路

8. **HP-014/015/016/017/018**: 前端和数据库 (13h)
   - GameStore验证
   - SocketClient重连
   - RendererManager优化
   - 数据库表和索引
   - Scene实现

---

## 🟢 Medium Priority 第二周任务 (38h)

代码质量改进、测试覆盖、边界情况处理

### 按工作量排序
1. **MP-018/019**: 测试实现 (7h)
2. **MP-001-005**: PriorityQueue/RuleEvaluator 改进 (5.5h)
3. **MP-006**: EffectSystem 效果链 (3h)
4. **MP-011/012/013/014**: 前端完善 (6h)
5. **MP-015/016/017**: RendererManager 优化 (6h)
6. **其他 Medium**: 各种边界和优化 (3.5h)

---

## 📋 执行检查清单

### Week 1 (Critical - 34h)
- [ ] CR-002/003/004: SocketServer 认证/权限/CORS
- [ ] CR-005: CombatEngine.processQueue() 完整实现
- [ ] CR-007: 动作取消优化(O(n)→O(1))
- [ ] CR-008: 并发控制
- [ ] CR-009: VisibilityFilter FoW/LoS

### Week 2 (High Priority - 51h)
- [ ] HP-001-003: 空文件填充
- [ ] HP-004: CampaignManager 生命周期
- [ ] HP-006: disconnect 处理
- [ ] HP-007-008: ClashPool 细节
- [ ] HP-009: RuleEvaluator 缓存
- [ ] HP-010-011: EffectSystem Buff/条件
- [ ] HP-012-013: SpatialSystem 碰撞/寻路
- [ ] HP-014-018: 前端/数据库完善

### Week 3+ (Medium Priority - 38h)
- [ ] MP-018-019: 集成测试/性能测试
- [ ] MP-001-005: 引擎代码质量
- [ ] MP-006-017: 前端优化
- [ ] LP-001-010: 低优先级(可选)

---

## 🎯 最关键的3个修复

### #1: 认证系统 (CR-002)
**当前**: 任何人可以伪造任意玩家身份  
**修复**: 实现JWT认证和权限检查  
**影响**: 安全边界，所有网络通信  
**工作量**: 12h

```typescript
// 认证中间件示例
socket.on('AUTHENTICATE', async (token, callback) => {
    const player = await authService.verifyJWT(token);
    (socket as any).playerId = player.id;
    callback({ success: true });
});

// 权限检查示例
socket.on('CONTROL_CHARACTER', (characterId, action) => {
    if (!authService.controlsActor(socket.playerId, characterId)) {
        throw new Error('Unauthorized');
    }
    // ... 处理动作
});
```

### #2: 战斗引擎 (CR-005+CR-007+CR-008)
**当前**: 核心事件循环不完整，无法完整运行战斗  
**修复**: 完整实现processQueue和生命周期管理  
**影响**: 整个游戏可玩性  
**工作量**: 17h

```typescript
// 完整的事件处理循环
async processQueue(): Promise<void> {
    while (this.eventQueue.size > 0 && !this.isOver()) {
        const events = this.eventQueue.dequeueByTick(this.currentTick);
        const clashes = ClashPool.resolve(events);
        for (const clash of clashes) {
            await this.resolveClash(clash);
        }
    }
    this.emit('COMBAT_END', result);
}
```

---

## 📊 工作量分布图

```
优先级分布:
🔴 Critical (52h) ████████████████████░░░░░░
🟡 High     (51h) ████████████████████░░░░░░
🟢 Medium   (38h) ███████████████░░░░░░░░░░░
🟣 Low      (17h) ███████░░░░░░░░░░░░░░░░░░░

按模块分布:
后端引擎  (64h) █████████████████████░░░░░░░
网络      (18h) ██████░░░░░░░░░░░░░░░░░░░░
前端      (25h) █████████░░░░░░░░░░░░░░░░░░
数据库    (8h)  ███░░░░░░░░░░░░░░░░░░░░░░░░
业务逻辑  (7h)  ██░░░░░░░░░░░░░░░░░░░░░░░░░
测试      (7h)  ██░░░░░░░░░░░░░░░░░░░░░░░░░
基础设施  (2h)  █░░░░░░░░░░░░░░░░░░░░░░░░░░
```

---

## 🚀 快速查询指南

### 按文件查询

**packages/backend/src/network/SocketServer.ts** (7个问题, 22h)
- CR-002: 无认证 (12h)
- CR-003: CORS过宽 (2h)
- CR-004: 无权限检查 (3h)
- HP-006: disconnect不完整 (3h)
- MP-009: 无速率限制 (2h)
- MP-010: 无错误回调 (1h)
- LP-009: 无加密 (3h)

**packages/backend/src/campaigns/engines/CombatEngine.ts** (4个问题, 18h)
- CR-005: processQueue不完整 (8h)
- CR-007: 动作取消O(n) (5h)
- CR-008: 缺少并发控制 (4h)
- MP-008: currentTick无上界 (1h)

**packages/backend/src/core/systems/EffectSystem.ts** (4个问题, 10h)
- HP-010: APPLY_BUFF未实现 (4h)
- HP-011: 条件判定未使用 (2h)
- MP-006: 缺少效果链 (3h)
- LP-002: 护盾缺失 (2h)

**packages/frontend/src/canvas/RendererManager.ts** (5个问题, 10h)
- HP-016: 无Culling优化 (4h)
- MP-015: 无摄像头系统 (3h)
- MP-016: 每帧更新所有实体 (2h)
- MP-017: Phantom逻辑欠缺 (1h)

---

## 📞 常见问题解答

### Q: 最少要花多少时间才能让游戏可玩？
**A**: 最少需要完成所有7个Critical问题 (34h ≈ 1周)

### Q: 哪个问题最紧急？
**A**: CR-002 (SocketServer认证) 和 CR-005 (CombatEngine.processQueue)

### Q: 可以并行处理哪些问题？
**A**: 
- 后端引擎问题可与网络层问题并行
- 前端问题与后端问题完全独立
- 测试可在修复时并行编写

### Q: 什么时候应该停下来做测试？
**A**: 所有Critical问题完成后立即开始集成测试

---

**最后更新**: 2026年4月30日
