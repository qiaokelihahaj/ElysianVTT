// test/socket-hook-lifecycle-e2e.test.ts
// 假前端联调测试：Hook 生命周期全场景
// 涵盖 TTL 过期、取消注册、启用/禁用切换、多钩子同 Tick、系统钩子清理
// 使用真实 Socket.IO 服务器 + socket.io-client + CombatEngine + StateBroadcaster

import { createServer, type Server as HttpServer } from 'http';
import { Server as IOServer, type Socket as ServerSocket } from 'socket.io';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import type { AddressInfo } from 'net';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { StateBroadcaster } from '../packages/backend/src/network/StateBroadcaster.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';
import type { Entity, ActionTemplate, DecisionPollPayload, DecisionResponsePayload } from '../packages/shared/src/index.js';

// ==========================================
// 辅助函数
// ==========================================
function registerAction(template: ActionTemplate) {
  const dict = Dictionary as any;
  if (!dict.actions) dict.actions = new Map<string, ActionTemplate>();
  dict.actions.set(template.id, template);
}

function makeActor(id: string, hp = 100, poise = 50, focus = 50, x = 0, y = 0): Entity {
  return {
    id, templateId: 'unit', type: 'ACTOR',
    transform: { coords: { x, y, z: 0 }, planeId: 'hook-lifecycle', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.5, mass: 70, movementModes: ['WALK'] },
    resources: { current: { hp, poise, focus }, max: { hp, poise, focus } },
    activeEffects: []
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

type HookFiredPayload = { hookId: string; source: string; label: string };

// 记录客户端实际收到的事件；自动响应只通过 Socket.IO 回到测试服务，
// 不直接调用引擎，这样可以覆盖真实的 DECISION_POLL → DECISION_RESPONSE 路径。
const observedDecisionPolls: DecisionPollPayload[] = [];
const observedDecisionResolved: unknown[] = [];
const observedHookFired: HookFiredPayload[] = [];
const respondedDecisionWindows = new Set<string>();

function installDecisionClientHarness(client: ClientSocket): void {
  client.on('DECISION_POLL', (payload: DecisionPollPayload) => {
    observedDecisionPolls.push(payload);

    // 每个窗口只自动发送一次放弃响应，避免重复事件推进计数器。
    if (respondedDecisionWindows.has(payload.windowId)) return;
    respondedDecisionWindows.add(payload.windowId);

    setTimeout(() => {
      const response: DecisionResponsePayload = {
        windowId: payload.windowId,
        chosenOptionId: 'DO_NOTHING'
      };
      if (client.connected) client.emit('DECISION_RESPONSE', response);
    }, 0);
  });

  client.on('DECISION_ALL_RESOLVED', payload => {
    observedDecisionResolved.push(payload);
  });

  client.on('HOOK_FIRED', (payload: HookFiredPayload) => {
    observedHookFired.push(payload);
  });
}

function waitForPoll(
  predicate: (payload: DecisionPollPayload) => boolean,
  fromIndex: number,
  timeoutMs = 2500
): Promise<DecisionPollPayload> {
  const existing = observedDecisionPolls.slice(fromIndex).find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const onPoll = (payload: DecisionPollPayload) => {
      if (!predicate(payload)) return;
      cleanup();
      resolve(payload);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待 DECISION_POLL 超时（fromIndex=${fromIndex}）`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      gmSocket.off('DECISION_POLL', onPoll);
    };

    gmSocket.on('DECISION_POLL', onPoll);
  });
}

function waitForDecisionResolved(fromIndex: number, timeoutMs = 2500): Promise<void> {
  if (observedDecisionResolved.length > fromIndex) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onResolved = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待 DECISION_ALL_RESOLVED 超时（fromIndex=${fromIndex}）`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      gmSocket.off('DECISION_ALL_RESOLVED', onResolved);
    };

    gmSocket.on('DECISION_ALL_RESOLVED', onResolved);
  });
}

// ==========================================
// 测试框架
// ==========================================
let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
  testCount++;
  if (cond) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}

// ==========================================
// 注册技能模板（含 PARRY 供系统钩子使用）
// ==========================================
registerAction({
  id: 'SLASH', tags: ['ATTACK', 'MELEE'],
  timeCost: { startupTicks: 5, recoveryTicks: 3 },
  resourceCost: {},
  range: { type: 'MELEE', distanceExpr: '3' },
  effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '30' } }],
  priorityExpr: '10', diceRules: []
} as ActionTemplate);

registerAction({
  id: 'PARRY', tags: ['DEFENSE', 'REACTION'],
  timeCost: { startupTicks: 2, recoveryTicks: 3 },
  resourceCost: { poise: '10' },
  range: { type: 'SELF', distanceExpr: '0' },
  effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '-30' } }],
  priorityExpr: '20', diceRules: []
} as ActionTemplate);

registerAction({
  id: 'HEAL', tags: ['BUFF'],
  timeCost: { startupTicks: 3, recoveryTicks: 2 },
  resourceCost: {},
  range: { type: 'SELF', distanceExpr: '0' },
  effects: [{ type: 'HEAL', targetSelector: 'SELF', parameters: { resource: 'hp', amountExpr: '20' } }],
  priorityExpr: '5', diceRules: []
} as ActionTemplate);

// 测试用：大幅推进引擎 Tick（不产生任何游戏效果）
registerAction({
  id: '__JUMP_200__', tags: [],
  timeCost: { startupTicks: 200, recoveryTicks: 1 },
  resourceCost: {},
  range: { type: 'SELF', distanceExpr: '0' },
  effects: [],
  priorityExpr: '0', diceRules: []
} as ActionTemplate);

// ============================================================
// 全局状态
// ============================================================
let httpServer: HttpServer;
let ioServer: IOServer;
let broadcaster: StateBroadcaster;
let engine: CombatEngine;
let gmSocket: ClientSocket;
const SCENE_ID = 'hook-lifecycle-scene';
const PORT = 0;

// ============================================================
// 启动服务
// ============================================================
async function startServer(): Promise<number> {
  httpServer = createServer();
  ioServer = new IOServer(httpServer, { cors: { origin: '*' } });

  broadcaster = new StateBroadcaster(ioServer);
  engine = new CombatEngine(SCENE_ID);
  broadcaster.wireEngine(engine, SCENE_ID);

  // 挂载实体
  const hero = makeActor('hook_lc_hero', 100, 50, 50, 0, 0);
  const enemy = makeActor('hook_lc_enemy', 60, 30, 30, 3, 0);
  engine.mountEntities([hero, enemy]);

  // Socket 连接处理
  ioServer.on('connection', (socket: ServerSocket) => {
    const role = socket.handshake.query.role as string || 'GM';
    const controlledId = socket.handshake.query.controlledId as string || 'hook_lc_hero';

    socket.data.authenticated = true;
    socket.data.currentSceneId = SCENE_ID;
    socket.data.role = role;
    socket.data.userId = controlledId;
    socket.data.permissionSubject = {
      sessionId: 'hook-lifecycle-session',
      userId: controlledId,
      role,
      controlledEntityIds: [controlledId],
      visibleEntityIds: role === 'GM' ? [] : [controlledId],
      allowedSceneIds: [SCENE_ID]
    };
    socket.data.permissionSnapshot = {
      version: 1,
      sessionId: 'hook-lifecycle-session',
      userId: controlledId,
      role,
      controllableEntities: [controlledId],
      visibleEntities: role === 'GM' ? [] : [controlledId],
      capabilities: ['react'],
      sceneId: SCENE_ID,
      snapshot: {}
    };

    socket.join(SCENE_ID);

    socket.emit('SCENE_SYNC', {
      tick: engine.currentTick,
      entities: engine.getAllEntities()
    });

    socket.on('CLIENT_INTENT', (intent: any) => {
      engine.receiveIntent(intent);
    });

    socket.on('DECISION_RESPONSE', (payload: DecisionResponsePayload) => {
      engine.handleDecisionResponse(payload, socket.id);
    });
  });

  return new Promise(resolve => {
    httpServer.listen(PORT, () => {
      const addr = httpServer.address() as AddressInfo;
      resolve(addr.port);
    });
  });
}

async function stopServer() {
  gmSocket?.close();
  await sleep(50);
  ioServer?.close();
  httpServer?.close();
}

async function connectClient(port: number, role: string, controlledId: string): Promise<ClientSocket> {
  const client = createClient(`http://localhost:${port}`, {
    query: { role, controlledId },
    transports: ['websocket'],
    forceNew: true
  });
  await new Promise<void>((resolve, reject) => {
    client.on('connect', resolve);
    client.on('connect_error', reject);
    setTimeout(() => reject(new Error('连接超时')), 3000);
  });
  await new Promise<void>(resolve => {
    client.on('SCENE_SYNC', () => resolve());
    setTimeout(() => resolve(), 1000);
  });
  return client;
}

// ============================================================
// 获取 HookRegistry（通过 as any 绕过 private）
// ============================================================
function getHookRegistry(): any {
  return (engine as any).hookRegistry;
}

// ============================================================
// 驱动引擎到达指定 Tick（直接推入 TickEvent + CAST_ACTION 触发 processQueue）
// ============================================================
async function advanceEngineTo(targetTick: number): Promise<void> {
  // 直接 push TickEvent 到引擎队列（不含 HOOK_PRESET，避免注册额外 hook）
  (engine as any).eventQueue.push({
    eventId: `__adv_${Date.now()}`,
    targetTick,
    status: 'PENDING'
  });
  // CAST_ACTION 触发 processQueue
  gmSocket.emit('CLIENT_INTENT', {
    actorId: 'hook_lc_hero', intentType: 'CAST_ACTION', clientTick: 0,
    payload: { actionTemplateId: 'HEAL' }
  });
  await sleep(250);
}

// ============================================================
// 测试主体
// ============================================================
async function runTests() {
  const port = await startServer();
  console.log(`[Setup] 服务器已启动，端口=${port}`);

  gmSocket = await connectClient(port, 'GM', 'hook_lc_hero');
  installDecisionClientHarness(gmSocket);
  console.log('[Setup] GM 客户端已连接');

  // ============================================================
  console.log('\n[Test 1] Hook TTL 过期 — TTL 耗尽后 cleanup 移除，不触发 DECISION_POLL');
  // ============================================================
  {
    const pollCursor = observedDecisionPolls.length;

    const hr = getHookRegistry();
    const ct = engine.currentTick;
    const targetTick = ct + 100;

    // 通过 hookRegistry 直接注册一个短 TTL 的钩子
    const hook = hr.register(
      'hook_lc_hero',
      {
        id: 'ttl_hook', entityId: 'hook_lc_hero',
        label: 'TTL过期',
        trigger: { type: 'TICK_REACHED', targetTick },
        enabled: true
      },
      'MANUAL',
      ct,
      1 // TTL = 1 tick
    );
    assert(hook !== undefined && hook.id === 'ttl_hook', 'TTL hook 注册成功');

    // 执行 cleanup 使 TTL 过期（createdAtTick=ct, ttl=1, tick >= ct+1 时过期）
    hr.cleanup(ct + 2);

    const afterCleanup = hr.getAll();
    const ttlGone = !afterCleanup.some((h: any) => h.id === 'ttl_hook');
    assert(ttlGone, 'TTL 过期 hook 被 cleanup 移除');

    // 驱动引擎到达 targetTick，验证 TTL hook 不触发
    await advanceEngineTo(targetTick);

    const ttlPolls = observedDecisionPolls.slice(pollCursor)
      .filter(p => p.sourceAction?.actionName === 'TTL过期');
    assert(ttlPolls.length === 0,
      `TTL 过期 hook 不应触发 DECISION_POLL（收到 ${ttlPolls.length} 次）`);
  }

  // ============================================================
  console.log('\n[Test 2] Hook 取消注册 — unregister 后不触发 DECISION_POLL');
  // ============================================================
  {
    const pollCursor = observedDecisionPolls.length;

    const hr = getHookRegistry();
    const ct = engine.currentTick;
    const targetTick = ct + 30;

    // 直接注册一个手动钩子
    hr.register(
      'hook_lc_hero',
      {
        id: 'unreg_hook', entityId: 'hook_lc_hero',
        label: '待取消',
        trigger: { type: 'TICK_REACHED', targetTick },
        enabled: true
      },
      'MANUAL',
      ct,
      0
    );

    // 执行取消注册
    const unregResult = hr.unregister('unreg_hook');
    assert(unregResult, 'unregister 返回 true，钩子已被移除');

    // 驱动引擎到达 targetTick
    await advanceEngineTo(targetTick);

    const unregPolls = observedDecisionPolls.slice(pollCursor)
      .filter(p => p.sourceAction?.actionName === '待取消');
    assert(unregPolls.length === 0,
      `取消注册的 hook 不应触发 DECISION_POLL（收到 ${unregPolls.length} 次）`);
  }

  // ============================================================
  console.log('\n[Test 3] Hook 启用/禁用 — enabled=false 不触发 DECISION_POLL');
  // ============================================================
  {
    const pollCursor = observedDecisionPolls.length;

    const hr = getHookRegistry();
    const ct = engine.currentTick;
    const targetTick = ct + 20;

    // 通过 HOOK_PRESET 注册一个禁用的钩子
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'hook_lc_hero', intentType: 'HOOK_PRESET', clientTick: 0,
      payload: {
        hookPreset: {
          id: 'disabled_hook', entityId: 'hook_lc_hero',
          label: '禁用钩子',
          trigger: { type: 'TICK_REACHED', targetTick },
          enabled: false
        }
      }
    });
    await sleep(100);

    // 验证钩子已被注册（但 disabled）
    const allHooks = hr.getAll();
    assert(allHooks.some((h: any) => h.id === 'disabled_hook' && !h.enabled),
      'disabled hook 已注册且 enabled=false');

    // 驱动引擎到达 targetTick
    await advanceEngineTo(targetTick);

    const disabledPolls = observedDecisionPolls.slice(pollCursor)
      .filter(p => p.sourceAction?.actionName === '禁用钩子');
    assert(disabledPolls.length === 0,
      `禁用的 hook 不应触发 DECISION_POLL（收到 ${disabledPolls.length} 次）`);
  }

  // ============================================================
  console.log('\n[Test 4] 同 Tick 同实体多钩子 — 两个手动钩子均应触发');
  // ============================================================
  {
    const pollCursor = observedDecisionPolls.length;
    const hookFiredCursor = observedHookFired.length;
    const resolvedCursor = observedDecisionResolved.length;

    const hr = getHookRegistry();
    const ct = engine.currentTick;
    const targetTick = ct + 20;

    // 注册两个钩子，相同 entity 相同 targetTick
    hr.register(
      'hook_lc_hero',
      {
        id: 'multi_A', entityId: 'hook_lc_hero',
        label: '多钩子A',
        trigger: { type: 'TICK_REACHED', targetTick },
        enabled: true
      },
      'MANUAL',
      ct,
      0
    );
    hr.register(
      'hook_lc_hero',
      {
        id: 'multi_B', entityId: 'hook_lc_hero',
        label: '多钩子B',
        trigger: { type: 'TICK_REACHED', targetTick },
        enabled: true
      },
      'MANUAL',
      ct,
      0
    );

    // 驱动引擎到达 targetTick
    await advanceEngineTo(targetTick);

    const multiPoll = await waitForPoll(
      p => p.actorId === 'hook_lc_hero'
        && p.sourceAction?.actionName.includes('多钩子A') === true
        && p.sourceAction?.actionName.includes('多钩子B') === true,
      pollCursor
    );
    const multiPolls = observedDecisionPolls.slice(pollCursor).filter(p => p === multiPoll);
    const representedHookLabels = multiPoll.sourceAction?.actionName.split(' · ') ?? [];
    const firedHooks = observedHookFired.slice(hookFiredCursor)
      .filter(h => h.label === '多钩子A' || h.label === '多钩子B');

    // 同一实体同一 Tick 的手动 Hook 按产品语义合并为一个决策窗口；
    // 断言真实 poll 携带两个 Hook，且两个 HOOK_FIRED 均已从 Socket.IO 到达。
    assert(multiPolls.length >= 1 && representedHookLabels.length >= 2 && firedHooks.length >= 2,
      `两个手动钩子均触发 DECISION_POLL（收到 ${multiPolls.length} 次 poll，${firedHooks.length} 次 HOOK_FIRED）`);
    await waitForDecisionResolved(resolvedCursor);
    assert((engine as any).pendingDecisionCount === 0,
      '同 Tick 多 Hook 的自动放弃响应后决策队列已恢复');
  }

  // ============================================================
  console.log('\n[Test 5] 系统钩子清理 — SLASH 生成的系统钩子被 cleanup 移除');
  // ============================================================
  {
    const pollCursor = observedDecisionPolls.length;
    const resolvedCursor = observedDecisionResolved.length;

    const hr = getHookRegistry();

    // 英雄 SLASH 敌人 → 触发 generateSystemHooks
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'hook_lc_hero', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'SLASH', targetIds: ['hook_lc_enemy'] }
    });
    const slashPoll = await waitForPoll(
      p => p.windowType === 'REACTION' && p.sourceAction?.actionName === 'SLASH',
      pollCursor
    );

    // 确认系统钩子触发了 DECISION_POLL
    const slashPolls = observedDecisionPolls.slice(pollCursor)
      .filter(p => p === slashPoll);
    assert(slashPolls.length > 0,
      `SLASH 系统钩子生成了 DECISION_POLL（${slashPolls.length} 次）`);

    await waitForDecisionResolved(resolvedCursor);

    // 确认系统钩子已被 cleanup 移除（fired + source=SYSTEM）
    const remaining = hr.getAll();
    const systemHooksRemaining = remaining.filter((h: any) => h.source === 'SYSTEM');
    assert(systemHooksRemaining.length === 0,
      `系统钩子已被 cleanup 移除（剩余 ${systemHooksRemaining.length} 个）`);
  }

  // ============================================================
  // 清理
  // ============================================================
  await stopServer();

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Hook 生命周期测试: ${passCount}/${testCount} 通过`);
  if (passCount < testCount) process.exit(1);
}

runTests().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
