# ElysianVTT 认证边界设计

> 状态：提案，尚未实施（2026-09-07）。本文只定义后续迁移边界，不改变运行时代码、数据库或测试。
>
> 依据：当前 TS/TSX 源码优先；`docs/AUTHENTICATION_HANDSHAKE.md` 是阶段性快照，和源码冲突时以源码为准。

## 目标与决策

认证只回答“这个请求属于哪个用户和哪个会话”。授权再回答“该用户在某个战役/场景中能做什么、能控制什么、能看到什么”。任何客户端传入的 `role`、`sceneId`、`actorId` 都是待校验的输入，不是授权事实。

本提案面向当前的自托管、单 Node 进程、SQLite 应用，目标是先建立可撤销、可测试的边界，不引入 OAuth、SSO、分布式会话或多租户平台模型。

| 选择 | MVP 结论 |
| --- | --- |
| 凭据 | `loginName + password`；无公开注册，首个账号通过本机 CLI 创建 |
| 密码 | 使用维护良好的 Argon2id 库和参数版本；不保存明文，不自行实现哈希 |
| 会话 | 随机不透明会话密钥，服务端保存哈希和状态；浏览器用 `HttpOnly` Cookie |
| 角色 | 只作为战役/场景成员资格上的角色快照；不作为跨战役的全局通行证 |
| Socket | Origin 校验、会话认证、每条消息授权；撤销或过期后立即退出房间并停止敏感出站 |
| 生命周期 | 绝对过期 1 小时，MVP 不发 refresh token；过期后重新登录 |

## 当前事实（以源码为准）

### HTTP、认证和权限

- `createApp()` 只把两个本地前端 Origin 放入 CORS，并开启 credentials：`packages/backend/src/app.ts:13-20`。Socket 的 Origin 来自另一个环境变量和默认列表：`packages/backend/src/network/SocketServer.ts:33-43`，两处尚未统一。
- `POST /auth/login` 接受客户端的 `userId` 和可选 `role`，随后原样交给 `AuthenticationService.login()`：`packages/backend/src/app.ts:24-40`。当前请求不校验密码或数据库用户。
- `POST /auth/logout` 只接受请求体中的 `sessionId`，然后撤销该 ID：`packages/backend/src/app.ts:58-72`。调用者不需要证明自己拥有该会话。
- `/permissions/me` 和 `/logs` 从 query string 读取 token：`packages/backend/src/app.ts:89-120`、`168-232`。日志接口还按客户端给出的 `sceneId` 构造 `allowedSceneIds`：`packages/backend/src/app.ts:215-221`；可见性过滤是在查询后进行的。
- `/permissions/grant` 和 `/permissions/revoke` 只检查 token 内的 `role === 'GM'`：`packages/backend/src/app.ts:262-279`、`304-321`。这里没有战役/场景成员资格边界。
- `PermissionGrantRepository.getActiveGrantsForUser()` 只按用户、撤销时间和过期时间筛选：`packages/backend/src/db/PermissionGrantRepository.ts:51-66`；调用方会把用户的全部实体授权和能力汇入当前主体，尚未按战役/场景收窄。
- `AuthenticationService` 的 token 接口本身包含 `userId`、`role`、`sessionId`、过期时间和版本：`packages/backend/src/auth/AuthenticationService.ts:5-12`。实现使用环境变量或固定回退值的 `JWT_SECRET`、进程内 `SESSION_POOL`：`45-47`。
- 当前登录会从请求写入任意 `userId/role`，并把自定义编码字符串保存到内存会话：`packages/backend/src/auth/AuthenticationService.ts:49-89`。它不是标准 JWT；编码、截断 HMAC 和 `Math.random()` 生成的会话 ID 位于 `139-175`。
- `verify()` 会检查内存会话、`revokedAt`、token 的 `expiresAt` 和版本：`packages/backend/src/auth/AuthenticationService.ts:92-120`；`revoke()` 只标记进程内 Map：`123-133`。Prisma 的 `Session` 表目前未被该服务使用。
- `PermissionService` 的主体同时包含角色、可控实体、可见实体、允许场景和快照版本：`packages/backend/src/permissions/PermissionService.ts:17-40`。但 `canJoinScene()` 对全局 `GM` 直接返回 true：`131-148`；`authorizeIntent()` 也对 GM 跳过场景和实体控制检查：`151-187`。

### Socket、路由和出站数据

- Socket 建连时只把 `authenticated` 设为 false：`packages/backend/src/network/SocketServer.ts:75-80`。`AUTHENTICATE` 事件从客户端接收 token，认证后把 token 中的用户和角色写入 `socket.data`：`81-147`。
- Socket 认证后从用户的全部 active grants 构造初始快照：`packages/backend/src/network/SocketServer.ts:103-127`。没有在这里绑定战役/场景；`refreshPlayerControlledEntities()` 只按 `role` 汇总控制权，GM 可加入引擎中的全部实体：`54-69`。
- `JOIN_SCENE` 接受客户端的 `sceneId` 和 `actorId`：`packages/backend/src/network/SocketServer.ts:160-205`。它直接创建 `allowedSceneIds: [sceneId]` 的主体，没有调用 `PermissionService.authorizeJoinScene()`；随后把 `engine.getAllEntities()` 原样发给该 socket：`217-229`。
- `IntentRouter` 会检查认证、当前场景、快照、主体、意图格式和 `authorizeIntent()`：`packages/backend/src/network/IntentRouter.ts:25-106`。这是当前最完整的输入授权链，但它只使用已写入 socket 的主体，未在每个事件重新确认会话仍有效。
- `RESYNC` 只检查 `currentSceneId` 后发送全部实体和地图状态：`packages/backend/src/network/SocketServer.ts:300-317`。`DECISION_RESPONSE` 和 `DECISION_ENGAGE` 也只检查当前场景：`319-335`；`GM_FORCE_RESOLVE` 只检查 socket 上的角色：`337-344`。
- `StateBroadcaster` 的状态差分调用 `VisibilityFilter.filterStateMutation(sceneId, payload)`，没有传 viewer：`packages/backend/src/network/StateBroadcaster.ts:105-110`；过滤器没有 viewer 时会原样返回 payload：`packages/backend/src/network/VisibilityFilter.ts:18-23`。
- 多个事件直接使用 `io.to(sceneId).emit()`，包括死亡、Hook、决策、探索事件、视觉效果和动作时间轴：`packages/backend/src/network/StateBroadcaster.ts:46-103`、`112-132`。这些路径没有 session 撤销 guard，也没有逐 socket 的场景/实体可见性过滤。
- 分组广播按 `socket.data.role` 分组，缺省角色为 `OB`：`packages/backend/src/network/StateBroadcaster.ts:144-205`。角色本身不能证明会话未过期、仍是成员或仍可见。
- `VisibilityFilter` 的角色规则让 GM 看到全部实体、状态和日志，PL/OB 依赖 `visibleEntityIds`：`packages/backend/src/network/VisibilityFilter.ts:9-166`。FOV 过滤另有实现：`231-319`；当前出站链路没有把权限过滤和 FOV 过滤统一串起来。

### 持久化、前端和旧文档

- Prisma 已有 `User(loginName, passwordHash, status)`、`Role` 和 `Session(userId, tokenVersion, roleSnapshot, expiresAt, revokedAt, ...)`：`packages/backend/prisma/schema.prisma:50-79`，但没有用户与战役/场景成员关系。
- `PermissionGrant` 有 `scopeType/scopeId/sceneId/expiresAt/revokedAt`：`packages/backend/prisma/schema.prisma:81-94`；`AuditEvent` 和 `PermissionSnapshot` 也已存在：`96-110`、`139-152`。没有外键或枚举约束保证作用域语义。
- `CharacterSheet.currentSceneId` 是实体当前场景字段：`packages/backend/prisma/schema.prisma:39-48`；实体仓库按场景加载战斗实体：`packages/backend/src/db/CharacterSheetRepository.ts:25-44`。`CampaignManager` 当前按字符串 sceneId 在内存中创建引擎：`packages/backend/src/campaigns/CampaignManager.ts:14-69`，持久化层没有 Campaign/Scene 访问控制。
- 前端自动用 `demo_gm/GM` 登录并把 token 放进 `localStorage`：`packages/frontend/src/App.tsx:11-27`；读取优先级是 URL `?token` 再到 localStorage：`29-37`，权限请求也把 token 放进 URL：`40-55`。
- `socketClient` 把 token 放入 `AUTHENTICATE` 事件，认证成功后又由客户端发送 `AUTH_SUCCESS`：`packages/frontend/src/network/socketClient.ts:54-64`；它发送 join、intent、决策等事件不带客户端可验证的权限事实：`66-84`、`184-202`。
- `TestToolbox` 的身份预设公开包含 GM 和多个 PL：`packages/frontend/src/ui/TestToolbox.tsx:22-36`；切换时把客户端选择的 `role` 发给登录端点，并在本地 store 写入 `source: 'local'` 的权限：`135-188`。这些只能保留为开发工具，不能成为生产认证流程。
- `docs/AUTHENTICATION_HANDSHAKE.md:5-19` 描述了“登录 token → Socket AUTHENTICATE → JOIN_SCENE”的顺序，但 `23-31` 仍把客户端 role 放进登录请求，`131-149` 将实现称为 JWT/角色认证；需按本提案和实际代码迁移。

### 测试覆盖事实

- `test/security-suite.runner.ts:8-13` 只执行 `auth.test.ts`、`permission.test.ts`、`visibility-and-logs.test.ts`、`security-regression.test.ts` 四个文件。
- `test/auth.test.ts:120-132` 的过期用例没有推进时钟或等待过期，只断言 `expiresAt` 存在且在未来；它不能证明服务端会拒绝已过期会话。
- `test/permission.test.ts:126-139` 明确把 GM 进入任意场景作为成功断言。迁移到成员资格模型时，这个断言是有意变更的旧语义，不是应继续保留的安全契约。
- `test/security-regression.test.ts` 确实启动真实 HTTP `createApp()`：`19-37`，但登录仍由客户端指定 `role`：`72-76`，权限查询仍使用 URL token：`88-96`，登出仍只传 `sessionId`：`108-125`。它是 HTTP 回归，不是目标认证边界的完整证明。
- `test/socket-e2e.test.ts:1-3` 明确写明绕过真实 `IntentRouter/PermissionService`；服务端在 `95-125` 直接设置 `socket.data` 身份并把 intent 送进引擎，连接参数还能指定 role/control：`96-114`。它只能验证引擎广播联调，不能宣称为认证 E2E。

## 边界模型

所有敏感请求遵循下面的顺序；每一步失败都不得继续产生副作用或敏感输出。

```text
凭据验证
  → 建立/验证 Session(userId, sessionId, expiresAt, revokedAt)
  → 读取 CampaignMember / SceneMember
  → 读取 EntityControl / PermissionGrant
  → 构造当前 scene 的 PermissionSubject
  → 校验事件、能力、目标实体和输入范围
  → 按该 socket 的可见实体与 FOV 过滤出站
```

必须保持以下不变量：

- `userId` 只能来自已验证的会话；`role` 只能来自被请求战役/场景中的成员关系。登录响应可以返回展示用角色，但客户端回传的角色永远被忽略。
- 进入场景是一次新的授权决策。请求的 `sceneId` 只用来查找成员关系；服务端从数据库和当前配置得到 `allowedSceneIds`，不能用请求值反填。
- `actorId` 是意图的目标，不是控制权声明。JOIN 时只能从服务端计算出的可控实体中选择；每个 `BATCH_CAST` 子意图都单独检查。
- “GM 可以控制全部实体”只在该 GM 对当前战役/场景有有效 GM 成员关系时成立；全局 `Role` 表或 token 内旧 role 不能跨战役放行。
- 撤销既是输入边界也是出站边界。撤销后的 socket 必须收到通用的会话状态事件、退出场景房间、清除权限上下文，并且不能再收到该场景的敏感广播。

## MVP 凭据、账号引导和会话

首个自托管实例不开放公共注册。新增一个本机 CLI（例如 `pnpm --filter @hard-vtt/backend auth:create-user`），交互式读取 `loginName`、隐藏密码和账号状态，使用 Argon2id 生成 `passwordHash`。首个账号创建后，只给配置的初始战役/场景建立 GM 成员关系；它不是跨战役的全局 GM。MVP 后续账号和成员关系仍由本机 CLI 配置，密码重置亦走本机 CLI 并撤销该账号的全部会话；不新增 Web 账号管理入口。战役 GM 的在线管理仅限下表中的作用域内 grant/revoke，不得修改其他用户的全局凭据。直接写库的 CLI 在服务停止时执行，重启时重新加载权限，避免绕过运行中缓存失效通知。

MVP 登录请求固定为 `{ loginName, password }`。不存在公开 `/auth/register`，也不接受 `userId`、`role`、`campaignId` 或 `sceneId` 来改变身份。登录失败统一返回 `INVALID_CREDENTIALS`，不区分“用户不存在”和“密码错误”。密码哈希采用有版本的 Argon2id 参数和库；若部署环境不能加载该库，应在实现前选定并测试一个维护良好的 scrypt 替代，而不是回退到自制算法。

会话使用 32 字节以上的密码学随机不透明值。服务端只保存该值的 SHA-256 哈希、`userId`、创建/最后访问时间、绝对 `expiresAt`、`revokedAt` 和版本；内部 sessionId 与浏览器 secret 分离。现有 `Session` 表可作为迁移起点，`roleSnapshot` 只用于审计或诊断，不能单独授权。生产浏览器通过 `Set-Cookie: __Host-elysian.sid=...; HttpOnly; Secure; SameSite=Strict; Path=/` 接收会话，不设置 Domain；敏感 HTTP 请求自动带 cookie。MVP 不把原 token 返回给 JavaScript，不继续拼装当前的 HMAC token，也不默认引入 JWT。需要无状态 token 或外部身份源时，另行采用成熟库/协议。

MVP 沿用当前一小时绝对 TTL，不发 refresh token；客户端遇到 `SESSION_EXPIRED` 清空本地权限并重新登录。服务器每次敏感 HTTP、每次 Socket 输入和每次敏感出站都以服务端时间检查过期/撤销。单进程内用 `Map<sessionId, Set<socketId>>` 做即时广播和踢出，数据库的 `Session` 是重启后的权威来源；任何只存在于内存的缓存都不能延长会话寿命。

会话另设服务端到期任务，在没有输入或广播时也能主动断开过期连接；它使用墙钟计时，与游戏 Tick 队列独立。权限缓存保留 session/成员/grant 的版本和最近到期时间，敏感操作同步检查缓存与时钟，变更由同一服务在提交成功前阻断相关连接、提交后刷新缓存，失败时保持拒绝。无需每个游戏 Tick 读写数据库；新连接、缓存缺失、重启时重新加载，数据库异常默认拒绝。

### 开发 demo 隔离

`demoLogin()` 和 `TestToolbox` 必须同时受前后端开发开关保护：前端只在 `import.meta.env.DEV` 且后端明确启用 demo 时显示，服务端生产配置直接拒绝 demo 登录。demo 账号固定为预置用户，demo 端点不接受客户端 `role`；每个 demo 用户仍只有测试战役/场景成员关系。生产 `/auth/login` 永远走密码校验，不允许客户端自选 GM。身份切换应创建/登录另一个预置账号后断开并重连 Socket，不能在已加入房间的连接上覆盖 `socket.data`。

### 前端存储、URL 迁移、CORS 和 CSRF

- 删除 `App.tsx` 的 `?token` 优先级、localStorage token 和把 token 放进 `/permissions/me` URL 的逻辑；改为 `fetch(..., { credentials: 'include' })`。权限快照可以留在内存 Zustand store，登出、过期或撤销时清空。
- 旧 URL token 返回 `TOKEN_IN_URL_DISABLED`，不写入日志或重定向地址。部署切换时废弃全部旧 token/会话；前端用 `history.replaceState` 去除 URL 凭据、删除旧 localStorage token，并要求重新登录，不将旧 token 兑换成新会话。反向代理访问日志也需排除 query 凭据；敏感响应使用 `Cache-Control: no-store`，页面使用 `Referrer-Policy: no-referrer`。
- HTTP 和 Socket 共用一份精确 Origin allowlist。带 credentials 时禁止 `*`；生产建议同源反向代理，开发的 `5173 → 3000` 仅允许明确列出的 Origin。Cookie 的 `Secure`、`SameSite` 设置随 HTTPS/跨站开发环境显式配置，不能静默降级。
- 采用服务端 synchronizer CSRF token：`GET /auth/csrf` 为当前会话返回随机 nonce；尚未登录时建立短期、无权限的预认证上下文并绑定 nonce。响应只允许同源或精确 allowlist 前端读取，使用 no-store；nonce 留在前端内存，由状态改变请求通过 `X-CSRF-Token` 回传，与当前 Cookie 上下文中的值比对。登录、demo 登录、logout、grant、revoke 都同时检查 Origin、JSON Content-Type 和 nonce，登录成功销毁预认证上下文并轮换会话/nonce。不能仅比较一个可注入的辅助 Cookie 与 header。
- Socket.IO 客户端使用 `withCredentials: true`，服务器在 Engine.IO `allowRequest` 对 polling 与 WebSocket upgrade 校验精确 Origin；仅配置 `cors` 不构成 WebSocket 来源校验。MVP 浏览器接口拒绝缺失或 `null` Origin，测试客户端显式提供允许的 Origin。`AUTHENTICATE { csrfToken }` 校验绑定该 Cookie 会话的 nonce，再建立身份；10 秒未认证断开。不要把 `AUTH_SUCCESS` 当作客户端可发送的事件；成功事件只能由服务端发出。
- 本地 HTTP 开发仅在显式开发配置下使用不同名称 `elysian.dev.sid`，限定 loopback、host-only 和同一主机名；不得使用缺少 Secure 的 `__Host-` Cookie。生产配置缺少 HTTPS/可信代理信息或配置了 demo 时启动失败。跨站部署不属于默认 MVP，避免静默改成 SameSite=None。

## 身份、成员、实体和可见性的分离

建议在现有 schema 上增加最小访问模型，不引入完整平台管理：

| 数据 | 权威含义 |
| --- | --- |
| `User` | 登录身份、显示名、密码哈希、ACTIVE/DISABLED 状态 |
| `Session` | 某个登录实例的 userId、哈希、过期和撤销状态 |
| `CampaignMember` | `(campaignId, userId, role, status)`；GM/PL/OB 只在战役内有效 |
| `SceneMember` | `(sceneId, userId, roleOverride?, status, expiresAt)`；决定是否可加入具体场景 |
| `EntityControl` | `(sceneId, entityId, userId, capability, expiresAt, revokedAt)`；决定可控实体 |
| `PermissionGrant` | 受授予人权限上限约束的临时能力，必须带 campaign/scene/entity 作用域 |

当前没有持久化 Campaign/Scene 关系，`CampaignManager` 只有内存 sceneId；实现前需确定一个最小 `campaignId → sceneId` 映射来源。假设 MVP 每个部署至少有一个由配置或种子数据明确标识的战役，GM 成员关系以该战役为边界。`Role` 表保留为角色目录或迁移兼容数据，不能直接参与授权。`PermissionGrant.scopeType` 的允许值及其与 campaign/scene/entity 的组合需在共享契约中固定。

MVP 具体采用 `Campaign(id)`、`SceneAccess(sceneId, campaignId)` 两张最小登记表，未知 sceneId 默认拒绝，授权后才允许创建/水合内存引擎。CampaignMember 与 SceneMember 必须同时 ACTIVE，SceneMember.roleOverride 只能降低战役角色（GM → PL → OB），不能提升；即使战役 GM 也需要显式场景成员记录。给成员表添加复合唯一键及用户/战役/场景外键，EntityControl 绑定场景内实体；PermissionGrant 限定 CAMPAIGN/SCENE/ENTITY 三类，数据库与服务校验父子归属，禁止 global/wildcard 或跨战役引用。旧会话全部失效，旧无作用域 grant 不自动升级为成员关系，须由本机配置显式映射。

控制权和可见性独立：攻击、治疗等动作只要求施事 `actorId` 可控；`targetId` 按同场景、可见性及动作的射程/目标规则校验，不要求目标可控。撤销控制权不会自动隐藏仍可见的实体；撤销可见权限、成员资格或会话才相应停止数据输出。`DECISION_RESPONSE` 还须绑定服务端记录的 window/reactor、当前允许选项及 socket/user，合法响应只提交一次。

`PermissionService` 应改为接收已加载的成员和授权上下文，提供 `authorizeJoinScene(context, sceneId)`、`authorizeIntent(context, sceneId, intent)` 和 `canReceiveEvent(context, event)`。`allowedSceneIds`、`controlledEntityIds`、`visibleEntityIds` 和 capability 都由服务端计算。角色变化、成员移除、实体控制撤销或 grant 到期时，必须刷新上下文并使旧快照失效；仅返回新的 `PERMISSION_DENIED` 不足以阻止已经加入房间的敏感广播。

## HTTP 与 Socket 权限矩阵

下表是目标 MVP 契约；“当前”行为若不同，按迁移计划改造。

### HTTP

| 入口 | 身份与作用域 | 必须检查 |
| --- | --- | --- |
| `GET /health` | 公共 | 只返回运行状态；不返回数据库细节、密钥或会话信息 |
| `GET /auth/csrf`（新增） | 公共或当前 Cookie 会话，精确来源限制 | 发放绑定短期预认证上下文或当前会话的 nonce；不返回认证 secret，no-store |
| `POST /auth/login` | 公共，Origin allowlist + 预认证 CSRF | 限速、`loginName/password` schema、Argon2id；拒绝 role/userId 等额外身份字段；设置 Cookie |
| `POST /auth/demo-login`（开发专用，新增） | loopback + 开发开关 + Origin + CSRF | 只选固定 demo 账号，不接收角色；生产不挂载该路由 |
| `POST /auth/logout` | 当前 Cookie 会话 | Origin + CSRF；只撤销当前 session，忽略 body 的 sessionId；通知该 session 的全部 sockets |
| `GET /auth/me`（新增） | 当前 Cookie 会话 | 只返回 userId/displayName/过期时间，不返回 token、密码或完整权限 |
| `GET /permissions/me` | 当前会话 + 指定 campaign/scene 成员 | 不接受 query token；由服务端重算成员、grant、控制和可见实体 |
| `GET /logs` | 当前会话 + scene 读权限 | scene 成员/能力检查，查询边界和 `VisibilityFilter`；visibility 参数只能收窄不能提升 |
| `POST /permissions/grant` | 当前 scene/campaign GM + `manage_permissions` | 校验目标用户、作用域、能力上限和过期时间；不能以全局 GM 授权 |
| `POST /permissions/revoke` | 当前 scene/campaign GM + 管理能力 | 校验 grant 所属作用域；刷新目标用户全部会话的权限，停止不再被授权的操作和出站 |
| 任意 `?token=...` 敏感入口 | 不允许 | 返回稳定的 `TOKEN_IN_URL_DISABLED`，不把 token 写入日志、Referer 或错误消息 |

### Socket 输入与输出

| 事件 | 身份/能力 | 目标规则 |
| --- | --- | --- |
| `connection` | 只完成 Origin 校验 | 不加入房间、不发送场景数据 |
| `AUTHENTICATE` | Cookie 会话 + 会话绑定 csrfToken | 服务端读取会话并建立 userId；不接受 role/userId；重复认证需原子清理旧上下文 |
| `PING` | 已通过 Origin 的连接 | 只返回时间/延迟，不返回权限或场景数据 |
| `JOIN_SCENE` | 有效 session + SceneMember | `sceneId` 查成员；`actorId` 只从服务端控制列表选择；授权前不得 join 或发 `SCENE_SYNC` |
| `LEAVE_SCENE` | 有效 session | 只清理当前 socket 的房间、主体和控制引用 |
| `REFRESH_PERMISSION` | 有效 session | 从 DB/权限服务重算；失去成员资格时退出房间并停发 |
| `RESYNC` | 有效 session + 当前 scene 成员 | 重验 session/成员/快照后发送该 viewer 的过滤同步；不能只检查 `currentSceneId` |
| `CLIENT_INTENT` | 当前 scene + capability + entity control | 运行时 schema、速率、目标和每个 batch 子意图逐项校验后才进引擎 |
| `DECISION_RESPONSE` | 当前 scene + 窗口参与者/实体控制 | 校验 windowId、actor/参与者和选项归属；不能只凭 currentScene |
| `DECISION_ENGAGE` | 当前 scene + 窗口参与者/实体控制 | 同上；重复响应幂等，断线清理按 socket 追踪 |
| `GM_FORCE_RESOLVE` | 当前 scene GM + `resolve_decision` | 角色必须来自该 scene 成员，不能只检查 `socket.data.role` |
| `disconnect` | 无需再认证 | 只清理该 socket；不得按 userId 删除其他标签页的连接 |
| `SCENE_SYNC`、`STATE_MUTATED`、`VISUAL_FX` 等出站 | 有效 session + 当前 scene 成员 | 逐 socket 检查撤销/过期，再做权限实体过滤和 FOV 过滤 |
| `SESSION_EXPIRED/REVOKED` | 仅目标 socket | 通用原因，不泄露会话细节；随后清主体、离房并断开或等待重连 |

出站事件至少覆盖 `ENTITY_DIED`、`HOOK_FIRED`、`HOOK_SYNC`、`DECISION_POLL`、`DECISION_ALL_RESOLVED`、`ACTION_SCHEDULED`、`ENTITY_MOVED`、`ZONE_*`、`INTERACT_TRIGGERED`、`EXAMINE_RESULT`、`SKILL_CHECK_RESULT`、`FOG_UPDATED` 和 `COMBAT_END`。现有 `io.to(sceneId).emit()` 路径都必须经过同一出站授权函数；`broadcastToSceneGrouped()` 的角色分组只能作为优化，不能作为安全判断。

## 生命周期、撤销和多标签页

状态机为：`CONNECTED_UNAUTHENTICATED → AUTHENTICATED_NO_SCENE → JOINED`，并可从任意已认证状态进入 `EXPIRED/REVOKED → DISCONNECTED`。

1. 建连先校验 Origin。`AUTHENTICATE { csrfToken }` 从握手 Cookie 找到 session，校验 nonce，检查用户 ACTIVE、`expiresAt > now`、未撤销及服务端版本，随后写入 userId/sessionId；响应只含脱敏身份和权限摘要。
2. 同一连接重新认证只允许重新验证当前会话。服务端先停止该 socket 的旧广播、离开旧房间、清除 subject/snapshot/currentActor，再建立新上下文；认证竞争采用单次进行中的 guard。身份切换走 HTTP logout/login 后断开并重连，禁止原地覆盖角色或保留旧 actor 控制。
3. JOIN、每个输入、REFRESH 和 RESYNC 都再次检查 session。过期返回 `SESSION_EXPIRED`；撤销返回 `SESSION_REVOKED`，清空上下文并停止场景广播。
4. `logout` 或权限撤销通过 `sessionId → socketIds` 映射找到同一会话的所有标签页/连接，逐一发通用状态事件、离开房间、清除权限，再断开。一个标签页的登出不能误删其他用户或其他 session；同一浏览器 Cookie 共享的标签页应全部失效。
5. 重连产生新的 socket。客户端可以记住期望 scene 作为 UI 状态，但服务端必须重新认证、重新读取成员关系、重新选择/校验 actor，然后才允许 JOIN 和过滤后的 SCENE_SYNC。
6. grant、SceneMember 或 EntityControl 被撤销时，不能只等待下一个 intent。权限服务发出本进程内 invalidation，SocketServer 立即重新计算目标 sockets；失去当前 scene 权限的连接按撤销路径处理。

出站实现建议维护 `sessionId → socketIds` 和 `socketId → {sessionId, campaignId, sceneId, subject}` 两个连接级索引。广播时先过滤 live session，再以 socket 的完整 subject 调用 `VisibilityFilter`。对性能敏感的 Tick 广播可以缓存本 Tick 的授权快照，但撤销事件必须使缓存失效；不能用按 user/entity 去重的单一 Set 替代连接级映射。

AUTH/JOIN/RESYNC 等存在 `await` 的流程还须捕获连接 generation 和权限版本：每次恢复后、入房/引擎副作用/发送数据之前重验。logout、leave、断线、重认证递增 generation；过期的异步结果不得恢复旧主体或重新入房。新一轮 JOIN 先撤销旧场景订阅，成功授权后发布新上下文。多 socket 控制同一 actor 使用引用计数，最后一个有权连接离开后才移除玩家控制；该连接占用的决策窗口走幂等清理/默认响应路径，不影响其他连接仍有效的窗口。

浏览器同源 Cookie 在标签页间共享，MVP 不支持同一浏览器 profile 的标签页分别登录 GM/PL；测试不同身份使用独立浏览器 profile/context 或独立 Cookie jar。切换账号先 logout，使用 BroadcastChannel 仅通知标签页清空 UI/重连，不传递凭据；安全边界仍由服务端踢出旧 session 保证。UI 清理覆盖 gameStore、exploreStore、PixiJS 实体、地图、日志与决策窗口，不能只清权限按钮。

## 共享契约、错误和脱敏

先在 `packages/shared/src/index.ts` 定义事件和 payload，再同步生产者、消费者和测试。建议新增/固定：`AuthState`、`SessionStatus`、`AuthErrorCode`、`PermissionSnapshot` 的 `campaignId/sceneId/version/expiresAt`、能力枚举、`SESSION_EXPIRED`/`SESSION_REVOKED` 出站事件，以及带 `requestId` 的授权错误。后端内部的 `PermissionSubject` 可以保持后端类型，不把密码、原始 session secret 或完整审计快照发给前端。

沿用现有 `ErrorCodes` 的 `UNAUTHENTICATED`、`INVALID_TOKEN`、`SESSION_EXPIRED`、`SESSION_REVOKED`、`NOT_IN_SCENE`、`UNAUTHORIZED`、`INVALID_TARGET`、`RATE_LIMITED`，并新增 `INVALID_CREDENTIALS`、`TOKEN_IN_URL_DISABLED`、`ORIGIN_DENIED`、`CAPABILITY_REQUIRED`（或把它们纳入既有稳定分类）。HTTP 使用 401/403/400/429；Socket 使用相同 code，不把内部异常直接放入 `message`。

登录失败、无效 session、无效场景和无权实体应使用通用外部消息。日志可以记录 `requestId`、userId、sceneId、操作类型和不可逆的 session fingerprint，但不得记录 Cookie、token、密码、Authorization header、完整权限快照或原始 `verify()` 异常。审计事件应记录授权前后的最小摘要和作用域。

## 分阶段迁移和文件清单

这是后续实施顺序；本次提案不修改这些文件。

每个阶段先更新对应 shared 契约，再同步后端/前端消费者；阶段 1–5 是同一关闭旧入口的发布单元，不能把仅修改 Cookie 登录、仍保留旧 Socket 授权的中间版本开放联机。数据库迁移先在独立副本验证并备份，禁止通过重置/seed 覆盖用户战斗数据；失败时关闭外部访问，不回退到接受旧 token 的模式。

1. **身份基础**：改 `packages/backend/src/auth/AuthenticationService.ts` 为数据库用户校验、Argon2id、opaque session、时钟注入和撤销事件；在 `packages/backend/src/app.ts` 加认证中间件、Cookie login/logout、`/auth/me`、CSRF 和 token URL 拒绝；在 `packages/backend/src/index.ts` 加启动配置；新增 `packages/backend/src/auth/AuthMiddleware.ts`、账号 CLI 和会话仓储；更新 `packages/backend/package.json` 依赖。同步 `packages/backend/prisma/schema.prisma`，让 Session 真正参与验证。
2. **成员授权**：schema 增加最小 CampaignMember/SceneMember/EntityControl（或等价表），新增对应 repository；改 `PermissionService.ts`、`PermissionGrantRepository.ts`，固定作用域和能力上限；改 `CampaignManager.ts`/`Scene.ts` 传递 campaignId；让 `JOIN_SCENE` 真实调用成员授权。
3. **Socket 输入边界**：改 `packages/backend/src/network/SocketServer.ts` 加 Origin/会话生命周期、连接级索引、重认证、撤销踢出、JOIN/RESYNC/DECISION/GM 统一 guard；改 `IntentRouter.ts` 让每次输入重验 live session、scene、snapshot 和所有 batch 目标。
4. **出站边界**：改 `StateBroadcaster.ts` 把所有 `io.to(sceneId).emit()` 收敛到逐 socket 出站授权；改 `VisibilityFilter.ts` 统一权限实体过滤、FOV 过滤和日志过滤；对撤销/过期建立即时 invalidation。
5. **共享与前端**：先改 `packages/shared/src/index.ts` 契约，再改 `packages/frontend/src/network/socketClient.ts` 使用 Cookie/`withCredentials` 和重连状态；新增 loginName/password 登录表单及退出入口，由 `App.tsx` 调用 `/auth/csrf`、`/auth/login` 和 `/auth/me` 驱动登录状态，删除 demo 生产路径、localStorage 和 URL token。删除 `socketClient.ts` 中客户端发送 `AUTH_SUCCESS` 的代码；改 `TestToolbox.tsx` 仅在开发开关下使用服务端预置身份并通过断开重连切换；改 gameStore、exploreStore 与 renderer 在 auth 状态失效时清空权限和敏感数据。
6. **测试迁移**：更新 `test/security-suite.runner.ts`，加入真实 Socket 安全套件；保留 `test/auth.test.ts` 做服务层单元测试但改用受控时钟；修改 `test/permission.test.ts` 的 GM 任意场景成功断言为“无该战役/场景成员时拒绝”，明确这是有意的旧语义变更；改 `test/security-regression.test.ts` 使用真实账号、Cookie、当前会话 logout，移除 URL token 和仅 sessionId 登出假设。
7. **旧 Socket 测试归类**：`test/socket-e2e.test.ts` 继续作为引擎/广播联调时，文件头和交付说明必须明确它绕过真实 `IntentRouter/PermissionService`，不能计入认证安全覆盖；新增独立的真实 `SocketServer + PermissionService` 测试文件，必要时将 socket hook 系列也标为功能联调。`visibility-and-logs.test.ts` 增加撤销后出站不再可见的断言。

## 可验证验收用例

认证端到端测试必须使用真实 `createApp()`、真实 `SocketServer`、真实 `PermissionService` 和隔离测试数据库；不得通过直接设置 `socket.data`、替代 router 或替代权限服务来满足安全断言。当前 Prisma datasource 硬编码 `file:./dev.db`，实施时先改为可注入的数据库配置，再创建临时测试库，不能只设置一个当前 schema 不读取的 DATABASE_URL 就声称隔离。服务层测试可单独执行；涉及时间的用例注入受控时钟，多连接用例至少建立两个独立客户端，并在 teardown 清理连接、计时器、临时库和内存索引。

- 首次启动通过本机 CLI 建立账号；登录请求伪造 `role: GM`、`userId` 或 scene 字段不会改变身份。错误密码与不存在用户返回同一错误码，数据库只有 Argon2id 哈希。
- PL 只拥有其被授予的 campaign/scene；同一用户在另一战役没有成员关系时 JOIN、RESYNC、日志读取和 intent 都被拒绝。GM 只有在其所属战役内可管理，跨战役 GM 不放行；这项替代 `permission.test.ts:132-133` 的旧成功断言。
- PL 使用未获控制权的 actor 或任何包含这种 actor 的 batch 都被拒绝；但控制己方 actor 攻击同场景合法、可见的敌方 target 应成功。控制 grant 撤销后不能继续操控，可见权限撤销后不能再收到对应实体的状态、视觉、决策或日志，分别测试两类权限。
- 真实 HTTP 测试证明：Cookie 能访问 `/auth/me`、`/permissions/me` 和允许的 `/logs`；URL token 被拒绝；logout 不接受任意 sessionId，只撤销当前会话；Origin/CSRF/CORS 失败没有状态改变。
- 真实 Socket 测试证明：未认证不能 JOIN/intent；无 scene 成员不能 JOIN；`RESYNC` 不能只凭 currentScene；`DECISION_RESPONSE/ENGAGE` 不能只凭 currentScene；`GM_FORCE_RESOLVE` 不能只凭 socket 上的 role。
- 已 JOIN 的两个客户端中撤销其中一个 session，受影响客户端收到 `SESSION_REVOKED` 或 `SESSION_EXPIRED`、退出房间并清除权限；随后触发引擎状态、Hook、决策、视觉和探索事件，受影响客户端一个敏感出站都收不到，仍授权客户端仍收到其可见内容。
- 推进受控时钟越过 `expiresAt` 后，HTTP 和 Socket 输入均失败；断开并重连不会恢复过期 session。重新登录后只按新的成员关系恢复，不能使用旧 snapshot 或旧 actor 控制。
- 同一 session 开两个标签页，各自建立独立 socket；一个 socket 断开不减少另一个 socket 的 Hook/决策计数，不清除另一连接的上下文；当前 session logout 后两个连接都停止敏感广播。
- Cookie 属性、CSRF 和恶意 Origin 分别在真实浏览器及 Socket 的 polling/websocket 两种 transport 下验证；普通 Node 客户端不能证明浏览器执行了 SameSite/HttpOnly/CORS。覆盖登录 CSRF、缺失/错误 nonce、空 Origin，以及异步 JOIN 等待期间发生撤销后不再入房/发数据。
- 安全套件的报告分别标注服务层单元、HTTP 回归、真实 Socket 授权和引擎联调；不得把现有 `socket-e2e.test.ts` 或其他绕过权限层的 E2E 统称为认证覆盖。

## 未决假设

- 当前代码没有持久化 Campaign/Scene 成员表；本提案假设后续会补一个最小 campaignId 映射。若部署实际只有单战役，也仍保留 campaignId 边界，避免把“当前只有一个”固化为全局 GM 规则。
- 假设自托管实例可执行本机账号 CLI，并能把 `User`/`Session` 写入同一 SQLite；若只能通过 Web UI 首次设置，需要额外的一次性 setup secret 和一次性初始化状态，但仍不能开放任意 role 登录。
- 假设 `User.status` 至少区分 ACTIVE/DISABLED，`PermissionGrant.scopeType` 的枚举和能力上限可在迁移时确定；当前 schema 没有这些约束。
- 本文未运行数据库、构建或测试，符合“只新增设计文档”的任务范围；验收用例是后续实施完成后的要求，不是当前已通过的结果。

## 外部安全依据

- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)：浏览器会话密钥应通过安全 Cookie 传输，服务端必须检查过期并支持撤销；这支撑 HttpOnly/Secure Cookie 和服务端 session 状态。
- [OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)：握手校验 Origin 只能建立来源边界，消息仍需逐条认证、授权和限流；这支撑 Socket 的 Origin guard 与出站/输入统一授权。
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)：密码应使用带 salt 的自适应慢哈希（优先 Argon2id）并通过成熟实现完成；这支撑 MVP 的 Argon2id 账号引导和不保存明文。
