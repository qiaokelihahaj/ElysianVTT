// test/socket-hook-range-e2e.test.ts
// 假前端联调测试：Hook ENEMY_ENTERS_RANGE 和 ENTITY_MOVES_TO 触发器
// 使用真实 Socket.IO 服务器 + socket.io-client + CombatEngine + StateBroadcaster
// 遵循 socket-hook-e2e.test.ts 的完全相同的模式

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
    transform: { coords: { x, y, z: 0 }, planeId: 'hook-range-e2e', facing: 0 },
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
// 注册测试技能模板（含 PARRY/DODGE 供反应使用）
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

// ============================================================
// 全局状态
// ============================================================
let httpServer: HttpServer;
let ioServer: IOServer;
let broadcaster: StateBroadcaster;
let engine: CombatEngine;
let gmSocket: ClientSocket;
const SCENE_ID = 'hook-range-e2e-scene';
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
  const hero = makeActor('hook_hero', 100, 50, 50, 0, 0);
  const enemy = makeActor('hook_enemy', 60, 30, 30, 100, 100);
  engine.mountEntities([hero, enemy]);

  // Socket 连接处理
  ioServer.on('connection', (socket: ServerSocket) => {
    const role = socket.handshake.query.role as string || 'GM';
    const controlledId = socket.handshake.query.controlledId as string || 'hook_hero';

    socket.data.authenticated = true;
    socket.data.currentSceneId = SCENE_ID;
    socket.data.role = role;
    socket.data.userId = controlledId;
    socket.data.permissionSubject = {
      sessionId: 'hook-range-e2e-session',
      userId: controlledId,
      role,
      controlledEntityIds: [controlledId],
      visibleEntityIds: role === 'GM' ? [] : [controlledId],
      allowedSceneIds: [SCENE_ID]
    };
    socket.data.permissionSnapshot = {
      version: 1,
      sessionId: 'hook-range-e2e-session',
      userId: controlledId,
      role,
      controllableEntities: [controlledId],
      visibleEntities: role === 'GM' ? [] : [controlledId],
      capabilities: ['react'],
      sceneId: SCENE_ID,
      snapshot: {}
    };

    socket.join(SCENE_ID);

    // 发送场景同步
    socket.emit('SCENE_SYNC', {
      tick: engine.currentTick,
      entities: engine.getAllEntities()
    });

    // 接收 CLIENT_INTENT
    socket.on('CLIENT_INTENT', (intent: any) => {
      engine.receiveIntent(intent);
    });

    // 接收 DECISION_RESPONSE
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

  gmSocket = await connectClient(port, 'GM', 'hook_hero');
  console.log('[Setup] GM 客户端已连接');

  // 公用 DECISION_POLL 监听
  const polls: DecisionPollPayload[] = [];
  gmSocket.on('DECISION_POLL', (p: DecisionPollPayload) => polls.push(p));

  // ============================================================
  console.log('\n[Test 1] ENEMY_ENTERS_RANGE — 敌人进入范围触发 DECISION_POLL');
  // ============================================================
  {
    polls.length = 0;

    // 注册 ENEMY_ENTERS_RANGE hook：侦测 hook_hero 周围 5 单位内的 ACTOR 实体
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'hook_hero', intentType: 'HOOK_PRESET', clientTick: 0,
      payload: {
        hookPreset: {
          id: 'range_hook_in', entityId: 'hook_hero',
          label: '敌方进入范围',
          trigger: { type: 'ENEMY_ENTERS_RANGE', range: 5, originEntityId: 'hook_hero' },
          enabled: true
        }
      }
    });
    await sleep(100);

    // 初始状态：enemy 在 (100,100) far away → hook 不应触发
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'hook_hero', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'HEAL' }
    });
    await sleep(200);

    let rangePolls = polls.filter(p =>
      p.sourceAction?.actorId === 'SYSTEM' && p.sourceAction?.actionName === '敌方进入范围'
    );
    assert(rangePolls.length === 0, 'enemy 在远处时 hook 不应触发');

    // 移动 enemy 到 hero 的 2 单位范围内
    const enemy = engine.getAllEntities().find(e => e.id === 'hook_enemy')!;
    enemy.transform.coords.x = 2;
    enemy.transform.coords.y = 0;

    polls.length = 0;

    // 发送 dummy 动作推进引擎 → processQueue → evaluateHooks
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'hook_hero', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'HEAL' }
    });
    await sleep(200);

    rangePolls = polls.filter(p =>
      p.sourceAction?.actorId === 'SYSTEM' && p.sourceAction?.actionName === '敌方进入范围'
    );
    assert(rangePolls.length >= 1, `敌人进入范围后 hook 触发 DECISION_POLL (${rangePolls.length} 次)`);
    assert(rangePolls[0].windowType === 'REACTION', `windowType 为 REACTION 而非 ${rangePolls[0].windowType}`);
  }

  // ============================================================
  console.log('\n[Test 2] ENEMY_ENTERS_RANGE — 敌人不在范围内不应触发');
  // ============================================================
  {
    polls.length = 0;

    // 把 enemy 移回远处
    const enemy = engine.getAllEntities().find(e => e.id === 'hook_enemy')!;
    enemy.transform.coords.x = 100;
    enemy.transform.coords.y = 100;

    // 注册新的 ENEMY_ENTERS_RANGE hook（不同 ID 避免复用已触发的 hook）
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'hook_hero', intentType: 'HOOK_PRESET', clientTick: 0,
      payload: {
        hookPreset: {
          id: 'range_hook_out', entityId: 'hook_hero',
          label: '敌方不在范围',
          trigger: { type: 'ENEMY_ENTERS_RANGE', range: 5, originEntityId: 'hook_hero' },
          enabled: true
        }
      }
    });
    await sleep(100);

    // 推进引擎 — enemy 仍在远处，不应触发
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'hook_hero', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'HEAL' }
    });
    await sleep(200);

    const rangePolls = polls.filter(p =>
      p.sourceAction?.actorId === 'SYSTEM' && p.sourceAction?.actionName === '敌方不在范围'
    );
    assert(rangePolls.length === 0, 'enemy 不在范围内时 hook 不应触发');
  }

  // ============================================================
  console.log('\n[Test 3] ENTITY_MOVES_TO — 实体移动到目标位置触发 DECISION_POLL');
  // ============================================================
  {
    polls.length = 0;

    // 重置 hero 位置
    const hero = engine.getAllEntities().find(e => e.id === 'hook_hero')!;
    hero.transform.coords.x = 0;
    hero.transform.coords.y = 0;

    // 注册 ENTITY_MOVES_TO hook：目标 hex (10, 5)
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'hook_hero', intentType: 'HOOK_PRESET', clientTick: 0,
      payload: {
        hookPreset: {
          id: 'move_hook_in', entityId: 'hook_hero',
          label: '移动到目标',
          trigger: { type: 'ENTITY_MOVES_TO', targetHex: { q: 10, r: 5 } },
          enabled: true
        }
      }
    });
    await sleep(100);

    // 初始状态：hero 在 (0,0)，距离目标 ~11.18，不应触发
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'hook_hero', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'HEAL' }
    });
    await sleep(200);

    let movePolls = polls.filter(p =>
      p.sourceAction?.actorId === 'SYSTEM' && p.sourceAction?.actionName === '移动到目标'
    );
    assert(movePolls.length === 0, 'hero 不在目标位置时 hook 不应触发');

    // 移动 hero 到目标位置 (10, 5) → 距离 0 < 1.5 → 应触发
    hero.transform.coords.x = 10;
    hero.transform.coords.y = 5;

    polls.length = 0;

    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'hook_hero', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'HEAL' }
    });
    await sleep(200);

    movePolls = polls.filter(p =>
      p.sourceAction?.actorId === 'SYSTEM' && p.sourceAction?.actionName === '移动到目标'
    );
    assert(movePolls.length >= 1, `移动到目标位置后 hook 触发 DECISION_POLL (${movePolls.length} 次)`);
    assert(movePolls[0].windowType === 'REACTION', `windowType 为 REACTION 而非 ${movePolls[0].windowType}`);
  }

  // ============================================================
  console.log('\n[Test 4] ENTITY_MOVES_TO — 实体不在目标位置不应触发');
  // ============================================================
  {
    polls.length = 0;

    // 重置 hero 到 (0,0)
    const hero = engine.getAllEntities().find(e => e.id === 'hook_hero')!;
    hero.transform.coords.x = 0;
    hero.transform.coords.y = 0;

    // 注册 ENTITY_MOVES_TO hook，目标在远处 (99, 99) ≈ 140 单位远
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'hook_hero', intentType: 'HOOK_PRESET', clientTick: 0,
      payload: {
        hookPreset: {
          id: 'move_hook_away', entityId: 'hook_hero',
          label: '不移动到目标',
          trigger: { type: 'ENTITY_MOVES_TO', targetHex: { q: 99, r: 99 } },
          enabled: true
        }
      }
    });
    await sleep(100);

    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'hook_hero', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'HEAL' }
    });
    await sleep(200);

    const movePolls = polls.filter(p =>
      p.sourceAction?.actorId === 'SYSTEM' && p.sourceAction?.actionName === '不移动到目标'
    );
    assert(movePolls.length === 0, 'hero 不在目标位置时 hook 不应触发');
  }

  // ============================================================
  console.log('\n[Test 5] ENTITY_MOVES_TO — 实体接近但未达到 1.5 距离阈值不应触发');
  // ============================================================
  {
    polls.length = 0;

    // 重置 hero 到 (0,0)
    const hero = engine.getAllEntities().find(e => e.id === 'hook_hero')!;
    hero.transform.coords.x = 0;
    hero.transform.coords.y = 0;

    // 注册 ENTITY_MOVES_TO hook，目标 (10, 5)
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'hook_hero', intentType: 'HOOK_PRESET', clientTick: 0,
      payload: {
        hookPreset: {
          id: 'move_hook_near', entityId: 'hook_hero',
          label: '接近但不触发',
          trigger: { type: 'ENTITY_MOVES_TO', targetHex: { q: 10, r: 5 } },
          enabled: true
        }
      }
    });
    await sleep(100);

    // 移动 hero 到 (11.6, 5) — 距离目标 1.6，不满足 evaluate() 的 < 1.5 条件
    hero.transform.coords.x = 11.6;
    hero.transform.coords.y = 5;

    polls.length = 0;

    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'hook_hero', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'HEAL' }
    });
    await sleep(200);

    const movePolls = polls.filter(p =>
      p.sourceAction?.actorId === 'SYSTEM' && p.sourceAction?.actionName === '接近但不触发'
    );
    assert(movePolls.length === 0, '接近但未进入 1.5 阈值时 hook 不应触发');
  }

  // ============================================================
  // 清理
  // ============================================================
  await stopServer();

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Hook Range E2E 测试: ${passCount}/${testCount} 通过`);
  if (passCount < testCount) process.exit(1);
}

runTests().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
