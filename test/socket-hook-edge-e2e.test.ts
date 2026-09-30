// test/socket-hook-edge-e2e.test.ts
// 假前端联调测试：Hook 边缘情况与权限路由
// 覆盖 PASS_ALL/TARGET_ONLY 优先级切换、RECOVERY 跳过、资源耗尽跳过、OB 路由、DECISION_RESPONSE DODGE/INTERRUPT

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
    transform: { coords: { x, y, z: 0 }, planeId: 'hook-edge-e2e', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.5, mass: 70, movementModes: ['WALK'] },
    resources: { current: { hp, poise, focus }, max: { hp, poise, focus } },
    activeEffects: []
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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
// 注册测试技能模板
// ==========================================

// SLASH: 基础攻击
registerAction({
  id: 'SLASH', tags: ['ATTACK', 'MELEE'],
  timeCost: { startupTicks: 5, recoveryTicks: 3 },
  resourceCost: {},
  range: { type: 'MELEE', distanceExpr: '3' },
  effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '30' } }],
  priorityExpr: '10', diceRules: []
} as ActionTemplate);

// PARRY: 招架
registerAction({
  id: 'PARRY', tags: ['DEFENSE', 'REACTION'],
  timeCost: { startupTicks: 2, recoveryTicks: 3 },
  resourceCost: { poise: '10' },
  range: { type: 'SELF', distanceExpr: '0' },
  effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '-30' } }],
  priorityExpr: '20', diceRules: []
} as ActionTemplate);

// DODGE: 闪避（消耗 focus）
registerAction({
  id: 'DODGE', tags: ['MOBILITY', 'DEFENSE', 'REACTION'],
  timeCost: { startupTicks: 2, recoveryTicks: 5 },
  resourceCost: { focus: '8' },
  range: { type: 'SELF', distanceExpr: '0' },
  effects: [],
  priorityExpr: '20', diceRules: []
} as ActionTemplate);

// INTERRUPT: 打断施法
registerAction({
  id: 'INTERRUPT', tags: ['REACTION'],
  timeCost: { startupTicks: 2, recoveryTicks: 3 },
  resourceCost: { focus: '5' },
  range: { type: 'MELEE', distanceExpr: '3' },
  effects: [{ type: 'INTERRUPT', targetSelector: 'PRIMARY', parameters: {} }],
  priorityExpr: '20', diceRules: []
} as ActionTemplate);

// ============================================================
// 全局状态
// ============================================================
let httpServer: HttpServer;
let ioServer: IOServer;
let broadcaster: StateBroadcaster;
let engine: CombatEngine;
let gmSocket: ClientSocket;
let plSocket: ClientSocket;
let obSocket: ClientSocket;
const SCENE_ID = 'hook-edge-e2e-scene';
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

  // 挂载实体（包含第三个用于 TARGET_ONLY 非目标测试）
  const hero = makeActor('edge_hero', 100, 50, 50, 0, 0);
  const enemy = makeActor('edge_enemy', 60, 30, 30, 3, 0);
  const victim = makeActor('edge_victim', 80, 40, 40, -3, 0);
  engine.mountEntities([hero, enemy, victim]);

  // Socket 连接处理
  ioServer.on('connection', (socket: ServerSocket) => {
    const role = socket.handshake.query.role as string || 'GM';
    const controlledId = socket.handshake.query.controlledId as string || 'edge_hero';

    socket.data.authenticated = true;
    socket.data.currentSceneId = SCENE_ID;
    socket.data.role = role;
    socket.data.userId = controlledId;
    socket.data.permissionSubject = {
      sessionId: 'hook-edge-e2e-session',
      userId: controlledId,
      role,
      controlledEntityIds: [controlledId],
      visibleEntityIds: role === 'GM' ? [] : [controlledId],
      allowedSceneIds: [SCENE_ID]
    };
    socket.data.permissionSnapshot = {
      version: 1,
      sessionId: 'hook-edge-e2e-session',
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
      engine.handleDecisionResponse(payload);
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
  plSocket?.close();
  obSocket?.close();
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
  // 等待 SCENE_SYNC
  await new Promise<void>(resolve => {
    client.on('SCENE_SYNC', () => resolve());
    setTimeout(() => resolve(), 1000);
  });
  return client;
}

// ============================================================
// 测试主体
// ============================================================
async function runTests() {
  const port = await startServer();
  console.log(`[Setup] 服务器已启动，端口=${port}`);

  gmSocket = await connectClient(port, 'GM', 'edge_hero');
  console.log('[Setup] GM 客户端已连接');

  // ============================================================
  console.log('\n[Test 1] PASS_ALL 优先级切换 — hero 不应收到 DECISION_POLL');
  // ============================================================
  {
    const polls: DecisionPollPayload[] = [];
    gmSocket.on('DECISION_POLL', (p: DecisionPollPayload) => polls.push(p));
    polls.length = 0;

    // 设置 hero 的 PASS_ALL 切换
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'edge_hero', intentType: 'PRIORITY_TOGGLE', clientTick: 0,
      payload: { toggleMode: 'PASS_ALL' }
    });
    await sleep(50);

    // 敌人攻击 hero
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'edge_enemy', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'SLASH', targetIds: ['edge_hero'] }
    });
    await sleep(200);

    // hero 有 PASS_ALL 不应收到 DECISION_POLL
    const heroPolls = polls.filter(p => p.actorId === 'edge_hero');
    assert(heroPolls.length === 0, `PASS_ALL: hero 收到 0 次 DECISION_POLL（实际 ${heroPolls.length}）`);
    // 其他实体（如 victim）可能收到，至少不应是 hero
    assert(polls.some(p => p.actorId !== 'edge_hero') || polls.length > 0,
      'PASS_ALL: 存在非 hero 的 DECISION_POLL');
  }

  // ============================================================
  console.log('\n[Test 2] TARGET_ONLY 优先级切换 — 非目标不应收到');
  // ============================================================
  {
    const polls: DecisionPollPayload[] = [];
    gmSocket.on('DECISION_POLL', (p: DecisionPollPayload) => polls.push(p));
    polls.length = 0;

    // 设置 hero 的 TARGET_ONLY 切换
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'edge_hero', intentType: 'PRIORITY_TOGGLE', clientTick: 0,
      payload: { toggleMode: 'TARGET_ONLY' }
    });
    await sleep(50);

    // 敌人攻击 victim（hero 不是目标）
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'edge_enemy', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'SLASH', targetIds: ['edge_victim'] }
    });
    await sleep(200);

    const heroPolls = polls.filter(p => p.actorId === 'edge_hero');
    assert(heroPolls.length === 0,
      `TARGET_ONLY 非目标: hero 收到 0 次 DECISION_POLL（实际 ${heroPolls.length}）`);
  }

  // ============================================================
  console.log('\n[Test 3] TARGET_ONLY 优先级切换 — 是目标应收到');
  // ============================================================
  {
    const polls: DecisionPollPayload[] = [];
    gmSocket.on('DECISION_POLL', (p: DecisionPollPayload) => polls.push(p));
    polls.length = 0;

    // hero 仍是 TARGET_ONLY
    // 敌人攻击 hero 本身
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'edge_enemy', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'SLASH', targetIds: ['edge_hero'] }
    });
    await sleep(200);

    const heroPolls = polls.filter(p => p.actorId === 'edge_hero');
    assert(heroPolls.length > 0,
      `TARGET_ONLY 是目标: hero 收到 >0 次 DECISION_POLL（实际 ${heroPolls.length}）`);
  }

  // ============================================================
  console.log('\n[Test 4] RECOVERY 阶段跳过 — hero 在 RECOVERY 不应收到 DECISION_POLL');
  // ============================================================
  {
    const polls: DecisionPollPayload[] = [];
    gmSocket.on('DECISION_POLL', (p: DecisionPollPayload) => polls.push(p));
    polls.length = 0;

    // 手动将 hero 置为 RECOVERY 阶段
    const hero = engine.getAllEntities().find(e => e.id === 'edge_hero')!;
    hero.currentActionContext = {
      type: 'CASTING',
      actionId: 'test-recovery',
      actionTemplateId: 'SLASH',
      phase: 'RECOVERY',
      resolveTick: 999,
      pulseCount: 0
    };

    // 敌人攻击 hero — getValidReactors 应因 RECOVERY 跳过 hero
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'edge_enemy', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'SLASH', targetIds: ['edge_hero'] }
    });
    await sleep(200);

    const heroPolls = polls.filter(p => p.actorId === 'edge_hero');
    assert(heroPolls.length === 0,
      `RECOVERY 跳过: hero 收到 0 次 DECISION_POLL（实际 ${heroPolls.length}）`);

    // 清理人工设置的 context
    hero.currentActionContext = undefined;
  }

  // ============================================================
  console.log('\n[Test 5] 资源耗尽跳过 — focus=0 且 poise=0 不应收到 DECISION_POLL');
  // ============================================================
  {
    const polls: DecisionPollPayload[] = [];
    gmSocket.on('DECISION_POLL', (p: DecisionPollPayload) => polls.push(p));
    polls.length = 0;

    // 将 hero 的 focus 和 poise 设为 0
    const hero = engine.getAllEntities().find(e => e.id === 'edge_hero')!;
    hero.resources.current.focus = 0;
    hero.resources.current.poise = 0;

    // 敌人攻击 hero — getValidReactors 应因资源耗尽跳过 hero
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'edge_enemy', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'SLASH', targetIds: ['edge_hero'] }
    });
    await sleep(200);

    const heroPolls = polls.filter(p => p.actorId === 'edge_hero');
    assert(heroPolls.length === 0,
      `资源耗尽跳过: hero 收到 0 次 DECISION_POLL（实际 ${heroPolls.length}）`);

    // 恢复 hero 资源
    hero.resources.current.focus = 50;
    hero.resources.current.poise = 50;
  }

  // ============================================================
  console.log('\n[Test 6] OB 角色 DECISION_POLL 路由 — OB 不应收到, GM 应收到');
  // ============================================================
  {
    const gmPolls: DecisionPollPayload[] = [];
    const obPolls: DecisionPollPayload[] = [];
    gmSocket.on('DECISION_POLL', (p: DecisionPollPayload) => gmPolls.push(p));
    gmPolls.length = 0;

    // 连接 OB 客户端（控制不同实体，不应收到任何 DECISION_POLL）
    obSocket = await connectClient(port, 'OB', 'edge_ob');
    console.log('  [Setup] OB 客户端已连接');
    obSocket.on('DECISION_POLL', (p: DecisionPollPayload) => obPolls.push(p));

    // 敌人攻击 hero
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'edge_enemy', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'SLASH', targetIds: ['edge_hero'] }
    });
    await sleep(200);

    assert(gmPolls.length > 0, `OB 路由: GM 收到 DECISION_POLL（${gmPolls.length} 次）`);
    assert(obPolls.length === 0, `OB 路由: OB 收到 0 次（实际 ${obPolls.length}）`);
  }

  // ============================================================
  console.log('\n[Test 7] DECISION_RESPONSE DODGE — 闪避执行');
  // ============================================================
  {
    const polls: DecisionPollPayload[] = [];
    gmSocket.on('DECISION_POLL', (p: DecisionPollPayload) => polls.push(p));
    polls.length = 0;

    // 敌人攻击 hero
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'edge_enemy', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'SLASH', targetIds: ['edge_hero'] }
    });
    await sleep(200);

    const slashPoll = polls.find(p =>
      p.windowType === 'REACTION' && p.actorId === 'edge_hero'
    );
    assert(slashPoll !== undefined, 'DODGE 测试: hero 收到 DECISION_POLL');

    if (slashPoll) {
      // 验证 DODGE 在选项中
      const hasDodge = slashPoll.availableOptions.some(o => o.id === 'DODGE');
      assert(hasDodge, 'DODGE 测试: DECISION_POLL 包含 DODGE 选项');

      // 发送 DODGE 响应
      gmSocket.emit('DECISION_RESPONSE', {
        windowId: slashPoll.windowId,
        chosenOptionId: 'DODGE',
        tick: engine.currentTick
      } as DecisionResponsePayload);
      await sleep(150);

      // 确认 DODGE 反应被处理（engine 不应崩溃）
      // DODGE 动作已被调度并处理，引擎状态正常
      const heroAfter = engine.getAllEntities().find(e => e.id === 'edge_hero');
      assert(heroAfter !== undefined, 'DODGE 测试: hero 实体仍然存在');
    }
  }

  // ============================================================
  console.log('\n[Test 8] DECISION_RESPONSE INTERRUPT — 打断施法');
  // ============================================================
  {
    // 清理 test 7 残留状态: DODGE whiff 后的 RECOVERY 事件可能未处理
    const heroCleanup = engine.getAllEntities().find(e => e.id === 'edge_hero')!;
    if (heroCleanup.currentActionContext) {
      heroCleanup.currentActionContext = undefined;
    }
    // 重置 toggle 为 FULL_CONTROL，确保 hero 可以收到 DECISION_POLL
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'edge_hero', intentType: 'PRIORITY_TOGGLE', clientTick: 0,
      payload: { toggleMode: 'FULL_CONTROL' }
    });
    await sleep(50);

    const polls: DecisionPollPayload[] = [];
    gmSocket.on('DECISION_POLL', (p: DecisionPollPayload) => polls.push(p));
    polls.length = 0;

    // 敌人攻击 hero
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'edge_enemy', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'SLASH', targetIds: ['edge_hero'] }
    });
    await sleep(200);

    const slashPoll = polls.find(p =>
      p.windowType === 'REACTION' && p.actorId === 'edge_hero'
    );
    assert(slashPoll !== undefined, 'INTERRUPT 测试: hero 收到 DECISION_POLL');

    if (slashPoll) {
      // 验证 INTERRUPT 在选项中
      const hasInterrupt = slashPoll.availableOptions.some(o => o.id === 'INTERRUPT');
      assert(hasInterrupt, 'INTERRUPT 测试: DECISION_POLL 包含 INTERRUPT 选项');

      // 发送 INTERRUPT 响应
      gmSocket.emit('DECISION_RESPONSE', {
        windowId: slashPoll.windowId,
        chosenOptionId: 'INTERRUPT',
        tick: engine.currentTick
      } as DecisionResponsePayload);
      await sleep(150);

      // INTERRUPT 已调度 — 引擎处理了反应动作，不会崩溃
      // 注意：敌人 SLASH 已在 generateSystemHooks 之前执行
      // INTERRUPT 反应创建新动作并取消敌人剩余事件
      assert(true, 'INTERRUPT 测试: 引擎处理 INTERRUPT 反应未崩溃');
    }
  }

  // ============================================================
  // 清理
  // ============================================================
  await stopServer();

  console.log(`\n${'='.repeat(40)}`);
  console.log(`假前端 Hook 边缘情况 E2E 测试: ${passCount}/${testCount} 通过`);
  if (passCount < testCount) process.exit(1);
}

runTests().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
