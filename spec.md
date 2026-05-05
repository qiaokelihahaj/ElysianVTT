# ElysianVTT - 功能规格

## Feature 1: Tick 战斗引擎（MVP 核心）

### 需求
1. 二叉最小堆优先队列驱动事件循环，按 targetTick 排序
2. 三阶段动作系统：STARTUP → ACTIVE → RECOVERY
3. 墓碑删除机制（取消事件标记 CANCELLED，惰性丢弃）
4. Clash Pool：同 Tick 并发事件同时结算
5. 数据驱动规则计算（伤害公式、掷骰表达式通过 mathjs 安全求值）

### 数据模型
- PriorityQueue<T>：最小堆实现
- ActionEvent：{ actionId, actorId, targetTick, phase, payload, status }
- CombatState：{ entities, events, tick, clashPool }
- StateMutationPayload：增量状态变更

### 业务逻辑
- 循环：弹出堆顶事件 → 推进时间 → 执行阶段 → 生成后续事件 → 广播差异
- 被打断的事件在 ACTIVE 阶段之前取消
- RECOVERY 阶段不可打断

## Feature 2: 权限系统

### 需求
1. 基于角色的权限矩阵（RBAC）
2. 权限快照与变更追踪
3. 接口级权限校验
4. 数据级权限过滤

### API 规格
- `POST /api/permissions/check` — 权限校验
- `GET /api/permissions/snapshot/:userId` — 用户权限快照
- `POST /api/permissions/grant` — 授权
- `DELETE /api/permissions/revoke` — 撤销

### 数据模型
- PermissionGrant：{ userId, roleId, resourceId, actions[] }
- PermissionSnapshot：{ userId, grants, timestamp }
- 权限矩阵表：角色 × 资源 × 操作

## Feature 3: 网络协议与状态同步

### 需求
1. WebSocket 实时双向通信（Socket.io）
2. 意图驱动动作提交（客户端不直接修改状态）
3. 增量状态广播（StateMutationPayload）
4. 可见性过滤（VisibilityFilter，按玩家视野裁剪）
5. 房间管理（Scene room）

### 协议事件
| 事件 | 方向 | 说明 |
|------|------|------|
| JOIN_SCENE | client→server | 加入场景房间 |
| CLIENT_INTENT | client→server | 动作意图提交 |
| STATE_MUTATED | server→client | 增量状态推送 |
| VISUAL_FX | server→client | 视觉/动画事件 |

## Feature 4: 多模态场景管理

### 需求
1. 一个 Scene 可承载多个引擎实例（CombatEngine + ExploreEngine）
2. CombatEngine：Tick 驱动，严格一致性
3. ExploreEngine：即时结算，无时间轴
4. 实体可动态挂载切换引擎（无缝切战）

### 数据模型
- Scene：{ id, name, engines[], entities[] }
- Engine：{ type: 'combat' | 'explore', entities[], state }

## Feature 5: 认证与用户系统

### 需求
1. 用户注册/登录
2. 会话管理（JWT）
3. 角色绑定

### API 规格
- `POST /api/auth/register` — 注册
- `POST /api/auth/login` — 登录
- `POST /api/auth/refresh` — 刷新令牌
- `GET /api/auth/me` — 当前用户信息
