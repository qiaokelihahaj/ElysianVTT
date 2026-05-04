# ElysianVTT 完整问题清单（去重统一版）

**生成日期**: 2026年4月30日  
**来源报告**: CODE_REVIEW.md、CODE_REVIEW_COMPREHENSIVE.md、CODE_REVIEW_ISSUES_DETAILED.md、CODE_REVIEW_QUICK_REFERENCE.md、CODE_REVIEW_AGENT1_REPORT.md、CODE_REVIEW_AGENT2_REPORT.md  
**总问题数**: 53个（已移除已修复项）

---

## 📊 问题统计

| 优先级 | 问题数 | 总工作量 | 状态 |
|--------|--------|---------|------|
| 🔴 Critical | 7 | 34h | 本周必须完成 |
| 🟡 High Priority | 17 | 50h | 第一周处理 |
| 🟢 Medium Priority | 19 | 28h | 第二周处理 |
| 🟣 Low Priority | 10 | 12h | 可选优化 |
| **总计** | **53** | **124h** | - |

---

# 第一类：关键问题（Critical Issues）🔴

必须立即解决，否则MVP Phase 1无法完成或存在严重安全风险

## CR-002: Socket 无玩家认证机制
- **模块**: 网络安全
- **文件**: [packages/backend/src/network/SocketServer.ts](packages/backend/src/network/SocketServer.ts)
- **优先级**: 🔴 CRITICAL
- **问题描述**: 后端完全信任客户端自报身份，任何人可以伪造任意玩家身份连接并控制任意角色。缺少JWT/OAuth认证
- **影响范围**: 所有网络通信、安全边界被打破
- **工作量**: 12h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_AGENT1_REPORT.md, CODE_REVIEW_AGENT2_REPORT.md
- **详细位置**: 
  - [SocketServer.ts:19](packages/backend/src/network/SocketServer.ts#L19) - CORS配置
  - [SocketServer.ts:39](packages/backend/src/network/SocketServer.ts#L39) - 无认证处理

## CR-003: SocketServer CORS 过于宽松
- **模块**: 网络安全
- **文件**: [packages/backend/src/network/SocketServer.ts](packages/backend/src/network/SocketServer.ts)
- **优先级**: 🔴 CRITICAL
- **问题描述**: `cors: { origin: '*' }` 允许任意来源的跨域请求，生产环境存在XSS/CSRF风险
- **影响范围**: 跨域安全
- **工作量**: 2h (与CR-002合并处理)
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_QUICK_REFERENCE.md, CODE_REVIEW_AGENT1_REPORT.md
- **修复示例**: 限制到 `['http://localhost:5173', 'https://elysianimvtt.com']`

## CR-004: Socket 无权限检查
- **模块**: 网络安全
- **文件**: [packages/backend/src/network/SocketServer.ts](packages/backend/src/network/SocketServer.ts)
- **优先级**: 🔴 CRITICAL
- **问题描述**: 客户端可以声称控制任意角色，无验证玩家是否拥有该角色的权限检查
- **影响范围**: 玩家可以控制他人角色
- **工作量**: 3h (与CR-002合并处理)
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_AGENT2_REPORT.md
- **详细位置**: [SocketServer.ts:77](packages/backend/src/network/SocketServer.ts#L77)

## CR-005: CombatEngine.processQueue() 实现不完整
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/campaigns/engines/CombatEngine.ts](packages/backend/src/campaigns/engines/CombatEngine.ts)
- **优先级**: 🔴 CRITICAL
- **问题描述**: 主事件处理循环代码被截断或不完整，引擎无法完整运行完整的战斗流程。缺少：processQueue()完整实现、resolveClash()实现、战斗结束检查
- **影响范围**: 整个战斗引擎核心逻辑
- **工作量**: 8h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_ISSUES_DETAILED.md, CODE_REVIEW_AGENT1_REPORT.md
- **相关问题**: 依赖ClashPool的resolveClash()实现

## CR-007: CombatEngine 动作取消性能问题 O(n)
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/campaigns/engines/CombatEngine.ts](packages/backend/src/campaigns/engines/CombatEngine.ts)
- **优先级**: 🔴 CRITICAL
- **问题描述**: cancelCurrentAction()通过遍历整个堆查找事件（O(n)复杂度），大量动作时会导致严重性能下降
- **影响范围**: 玩家取消动作时卡顿，多玩家场景明显
- **工作量**: 5h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_ISSUES_DETAILED.md
- **解决方案**: 维护事件ID到堆索引的映射，转为O(1)查询

## CR-008: CombatEngine 缺少并发控制
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/campaigns/engines/CombatEngine.ts](packages/backend/src/campaigns/engines/CombatEngine.ts)
- **优先级**: 🔴 CRITICAL
- **问题描述**: 多个客户端同时操作同一场景时无同步和竞态条件保护
- **影响范围**: 多玩家交互数据不一致
- **工作量**: 4h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_ISSUES_DETAILED.md
- **相关问题**: CR-005依赖

## CR-009: VisibilityFilter 文件为空
- **模块**: 网络 / 可见性系统
- **文件**: [packages/backend/src/network/VisibilityFilter.ts](packages/backend/src/network/VisibilityFilter.ts)
- **优先级**: 🔴 CRITICAL
- **问题描述**: 完全缺失战争迷雾(FoW)和视线(LoS)实现，无法隐藏玩家不应该看到的信息（隐身、GM隐藏的敌人等）
- **影响范围**: 游戏规则完整性、隐身等机制无法实现
- **工作量**: 8h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_AGENT1_REPORT.md, CODE_REVIEW_AGENT2_REPORT.md
- **是否为空文件**: 是
- **需要实现**: isInLineOfSight()、filterMutation()、Bresenham视线算法

---

# 第二类：高优先级问题（High Priority Issues）🟡

第一周内应该完成，影响功能完整性或引发隐性bug

## HP-001: IntentRouter 文件为空
- **模块**: 网络
- **文件**: [packages/backend/src/network/IntentRouter.ts](packages/backend/src/network/IntentRouter.ts)
- **优先级**: 🟡 HIGH
- **问题描述**: 应该处理意图的路由和验证逻辑，当前为空，逻辑混在SocketServer中
- **影响范围**: 代码组织，职责不清
- **工作量**: 4h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_ISSUES_DETAILED.md, CODE_REVIEW_AGENT1_REPORT.md
- **是否为空文件**: 是

## HP-002: StateBroadcaster 文件为空
- **模块**: 网络
- **文件**: [packages/backend/src/network/StateBroadcaster.ts](packages/backend/src/network/StateBroadcaster.ts)
- **优先级**: 🟡 HIGH
- **问题描述**: 应该管理状态广播到客户端的逻辑，当前为空，逻辑混在CampaignManager中
- **影响范围**: 代码组织，职责不清
- **工作量**: 3h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_AGENT1_REPORT.md
- **是否为空文件**: 是

## HP-003: Repository 文件为空
- **模块**: 数据库抽象层
- **文件**: [packages/backend/src/db/Repository.ts](packages/backend/src/db/Repository.ts)
- **优先级**: 🟡 HIGH
- **问题描述**: 应该提供通用的数据库访问抽象，当前为空，直接使用Prisma
- **影响范围**: 代码复用性低，测试困难
- **工作量**: 3h
- **在报告中出现**: CODE_REVIEW_AGENT2_REPORT.md
- **是否为空文件**: 是

## HP-004: CampaignManager 缺少引擎生命周期管理
- **模块**: 业务逻辑
- **文件**: [packages/backend/src/campaigns/CampaignManager.ts](packages/backend/src/campaigns/CampaignManager.ts)
- **优先级**: 🟡 HIGH
- **问题描述**: 引擎实例在Map中永久存储，没有过期清理或销毁机制。长时间运行会导致内存泄漏，事件监听器累积
- **影响范围**: 内存泄漏、性能下降
- **工作量**: 3h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_AGENT1_REPORT.md, CODE_REVIEW_AGENT2_REPORT.md

## HP-006: Socket disconnect 处理不完整
- **模块**: 网络
- **文件**: [packages/backend/src/network/SocketServer.ts](packages/backend/src/network/SocketServer.ts)
- **优先级**: 🟡 HIGH
- **问题描述**: 客户端掉线时只记录日志，没有实现"幽灵玩家"清理、角色离线持久化等逻辑
- **影响范围**: 掉线玩家的角色无法恢复
- **工作量**: 3h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_ISSUES_DETAILED.md
- **需要实现**: handlePlayerDisconnect()

## HP-007: ClashPool tolerance 硬编码
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/engine/ClashPool.ts](packages/backend/src/core/engine/ClashPool.ts)
- **优先级**: 🟡 HIGH
- **问题描述**: `tolerance: number = 2.0` 硬编码在代码中，无法通过配置调整冲突判定的灵敏度
- **影响范围**: 游戏平衡无法配置
- **工作量**: 1h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_ISSUES_DETAILED.md
- **修复**: 从Config或environment读取

## HP-008: ClashPool 缺少死亡检查
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/engine/ClashPool.ts](packages/backend/src/core/engine/ClashPool.ts)
- **优先级**: 🟡 HIGH
- **问题描述**: 当目标在冲突结算过程中已经死亡时，仍然会受到多次伤害。应该在resolveGroup()中检查目标血量
- **影响范围**: 同时攻击同一目标时可能多次计算伤害
- **工作量**: 2h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_ISSUES_DETAILED.md

## HP-009: RuleEvaluator 缺少表达式编译缓存
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/systems/RuleEvaluator.ts](packages/backend/src/core/systems/RuleEvaluator.ts)
- **优先级**: 🟡 HIGH
- **问题描述**: 重复的表达式（如伤害计算公式）每次都重新编译，浪费CPU。应该缓存编译结果
- **影响范围**: 性能下降15-20%
- **工作量**: 3h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_ISSUES_DETAILED.md

## HP-010: EffectSystem APPLY_BUFF 未实现
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/systems/EffectSystem.ts](packages/backend/src/core/systems/EffectSystem.ts)
- **优先级**: 🟡 HIGH
- **问题描述**: APPLY_BUFF效果类型只记录日志，没有实际的Buff挂载逻辑。需要实现：向Entity.activeEffects追加、残余Tick计算、Buff过期检测
- **影响范围**: Buff系统完全不工作
- **工作量**: 4h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_ISSUES_DETAILED.md, CODE_REVIEW_AGENT2_REPORT.md

## HP-011: EffectSystem 条件判定未使用
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/systems/EffectSystem.ts](packages/backend/src/core/systems/EffectSystem.ts)
- **优先级**: 🟡 HIGH
- **问题描述**: ActionEffectPayload.conditions字段定义了但在executeEffect()中被忽略，条件效果无法工作
- **影响范围**: 条件技能（如"仅对生物有效"）无法实现
- **工作量**: 2h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_ISSUES_DETAILED.md, CODE_REVIEW_AGENT2_REPORT.md

## HP-012: SpatialSystem 缺少碰撞检测
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/systems/SpatialSystem.ts](packages/backend/src/core/systems/SpatialSystem.ts)
- **优先级**: 🟡 HIGH
- **问题描述**: planMovement()直接从起点步向目标，不检查路径上是否有障碍物或其他单位，导致单位可以穿过墙或其他实体
- **影响范围**: 移动系统不现实
- **工作量**: 4h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_ISSUES_DETAILED.md

## HP-013: SpatialSystem 缺少寻路逻辑
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/systems/SpatialSystem.ts](packages/backend/src/core/systems/SpatialSystem.ts)
- **优先级**: 🟡 HIGH
- **问题描述**: 无A*或Dijkstra实现，无法规划障碍物周围的最优路径
- **影响范围**: 复杂地图上无法移动
- **工作量**: 5h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_ISSUES_DETAILED.md

## HP-014: GameStore 缺少entityId验证
- **模块**: 前端
- **文件**: [packages/frontend/src/store/gameStore.ts](packages/frontend/src/store/gameStore.ts)
- **优先级**: 🟡 HIGH
- **问题描述**: applyStateMutation()中没有检查entityId是否存在，可能导致应用无法预料的状态变化或崩溃
- **影响范围**: 崩溃风险
- **工作量**: 1h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md

## HP-015: SocketClient 缺少自动重连
- **模块**: 前端
- **文件**: [packages/frontend/src/network/socketClient.ts](packages/frontend/src/network/socketClient.ts)
- **优先级**: 🟡 HIGH
- **问题描述**: 网络断开后没有自动重连机制，网络抖动或临时断线会导致完全断开
- **影响范围**: 网络稳定性差
- **工作量**: 3h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md

## HP-016: RendererManager 缺少性能优化(Culling)
- **模块**: 前端
- **文件**: [packages/frontend/src/canvas/RendererManager.ts](packages/frontend/src/canvas/RendererManager.ts)
- **优先级**: 🟡 HIGH
- **问题描述**: 没有视锥剔除(Culling)，屏幕外的对象也被渲染，大量实体时FPS严重下降
- **影响范围**: 性能
- **工作量**: 4h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_AGENT1_REPORT.md

## HP-017: 数据库缺少关键表
- **模块**: 数据库
- **文件**: [packages/backend/prisma/schema.prisma](packages/backend/prisma/schema.prisma)
- **优先级**: 🟡 HIGH
- **问题描述**: 缺少Player、Scene、BattleLog、AppliedEffect、Inventory等关键表，影响玩家管理、战斗历史记录、物品系统
- **影响范围**: 功能无法完整
- **工作量**: 4h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_AGENT1_REPORT.md
- **需要添加**: Player、BattleLog、AppliedEffect、Inventory、 索引、JSON Schema验证

## HP-018: Scene 文件为空
- **模块**: 业务逻辑
- **文件**: [packages/backend/src/campaigns/Scene.ts](packages/backend/src/campaigns/Scene.ts)
- **优先级**: 🟡 HIGH
- **问题描述**: 场景管理类未实现
- **影响范围**: 场景管理不完整
- **工作量**: 2h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_AGENT1_REPORT.md
- **是否为空文件**: 是

---

# 第三类：中等优先级问题（Medium Priority Issues）🟢

第二周或后续处理，改进代码质量和性能

## MP-001: PriorityQueue 缺少堆序列化能力
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/engine/PriorityQueue.ts](packages/backend/src/core/engine/PriorityQueue.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: 缺少toArray()和isValid()方法，调试困难，无法导出堆状态用于调试或回放
- **影响范围**: 可维护性
- **工作量**: 2h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_ISSUES_DETAILED.md

## MP-002: PriorityQueue 没有 buildHeap() 快速初始化
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/engine/PriorityQueue.ts](packages/backend/src/core/engine/PriorityQueue.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: 批量添加N个元素时O(n log n)，应该支持O(n)的buildHeap()
- **影响范围**: 性能
- **工作量**: 2h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_ISSUES_DETAILED.md

## MP-003: RuleEvaluator DICE_REGEX 不规范
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/systems/RuleEvaluator.ts](packages/backend/src/core/systems/RuleEvaluator.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: 不必要的 `DICE_REGEX.lastIndex = 0` 赋值，应该每次创建新的RegExp实例
- **影响范围**: 代码风格
- **工作量**: 0.5h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_ISSUES_DETAILED.md

## MP-004: RuleEvaluator 异常处理过于通用
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/systems/RuleEvaluator.ts](packages/backend/src/core/systems/RuleEvaluator.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: 表达式求值失败时直接返回0，无区分"解析错误"还是"运行时错误"，调试困难
- **影响范围**: 调试难度
- **工作量**: 1h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_ISSUES_DETAILED.md

## MP-005: RuleEvaluator 缺少递归深度限制
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/systems/RuleEvaluator.ts](packages/backend/src/core/systems/RuleEvaluator.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: 没有限制表达式长度或复杂度，可能被DoS攻击（无限递归或非常长的表达式）
- **影响范围**: 安全
- **工作量**: 2h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_ISSUES_DETAILED.md

## MP-006: EffectSystem 缺少效果链支持
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/systems/EffectSystem.ts](packages/backend/src/core/systems/EffectSystem.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: 当一个效果被应用时，无法级联触发其他效果（如"击中时造成DOT"）
- **影响范围**: 复杂技能设计
- **工作量**: 3h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_ISSUES_DETAILED.md

## MP-007: SpatialSystem stepSize与游戏单位不对应
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/systems/SpatialSystem.ts](packages/backend/src/core/systems/SpatialSystem.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: stepSize参数与实际游戏单位制不统一，距离计算不准确
- **影响范围**: 移动的真实感
- **工作量**: 1h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_ISSUES_DETAILED.md

## MP-008: CombatEngine currentTick 无上界
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/campaigns/engines/CombatEngine.ts](packages/backend/src/campaigns/engines/CombatEngine.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: currentTick可能无限增长，长时间运行会导致整数溢出
- **影响范围**: 长期运行稳定性
- **工作量**: 1h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_ISSUES_DETAILED.md

## MP-009: SocketServer 没有速率限制
- **模块**: 网络
- **文件**: [packages/backend/src/network/SocketServer.ts](packages/backend/src/network/SocketServer.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: 恶意客户端可以发送大量CLIENT_INTENT造成DDoS
- **影响范围**: 安全
- **工作量**: 2h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_ISSUES_DETAILED.md

## MP-010: SocketServer CLIENT_INTENT 缺少错误回调
- **模块**: 网络
- **文件**: [packages/backend/src/network/SocketServer.ts](packages/backend/src/network/SocketServer.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: 意图处理失败时没有通知客户端，导致客户端不知道命令是否成功
- **影响范围**: UX
- **工作量**: 1h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_ISSUES_DETAILED.md

## MP-011: GameStore 缺少乐观更新回滚
- **模块**: 前端
- **文件**: [packages/frontend/src/store/gameStore.ts](packages/frontend/src/store/gameStore.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: 如果网络请求失败，本地乐观更新无法回滚，导致UI和服务器状态不一致
- **影响范围**: 网络延迟时UI卡顿
- **工作量**: 3h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_AGENT1_REPORT.md

## MP-012: GameStore movementTargets 字段用途不清
- **模块**: 前端
- **文件**: [packages/frontend/src/store/gameStore.ts](packages/frontend/src/store/gameStore.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: movementTargets字段的含义和使用方式不清楚，缺少文档
- **影响范围**: 可维护性
- **工作量**: 1h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md

## MP-013: SocketClient 缺少连接状态查询
- **模块**: 前端
- **文件**: [packages/frontend/src/network/socketClient.ts](packages/frontend/src/network/socketClient.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: 无isConnected()方法，UI无法显示连接状态
- **影响范围**: UX
- **工作量**: 1h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_AGENT1_REPORT.md

## MP-014: SocketClient 缺少心跳检测
- **模块**: 前端
- **文件**: [packages/frontend/src/network/socketClient.ts](packages/frontend/src/network/socketClient.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: 无心跳机制检测僵尸连接，导致网络断开但本地认为仍连接
- **影响范围**: 网络可靠性
- **工作量**: 1h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md

## MP-015: RendererManager 缺少摄像头系统
- **模块**: 前端
- **文件**: [packages/frontend/src/canvas/RendererManager.ts](packages/frontend/src/canvas/RendererManager.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: 渲染器宽高固定，无缩放、平移等摄像头控制
- **影响范围**: 游戏体验
- **工作量**: 3h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_AGENT1_REPORT.md

## MP-016: RendererManager 每帧更新所有实体
- **模块**: 前端
- **文件**: [packages/frontend/src/canvas/RendererManager.ts](packages/frontend/src/canvas/RendererManager.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: 没有脏标记机制，即使静止的实体也被每帧重新计算，浪费CPU
- **影响范围**: 性能
- **工作量**: 2h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_AGENT1_REPORT.md

## MP-017: RendererManager Phantom逻辑欠缺
- **模块**: 前端
- **文件**: [packages/frontend/src/canvas/RendererManager.ts](packages/frontend/src/canvas/RendererManager.ts)
- **优先级**: 🟢 MEDIUM
- **问题描述**: 移动预览(phantomHero)的更新逻辑不完整
- **影响范围**: 移动预览不准确
- **工作量**: 1h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_AGENT1_REPORT.md

## MP-018: 缺少集成测试
- **模块**: 测试
- **文件**: [test/](test/)
- **优先级**: 🟢 MEDIUM
- **问题描述**: 无完整战斗流程的集成测试，无法验证从意图到结算的完整链路
- **影响范围**: 无法验证系统完整性
- **工作量**: 4h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_ISSUES_DETAILED.md, CODE_REVIEW_QUICK_REFERENCE.md

## MP-019: 缺少并发和性能测试
- **模块**: 测试
- **文件**: [test/](test/)
- **优先级**: 🟢 MEDIUM
- **问题描述**: 缺少并发竞态条件测试、性能压力测试
- **影响范围**: 无法发现多玩家场景的bug
- **工作量**: 3h
- **在报告中出现**: CODE_REVIEW.md, CODE_REVIEW_COMPREHENSIVE.md, CODE_REVIEW_ISSUES_DETAILED.md, CODE_REVIEW_QUICK_REFERENCE.md

---

# 第四类：低优先级问题（Low Priority Issues）🟣

可选优化，改进边界情况或代码质量

## LP-001: ClashPool groupByPriority() 内存分配低效
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/engine/ClashPool.ts](packages/backend/src/core/engine/ClashPool.ts)
- **优先级**: 🟣 LOW
- **问题描述**: 每次创建新的ClashEvent[]，低效的内存分配
- **工作量**: 1h

## LP-002: EffectSystem 护盾等中间层缺失
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/systems/EffectSystem.ts](packages/backend/src/core/systems/EffectSystem.ts)
- **优先级**: 🟣 LOW
- **问题描述**: DAMAGE时缺少护盾计算，伤害计算不完整
- **工作量**: 2h

## LP-003: PriorityQueue 缺少越界保护日志
- **模块**: 后端核心引擎
- **文件**: [packages/backend/src/core/engine/PriorityQueue.ts](packages/backend/src/core/engine/PriorityQueue.ts)
- **优先级**: 🟣 LOW
- **问题描述**: _siftUp/_siftDown没有边界日志，隐蔽的边界问题难以发现
- **工作量**: 0.5h

## LP-004: GameCanvas 缺少错误边界
- **模块**: 前端
- **文件**: [packages/frontend/src/canvas/GameCanvas.tsx](packages/frontend/src/canvas/GameCanvas.tsx)
- **优先级**: 🟣 LOW
- **问题描述**: 没有React ErrorBoundary，渲染错误会导致整个应用崩溃
- **工作量**: 1h

## LP-005: GameCanvas 没有加载状态
- **模块**: 前端
- **文件**: [packages/frontend/src/canvas/GameCanvas.tsx](packages/frontend/src/canvas/GameCanvas.tsx)
- **优先级**: 🟣 LOW
- **问题描述**: 初始化状态不清晰，用户不知道游戏是否在加载
- **工作量**: 1h

## LP-006: 数据库缺少索引
- **模块**: 数据库
- **文件**: [packages/backend/prisma/schema.prisma](packages/backend/prisma/schema.prisma)
- **优先级**: 🟣 LOW
- **问题描述**: Character、Scene等表缺少查询索引
- **工作量**: 1h

## LP-007: 数据库无JSON Schema验证
- **模块**: 数据库
- **文件**: [packages/backend/prisma/schema.prisma](packages/backend/prisma/schema.prisma)
- **优先级**: 🟣 LOW
- **问题描述**: 动态JSON字段缺少类型验证，脏数据风险
- **工作量**: 2h

## LP-008: 数据库缺少时间戳
- **模块**: 数据库
- **文件**: [packages/backend/prisma/schema.prisma](packages/backend/prisma/schema.prisma)
- **优先级**: 🟣 LOW
- **问题描述**: 多数表缺少createdAt/updatedAt，审计困难
- **工作量**: 1h

## LP-009: Socket 没有消息加密
- **模块**: 网络
- **优先级**: 🟣 LOW
- **问题描述**: Socket通信未加密，敏感数据(角色位置、技能等)在网络上暴露
- **工作量**: 3h

## LP-010: Logger日志聚合缺失
- **模块**: 基础设施
- **优先级**: 🟣 LOW
- **问题描述**: 日志仅输出到控制台，无聚合或持久化
- **工作量**: 2h

---

## 📋 按优先级的工作量统计

| 优先级 | 问题数 | 总工作量 | 建议完成时间 |
|--------|--------|---------|------------|
| 🔴 Critical | 11 | 52h | 本周(5天) |
| 🟡 High | 18 | 51h | 第2周(5天) |
| 🟢 Medium | 19 | 38h | 第3周(5天) |
| 🟣 Low | 10 | 17h | 可选 |
| **总计** | **58** | **158h** | **3-4周** |

---

## 📅 建议实施计划

### 第1周（Critical Issues - 52h）
**优先顺序**:
1. CR-002/003/004: SocketServer安全修复 (12h)
2. CR-005/007/008: CombatEngine修复 (17h)
4. CR-009: VisibilityFilter实现 (8h)

### 第2周（High Priority - 51h）
**优先顺序**:
1. HP-001/002/003: IntentRouter/StateBroadcaster/Repository (10h)
2. HP-004/005: CampaignManager修复 (4h)
3. HP-006/007/008: ClashPool修复 (6h)
4. HP-009/010/011: EffectSystem完善 (10h)
5. HP-012/013/014: SpatialSystem修复 (11h)
6. HP-015/016/017/018: 前端和数据库修复 (10h)

### 第3周+（Medium Priority - 38h）
可以并行进行代码质量改进和测试实现。

---

## 🔍 验证清单

使用此清单验证所有修复：

- [ ] CR-002/003/004 SocketServer 实现完整的认证、权限检查、CORS限制
- [ ] CR-005/007/008 CombatEngine processQueue完整实现、取消优化、并发控制
- [ ] CR-009 VisibilityFilter 实现FoW和LoS机制
- [ ] HP-001-018 所有高优先级问题修复
- [ ] 所有关键代码移除 `as any` 类型转换
- [ ] 添加关键表和索引到数据库
- [ ] 编写集成测试覆盖完整战斗流程
- [ ] 性能测试验证优化效果

---

**生成日期**: 2026年4月30日  
**总问题数**: 58（去重后）  
**总工作量**: 158小时  
**建议周期**: 3-4周完成所有Critical和High Priority问题
