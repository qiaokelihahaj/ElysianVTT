import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// 在隔离浏览器中运行真正的 React 组件，不连接后端或修改数据库。
async function main(): Promise<void> {
const frontend = resolve('packages/frontend');
const bundle = await build({
  stdin: { resolveDir: frontend, sourcefile: 'audit-lifecycle.tsx', loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import DemoApp from './src/demo/DemoApp';
    import { demoApi } from './src/demo/api';
    import { DemoSocket } from './src/demo/socket';
    import { useDemoStore } from './src/demo/store';
    import { useExploreStore } from './src/store/exploreStore';
    import { useGameStore } from './src/store/gameStore';
    import { SkillCheckPanel } from './src/ui/components/SkillCheckPanel';
    import { TacticalDecisionPanel } from './src/ui/components/TacticalDecisionPanel';
    import { EntityRoster } from './src/demo/EntityRoster';
    import { GmPanel } from './src/demo/Panels';
    import { TestToolbox } from './src/ui/TestToolbox';
    import { socketClient } from './src/network/socketClient';
    import { RendererManager } from './src/canvas/RendererManager';
    import { assetManager } from './src/assets/AssetManager';
    const entity = { id: 'actor', templateId: 'hero', displayName: '测试角色', type: 'ACTOR',
      transform: { coords: { x: 0, y: 0, z: 0 }, facing: 0, planeId: 'test' },
      physics: { scaleClass: 1, collisionRadius: 1, mass: 100, movementModes: ['WALK'] },
      resources: { current: { hp: 100 }, max: { hp: 100 } }, activeEffects: [] };
    const targetA = { ...entity, id: 'target-a', displayName: '旧目标' };
    const targetB = { ...entity, id: 'target-b', displayName: '当前目标' };
    const action = { actionId: 'old-action', actorId: entity.id, actionTemplateId: 'REPEATED', targetIds: [targetA.id],
      phase: 'STARTUP', declaredTick: 0, priority: 1, paidResources: {}, decisionVersion: 1, controlEpoch: 1, causationId: 'test' };
    const snapshot = { encounterId: 'audit-room', revision: 1, tick: 0, status: 'LOBBY', paused: false,
      entities: [entity, targetA, targetB], actions: [], decisions: [], controls: [], logs: [],
      plan: { windowTick: 0, slots: [], actions: [], committed: false, barrierVersion: 1 } };
    const session = { accessToken: 'audit-token', snapshot, session: { sessionId: 'audit-session', userId: 'gm', role: 'GM',
      displayName: '测试GM', expiresAt: Date.now() + 60000, reconnectUntil: Date.now() + 60000, connectedSocketCount: 0, controlledEntityIds: [] } };
    const catalog = { entries: [], map: { id: 'audit-map', name: '审计地图', width: 1, height: 1, tiles: [], spawnPoints: {} } };
    const room = { encounterId: snapshot.encounterId, snapshot, entries: [{ userId: 'player', displayName: '测试玩家', role: 'PL', connectedSocketCount: 1, connected: true, controlledEntityIds: [] }] };
    window.socketConnects = 0;
    window.restorePending = false;
    demoApi.createGmSession = async () => session;
    demoApi.getRoster = () => new Promise(resolve => { window.resolveRoster = () => resolve(room); });
    demoApi.assignEntity = () => new Promise(resolve => { window.resolveAssignment = () => resolve(room); });
    demoApi.retrySettlement = () => new Promise(resolve => { window.resolveSettlement = () => resolve({ status: 'saved', retryable: false }); });
    demoApi.getCatalog = async () => catalog;
    demoApi.logout = async () => {};
    DemoSocket.prototype.connect = function() { window.socketConnects++; };
    const root = createRoot(document.getElementById('root'));
    root.render(<DemoApp />);
    window.readDemo = () => ({ session: useDemoStore.getState().session, catalog: useDemoStore.getState().catalog, connection: useDemoStore.getState().connection, snapshot: useDemoStore.getState().snapshot, notices: useDemoStore.getState().notices, settlement: useDemoStore.getState().room?.settlement });
    window.prepareSettlement = () => {
      const resolved = { ...snapshot, revision: 2, status: 'ENDED', result: { status: 'ENDED', resolvedTick: 0, endedBy: 'GM' } };
      flushSync(() => useDemoStore.getState().setRoom({ ...room, snapshot: resolved, settlement: { status: 'failed', retryable: true, message: 'fixture' } }));
    };
    window.showSkill = () => flushSync(() => root.render(<SkillCheckPanel />));
    window.setResult = (skill) => flushSync(() => useExploreStore.getState().setSkillCheckResult({ roll: 12, total: 12, dc: 10, success: true, critical: false, fumble: false, skill, timestamp: Date.now() }));
    window.readSkill = () => useExploreStore.getState().skillCheckResult?.skill;
    window.showRoster = () => {
      const currentAction = { ...action, actionId: 'current-action', targetIds: [targetB.id] };
      const currentActor = { ...entity, currentActionContext: { actionId: currentAction.actionId, actionTemplateId: action.actionTemplateId, phase: 'STARTUP', resolveTick: 2 } };
      const current = { ...snapshot, status: 'ACTIVE', entities: [currentActor, targetA, targetB], actions: [action, currentAction] };
      flushSync(() => root.render(<EntityRoster snapshot={current} session={session} catalog={catalog} selectedEntityId={entity.id} onSelectEntity={() => {}} />));
    };
    window.showGm = (hidden = false) => flushSync(() => root.render(<GmPanel snapshot={{...snapshot, entities: [{ ...entity, visibility: hidden ? 'GM' : 'PUBLIC' }, targetA, targetB], actions: [action]}} session={session} catalog={catalog}
      selectedEntityId={entity.id} selectedTargetId={null} selectedCell={null} onRestart={() => {}}
      onCommand={(type, payload) => { window.lastCommand = { type, payload }; }} />));
    window.showToolbox = () => {
      window.legacyEmits = [];
      window.legacyAuthRespond = true;
      const socket = socketClient.socket;
      socket.connected = true;
      socket.emit = (event, ...args) => {
        window.legacyEmits.push(event);
        if (event === 'CLIENT_INTENT') window.legacyLastIntent = args[0];
        if (event === 'AUTHENTICATE' && window.legacyAuthRespond) {
          args[1]({ ok: true });
          for (const handler of [...socket.listeners('AUTH_SUCCESS')]) handler({ ok: true });
        }
        return socket;
      };
      window.fetch = async (url, options) => {
        const identity = JSON.parse(options.body);
        return new Response(JSON.stringify({ ok: true, data: { accessToken: 'fixture', userId: identity.userId, role: identity.role, sessionId: 'fixture' } }), { headers: { 'Content-Type': 'application/json' } });
      };
      flushSync(() => root.render(<TestToolbox onClose={() => {}} />));
    };
    window.readLegacy = () => ({ emits: window.legacyEmits, success: socketClient.socket.listeners('AUTH_SUCCESS').length,
      failed: socketClient._authFailedCallbacks.length, skipAutoJoin: socketClient.skipAutoJoin });
    window.showDecision = (busy, windowId) => {
      const reactor = busy ? { ...entity, currentActionContext: { actionId: 'running', actionTemplateId: 'REPEATED', phase: 'STARTUP' } } : entity;
      flushSync(() => {
        const game = useGameStore.getState();
        game.setInitialScene([reactor, targetA], 0);
        game.setSelectedEntityId(targetA.id);
        game.setActiveWindow({ windowId, actorId: entity.id, windowType: 'REACTION', tick: 0, countdownMs: 1000, availableOptions: [] });
        game.triggerReaction();
        root.render(<TacticalDecisionPanel />);
      });
    };
    window.cancelRendererInit = async () => {
      let release;
      assetManager.preload = () => new Promise(resolve => { release = resolve; });
      const manager = RendererManager.getInstance();
      const task = manager.initialize({ canvas: document.createElement('canvas'), width: 100, height: 100 });
      manager.destroy();
      release();
      await task;
      const result = manager.app === null;
      manager.destroy();
      return result;
    };
    window.remountRenderer = async () => {
      assetManager.preload = async () => {};
      const manager = RendererManager.getInstance();
      await manager.initialize({ canvas: document.createElement('canvas'), width: 100, height: 100 });
      manager.handleVisualFx({ events: [{ eventType: 'MUTUAL_KILL', fxTemplateId: 'clash', sourceId: 'actor' }] });
      manager.destroy();
      await manager.initialize({ canvas: document.createElement('canvas'), width: 100, height: 100 });
      const result = !!manager.app && !manager.tokenLayer.destroyed && !manager.fxLayer.destroyed
        && manager.fxTimers.size === 0 && manager.activeFloatingTexts.length === 0;
      manager.destroy();
      return result;
    };
  ` },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'import.meta.env': '{}' }, loader: { '.css': 'empty' },
  plugins: [{ name: 'shared-source', setup(builder) {
    builder.onResolve({ filter: /^@hard-vtt\/shared$/ }, () => ({ path: resolve('packages/shared/src/index.ts') }));
  } }],
});
const javascript = bundle.outputFiles[0].text;
const server = createServer((request, response) => {
  if (request.url === '/fixture.js') {
    response.writeHead(200, { 'Content-Type': 'application/javascript' });
    response.end(javascript);
  } else {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert.ok(address && typeof address === 'object');
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByPlaceholder('GM-阿斯特拉').fill('审计GM');
  await page.locator('input[type="password"]').fill('fixture');
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => typeof (window as unknown as { resolveRoster?: unknown }).resolveRoster === 'function');
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.evaluate(() => (window as unknown as { resolveRoster: () => void }).resolveRoster());
  await page.clock.runFor(10);
  const afterLogout = await page.evaluate(() => {
    const fixture = window as unknown as { readDemo: () => { session: unknown; catalog: unknown; connection: string }; socketConnects: number };
    return { ...fixture.readDemo(), connects: fixture.socketConnects };
  });
  assert.equal(afterLogout.session, null);
  assert.equal(afterLogout.catalog, null, '退出后迟到大厅请求不能写回旧目录');
  assert.equal(afterLogout.connects, 0, '退出后迟到 hydrate 不能重建旧 socket');
  assert.equal(afterLogout.connection, 'offline');

  await page.getByPlaceholder('GM-阿斯特拉').fill('审计GM');
  await page.locator('input[type="password"]').fill('fixture');
  await page.locator('button[type="submit"]').click();
  await page.evaluate(() => (window as unknown as { resolveRoster: () => void }).resolveRoster());
  await page.getByLabel('测试玩家 的角色').selectOption('actor');
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.evaluate(() => (window as unknown as { resolveAssignment: () => void }).resolveAssignment());
  await page.clock.runFor(10);
  const afterAssignment = await page.evaluate(() => (window as unknown as { readDemo: () => { snapshot: unknown; notices: unknown[] } }).readDemo());
  assert.equal(afterAssignment.snapshot, null, '退出后迟到分配请求不能恢复旧遭遇');
  assert.deepEqual(afterAssignment.notices, [], '退出后迟到分配请求不在登录页遗留通知');

  await page.getByPlaceholder('GM-阿斯特拉').fill('审计GM');
  await page.locator('input[type="password"]').fill('fixture');
  await page.locator('button[type="submit"]').click();
  await page.evaluate(() => (window as unknown as { resolveRoster: () => void }).resolveRoster());
  await page.getByLabel('测试玩家 的角色').waitFor();
  await page.evaluate(() => (window as unknown as { prepareSettlement: () => void }).prepareSettlement());
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await page.evaluate(() => (window as unknown as { showSkill: () => void }).showSkill());
  await page.evaluate(() => (window as unknown as { resolveSettlement: () => void }).resolveSettlement());
  await page.clock.runFor(10);
  const afterSettlement = await page.evaluate(() => (window as unknown as { readDemo: () => { settlement: { status: string }; notices: unknown[] } }).readDemo());
  assert.equal(afterSettlement.settlement.status, 'failed', '组件卸载后迟到保存请求不能写回旧房间');
  assert.deepEqual(afterSettlement.notices, [], '组件卸载后迟到保存请求不遗留通知');

  await page.evaluate(() => (window as unknown as { showSkill: () => void }).showSkill());
  await page.evaluate(() => (window as unknown as { setResult: (skill: string) => void }).setResult('旧检定'));
  await page.getByRole('button', { name: '✕' }).click();
  await page.evaluate(() => (window as unknown as { setResult: (skill: string) => void }).setResult('新检定'));
  await page.clock.runFor(300);
  assert.equal(await page.evaluate(() => (window as unknown as { readSkill: () => string }).readSkill()), '新检定', '旧检定淡出定时器不能删除新结果');
  await page.clock.runFor(7700);
  await page.evaluate(() => (window as unknown as { setResult: (skill: string) => void }).setResult('第三检定'));
  await page.clock.runFor(400);
  assert.equal(await page.evaluate(() => (window as unknown as { readSkill: () => string }).readSkill()), '第三检定', '自动关闭后的淡出定时器也不能删除新结果');

  await page.evaluate(() => (window as unknown as { showRoster: () => void }).showRoster());
  const row = page.locator('article[data-entity-id="actor"]');
  assert.match(await row.textContent() ?? '', /目标：当前目标/, '同模板多次行动按实例 ID 展示当前目标');
  assert.doesNotMatch(await row.textContent() ?? '', /目标：旧目标/);
  await page.evaluate(() => (window as unknown as { showGm: () => void }).showGm());
  await page.getByText('行动与反应', { exact: true }).click();
  await page.getByLabel('编辑动作目标').selectOption('');
  await page.getByRole('button', { name: '保存动作编辑', exact: true }).click();
  const command = await page.evaluate(() => (window as unknown as { lastCommand: { type: string; payload: { targetIds?: string[] } } }).lastCommand);
  assert.equal(command.type, 'GM_EDIT_ACTION');
  assert.deepEqual(command.payload.targetIds, [], 'GM 清除目标显式发送空数组');
  await page.evaluate(() => (window as unknown as { showGm: (hidden: boolean) => void }).showGm(true));
  await page.getByPlaceholder('HP', { exact: true }).fill('75');
  await page.getByRole('button', { name: '应用调整', exact: true }).click();
  const adjustment = await page.evaluate(() => (window as unknown as { lastCommand: { payload: { visibility?: string; resources?: { hp: number } } } }).lastCommand);
  assert.equal(adjustment.payload.resources?.hp, 75);
  assert.equal(adjustment.payload.visibility, undefined, '修改隐藏实体 HP 不会意外公开它');

  await page.evaluate(() => (window as unknown as { showToolbox: () => void }).showToolbox());
  await page.getByRole('button', { name: /GM \(管理员\)/ }).click();
  await page.clock.runFor(10);
  let legacy = await page.evaluate(() => (window as unknown as { readLegacy: () => { emits: string[]; success: number; failed: number; skipAutoJoin: boolean } }).readLegacy());
  assert.deepEqual(legacy.emits, ['AUTHENTICATE', 'JOIN_SCENE'], '认证成功不把服务端权限响应重复回传');
  assert.equal(legacy.success, 0, '完成切换清理临时成功回调');
  assert.equal(legacy.failed, 0, '完成切换清理临时失败回调');
  await page.evaluate(() => { (window as unknown as { legacyAuthRespond: boolean }).legacyAuthRespond = false; });
  await page.getByRole('button', { name: /战士 \(PL\)/ }).click();
  await page.clock.runFor(5010);
  legacy = await page.evaluate(() => (window as unknown as { readLegacy: () => typeof legacy }).readLegacy());
  assert.equal(legacy.success, 0, '超时清理临时成功回调');
  assert.equal(legacy.failed, 0, '超时清理临时失败回调');
  assert.equal(legacy.skipAutoJoin, false);
  await page.getByRole('button', { name: /骑士 \(PL\)/ }).click();
  await page.clock.runFor(10);
  await page.evaluate(() => (window as unknown as { showSkill: () => void }).showSkill());
  legacy = await page.evaluate(() => (window as unknown as { readLegacy: () => typeof legacy }).readLegacy());
  assert.equal(legacy.success, 0, '卸载清理临时成功回调');
  assert.equal(legacy.failed, 0, '卸载清理临时失败回调');
  assert.equal(legacy.skipAutoJoin, false);

  await page.evaluate(() => (window as unknown as { showDecision: (busy: boolean, id: string) => void }).showDecision(true, 'first-decision'));
  assert.match(await page.locator('body').textContent() ?? '', /是，取消行动/, '取消提示读取决策响应者而非当前选中目标');
  await page.getByRole('button', { name: /是，取消行动/ }).click();
  assert.equal(await page.evaluate(() => (window as unknown as { legacyLastIntent: { actorId: string } }).legacyLastIntent.actorId), 'actor');
  await page.evaluate(() => (window as unknown as { showDecision: (busy: boolean, id: string) => void }).showDecision(false, 'second-decision'));
  await page.getByRole('button', { name: '决策', exact: true }).click();
  await page.evaluate(() => (window as unknown as { showDecision: (busy: boolean, id: string) => void }).showDecision(false, 'third-decision'));
  assert.equal(await page.getByRole('button', { name: '决策', exact: true }).count(), 1, '新决策窗口不继承旧选项展开态');

  assert.equal(await page.evaluate(() => (window as unknown as { cancelRendererInit: () => Promise<boolean> }).cancelRendererInit()), true, '初始化期间卸载不能留下新的 Pixi Application');
  assert.equal(await page.evaluate(() => (window as unknown as { remountRenderer: () => Promise<boolean> }).remountRenderer()), true, 'Pixi 卸载后可重建所有图层且不继承旧特效');
  await page.clock.runFor(1000);
  assert.deepEqual(errors, [], '生命周期回归没有未处理的浏览器异常');
  console.log('PASS: real React session and settlement races, skill-check timers, action identity, GM edits and Pixi lifecycle.');
} finally {
  await browser?.close();
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
}
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
