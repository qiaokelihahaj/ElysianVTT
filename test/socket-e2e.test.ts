// test/socket-e2e.test.ts
// 假前端联调测试：启动真实 Socket.IO 服务器，通过 socket.io-client 模拟前端
// 绕过 DB 权限层，直接从 CLIENT_INTENT 到引擎处理 + 广播验证

import { createServer, type Server as HttpServer } from 'http';
import { Server as IOServer, type Socket as ServerSocket } from 'socket.io';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import type { AddressInfo } from 'net';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { StateBroadcaster } from '../packages/backend/src/network/StateBroadcaster.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';
import type { Entity, ActionTemplate, DecisionPollPayload } from '../packages/shared/src/index.js';

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
    transform: { coords: { x, y, z: 0 }, planeId: 'e2e', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 0.5, mass: 70, movementModes: ['WALK'] },
    resources: { current: { hp, poise, focus }, max: { hp, poise, focus } },
    activeEffects: []
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function waitForEvent<T>(
  client: ClientSocket,
  event: string,
  predicate: (payload: T) => boolean = () => true,
  timeoutMs = 3000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const listener = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      client.off(event, listener as (...args: any[]) => void);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      client.off(event, listener as (...args: any[]) => void);
      reject(new Error(`等待 Socket 事件 ${event} 超时`));
    }, timeoutMs);
    client.on(event, listener as (...args: any[]) => void);
  });
}

function hasMutation(
  payload: any,
  entityId: string,
  field: string,
  predicate: (value: any) => boolean = () => true
): boolean {
  return payload?.mutations?.some((mutation: any) =>
    mutation.entityId === entityId && predicate(mutation.changes?.[field])
  ) ?? false;
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
// 全局状态
// ==========================================
let httpServer: HttpServer;
let ioServer: IOServer;
let broadcaster: StateBroadcaster;
let engine: CombatEngine;
let gmSocket: ClientSocket;
let plSocket: ClientSocket;
const SCENE_ID = 'e2e-scene';
const PORT = 0; // 随机端口

// ==========================================
// 注册测试技能模板
// ==========================================
registerAction({
  id: 'E2E_STRIKE', tags: ['ATTACK', 'MELEE'],
  timeCost: { startupTicks: 5, recoveryTicks: 3 },
  resourceCost: {}, range: { type: 'MELEE', distanceExpr: '3' },
  effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '25' } }],
  priorityExpr: '10', diceRules: []
} as ActionTemplate);

registerAction({
  id: 'E2E_HEAL', tags: ['BUFF'],
  timeCost: { startupTicks: 3, recoveryTicks: 2 },
  resourceCost: {}, range: { type: 'SELF', distanceExpr: '0' },
  effects: [{ type: 'HEAL', targetSelector: 'SELF', parameters: { resource: 'hp', amountExpr: '20' } }],
  priorityExpr: '5', diceRules: []
} as ActionTemplate);

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
  const hero = makeActor('e2e_hero', 100, 50, 50, 0, 0);
  const enemy = makeActor('e2e_enemy', 60, 30, 30, 3, 0);
  hero.resources.max.hp = 200; // 留治疗空间
  engine.mountEntities([hero, enemy]);

  // Socket 连接处理 —— 替代真实 IntentRouter/PermissionService
  ioServer.on('connection', (socket: ServerSocket) => {
    const role = socket.handshake.query.role as string || 'GM';
    const controlledId = socket.handshake.query.controlledId as string || 'e2e_hero';

    // 模拟 AUTHENTICATE + JOIN_SCENE 后的状态
    socket.data.authenticated = true;
    socket.data.currentSceneId = SCENE_ID;
    socket.data.role = role;
    socket.data.userId = controlledId;
    socket.data.permissionSubject = {
      sessionId: 'e2e-session',
      userId: controlledId,
      role,
      controlledEntityIds: [controlledId],
      visibleEntityIds: role === 'GM' ? [] : [controlledId],
      allowedSceneIds: [SCENE_ID]
    };

    socket.join(SCENE_ID);

    // 发送场景同步
    socket.emit('SCENE_SYNC', {
      tick: engine.currentTick,
      entities: engine.getAllEntities()
    });

    // 接收 CLIENT_INTENT 并路由到引擎
    socket.on('CLIENT_INTENT', (intent: any) => {
      engine.receiveIntent(intent);
    });

    socket.on('DECISION_RESPONSE', (payload: any) => {
      engine.handleDecisionResponse(payload, socket.id);
    });

    socket.on('disconnect', () => {
      // cleanup handled by socket.io
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
  await sleep(50);
  ioServer?.close();
  httpServer?.close();
}

async function connectClient(
  port: number,
  role: string,
  controlledId: string,
  onSceneSync?: (payload: any) => void
): Promise<ClientSocket> {
  const client = createClient(`http://localhost:${port}`, {
    query: { role, controlledId },
    transports: ['websocket'],
    forceNew: true
  });
  const sceneSync = waitForEvent<any>(client, 'SCENE_SYNC').then(payload => {
    onSceneSync?.(payload);
  });
  await Promise.all([new Promise<void>((resolve, reject) => {
    client.on('connect', resolve);
    client.on('connect_error', reject);
    setTimeout(() => reject(new Error('连接超时')), 3000);
  }), sceneSync]);
  return client;
}

// ============================================================
// 测试
// ============================================================
async function runTests() {
  // 启动服务器
  const port = await startServer();
  console.log(`[Setup] 服务器已启动，端口=${port}`);

  // 连接 GM 客户端
  gmSocket = await connectClient(port, 'GM', 'e2e_hero');
  console.log('[Setup] GM 客户端已连接');

  const decisionPolls: DecisionPollPayload[] = [];
  gmSocket.on('DECISION_POLL', (poll: DecisionPollPayload) => {
    decisionPolls.push(poll);
    gmSocket.emit('DECISION_RESPONSE', {
      windowId: poll.windowId,
      chosenOptionId: null
    });
  });

  // ============================================================
  console.log('\n[Test 1] GM 发送 CAST_ACTION → 收到 STATE_MUTATED');
  // ============================================================
  {
    const stateMutations: any[] = [];
    gmSocket.on('STATE_MUTATED', (p: any) => stateMutations.push(p));
    const enemyDamage = waitForEvent<any>(gmSocket, 'STATE_MUTATED', p =>
      hasMutation(p, 'e2e_enemy', 'resources.current.hp')
    );
    const decisionResolved = waitForEvent<any>(gmSocket, 'DECISION_ALL_RESOLVED');

    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'e2e_hero', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'E2E_STRIKE', targetIds: ['e2e_enemy'] }
    });

    await Promise.all([enemyDamage, decisionResolved]);

    assert(stateMutations.length > 0, `STATE_MUTATED 收到 ${stateMutations.length} 次`);
    const hasEnemyHp = stateMutations.some((m: any) =>
      m.mutations?.some((mu: any) => mu.entityId === 'e2e_enemy' && mu.changes?.['resources.current.hp'] !== undefined)
    );
    assert(hasEnemyHp, 'enemy HP 变更已广播');
  }

  // ============================================================
  console.log('\n[Test 2] GM 发送 HEAL 自施法 → HP 恢复');
  // ============================================================
  {
    // 先用攻击让英雄掉血
    const heroDamage = waitForEvent<any>(gmSocket, 'STATE_MUTATED', p =>
      hasMutation(p, 'e2e_hero', 'resources.current.hp', value => value < 100)
    );
    const damageDecisionResolved = waitForEvent<any>(gmSocket, 'DECISION_ALL_RESOLVED');
    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'e2e_enemy', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'E2E_STRIKE', targetIds: ['e2e_hero'] }
    });

    await Promise.all([heroDamage, damageDecisionResolved]);

    const heroEntity = engine.getAllEntities().find(e => e.id === 'e2e_hero')!;
    const hpBeforeHeal = heroEntity.resources.current.hp;
    assert(hpBeforeHeal < 100, `英雄受伤 HP=${hpBeforeHeal} < 100`);

    // 自愈
    const healed = waitForEvent<any>(gmSocket, 'STATE_MUTATED', p =>
      hasMutation(p, 'e2e_hero', 'resources.current.hp', value => value > hpBeforeHeal)
    );
    const healDecisionResolved = waitForEvent<any>(gmSocket, 'DECISION_ALL_RESOLVED');

    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'e2e_hero', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'E2E_HEAL' }
    });

    await Promise.all([healed, healDecisionResolved]);

    assert(heroEntity.resources.current.hp > hpBeforeHeal,
      `治愈后 HP=${heroEntity.resources.current.hp} > ${hpBeforeHeal}`);
  }

  // ============================================================
  console.log('\n[Test 3] GM 发送 MOVE → 坐标更新');
  // ============================================================
  {
    const heroEntity = engine.getAllEntities().find(e => e.id === 'e2e_hero')!;
    const movementFinished = waitForEvent<any>(gmSocket, 'STATE_MUTATED', p =>
      hasMutation(p, 'e2e_hero', 'transform.coords.x', value => Math.abs(value - 10) < 0.01)
    );

    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'e2e_hero', intentType: 'MOVE', clientTick: 0,
      payload: { targetCoords: { x: 10, y: 0, z: 0 } }
    });

    await movementFinished;

    assert(Math.abs(heroEntity.transform.coords.x - 10) < 0.01,
      `移动到 x=10, 实际 x=${heroEntity.transform.coords.x}`);
  }

  // ============================================================
  console.log('\n[Test 4] BATCH_CAST 双角色 Clash');
  // ============================================================
  {
    // 重置位置
    const hero = engine.getAllEntities().find(e => e.id === 'e2e_hero')!;
    const enemy = engine.getAllEntities().find(e => e.id === 'e2e_enemy')!;

    // 确保双方都在射程内且有 HP
    hero.transform.coords = { x: 0, y: 0, z: 0 };
    enemy.transform.coords = { x: 2, y: 0, z: 0 };
    hero.resources.current.hp = 100;
    enemy.resources.current.hp = 60;

    const scheduled: any[] = [];
    engine.on('ACTION_SCHEDULED', (p: any) => scheduled.push(p));
    const clashFinished = waitForEvent<any>(gmSocket, 'STATE_MUTATED', p =>
      hasMutation(p, 'e2e_hero', 'resources.current.hp', value => value < 100) &&
      hasMutation(p, 'e2e_enemy', 'resources.current.hp', value => value < 60)
    );

    gmSocket.emit('CLIENT_INTENT', {
      actorId: '__batch__', intentType: 'BATCH_CAST', clientTick: 0,
      payload: {
        batchIntents: [
          { actorId: 'e2e_hero', actionTemplateId: 'E2E_STRIKE', targetIds: ['e2e_enemy'] },
          { actorId: 'e2e_enemy', actionTemplateId: 'E2E_STRIKE', targetIds: ['e2e_hero'] }
        ]
      }
    });

    await clashFinished;

    // 双方应该都受到伤害
    assert(hero.resources.current.hp < 100, `英雄受伤 HP=${hero.resources.current.hp}`);
    assert(enemy.resources.current.hp < 60, `敌人受伤 HP=${enemy.resources.current.hp}`);
  }

  // ============================================================
  console.log('\n[Test 5] PL 客户端 → 连接并接收 SCENE_SYNC');
  // ============================================================
  {
    let sceneSyncPayload: any;
    plSocket = await connectClient(port, 'PL', 'e2e_hero', payload => {
      sceneSyncPayload = payload;
    });
    console.log('  [Setup] PL 客户端已连接');

    assert(Array.isArray(sceneSyncPayload?.entities), 'PL 客户端收到 SCENE_SYNC');

    const plMutations: any[] = [];
    plSocket.on('STATE_MUTATED', (p: any) => plMutations.push(p));
    const plMutation = waitForEvent<any>(plSocket, 'STATE_MUTATED', p =>
      hasMutation(p, 'e2e_hero', 'resources.current.hp')
    );
    const plDecisionResolved = waitForEvent<any>(gmSocket, 'DECISION_ALL_RESOLVED');

    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'e2e_enemy', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'E2E_STRIKE', targetIds: ['e2e_hero'] }
    });

    await Promise.all([plMutation, plDecisionResolved]);

    // PL 能收到涉及 e2e_hero 的变更
    assert(plMutations.length > 0, 'PL 客户端收到 STATE_MUTATED');
  }

  // ============================================================
  console.log('\n[Test 6] 击杀敌人 → COMBAT_END 广播');
  // ============================================================
  {
    const enemy = engine.getAllEntities().find(e => e.id === 'e2e_enemy')!;
    const gmEndEvents: any[] = [];
    gmSocket.on('COMBAT_END', (p: any) => gmEndEvents.push(p));

    // 给敌人 1 HP 然后击杀
    enemy.resources.current.hp = 1;
    const enemyDied = waitForEvent<any>(gmSocket, 'STATE_MUTATED', p =>
      hasMutation(p, 'e2e_enemy', 'resources.current.hp', value => value <= 0)
    );
    const combatEnded = waitForEvent<any>(gmSocket, 'COMBAT_END');

    gmSocket.emit('CLIENT_INTENT', {
      actorId: 'e2e_hero', intentType: 'CAST_ACTION', clientTick: 0,
      payload: { actionTemplateId: 'E2E_STRIKE', targetIds: ['e2e_enemy'] }
    });

    await Promise.all([enemyDied, combatEnded]);

    assert(gmEndEvents.length >= 1, `COMBAT_END 收到 ${gmEndEvents.length} 次`);
    assert(enemy.resources.current.hp <= 0, `敌人已死亡 HP=${enemy.resources.current.hp}`);
  }

  // ============================================================
  console.log('\n[Test 7] 客户端断开不崩溃');
  // ============================================================
  {
    try {
      const gmDisconnected = waitForEvent<any>(gmSocket, 'disconnect');
      const plDisconnected = waitForEvent<any>(plSocket, 'disconnect');
      gmSocket.close();
      plSocket.close();
      await Promise.all([gmDisconnected, plDisconnected]);
      assert(true, '客户端断开不抛异常');
    } catch (e) {
      assert(false, `断开抛异常: ${e}`);
    }

    // 快速重连验证引擎仍可用
    gmSocket = await connectClient(port, 'GM', 'e2e_hero');
    const hero = engine.getAllEntities().find(e => e.id === 'e2e_hero')!;
    assert(hero !== undefined, '重连后引擎实体仍在');
  }

  // ============================================================
  // 清理
  // ============================================================
  await stopServer();

  console.log(`\n${'='.repeat(40)}`);
  console.log(`假前端联调测试: ${passCount}/${testCount} 通过`);
  if (passCount < testCount) process.exit(1);
}

runTests().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
