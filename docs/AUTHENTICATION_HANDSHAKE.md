# Socket 认证握手流程

## 流程概览

客户端现在必须按以下顺序操作：

```
1. 调用 HTTP POST /auth/login 获取 token
   ↓
2. Socket 连接后发送 AUTHENTICATE 事件，携带 token
   ↓
3. 服务端验证 token，建立会话上下文
   ↓
4. 客户端收到 AUTH_SUCCESS 后才能进行 JOIN_SCENE
   ↓
5. JOIN_SCENE 时服务端从会话上下文读取身份，创建权限主体
   ↓
6. 进入场景后才能发送 CLIENT_INTENT
```

## HTTP 认证端点

### POST /auth/login

**请求：**
```json
{
  "userId": "alice",
  "role": "PL"
}
```

**响应：**
```json
{
  "ok": true,
  "data": {
    "accessToken": "...",
    "sessionId": "sess_...",
    "userId": "alice",
    "role": "PL",
    "expiresIn": 3600,
    "expiresAt": 1777888345000
  }
}
```

## Socket 认证事件

### AUTHENTICATE (客户端 → 服务端)

**发送：**
```typescript
socket.emit('AUTHENTICATE', { token: accessToken }, (response) => {
    console.log(response);
});
```

**成功响应 (AUTH_SUCCESS 事件)：**
```json
{
  "ok": true,
  "subject": {
    "userId": "alice",
    "role": "PL",
    "sessionId": "sess_...",
    "permissionSnapshotVersion": 1
  }
}
```

**失败响应 (AUTH_FAILED 事件)：**
```json
{
  "ok": false,
  "code": "AUTH_FAILED",
  "message": "认证失败"
}
```

## 完整握手示例（客户端伪代码）

```typescript
// 1. 先登录获取 token
const loginResp = await fetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ userId: 'alice', role: 'PL' })
});
const { data: { accessToken } } = await loginResp.json();

// 2. 连接 Socket
const socket = io('http://localhost:3000');

socket.on('connect', () => {
    // 3. 立即认证
    socket.emit('AUTHENTICATE', { token: accessToken }, (response) => {
        if (response.ok) {
            console.log('认证成功，现在可以进入场景');
            // 4. 进入场景
            socket.emit('JOIN_SCENE', { sceneId: 'room_1' });
        } else {
            console.error('认证失败:', response.message);
        }
    });
});

socket.on('AUTH_SUCCESS', (subject) => {
    console.log('会话建立:', subject);
});

socket.on('AUTH_FAILED', (error) => {
    console.error('认证错误:', error);
});

socket.on('JOIN_SUCCESS', (data) => {
    console.log('进入场景:', data);
    // 5. 现在可以发送意图
    socket.emit('CLIENT_INTENT', {
        actorId: 'alice',
        intentType: 'MOVE',
        clientTick: 0,
        payload: { targetCoords: { x: 100, y: 100, z: 0 } }
    });
});

socket.on('ERROR', (error) => {
    console.error('操作错误:', error);
});
```

## 关键改动

1. **AuthenticationService**（新建）
   - JWT 签发和验证
   - 会话存储和撤销
   - 支持多并发会话

2. **SocketServer**（改动）
   - 新增 AUTHENTICATE 事件处理
   - Socket 状态改为 `authenticated: boolean`
   - JOIN_SCENE 检查认证状态
   - 从认证上下文绑定身份

3. **IntentRouter**（改动）
   - CLIENT_INTENT 检查 `authenticated` 标志
   - 优先级提升到第一道关卡

4. **app.ts**（改动）
   - 新增 POST /auth/login 端点

## 权限链路

现在的权限判定顺序是：

```
Socket 连接
  ↓
AUTHENTICATE (验证 JWT，建立会话)
  ↓
JOIN_SCENE (检查认证，创建权限快照)
  ↓
CLIENT_INTENT (验证权限快照，授权意图)
  ↓
引擎执行
```

## 测试结果

AuthenticationService 通过了 27 项单元测试：
- JWT 签发和验证
- 会话管理
- Token 过期检查
- 会话撤销
- 多并发会话隔离
- 多角色支持
