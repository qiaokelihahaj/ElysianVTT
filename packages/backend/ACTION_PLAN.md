# ElysianVTT 后端 - 执行摘要与行动计划

📅 **日期**: 2026年4月30日  
🎯 **目标**: 将后端系统从MVP阶段升级至生产就绪

---

## ⚡ 5分钟快览

### 现状评分
| 维度 | 评分 | 状态 |
|------|------|------|
| 架构设计 | ⭐⭐⭐⭐⭐ | 优秀 |
| 代码质量 | ⭐⭐⭐⭐ | 良好 |
| 测试覆盖 | ⭐⭐⭐ | 需补强 |
| 生产就绪度 | ⭐⭐ | 高风险 |
| **综合评分** | **⭐⭐⭐⭐** | **需改进** |

### 关键发现

| 项目 | 严重程度 | 描述 |
|------|---------|------|
| 🔴 CORS 开放 | **P0** | 任何域名可连接，存在CSRF风险 |
| 🔴 无输入验证 | **P0** | 客户端意图直接使用，无校验 |
| 🔴 表达式注入 | **P0** | mathjs 求值虽有防护，仍需加强 |
| 🟡 内存泄漏 | **P1** | 引擎实例无清理机制，长期运行风险 |
| 🟡 断连不处理 | **P1** | 断线玩家资源未释放 |
| 🟠 缺少监控 | **P2** | 无性能指标、无事件审计日志 |

---

## 🚀 优先行动项（按危度排序）

### 🔴 **第一周 - 高危风险修复**

#### Task 1: 修复 CORS 配置
**文件**: `packages/backend/src/network/SocketServer.ts` 行 18-22

```typescript
// ❌ 当前
cors: { origin: '*', methods: ['GET', 'POST'] }

// ✅ 改为
cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true,
    maxAge: 86400
}
```

**验收标准**:
- [ ] 在 `.env.example` 添加 `ALLOWED_ORIGINS` 配置
- [ ] Docker 环境传入正确的源列表
- [ ] 跨域请求测试通过

**预计时间**: 30分钟

---

#### Task 2: 添加客户端意图验证
**文件**: `packages/backend/src/network/SocketServer.ts` 行 66-77

**新建**: `packages/backend/src/network/IntentValidator.ts`

```typescript
import { ClientIntent } from '@hard-vtt/shared';

export interface ValidationResult {
    valid: boolean;
    errors: string[];
}

export function validateClientIntent(intent: ClientIntent): ValidationResult {
    const errors: string[] = [];
    
    // 检查必填字段
    if (!intent.actorId || typeof intent.actorId !== 'string') {
        errors.push('Invalid actorId');
    }
    
    // 检查意图类型
    const validTypes = ['MOVE', 'CAST_ACTION', 'INTERACT'];
    if (!validTypes.includes(intent.intentType)) {
        errors.push(`Invalid intentType: ${intent.intentType}`);
    }
    
    // 检查坐标范围（防止远程传送）
    if (intent.intentType === 'MOVE' && intent.payload.targetCoords) {
        const { x, y, z } = intent.payload.targetCoords;
        if (Math.abs(x) > 1000 || Math.abs(y) > 1000 || Math.abs(z) > 100) {
            errors.push('Target coordinates out of bounds');
        }
    }
    
    return {
        valid: errors.length === 0,
        errors
    };
}
```

**使用**:
```typescript
socket.on('CLIENT_INTENT', async (intent: ClientIntent) => {
    const validation = validateClientIntent(intent);
    if (!validation.valid) {
        logger.warn('Invalid intent', validation.errors);
        socket.emit('ERROR', { code: 'INVALID_INTENT', errors: validation.errors });
        return;
    }
    // 继续处理
});
```

**预计时间**: 1小时

---

#### Task 3: 实现客户端断连处理
**文件**: `packages/backend/src/network/SocketServer.ts` 行 138-140

**新建**: `packages/backend/src/campaigns/DisconnectionHandler.ts`

```typescript
export class DisconnectionHandler {
    private pendingDisconnects = new Map<string, { socketId: string, timeout: NodeJS.Timeout }>();
    
    public handleDisconnect(socketId: string, sceneId: string, actorId: string): void {
        const key = `${sceneId}:${actorId}`;
        
        // 30秒内重连则取消清理
        const timeout = setTimeout(() => {
            logger.info(`Actor ${actorId} purged from scene ${sceneId} after 30s timeout`);
            this.pendingDisconnects.delete(key);
        }, 30000);
        
        this.pendingDisconnects.set(key, { socketId, timeout });
    }
    
    public handleReconnect(sceneId: string, actorId: string): void {
        const key = `${sceneId}:${actorId}`;
        const pending = this.pendingDisconnects.get(key);
        if (pending) {
            clearTimeout(pending.timeout);
            this.pendingDisconnects.delete(key);
            logger.info(`Actor ${actorId} reconnected to scene ${sceneId}`);
        }
    }
}
```

**预计时间**: 1.5小时

---

### 🟡 **第二周 - 资源管理与监控**

#### Task 4: 实现引擎生命周期管理
**文件**: `packages/backend/src/campaigns/CampaignManager.ts`

```typescript
private engineCleanupTimers = new Map<string, NodeJS.Timeout>();

private startCleanupTimer(sceneId: string): void {
    // 清除旧计时器
    if (this.engineCleanupTimers.has(sceneId)) {
        clearTimeout(this.engineCleanupTimers.get(sceneId)!);
    }
    
    // 设置30分钟无活动超时
    const timer = setTimeout(() => {
        logger.info(`Unloading inactive engine: ${sceneId}`);
        this.engines.delete(sceneId);
        this.engineCleanupTimers.delete(sceneId);
    }, 30 * 60 * 1000);
    
    this.engineCleanupTimers.set(sceneId, timer);
}

public async getOrCreateEngine(sceneId: string): Promise<CombatEngine> {
    this.startCleanupTimer(sceneId);  // 每次访问重置计时器
    // ... 现有逻辑
}
```

**预计时间**: 1小时

---

#### Task 5: 添加速率限制
**新建**: `packages/backend/src/network/RateLimiter.ts`

```typescript
export class RateLimiter {
    private tokens: number;
    private lastRefill: number = Date.now();
    
    constructor(private capacity: number, private refillRate: number) {
        this.tokens = capacity;
    }
    
    public tryConsume(count: number = 1): boolean {
        this.refill();
        if (this.tokens >= count) {
            this.tokens -= count;
            return true;
        }
        return false;
    }
    
    private refill(): void {
        const now = Date.now();
        const timePassed = (now - this.lastRefill) / 1000;
        this.tokens = Math.min(
            this.capacity,
            this.tokens + timePassed * this.refillRate
        );
        this.lastRefill = now;
    }
}
```

**集成**:
```typescript
private intentLimiters = new Map<string, RateLimiter>();

socket.on('CLIENT_INTENT', async (intent: ClientIntent) => {
    const limiter = this.getOrCreateLimiter(socket.id);
    if (!limiter.tryConsume(1)) {
        socket.emit('ERROR', { code: 'RATE_LIMITED', retryAfter: 1 });
        return;
    }
    // 处理意图
});
```

**预计时间**: 1.5小时

---

#### Task 6: 完善健康检查端点
**文件**: `packages/backend/src/network/routes/health.ts`

```typescript
import express from 'express';

const router = express.Router();

router.get('/', (_req, res) => {
    // 深度检查
    const checks = {
        database: await checkDatabase(),
        cache: await checkCache(),
        memory: process.memoryUsage(),
        uptime: process.uptime()
    };
    
    const healthy = checks.database && checks.cache;
    res.status(healthy ? 200 : 503).json({
        status: healthy ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        checks
    });
});

export default router;
```

**预计时间**: 1小时

---

### 🟠 **第三周 - 完善性能与文档**

#### Task 7: 补全测试覆盖
**目标**: 从 40% 提升到 80%

新增测试文件:
- `test/socket-server.test.ts` - SocketServer 单元测试
- `test/campaign-manager.test.ts` - CampaignManager 单元测试
- `test/effect-system.test.ts` - EffectSystem 单元测试
- `test/spatial-system.test.ts` - SpatialSystem 单元测试

**预计时间**: 3天

---

#### Task 8: 生成 AsyncAPI 文档
**新建**: `packages/backend/api/socket-events.asyncapi.yaml`

```yaml
asyncapi: '3.0.0'
info:
  title: ElysianVTT WebSocket API
  version: 1.0.0

channels:
  playerActions:
    address: CLIENT_INTENT
    messages:
      clientIntent:
        payload:
          type: object
          properties:
            actorId: { type: string }
            intentType: { enum: [MOVE, CAST_ACTION, INTERACT] }
            payload: { type: object }

  serverBroadcast:
    address: STATE_MUTATED
    messages:
      stateMutation:
        payload:
          type: object
          properties:
            tick: { type: integer }
            mutations: { type: array }
```

**预计时间**: 2小时

---

#### Task 9: 集成日志服务
**库选择**: Winston 或 Pino

```bash
pnpm add winston
```

替换现有 console.log:
```typescript
import winston from 'winston';

const logger = winston.createLogger({
    format: winston.format.json(),
    defaultMeta: { service: 'backend' },
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});
```

**预计时间**: 2小时

---

## 📋 完整任务清单

### 第一周（高优先级）
- [ ] Task 1: CORS 配置修复 (30min)
- [ ] Task 2: 意图验证器 (1h)
- [ ] Task 3: 断连处理 (1.5h)
- [ ] 💡 测试验证所有修复 (2h)

**小计**: 5小时

---

### 第二周（中优先级）
- [ ] Task 4: 引擎清理机制 (1h)
- [ ] Task 5: 速率限制 (1.5h)
- [ ] Task 6: 健康检查 (1h)
- [ ] 💡 集成测试与部署验证 (3h)

**小计**: 6.5小时

---

### 第三周（低优先级）
- [ ] Task 7: 测试补全 (3天)
- [ ] Task 8: API 文档 (2h)
- [ ] Task 9: 日志服务 (2h)
- [ ] 💡 代码审查与文档 (2h)

**小计**: 3-4天

---

## 📊 改进前后对比

| 指标 | 改进前 | 改进后 | 提升 |
|------|--------|--------|------|
| 安全漏洞数 | 4个 | 0个 | 100% |
| 测试覆盖率 | 40% | 80%+ | +100% |
| 生产就绪度 | ⭐⭐ | ⭐⭐⭐⭐⭐ | +150% |
| 可观测性 | ❌ | ✅ | 新增 |
| 文档完整度 | 20% | 80%+ | +300% |

---

## 🎯 验收标准

每个任务完成后应验证：

```bash
# 1. 构建通过
npm run build

# 2. 类型检查通过
npx tsc --noEmit

# 3. 所有测试通过
npm test

# 4. 代码审查通过
# 需要一位技术主管签核

# 5. 本地环境验证
npm run dev
# 手动测试关键功能
```

---

## 📞 沟通计划

建议的里程碑会议:

| 时间 | 议题 | 参与者 |
|------|------|--------|
| 周一 10:00 | 启动会议，讨论优先级 | 全队 |
| 周三 15:00 | P0 修复验收 | 核心开发 + QA |
| 周五 17:00 | 周报与下周计划 | 全队 |

---

## 📌 风险识别

| 风险 | 概率 | 影响 | 缓解方案 |
|------|------|------|---------|
| 修复CORS破坏现有客户端 | 中 | 中 | 先在测试环境验证 |
| 引擎清理导致数据丢失 | 低 | 高 | 添加持久化机制 |
| 性能回退 | 低 | 中 | 建立基准测试 |

---

## ✅ 完成标准

当以下条件均满足时，后端可上线生产：

1. ✅ 所有 P0 问题已修复
2. ✅ 测试覆盖率 ≥ 80%
3. ✅ 安全审计通过
4. ✅ 性能基准建立
5. ✅ API 文档完整
6. ✅ 监控告警配置
7. ✅ 灾难恢复计划就位

---

**最后更新**: 2026-04-30  
**负责人**: [待指定]  
**预计完成**: 2026-05-28
