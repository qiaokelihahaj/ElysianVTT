# ElysianVTT - 实现计划

## Phase 1: MVP 可玩战斗核心

- [x] PriorityQueue 最小堆实现
- [x] TickLoop 事件循环引擎
- [x] 三阶段动作系统（STARTUP/ACTIVE/RECOVERY）
- [x] CombatSystem（伤害/治疗/增益计算）
- [x] RuleEvaluator（mathjs 表达式求值）
- [x] 基础实体类（Actor, Projectile）
- [x] 骰子系统（dice/）
- [x] EffectSystem（DAMAGE, HEAL, APPLY_BUFF）
- [x] SocketServer + IntentRouter
- [x] StateBroadcaster（增量广播）
- [ ] ClashPool 并发结算（规划中）
- [ ] 完整的 PUSH/INTERRUPT 效果
- [ ] 前端 PixiJS 渲染集成
- [ ] 前端 Zustand 状态树与后端同步

## Phase 2: 多引擎分离

- [ ] ExploreEngine（即时结算，无 Tick）
- [ ] Scene 多引擎挂载管理
- [ ] 实体动态引擎切换（无缝切战）
- [ ] SettlementService 战斗结算（经验/战利品持久化）

## Phase 3: 空间系统

- [ ] SpatialSystem（坐标/距离/范围）
- [ ] 弹道系统（Projectile 轨迹）
- [ ] 射线检测（Ray/AABB 相交）
- [ ] 边界事件（进入/离开区域触发）
- [ ] VisibilityFilter 优化

## Phase 4: 完整效果系统

- [ ] PUSH（击退/位移）
- [ ] INTERRUPT（打断判定逻辑）
- [ ] 完整 Clash Pool（并发冲突解决策略）
- [ ] 增强表达式语法（条件/分支）

## Phase 5: 扩展（可选）

- [ ] DSL/脚本语言支持
- [ ] MOD 加载器
- [ ] 自定义规则包

## 依赖关系

- Phase 2 依赖 Phase 1（基础引擎完成）
- Phase 3 依赖 Phase 2（引擎分离后空间系统接入）
- Phase 4 依赖 Phase 1 + Phase 3（效果系统需要空间系统配合）
- Phase 5 独立可选

## 当前状态

Phase 1 核心引擎大部分已完成，ClashPool 和前端渲染集成仍在进行中。优先完成 ClashPool 并发结算和前端 PixiJS 渲染管线。
