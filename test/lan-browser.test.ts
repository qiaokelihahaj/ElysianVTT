import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { EncounterSnapshot } from '../packages/shared/src/index.js';
import { getEncounterRelation, getEncounterSide } from '../packages/shared/src/encounterFactions.js';
import React, { createElement } from '../packages/frontend/node_modules/react/index.js';
import { renderToStaticMarkup } from '../packages/frontend/node_modules/react-dom/server.node.js';
import { EntityRoster } from '../packages/frontend/src/demo/EntityRoster';
import { DemoAppearance } from '../packages/frontend/src/demo/DemoAppearance';
import { defaultWorkspaceLayout } from '../packages/frontend/src/demo/workspaceLayout';
import type { DemoSessionInfo } from '../packages/frontend/src/demo/types';

Object.assign(globalThis, { React });

const root = resolve(__dirname, '..');
const frontend = join(root, 'packages/frontend/dist');
const database = join(root, 'packages/backend/prisma/dev.db');
const hash = () => existsSync(database) ? createHash('sha256').update(readFileSync(database)).digest('hex') : null;
const originalHash = hash();
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'elysian-lan-browser-')));
const artifacts = join(root, '.tmp', `lan-browser-${Date.now()}`);
mkdirSync(artifacts, { recursive: true });
const credential = randomBytes(24).toString('hex');
const joinCode = randomBytes(5).toString('hex').toUpperCase();
const secrets = new Set([credential, joinCode]);
const output: string[] = [];
const reports: Array<{ scenario: string; status: string; error?: string }> = [];
const contexts: BrowserContext[] = [];
const views: View[] = [];
const cancellation = new AbortController();
let serverFailure: Error | undefined;
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let url = '';
let environmentStage = true;
const ids = ['demo-player-melee', 'demo-player-ranged', 'demo-player-guide', 'demo-monster-bruiser'];

interface SocketMetricBucket { count: number; jsonBytes: number; }
interface SocketFrameMetrics {
  demoIncrement: SocketMetricBucket;
  demoSnapshot: SocketMetricBucket;
  commandAckSnapshot: SocketMetricBucket;
  sameRevisionFrames: number;
  staleRevisionFrames: number;
}
interface View { page: Page; context: BrowserContext; role: 'GM' | 'PL'; snapshot?: EncounterSnapshot; leaks: string[]; errors: string[]; socketMetrics: SocketFrameMetrics; lastSocketSnapshot?: { encounterId: string; revision: number }; }

function emptySocketMetricBucket(): SocketMetricBucket {
  return { count: 0, jsonBytes: 0 };
}

function emptySocketFrameMetrics(): SocketFrameMetrics {
  return {
    demoIncrement: emptySocketMetricBucket(),
    demoSnapshot: emptySocketMetricBucket(),
    commandAckSnapshot: emptySocketMetricBucket(),
    sameRevisionFrames: 0,
    staleRevisionFrames: 0,
  };
}

function isSnapshot(value: unknown): value is EncounterSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.encounterId === 'string' &&
    typeof record.revision === 'number' &&
    typeof record.tick === 'number' &&
    Array.isArray(record.entities) &&
    Array.isArray(record.actions) &&
    Array.isArray(record.decisions) &&
    Array.isArray(record.controls) &&
    Array.isArray(record.logs) &&
    typeof record.plan === 'object' && record.plan !== null;
}

function snapshotFromSocketValue(value: unknown): EncounterSnapshot | undefined {
  if (isSnapshot(value)) return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const snapshot = (value as Record<string, unknown>).snapshot;
  return isSnapshot(snapshot) ? snapshot : undefined;
}

function commandResultSnapshot(value: unknown): EncounterSnapshot | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.requestId !== 'string' || typeof record.ok !== 'boolean' || typeof record.success !== 'boolean') return undefined;
  return snapshotFromSocketValue(record);
}

interface ParsedSocketSnapshot {
  kind: 'demoIncrement' | 'demoSnapshot' | 'commandAckSnapshot';
  snapshot: EncounterSnapshot;
  jsonBytes: number;
}

function parseSocketSnapshotFrame(frame: string): ParsedSocketSnapshot | undefined {
  const match = /^4[23]\d*(\[.*)$/s.exec(frame);
  if (!match) return undefined;
  const json = match[1];
  let packet: unknown;
  try { packet = JSON.parse(json) as unknown; } catch { return undefined; }
  if (!Array.isArray(packet) || packet.length === 0) return undefined;
  const eventName = typeof packet[0] === 'string' ? packet[0] : undefined;
  const kind = eventName === 'DEMO_INCREMENT'
    ? 'demoIncrement'
    : eventName === 'DEMO_SNAPSHOT'
      ? 'demoSnapshot'
      : eventName === undefined
        ? 'commandAckSnapshot'
        : undefined;
  const snapshot = kind === 'commandAckSnapshot'
    ? commandResultSnapshot(packet[0])
    : kind
      ? snapshotFromSocketValue(packet[1])
      : undefined;
  if (!kind || !snapshot) return undefined;
  return kind ? { kind, snapshot, jsonBytes: Buffer.byteLength(json, 'utf8') } : undefined;
}

function recordSocketSnapshot(view: View, parsed: ParsedSocketSnapshot): void {
  const bucket = view.socketMetrics[parsed.kind];
  bucket.count += 1;
  bucket.jsonBytes += parsed.jsonBytes;
  const previous = view.lastSocketSnapshot;
  if (previous?.encounterId === parsed.snapshot.encounterId) {
    if (parsed.snapshot.revision === previous.revision) view.socketMetrics.sameRevisionFrames += 1;
    if (parsed.snapshot.revision < previous.revision) view.socketMetrics.staleRevisionFrames += 1;
  }
  if (previous?.encounterId !== parsed.snapshot.encounterId || parsed.snapshot.revision > previous.revision) {
    view.lastSocketSnapshot = { encounterId: parsed.snapshot.encounterId, revision: parsed.snapshot.revision };
  }
  if (!view.snapshot || view.snapshot.encounterId !== parsed.snapshot.encounterId || parsed.snapshot.revision >= view.snapshot.revision) {
    view.snapshot = parsed.snapshot;
  }
}

function sumSocketFrameMetrics(values: SocketFrameMetrics[]): SocketFrameMetrics {
  const total = emptySocketFrameMetrics();
  for (const value of values) {
    for (const key of ['demoIncrement', 'demoSnapshot', 'commandAckSnapshot'] as const) {
      total[key].count += value[key].count;
      total[key].jsonBytes += value[key].jsonBytes;
    }
    total.sameRevisionFrames += value.sameRevisionFrames;
    total.staleRevisionFrames += value.staleRevisionFrames;
  }
  return total;
}

function socketMetricsReport(): { definition: string; observedPageCount: number; byRole: Record<View['role'], SocketFrameMetrics>; total: SocketFrameMetrics } {
  const byRole = {
    GM: sumSocketFrameMetrics(views.filter(view => view.role === 'GM').map(view => view.socketMetrics)),
    PL: sumSocketFrameMetrics(views.filter(view => view.role === 'PL').map(view => view.socketMetrics)),
  } satisfies Record<View['role'], SocketFrameMetrics>;
  return {
    definition: 'Received state events and command ACKs on the four primary pages plus the fresh GM page after restart. The auxiliary popup, HTTP, roster and other packets are excluded. jsonBytes is the UTF-8 length of the decoded Socket.IO JSON packet array (including an event name when present), excluding protocol framing; it is not network bandwidth or a store/render count.',
    observedPageCount: views.length,
    byRole,
    total: sumSocketFrameMetrics(Object.values(byRole)),
  };
}
function redact(text: string): string {
  let value = text.replace(/\b(?:demo|tok|sess|session|gm)_[A-Za-z0-9_-]+\b/g, '[REDACTED]');
  for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
  return value;
}
async function until(test: () => boolean | Promise<boolean>, message: string, timeout = 15000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await test()) {
    cancellation.signal.throwIfAborted();
    if (serverFailure) throw serverFailure;
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
}
async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  cancellation.signal.throwIfAborted();
  console.log(`[browser] ${name}`);
  try { await run(); reports.push({ scenario: name, status: 'passed' }); }
  catch (error) { reports.push({ scenario: name, status: 'failed', error: redact(String(error)) }); throw error; }
}
async function compileFixture(): Promise<string> {
  const outfile = join(temporary, 'fixture.cjs');
  const backendRequire = createRequire(join(root, 'packages/backend/package.json'));
  const result = await build({
    entryPoints: [join(__dirname, 'lan-browser.fixture.ts')], outfile,
    bundle: true, platform: 'node', target: 'node22', format: 'cjs', metafile: true,
    plugins: [{ name: 'current-typescript', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path.startsWith('node:')) return { path: args.path, external: true };
        if (args.path === '@hard-vtt/shared') return { path: join(root, 'packages/shared/src/index.ts') };
        if (args.path.startsWith('.') || args.path.startsWith(root)) {
          const target = resolve(args.resolveDir || root, args.path);
          const source = target.replace(/\.js$/, '.ts');
          if (existsSync(source)) return { path: source };
          return undefined;
        }
        const resolved = backendRequire.resolve(args.path);
        return { path: resolved, external: true };
      });
    } }],
  });
  assert.ok(!Object.keys(result.metafile!.inputs).some(name => /packages\/(backend|shared)\/src\/.*\.js$/.test(name.replaceAll('\\', '/'))));
  return outfile;
}
async function startServer(fixture: string): Promise<number> {
  cancellation.signal.throwIfAborted();
  const processChild = fork(fixture, [], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_ENV: 'test', LAN_TEST_DIRECTORY: join(temporary, 'data'),
      LAN_TEST_FRONTEND: frontend, LAN_TEST_CREDENTIAL: credential, LAN_TEST_JOIN_CODE: joinCode },
  });
  child = processChild;
  processChild.on('exit', code => {
    if (child === processChild) serverFailure = new Error(`SERVER_EXITED: ${code}`);
  });
  processChild.stdout?.on('data', data => output.push(String(data)));
  processChild.stderr?.on('data', data => output.push(String(data)));
  return new Promise<number>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('SERVER_START_FAILED: readiness timeout')), 15000);
    const fail = (error: Error) => { clearTimeout(timer); reject(error); };
    processChild.once('error', fail);
    processChild.once('exit', code => fail(new Error(`SERVER_START_FAILED: exit ${code}`)));
    processChild.on('message', message => {
      const packet = message as { type?: string; url?: string; pid?: number };
      if (packet.type === 'ready' && packet.url && packet.pid) {
        clearTimeout(timer); url = packet.url; resolveReady(packet.pid);
      }
    });
  });
}
async function stopServer(): Promise<void> {
  const running = child;
  if (!running || running.exitCode !== null) return;
  child = undefined;
  await new Promise<void>((resolveExit, reject) => {
    const force = setTimeout(() => running.kill(), 3000);
    const timer = setTimeout(() => { running.kill(); reject(new Error('SERVER_STOP_FAILED')); }, 10000);
    running.once('exit', () => { clearTimeout(force); clearTimeout(timer); resolveExit(); });
    if (running.connected) running.send('stop'); else running.kill();
  });
}
async function persistence(): Promise<{ record: { result?: { status: string }; openingSnapshot: EncounterSnapshot }; history: unknown[] }> {
  assert.ok(child?.connected);
  const running = child;
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => { running.off('message', onMessage); reject(new Error('Persistence IPC timeout')); }, 3000);
    const onMessage = (message: unknown) => {
      const packet = message as { type: string; record: { result?: { status: string }; openingSnapshot: EncounterSnapshot }; history: unknown[] };
      if (packet.type === 'persistence') { clearTimeout(timer); running.off('message', onMessage); resolveMessage(packet); }
    };
    running.on('message', onMessage);
    running.send('persistence');
  });
}
function observe(view: View): void {
  view.page.on('console', message => { if (message.type() === 'error') output.push(message.text()); });
  view.page.on('pageerror', error => { view.errors.push(error.message); });
  view.page.on('response', async response => {
    if (!response.url().includes('/api/demo/')) return;
    try {
      const body = await response.json() as { data?: { accessToken?: string } };
      if (body.data?.accessToken) secrets.add(body.data.accessToken);
      const text = JSON.stringify(body);
      if (view.role === 'PL' && /lan-secret-prop|LAN_SECRET_ENTITY/.test(text)) view.leaks.push('HTTP hidden entity');
    } catch { /* Aborted requests during the intentional offline scenario. */ }
  });
  view.page.on('websocket', socket => socket.on('framereceived', event => {
    const text = event.payload.toString();
    if (view.role === 'PL' && /lan-secret-prop|LAN_SECRET_ENTITY/.test(text)) view.leaks.push('Socket hidden entity');
    const parsed = parseSocketSnapshotFrame(text);
    if (parsed) recordSocketSnapshot(view, parsed);
  }));
}
async function newView(role: View['role']): Promise<View> {
  cancellation.signal.throwIfAborted();
  assert.ok(browser);
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  contexts.push(context);
  // Screenshots are saved separately with masks; trace contains text only and
  // is sanitized before it leaves the temporary directory.
  await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
  const view: View = { context, page: await context.newPage(), role, leaks: [], errors: [], socketMetrics: emptySocketFrameMetrics() };
  view.page.setDefaultTimeout(10000);
  views.push(view); observe(view);
  return view;
}
async function login(view: View, name: string): Promise<void> {
  await view.page.goto(url);
  if (view.role === 'PL') await view.page.getByRole('button', { name: '玩家加入', exact: true }).click();
  await view.page.getByLabel('昵称', { exact: true }).fill(name);
  await view.page.getByLabel(view.role === 'GM' ? /^主持凭据/ : '房间加入码').fill(view.role === 'GM' ? credential : joinCode);
  await view.page.getByRole('button', { name: view.role === 'GM' ? '进入主持大厅' : '加入遭遇', exact: true }).click();
  await view.page.getByRole('heading', { name: '在线玩家', exact: true }).waitFor();
  await until(() => Boolean(view.snapshot), `${name}: initial snapshot missing`);
}
function entity(view: View, id: string) { return view.snapshot?.entities.find(item => item.id === id); }
const panelTitles = { actions: '行动与反应', entities: '实体列表', timeline: '战术时间轴', logs: '战斗日志', gm: '主持工具' } as const;
type WorkspacePanelId = keyof typeof panelTitles;
const panel = (page: Page, id: WorkspacePanelId) => page.locator(`.workspace-window[data-panel="${id}"]`);
const dockTab = (page: Page, id: WorkspacePanelId) => page.locator(`.workspace-dock-tab[data-panel="${id}"]`);
async function pinPanel(page: Page, id: WorkspacePanelId): Promise<void> {
  const windowPanel = panel(page, id);
  if (await windowPanel.getAttribute('aria-hidden') === 'true' || await windowPanel.getAttribute('hidden') !== null) {
    if (await dockTab(page, id).isVisible()) await dockTab(page, id).click();
    else {
      await page.getByRole('button', { name: '工作台菜单', exact: true }).click();
      await page.getByRole('navigation', { name: '工作区模块' }).getByRole('button', { name: new RegExp(`^${panelTitles[id]}`) }).click();
    }
  }
  const pin = windowPanel.locator('.workspace-pin');
  await pin.waitFor({ state: 'visible' });
  if (await pin.getAttribute('aria-pressed') !== 'true') await pin.click();
  await until(async () => await pin.getAttribute('aria-pressed') === 'true', `${panelTitles[id]} did not retain its pin`);
}
async function pinCommonPanels(page: Page): Promise<void> {
  for (const id of ['actions', 'entities', 'timeline'] as const) await pinPanel(page, id);
}
async function select(view: View, id: string): Promise<void> {
  if (view.role === 'GM') {
    if (await view.page.locator('.workspace').count()) await pinPanel(view.page, 'entities');
    await view.page.locator(`.demo-entity-roster-row[data-entity-id="${id}"] .demo-entity-roster-select`).click();
  }
  else await view.page.locator(`.demo-entity-token[data-entity-id="${id}"]`).click();
}
async function action(view: View, label: string, target: string | { x: number; y: number }): Promise<void> {
  await pinPanel(view.page, 'actions');
  await view.page.locator('.demo-action-card').filter({ has: view.page.getByText(label, { exact: true }) }).click();
  const locator = typeof target === 'string'
    ? view.page.locator(`.demo-entity-token.is-legal[data-entity-id="${target}"]`)
    : view.page.locator(`.demo-map-cell.is-legal[aria-label="格${target.x},${target.y}"]`);
  await locator.click();
  await view.page.locator('.demo-targeting-banner').waitFor({ state: 'hidden' });
}
async function waitAction(view: View): Promise<void> {
  await pinPanel(view.page, 'actions');
  await view.page.getByRole('button', { name: '等待 +5 Tick', exact: true }).click();
}
async function main(): Promise<void> {
  if (!existsSync(join(frontend, 'index.html'))) throw new Error('BUILD_MISSING: run pnpm build');
  if (!existsSync(chromium.executablePath())) throw new Error('BROWSER_MISSING: pnpm --filter test exec playwright install chromium');
  const fixture = await compileFixture();
  const firstPid = await startServer(fixture);
  browser = await chromium.launch({ headless: !process.argv.includes('--headed') && process.env.ELYSIAN_LAN_HEADED !== '1' });
  const gm = await newView('GM');
  const players = await Promise.all([newView('PL'), newView('PL'), newView('PL')]);
  environmentStage = false;
  await scenario('four isolated users join and GM assigns roles through UI', async () => {
    await login(gm, 'LAN GM');
    await select(gm, ids[1]);
    assert.ok(await gm.page.locator('.demo-gm-panel').getByRole('heading', { name: '游侠', exact: true }).isVisible(), 'the lobby roster selects the entity configured by the GM');
    for (const [index, player] of players.entries()) await login(player, `LAN P${index + 1}`);
    for (const [index, player] of players.entries()) {
      await gm.page.getByLabel(`LAN P${index + 1} 的角色`, { exact: true }).selectOption(ids[index]);
      await until(() => Boolean(player.snapshot?.controls.some(control => control.entityId === ids[index] && control.userId)), 'assigned control missing');
      assert.equal(await player.page.getByRole('heading', { name: '主持裁决台' }).count(), 0);
      assert.equal(await player.page.getByRole('button', { name: '开始遭遇', exact: true }).count(), 0);
    }
    assert.equal(gm.snapshot?.controls.filter(control => control.connectedSocketIds.length > 0 && control.role === 'PL').length, 3);
    await gm.page.getByRole('button', { name: '开始遭遇', exact: true }).click();
    await Promise.all(views.map(view => dockTab(view.page, 'entities').waitFor()));
    for (const view of [gm, ...players]) {
      assert.equal(await view.page.getByLabel('操控实体', { exact: true }).count(), 0, 'entity selection is handled by the roster');
      assert.equal(await view.page.locator('.workspace-map .demo-panel-heading, .workspace-map .demo-inspected').count(), 0, 'the background map has no redundant heading or entity summary');
      const viewport = view.page.viewportSize()!;
      assert.deepEqual(await view.page.locator('.workspace-map .demo-battlefield-wrap').boundingBox(), { x: 0, y: 0, width: viewport.width, height: viewport.height }, 'the map canvas reaches every viewport edge');
    }
  });

  await scenario('desktop windows auto-hide at the edge and pins preserve explicit visibility', async () => {
    const page = gm.page;
    await page.mouse.move(800, 500);
    for (const view of [gm, ...players]) {
      assert.equal(await view.page.locator('.workspace-dock-tab').count(), view.role === 'GM' ? 5 : 4);
      for (const id of Object.keys(panelTitles) as WorkspacePanelId[]) {
        if (id === 'gm' && view.role !== 'GM') continue;
        await panel(view.page, id).waitFor({ state: 'hidden' });
        assert.equal(await panel(view.page, id).getAttribute('aria-hidden'), 'true');
        assert.ok(await panel(view.page, id).evaluate(node => node.hasAttribute('inert')), 'retracted content cannot take keyboard focus');
        assert.ok(await dockTab(view.page, id).isVisible(), 'each unhidden window leaves its name at the edge');
      }
    }
    const leftRail = page.getByRole('navigation', { name: '左侧窗口', exact: true });
    assert.deepEqual(await leftRail.locator('.workspace-dock-tab').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-panel'))), ['logs', 'gm'], 'default same-edge labels follow the vertical order of their windows');
    const logLabel = await dockTab(page, 'logs').boundingBox();
    const gmLabel = await dockTab(page, 'gm').boundingBox();
    assert.ok(logLabel && gmLabel && logLabel.y + logLabel.height <= gmLabel.y, 'same-edge labels never overlap');
    const menuBox = await page.getByRole('button', { name: '工作台菜单', exact: true }).boundingBox();
    assert.ok(menuBox);
    for (const id of ['timeline', 'entities'] as const) {
      const label = await dockTab(page, id).boundingBox();
      assert.ok(label && (label.x + label.width <= menuBox.x || menuBox.x + menuBox.width <= label.x || label.y + label.height <= menuBox.y || menuBox.y + menuBox.height <= label.y), 'top and right labels leave the corner menu reachable');
    }
    await page.screenshot({ path: join(artifacts, 'workspace-auto-hidden.png'), fullPage: true });
    const logs = panel(page, 'logs');
    const logTab = dockTab(page, 'logs');
    await logTab.hover();
    await logs.waitFor({ state: 'visible' });
    assert.equal(await logTab.getAttribute('aria-expanded'), 'true');
    await logs.hover();
    await page.mouse.move(800, 500);
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    assert.ok(await logs.isVisible(), 'leaving the window allows a short return interval');
    await logTab.hover();
    await new Promise<void>(resolve => setTimeout(resolve, 650));
    assert.ok(await logs.isVisible(), 'returning before the deadline cancels retraction');
    await page.mouse.move(800, 500);
    await logs.waitFor({ state: 'hidden' });
    await logTab.press('Enter');
    await logs.waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '最小化战斗日志', exact: true }).click();
    await logs.waitFor({ state: 'hidden' });
    await new Promise<void>(resolve => setTimeout(resolve, 350));
    assert.equal(await logs.isVisible(), false, 'manual minimization does not immediately reopen under the old pointer position');
    await logTab.click();
    const gripLocator = logs.getByRole('button', { name: '移动战斗日志窗口', exact: true });
    await gripLocator.hover();
    const grip = await gripLocator.boundingBox();
    assert.ok(grip);
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + grip.height / 2 + 40, { steps: 5 });
    await new Promise<void>(resolve => setTimeout(resolve, 750));
    assert.ok(await logs.isVisible(), 'an active drag keeps an unpinned window expanded');
    await page.mouse.up();
    await page.getByRole('button', { name: '固定战斗日志', exact: true }).click();
    await page.mouse.move(800, 500);
    await new Promise<void>(resolve => setTimeout(resolve, 750));
    assert.ok(await logs.isVisible(), 'pinned windows remain expanded after leaving');
    await page.getByRole('button', { name: '最小化战斗日志', exact: true }).click();
    await logs.waitFor({ state: 'hidden' });
    await logTab.hover();
    await new Promise<void>(resolve => setTimeout(resolve, 350));
    assert.equal(await logs.isVisible(), false, 'hover never restores a manually minimized pinned window');
    await logTab.click();
    await logs.waitFor({ state: 'visible' });
    assert.ok(await logs.getByRole('button', { name: '取消固定战斗日志', exact: true }).isVisible(), 'manual restore retains the pin');
    await page.getByRole('button', { name: '取消固定战斗日志', exact: true }).click();
    await page.mouse.move(800, 500);
    await logs.waitFor({ state: 'hidden' });
    await logTab.click();
    await page.getByRole('button', { name: '隐藏战斗日志', exact: true }).click();
    assert.equal(await logTab.count(), 0, 'hidden windows remove their edge labels');
    await page.getByRole('button', { name: '工作台菜单', exact: true }).click();
    await page.getByRole('navigation', { name: '工作区模块' }).getByRole('button', { name: /^战斗日志/ }).click();
    await logs.waitFor({ state: 'visible' });
    await page.mouse.move(800, 500);
    await new Promise<void>(resolve => setTimeout(resolve, 750));
    assert.ok(await logs.isVisible(), 'a menu-opened window waits for the user to enter or dismiss it');
    assert.ok(await logs.getByRole('button', { name: '固定战斗日志', exact: true }).isVisible(), 'menu restoration does not change the pin');
    await page.mouse.click(1540, 940);
    await logs.waitFor({ state: 'hidden' });

    await dockTab(page, 'gm').click();
    const hp = page.getByPlaceholder('HP', { exact: true });
    const originalHp = await hp.inputValue();
    await hp.fill('61');
    await page.mouse.move(800, 500);
    await new Promise<void>(resolve => setTimeout(resolve, 750));
    assert.ok(await panel(page, 'gm').isVisible(), 'editing a form keeps its window expanded after pointer exit');
    await page.mouse.click(1540, 940);
    await panel(page, 'gm').waitFor({ state: 'hidden' });
    await dockTab(page, 'gm').click();
    assert.equal(await hp.inputValue(), '61', 'retraction keeps the form draft mounted');
    await hp.fill(originalHp);
    await page.mouse.click(1540, 940);
    await panel(page, 'gm').waitFor({ state: 'hidden' });

    const player = players[0];
    await dockTab(player.page, 'actions').click();
    await player.page.locator('.demo-action-card').filter({ hasText: '移动' }).click();
    await player.page.locator('.demo-targeting-banner').waitFor();
    await player.page.mouse.move(800, 500);
    await panel(player.page, 'actions').waitFor({ state: 'hidden' });
    assert.ok(await player.page.locator('.demo-targeting-banner').isVisible(), 'retracting the action window preserves map targeting');
    await player.page.locator('.demo-targeting-banner').getByRole('button', { name: '取消', exact: true }).click();

    const timeline = panel(page, 'timeline');
    const timelineTab = dockTab(page, 'timeline');
    const timelineOptions = timeline.getByLabel('时间轴选项', { exact: true });
    await timelineTab.click();
    await timelineOptions.click();
    await timeline.getByRole('button', { name: '跟随当前', exact: true }).click();
    await page.mouse.move(800, 500);
    await new Promise<void>(resolve => setTimeout(resolve, 750));
    assert.ok(await timeline.isVisible(), 'mouse focus inside an open options menu holds an unpinned timeline');
    await page.mouse.click(1540, 940);
    await timeline.waitFor({ state: 'hidden' });
    assert.ok(await timeline.locator('.timeline-options').evaluate(node => (node as HTMLDetailsElement).open), 'retraction preserves the mounted menu state');
    await timelineTab.click();
    await timeline.locator('.demo-timeline-scroll').hover();
    await page.mouse.move(800, 500);
    await timeline.waitFor({ state: 'hidden' });
    assert.equal(await timeline.getAttribute('aria-hidden'), 'true', 'an unfocused mounted menu does not permanently block retraction');
    await timelineTab.click();
    await timelineOptions.click();
    await page.mouse.move(800, 500);
    await timeline.waitFor({ state: 'hidden' });

    // Supply touch pointer events on the existing desktop viewport. These are
    // UI events only; no component, storage or encounter state is injected.
    const touch = { pointerType: 'touch', pointerId: 71, isPrimary: true, button: 0 };
    const touchTap = async (target: Locator) => {
      await target.dispatchEvent('pointerover', touch);
      await target.dispatchEvent('pointerdown', touch);
      await target.focus();
      await target.dispatchEvent('pointerup', touch);
      await target.dispatchEvent('click');
      await target.dispatchEvent('pointerout', touch);
    };
    await touchTap(dockTab(player.page, 'actions'));
    await panel(player.page, 'actions').waitFor({ state: 'visible' });
    await touchTap(player.page.getByRole('region', { name: '角色动作栏', exact: true }).getByRole('button', { name: '全部', exact: true }));
    await new Promise<void>(resolve => setTimeout(resolve, 750));
    assert.ok(await panel(player.page, 'actions').isVisible(), 'touch pointerleave after a regular button does not retract a tapped-open window');
    await player.page.locator('.workspace-map').dispatchEvent('pointerdown', touch);
    await panel(player.page, 'actions').waitFor({ state: 'hidden' });
    for (const view of [gm, ...players]) await pinCommonPanels(view.page);
    await page.screenshot({ path: join(artifacts, 'workspace-pinned.png'), fullPage: true });
  });

  await scenario('roster selection replaces map chrome without submitting actions or transferring control', async () => {
    const controlsBefore = JSON.stringify(gm.snapshot!.controls);
    const plansBefore = JSON.stringify(gm.snapshot!.plan.actions);
    const player = players[0];
    const roster = player.page.getByRole('region', { name: '实体列表窗口', exact: true });
    const foreign = roster.locator(`.demo-entity-roster-row[data-entity-id="${ids[1]}"] .demo-entity-roster-select`);
    await foreign.press('Enter');
    assert.equal(await foreign.getAttribute('aria-pressed'), 'true', 'keyboard selection can inspect a visible entity controlled by someone else');
    assert.equal(await player.page.getByRole('button', { name: '等待 +5 Tick', exact: true }).isEnabled(), false, 'inspecting another entity does not grant control');
    assert.match(await player.page.locator('.workspace-window[data-panel="actions"]').innerText(), /角色不在你的控制权内/);
    await roster.locator(`.demo-entity-roster-row[data-entity-id="${ids[0]}"] .demo-entity-roster-select`).click();
    assert.ok(await player.page.getByRole('button', { name: '等待 +5 Tick', exact: true }).isEnabled());

    await select(gm, ids[0]);
    const mapBefore = await gm.page.locator('.demo-battlefield-wrap').boundingBox();
    await gm.page.locator('.demo-action-card').filter({ hasText: '移动' }).click();
    await gm.page.locator('.demo-targeting-banner').waitFor();
    assert.deepEqual(await gm.page.locator('.demo-battlefield-wrap').boundingBox(), mapBefore, 'temporary targeting information never resizes the background map');
    await select(gm, ids[3]);
    await gm.page.locator('.demo-targeting-banner').waitFor({ state: 'hidden' });
    assert.ok(await gm.page.locator(`.demo-entity-token[data-entity-id="${ids[3]}"]`).evaluate(node => node.classList.contains('is-selected')), 'changing the roster selection cancels targeting and updates the map');
    assert.equal(JSON.stringify(gm.snapshot!.plan.actions), plansBefore, 'selection and preview never submit an action');
    assert.equal(JSON.stringify(gm.snapshot!.controls), controlsBefore, 'local selection never transfers entity control');
  });

  await scenario('modular workspace floats, resizes, restores and adapts to compact viewports', async () => {
    assert.equal(await gm.page.locator('.demo-notices').evaluate(node => getComputedStyle(node).left), '20px', 'notifications stay away from the right action column');
    const logWindow = panel(gm.page, 'logs');
    await pinPanel(gm.page, 'logs');
    await until(() => logWindow.evaluate(node => node.classList.contains('is-floating')), 'log window did not float');
    const mapBefore = await gm.page.locator('.workspace-map').boundingBox();
    const before = await logWindow.boundingBox();
    assert.ok(before);
    const drag = gm.page.getByRole('button', { name: '移动战斗日志窗口', exact: true });
    await drag.focus();
    await drag.press('ArrowRight');
    const moved = await logWindow.boundingBox();
    assert.ok(moved && moved.x > before.x, 'keyboard movement changes window position');
    const resize = gm.page.getByRole('button', { name: '调整战斗日志窗口大小', exact: true });
    await resize.focus();
    await resize.press('ArrowRight');
    const resized = await logWindow.boundingBox();
    assert.ok(resized && resized.width > before.width, 'keyboard resize changes window width');
    await drag.hover();
    const handle = await drag.boundingBox();
    assert.ok(handle);
    await gm.page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await gm.page.mouse.down();
    await gm.page.mouse.move(handle.x + handle.width / 2 + 60, handle.y + handle.height / 2 + 40, { steps: 5 });
    await gm.page.mouse.up();
    const dragged = await logWindow.boundingBox();
    assert.ok(dragged && dragged.x > resized.x && dragged.y > resized.y, 'pointer drag moves the floating window');
    assert.deepEqual(await gm.page.locator('.workspace-map').boundingBox(), mapBefore, 'window movement never reflows the base map');
    await gm.page.getByRole('button', { name: '最小化战斗日志', exact: true }).click();
    await logWindow.waitFor({ state: 'hidden' });
    await dockTab(gm.page, 'logs').click();
    await gm.page.getByRole('button', { name: '隐藏战斗日志', exact: true }).click();
    await logWindow.waitFor({ state: 'hidden' });
    await until(() => gm.page.evaluate(() => {
      const value = JSON.parse(localStorage.getItem('elysian-workspace-v3-GM') ?? '{}');
      return value.panels?.logs?.hidden === true;
    }), 'the hidden state did not persist before restoration');
    await gm.page.getByRole('button', { name: '工作台菜单', exact: true }).click();
    await gm.page.getByRole('navigation', { name: '工作区模块' }).getByRole('button', { name: /^战斗日志/ }).click();
    await logWindow.waitFor({ state: 'visible' });
    await until(() => gm.page.evaluate(() => {
      const value = JSON.parse(localStorage.getItem('elysian-workspace-v3-GM') ?? '{}');
      return value.version === 3 && value.panels?.logs?.pinned === true && !value.panels.logs.hidden && !value.panels.logs.collapsed;
    }), 'layout did not persist');
    await gm.page.reload();
    await logWindow.waitFor({ state: 'visible' });
    assert.ok(await logWindow.getByRole('button', { name: '取消固定战斗日志', exact: true }).isVisible(), 'reload preserves the restored window pin');
    await until(() => logWindow.evaluate(node => node.classList.contains('is-floating')), 'reload did not restore floating window');
    await gm.page.setViewportSize({ width: 820, height: 900 });
    await until(() => logWindow.evaluate(node => { const rect = node.getBoundingClientRect(); return node.classList.contains('is-floating') && rect.right <= innerWidth && rect.bottom <= innerHeight; }), 'compact view keeps floating panels within viewport');
    assert.ok(await gm.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'compact viewport has no page overflow');
    await gm.page.setViewportSize({ width: 1600, height: 1000 });
    await gm.page.getByRole('button', { name: '工作台菜单', exact: true }).click();
    await gm.page.getByRole('button', { name: '恢复默认布局', exact: true }).click();
    await pinCommonPanels(gm.page);
    await logWindow.waitFor({ state: 'hidden' });
    await dockTab(gm.page, 'logs').click();
    await gm.page.getByRole('button', { name: '隐藏战斗日志', exact: true }).click();
    await gm.page.getByRole('button', { name: '工作台菜单', exact: true }).click();
    await gm.page.getByRole('navigation', { name: '工作区模块' }).getByRole('button', { name: /^战斗日志/ }).click();
    await logWindow.waitFor({ state: 'visible' });
    await until(() => logWindow.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.top >= 12 && rect.top < innerHeight - 40;
    }), 'reopened docked panel should scroll into view below the header');
    await gm.page.getByRole('button', { name: '工作台菜单', exact: true }).click();
    await gm.page.getByRole('button', { name: '恢复默认布局', exact: true }).click();
    await pinCommonPanels(gm.page);
    const timelineWindow = gm.page.getByRole('region', { name: '战术时间轴窗口', exact: true });
    const timelineBox = await timelineWindow.boundingBox();
    assert.equal(await gm.page.locator('.workspace-toolbar').count(), 0, 'the page has no permanent top toolbar');
    const rosterBox = await gm.page.locator('.workspace-window[data-panel="entities"]').boundingBox();
    assert.ok(timelineBox && rosterBox && timelineBox.x + timelineBox.width < rosterBox.x && timelineBox.y <= 28, 'docked timeline sits below its top edge label beside the roster');
    assert.equal((await gm.page.locator('.workspace-map').boundingBox())?.y, 0, 'map reaches the top of the page');
    await gm.page.getByRole('button', { name: '工作台菜单', exact: true }).click();
    await gm.page.keyboard.press('Escape');
    assert.equal(await gm.page.getByRole('button', { name: '工作台菜单', exact: true }).getAttribute('aria-expanded'), 'false', 'Escape dismisses the corner menu');
    assert.ok(await timelineWindow.locator('.demo-timeline-lane').nth(2).evaluate(node => {
      const rect = node.getBoundingClientRect();
      const body = node.closest('.workspace-window-body')!.getBoundingClientRect();
      return rect.top >= body.top && rect.bottom <= body.bottom;
    }), 'compact timeline exposes at least three complete actor lanes');
    for (const bar of await gm.page.locator('.workspace-window-bar').all()) {
      assert.doesNotMatch(await bar.innerText(), /\b0[0-9]\b/, 'window chrome has no decorative sequence number');
    }
    const dragIntoBottomLeftCorner = async (id: 'timeline' | 'entities', lastDirection: 'left' | 'bottom') => {
      const windowPanel = panel(gm.page, id);
      const grip = windowPanel.getByRole('button', { name: `移动${panelTitles[id]}窗口`, exact: true });
      await grip.hover();
      const initial = await windowPanel.boundingBox();
      const handle = await grip.boundingBox();
      assert.ok(initial && handle);
      const pointer = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
      const bottom = gm.page.viewportSize()!.height - initial.height - 12;
      const moveTo = (x: number, y: number) => gm.page.mouse.move(pointer.x + x - initial.x, pointer.y + y - initial.y, { steps: 4 });
      await gm.page.mouse.move(pointer.x, pointer.y);
      await gm.page.mouse.down();
      // Overshoot the 12px fitted bounds slightly, so the last effective
      // segment is horizontal/vertical even after clamping at the corner.
      if (lastDirection === 'left') {
        await moveTo(92, bottom + 16);
        await moveTo(-4, bottom + 16);
      } else {
        await moveTo(-4, bottom - 80);
        await moveTo(-4, bottom + 16);
      }
      await gm.page.mouse.up();
      const corner = await windowPanel.boundingBox();
      assert.ok(corner && Math.abs(corner.x - 12) < 1 && Math.abs(corner.y - bottom) < 1, 'the pointer drag reaches an equal-distance bottom-left corner');
      assert.equal(await windowPanel.getAttribute('data-dock-edge'), lastDirection, 'a corner tie follows the last fitted drag segment when the previous edge is not tied');
      await windowPanel.getByRole('button', { name: `最小化${panelTitles[id]}`, exact: true }).click();
      await windowPanel.waitFor({ state: 'hidden' });
      assert.equal(await dockTab(gm.page, id).evaluate(node => node.closest('.workspace-dock-rail')?.getAttribute('data-dock-edge')), lastDirection, 'minimization uses the selected corner edge');
      await dockTab(gm.page, id).click();
      await windowPanel.waitFor({ state: 'visible' });
    };
    assert.equal(await panel(gm.page, 'timeline').getAttribute('data-dock-edge'), 'top');
    await dragIntoBottomLeftCorner('timeline', 'left');
    assert.equal(await panel(gm.page, 'entities').getAttribute('data-dock-edge'), 'right');
    await dragIntoBottomLeftCorner('entities', 'bottom');
    await gm.page.getByRole('button', { name: '工作台菜单', exact: true }).click();
    await gm.page.getByRole('button', { name: '恢复默认布局', exact: true }).click();
    await pinCommonPanels(gm.page);
    const dragPinnedWindowTo = async (id: 'actions' | 'entities', x: number, y: number, edge: 'bottom' | 'right') => {
      const windowPanel = panel(gm.page, id);
      const grip = windowPanel.getByRole('button', { name: `移动${panelTitles[id]}窗口`, exact: true });
      await grip.hover();
      const initial = await windowPanel.boundingBox();
      const handle = await grip.boundingBox();
      assert.ok(initial && handle);
      const pointer = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
      const moveTo = (nextX: number, nextY: number) => gm.page.mouse.move(pointer.x + nextX - initial.x, pointer.y + nextY - initial.y, { steps: 4 });
      await gm.page.mouse.move(pointer.x, pointer.y);
      await gm.page.mouse.down();
      if (edge === 'bottom') {
        await moveTo(x, y - 40);
        await moveTo(x, y + 16);
      } else {
        await moveTo(x - 40, y);
        await moveTo(x + 16, y);
      }
      await gm.page.mouse.up();
      const expanded = await windowPanel.boundingBox();
      assert.ok(expanded && Math.abs(expanded.x - x) < 1 && Math.abs(expanded.y - y) < 1, 'the pinned window reaches the requested edge position');
      assert.equal(await windowPanel.getAttribute('data-dock-edge'), edge);
      await windowPanel.getByRole('button', { name: `最小化${panelTitles[id]}`, exact: true }).click();
      await windowPanel.waitFor({ state: 'hidden' });
      const label = await dockTab(gm.page, id).boundingBox();
      assert.ok(label);
      const labelCenter = edge === 'bottom' ? label.x + label.width / 2 : label.y + label.height / 2;
      const windowCenter = edge === 'bottom' ? expanded.x + expanded.width / 2 : expanded.y + expanded.height / 2;
      assert.ok(Math.abs(labelCenter - windowCenter) < 1, 'the edge label follows the projected center of its own window');
      await dockTab(gm.page, id).click();
      await grip.hover();
      const restored = await windowPanel.boundingBox();
      assert.ok(restored && Math.abs(restored.x - expanded.x) < 1 && Math.abs(restored.y - expanded.y) < 1, 'clicking the label restores the saved window position');
      return labelCenter;
    };
    const workspaceViewport = gm.page.viewportSize()!;
    const pinnedActions = await panel(gm.page, 'actions').boundingBox();
    assert.ok(pinnedActions);
    const bottom = workspaceViewport.height - pinnedActions.height - 12;
    const labelCenters: number[] = [];
    for (const x of [12, (workspaceViewport.width - pinnedActions.width) / 2, workspaceViewport.width - pinnedActions.width - 12]) {
      labelCenters.push(await dragPinnedWindowTo('actions', x, bottom, 'bottom'));
    }
    assert.ok(labelCenters[0] < labelCenters[1] && labelCenters[1] < labelCenters[2], 'the same bottom label follows left, center and right window positions');
    const pinnedEntities = await panel(gm.page, 'entities').boundingBox();
    assert.ok(pinnedEntities);
    await dragPinnedWindowTo('entities', workspaceViewport.width - pinnedEntities.width - 12, 350, 'right');
    await gm.page.getByRole('button', { name: '工作台菜单', exact: true }).click();
    await gm.page.getByRole('button', { name: '恢复默认布局', exact: true }).click();
    await pinCommonPanels(gm.page);
    const actionWindow = players[0].page.getByRole('region', { name: '行动与反应窗口', exact: true });
    const actionBefore = await actionWindow.boundingBox();
    const actionGrip = players[0].page.getByRole('button', { name: '移动行动与反应窗口', exact: true });
    await actionGrip.focus();
    await actionGrip.press('ArrowRight');
    const actionMoved = await actionWindow.boundingBox();
    assert.ok(actionBefore && actionMoved && actionMoved.x > actionBefore.x, 'compact action grip supports keyboard movement');
    await players[0].page.getByRole('button', { name: '最小化行动与反应', exact: true }).click();
    await actionWindow.waitFor({ state: 'hidden' });
    assert.match(await dockTab(players[0].page, 'actions').innerText(), /行动与反应/, 'minimized action window keeps its visible edge name');
    await players[0].page.getByRole('button', { name: '展开行动与反应', exact: true }).click();
    await actionWindow.locator('.workspace-window-body').waitFor({ state: 'visible' });
    await players[0].page.getByRole('button', { name: '工作台菜单', exact: true }).click();
    await players[0].page.getByRole('button', { name: '恢复默认布局', exact: true }).click();
    await pinCommonPanels(players[0].page);
    const timelineHeader = timelineWindow.locator('.demo-timeline-header');
    assert.ok(await timelineHeader.isVisible(), 'the timeline retains its own header independently of the page toolbar');
    assert.ok(await timelineHeader.getByRole('heading', { name: /战术时间轴/ }).isVisible());
    assert.match(await timelineHeader.getByLabel('当前 Tick', { exact: true }).innerText(), new RegExp(`\\b${gm.snapshot!.tick}\\b`));
    assert.match(await timelineHeader.innerText(), /等待多人提交/, 'waiting status is visible without opening the options menu');
    await timelineWindow.getByLabel('时间轴选项', { exact: true }).click();
    await timelineWindow.getByRole('button', { name: '放大时间轴', exact: true }).click();
    assert.equal(await timelineWindow.locator('.demo-timeline-zoom').innerText(), '125%');
    await timelineWindow.getByRole('button', { name: '缩小时间轴', exact: true }).click();
    const compactLaneHeight = await timelineWindow.locator('.demo-timeline-lane').first().evaluate(node => node.getBoundingClientRect().height);
    await timelineWindow.getByRole('button', { name: '切换完整时间轴视图', exact: true }).click();
    assert.ok(await timelineWindow.locator('.demo-timeline-lane').first().evaluate(node => node.getBoundingClientRect().height) > compactLaneHeight, 'full timeline increases lane readability');
    await timelineWindow.getByRole('button', { name: '切换紧凑时间轴视图', exact: true }).click();
    const track = timelineWindow.getByRole('region', { name: '时间轴轨道，可横向滚动', exact: true });
    await track.focus();
    await track.press('ArrowRight');
    await timelineWindow.getByRole('button', { name: '回到当前', exact: true }).click();
    await timelineWindow.getByRole('button', { name: '跟随当前', exact: true }).waitFor();
    await timelineWindow.getByLabel('时间轴选项', { exact: true }).click();
    const timelineResize = gm.page.getByRole('button', { name: '调整战术时间轴窗口大小', exact: true });
    for (let attempt = 0; attempt < 20 && (await timelineWindow.boundingBox())!.width > 300; attempt++) {
      await timelineResize.press('Shift+ArrowLeft');
    }
    await timelineWindow.getByLabel('时间轴选项', { exact: true }).click();
    assert.ok(await timelineWindow.locator('.timeline-options-popover').evaluate(node => {
      const rect = node.getBoundingClientRect();
      const panel = node.closest('.workspace-window')!.getBoundingClientRect();
      return rect.left >= panel.left && rect.right <= panel.right && rect.bottom <= panel.bottom;
    }), 'timeline options fit inside a manually narrowed window');
    const narrowViewButton = timelineWindow.getByRole('button', { name: '切换完整时间轴视图', exact: true });
    await narrowViewButton.scrollIntoViewIfNeeded();
    assert.ok(await narrowViewButton.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit !== null && node.contains(hit);
    }), 'all timeline options remain reachable in a narrow window');
    await timelineWindow.getByLabel('时间轴选项', { exact: true }).click();
    await gm.page.getByRole('button', { name: '工作台菜单', exact: true }).click();
    await gm.page.getByRole('button', { name: '恢复默认布局', exact: true }).click();
    await pinCommonPanels(gm.page);
    const hotbar = players[0].page.getByRole('region', { name: '角色动作栏', exact: true });
    await hotbar.getByRole('button', { name: '攻击', exact: true }).click();
    assert.equal(await hotbar.getByRole('button', { name: '移动', exact: true }).count(), 1, 'movement category remains available');
    assert.equal(await hotbar.locator('.demo-action-card').filter({ hasText: '移动' }).count(), 0, 'attack category filters skill slots');
    await hotbar.getByRole('button', { name: '全部', exact: true }).click();
    const moveSkill = hotbar.locator('.demo-action-card').filter({ hasText: '移动' });
    await moveSkill.focus();
    await hotbar.locator('.hotbar-description').waitFor({ state: 'visible' });
    await until(() => hotbar.locator('.hotbar-description').innerText().then(text => text.includes('前摇') && text.includes('收招')), 'focused skill should expose timing and cost');
    await gm.page.screenshot({ path: join(artifacts, 'workspace-gm.png'), fullPage: true, mask: [gm.page.locator('.demo-room-code')] });
    await players[0].page.screenshot({ path: join(artifacts, 'workspace-player.png'), fullPage: true });
  });

  await scenario('laptop defaults keep the battlefield and common actions reachable', async () => {
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }]) {
      for (const view of [gm, players[0]]) {
        await view.page.setViewportSize(viewport);
        await view.page.getByRole('button', { name: '工作台菜单', exact: true }).click();
        await view.page.getByRole('button', { name: '恢复默认布局', exact: true }).click();
        await pinCommonPanels(view.page);
        const timeline = await view.page.locator('.workspace-window[data-panel="timeline"]').boundingBox();
        const actions = await view.page.locator('.workspace-window[data-panel="actions"]').boundingBox();
        assert.ok(timeline && actions && timeline.y + timeline.height <= actions.y,
          `${view.role} ${viewport.width}: timeline must not overlap the action bar`);
        const roster = await panel(view.page, 'entities').boundingBox();
        assert.ok(roster && timeline.x + timeline.width < roster.x && actions.x + actions.width < roster.x,
          `${view.role} ${viewport.width}: edge tracks leave room for the full roster beside the pinned defaults`);
        assert.ok(await view.page.locator('.workspace-window[data-panel="timeline"] .demo-timeline-header').evaluate(node => {
          const header = node.getBoundingClientRect();
          const panel = node.closest('.workspace-window')!.getBoundingClientRect();
          const tracks = node.parentElement!.querySelector('.demo-timeline-scroll')!.getBoundingClientRect();
          return header.top >= panel.top && header.bottom <= tracks.top && header.height <= 38;
        }), `${view.role} ${viewport.width}: the compact timeline header remains above the tracks`);
        for (const selector of ['.demo-action-card', '.demo-action-secondary button', '.timeline-options > summary', '.workspace-window[data-panel="timeline"] .workspace-window-tools button']) {
          const buttons = view.page.locator(selector);
          for (const button of await buttons.all()) {
            assert.ok(await button.evaluate(node => {
              const rect = node.getBoundingClientRect();
              const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              return rect.width > 0 && rect.height > 0 && hit !== null && node.contains(hit);
            }), `${view.role} ${viewport.width}: ${selector} is visible without scrolling`);
          }
        }
        for (const id of ids) {
          const token = view.page.locator(`.demo-entity-token[data-entity-id="${id}"]`);
          assert.ok(await token.evaluate(node => {
            const rect = node.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return hit !== null && node.contains(hit);
          }), `${view.role} ${viewport.width}: ${id} is not covered by a default panel`);
        }
        await view.page.screenshot({ path: join(artifacts, `laptop-${view.role.toLowerCase()}-${viewport.width}.png`), fullPage: true });
        if (view.role === 'GM' && viewport.width === 1280) {
          await view.page.locator('.workspace-window[data-panel="timeline"]').screenshot({ path: join(artifacts, 'timeline-header-restored.png') });
        }
      }
    }
    const roster = players[0].page.getByRole('region', { name: '实体列表窗口', exact: true });
    assert.equal(await players[0].page.locator('.workspace-window[data-panel="actions"] .demo-ready-disclosure').count(), 0, 'roster is independent from the action bar');
    assert.ok((await roster.innerText()).includes('先锋'), 'visible actors appear in the roster');
    await roster.getByRole('button', { name: '选择先锋', exact: true }).click();
    await until(() => players[0].page.locator(`.demo-entity-token[data-entity-id="${ids[0]}"]`).getAttribute('class').then(value => value?.includes('is-selected') ?? false), 'roster selection reaches the map');
    await players[0].page.getByRole('button', { name: '隐藏实体列表', exact: true }).click();
    await roster.waitFor({ state: 'hidden' });
    await players[0].page.getByRole('button', { name: '工作台菜单', exact: true }).click();
    await players[0].page.getByRole('navigation', { name: '工作区模块' }).getByRole('button', { name: /^实体列表/ }).click();
    await roster.waitFor({ state: 'visible' });
    for (const view of [gm, players[0]]) {
      await view.page.setViewportSize({ width: 1600, height: 1000 });
      await view.page.getByRole('button', { name: '工作台菜单', exact: true }).click();
      await view.page.getByRole('button', { name: '恢复默认布局', exact: true }).click();
      await pinCommonPanels(view.page);
    }
  });

  await scenario('ten entity rows expose key data without vertical scrolling', async () => {
    // A static rendering fixture measures density without adding actors to the live encounter.
    const snapshot = structuredClone(players[0].snapshot!);
    const source = snapshot.entities.find(entity => entity.type === 'ACTOR')!;
    snapshot.entities = Array.from({ length: 10 }, (_, index) => ({
      ...structuredClone(source), id: `density-${index}`, displayName: `测试角色${index + 1}`,
      faction: index < 8 ? `势力${index + 1}` : null,
      resources: { current: { hp: 100 - index * 7, poise: Math.max(0, 20 - index * 3), focus: index % 9 }, max: { hp: 100, poise: 20, focus: 8 } },
      ...(index === 3 ? { currentActionContext: { type: 'CASTING' as const, actionId: 'density-event', actionTemplateId: 'DEMO_MELEE_STRIKE', phase: 'RECOVERY' as const, resolveTick: 12 } } : {}),
    }));
    snapshot.plan.slots = snapshot.entities.map((entity, index) => ({ entityId: entity.id, connected: true, ready: index % 3 === 0, waiting: false, controlEpoch: 0 }));
    snapshot.actions = [];
    snapshot.plan.actions = [];
    snapshot.controls = [];
    snapshot.relations = [
      { a: { kind: 'FACTION', id: '势力1' }, b: { kind: 'FACTION', id: '势力2' }, relation: 'ALLY' },
      { a: { kind: 'FACTION', id: '势力1' }, b: { kind: 'FACTION', id: '势力3' }, relation: 'HOSTILE' },
      { a: { kind: 'FACTION', id: '势力1' }, b: { kind: 'ENTITY', id: 'density-8' }, relation: 'NEUTRAL' },
    ];
    snapshot.decisions = [{ windowId: 'density-reaction', sourceActionId: 'density-source', sourceEntityId: 'density-5', reactorEntityId: 'density-2',
      causationId: 'density-cause', stage: 'REACTION_JOIN', openedTick: snapshot.tick, joinDeadlineAt: 10000, joinRemainingMs: 5000,
      version: 1, controlEpoch: 0, availableOptions: [], respondedSocketIds: [], resolved: false }];
    const session: DemoSessionInfo = { accessToken: 'density-test', snapshot,
      session: { sessionId: 'density', userId: 'density', role: 'PL', displayName: '测试', expiresAt: 0, reconnectUntil: 0, connectedSocketCount: 1, controlledEntityIds: ['density-0'] } };
    const css = readdirSync(join(frontend, 'assets')).filter(file => file.endsWith('.css')).map(file => readFileSync(join(frontend, 'assets', file), 'utf8')).join('\n');
    const markup = renderToStaticMarkup(createElement(EntityRoster, { snapshot, session, catalog: null, selectedEntityId: 'density-0', onSelectEntity: () => {} }));
    const appearance = renderToStaticMarkup(createElement(DemoAppearance));
    const densityPage = await browser!.newPage();
    try {
      for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }]) {
        await densityPage.setViewportSize(viewport);
        const panel = defaultWorkspaceLayout({ ...viewport, headerHeight: 0 }).entities;
        await densityPage.setContent(`<style>${css}</style>${appearance}<div class="demo-app is-header-hidden"><main class="workspace"><section data-panel="entities" class="workspace-window is-floating" style="left:${panel.x}px;top:${panel.y}px;width:${panel.width}px;height:${panel.height}px"><header class="workspace-window-bar">实体列表</header><div class="workspace-window-body">${markup}</div></section></main></div>`);
        const rows = densityPage.locator('.demo-entity-roster-row');
        assert.equal(await rows.count(), 10);
        for (const row of await rows.all()) {
          assert.ok(await row.evaluate(node => {
            const rect = node.getBoundingClientRect();
            const body = node.closest('.workspace-window-body')!.getBoundingClientRect();
            return rect.height <= 34 && rect.top >= body.top && rect.bottom <= body.bottom;
          }), `${viewport.width}: all ten compact rows fit in the default entity window`);
        }
        for (let index = 0; index < 10; index++) {
          for (const label of ['生命', '韧性', '专注']) {
            const resource = rows.nth(index).getByLabel(`测试角色${index + 1}${label}`, { exact: true });
            assert.ok(await resource.isVisible(), `${label} must be visible without opening details`);
            assert.ok(await resource.evaluate(node => {
              const rect = node.getBoundingClientRect();
              const rowRect = node.closest('.demo-entity-roster-row')!.getBoundingClientRect();
              const reading = node.querySelector('.demo-entity-roster-meter-reading')!;
              return rect.width > 0 && rect.left >= rowRect.left && rect.right <= rowRect.right && node.scrollWidth <= node.clientWidth + 1
                && reading.scrollWidth <= reading.clientWidth + 1
                && Array.from(reading.children).every(child => child.scrollWidth <= child.clientWidth + 1);
            }), 'resource values fit without clipping');
          }
        }
        assert.equal(await rows.locator('.demo-entity-roster-glyph').count(), 0, 'no avatar consumes row space');
        assert.ok(await rows.nth(2).getByLabel(/^反应待决：接入反应/).isVisible(), 'pending reaction remains visible in the primary row');
        assert.equal(await densityPage.locator('.demo-entity-roster-details[open]').count(), 0, 'secondary information starts collapsed');
        assert.ok(await densityPage.locator('.workspace-window-body').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'key columns fit the default window width');
        await densityPage.screenshot({ path: join(artifacts, `entity-roster-ten-${viewport.width}.png`), fullPage: true });
        await densityPage.locator('.workspace-window[data-panel="entities"]').screenshot({ path: join(artifacts, `entity-roster-ten-panel-${viewport.width}.png`) });
        await rows.last().locator('summary').click();
        assert.equal(await rows.last().locator('details[open]').count(), 1, 'even the last row can open additional information');
        await rows.last().locator('details[open]').getByText(/位置/).scrollIntoViewIfNeeded();
        assert.ok(await rows.last().locator('details[open]').getByText(/位置/).isVisible(), 'last-row details remain reachable');
      }
    } finally { await densityPage.close(); }
  });

  await scenario('GM configures custom factions and independent actors without changing control', async () => {
    await gm.page.getByRole('button', { name: '工作台菜单', exact: true }).click();
    await gm.page.getByRole('navigation', { name: '工作区模块' }).getByRole('button', { name: /^主持工具/ }).click();
    await pinPanel(gm.page, 'gm');
    await gm.page.keyboard.press('Escape');
    const controls = gm.snapshot!.controls.map(({ entityId, userId, role, controlEpoch }) => ({ entityId, userId, role, controlEpoch }));
    await gm.page.getByLabel('胜负条件', { exact: true }).selectOption('MANUAL');
    await gm.page.getByRole('button', { name: '应用胜负条件', exact: true }).click();
    await until(() => gm.snapshot?.victoryCondition === 'MANUAL', 'manual victory policy did not synchronize');
    const setFaction = async (entityId: string, name: string) => {
      await select(gm, entityId);
      await gm.page.getByLabel('阵营名称', { exact: true }).fill(name);
      await gm.page.getByRole('button', { name: '应用阵营', exact: true }).click();
      await until(() => views.every(view => entity(view, entityId)?.faction === name), 'custom faction did not reach every viewer');
    };
    await setFaction(ids[0], '赤砂商会');
    await setFaction(ids[1], '城镇守卫');
    await select(gm, ids[2]);
    await gm.page.getByRole('button', { name: '设为独立', exact: true }).click();
    await until(() => views.every(view => entity(view, ids[2])?.faction === null), 'independent actor did not synchronize');
    await select(gm, ids[0]);
    const otherSide = gm.page.getByLabel('关系另一方', { exact: true });
    const sideValue = await otherSide.locator('option').filter({ hasText: '城镇守卫' }).first().getAttribute('value');
    assert.ok(sideValue);
    await otherSide.selectOption(sideValue);
    const relationSelect = gm.page.getByLabel('双方关系', { exact: true });
    const relationIs = (relation: string) => views.every(view => getEncounterRelation(
      getEncounterSide(entity(view, ids[0])!), getEncounterSide(entity(view, ids[1])!), view.snapshot?.relations,
    ) === relation);
    for (const relation of ['HOSTILE', 'ALLY']) {
      await relationSelect.selectOption(relation);
      await gm.page.getByRole('button', { name: '应用关系', exact: true }).click();
      await until(() => relationIs(relation), 'relationship change did not synchronize');
    }
    const roster = players[0].page.getByRole('region', { name: '实体列表窗口', exact: true });
    assert.ok(await roster.locator(`[data-entity-id="${ids[1]}"]`).innerText().then(text => text.includes('城镇守卫')));
    assert.ok(await roster.locator(`[data-entity-id="${ids[2]}"]`).innerText().then(text => text.includes('独立')));
    assert.deepEqual(gm.snapshot!.controls.map(({ entityId, userId, role, controlEpoch }) => ({ entityId, userId, role, controlEpoch })), controls,
      'faction and diplomatic edits do not alter control ownership or epochs');
    assert.ok(await players[0].page.locator('.demo-action-card').count() > 0, 'custom-controlled faction retains its action catalog');
    await roster.screenshot({ path: join(artifacts, 'entity-roster-multiple-factions.png') });
    const resetValue = await relationSelect.locator('option').filter({ hasText: /未设置|恢复默认/ }).first().getAttribute('value');
    assert.notEqual(resetValue, null);
    await relationSelect.selectOption(resetValue!);
    await gm.page.getByRole('button', { name: '应用关系', exact: true }).click();
    await until(() => relationIs('UNKNOWN'), 'reset relationship did not clear the previous alliance');
    for (const id of ids.slice(0, 3)) await setFaction(id, 'PLAYERS');
    await gm.page.getByLabel('胜负条件', { exact: true }).selectOption('LAST_SIDE');
    await gm.page.getByRole('button', { name: '应用胜负条件', exact: true }).click();
    await until(() => gm.snapshot?.victoryCondition === 'LAST_SIDE', 'automatic victory policy did not synchronize');
    await gm.page.getByRole('button', { name: '隐藏主持工具', exact: true }).click();
  });

  await scenario('narrow layout preserves map targeting and module access', async () => {
    const player = players[0];
    const savedDesktopPins = await player.page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('elysian-workspace-v3-PL') ?? '{}');
      return Object.fromEntries(Object.entries(saved.panels ?? {}).map(([id, value]) => [id, (value as { pinned?: boolean }).pinned]));
    });
    for (const width of [760, 390]) {
      await player.page.setViewportSize({ width, height: 844 });
      assert.ok(await player.page.locator('.demo-battlefield').evaluate(node => {
        const svg = node.getBoundingClientRect();
        const wrap = node.parentElement!.getBoundingClientRect();
        const map = node.closest('.workspace-map')!.getBoundingClientRect();
        return svg.height >= 300 && svg.top >= wrap.top && svg.bottom <= wrap.bottom + 1 && wrap.bottom <= map.bottom + 1;
      }), `${width}px: the complete map canvas stays inside its compact container`);
    }
    await player.page.setViewportSize({ width: 390, height: 844 });
    await player.page.locator('.workspace.is-compact').waitFor();
    assert.equal(await player.page.locator('.workspace-dock-tab:visible').count(), 0, 'compact screens use stacked windows rather than edge hover controls');
    assert.ok(await player.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'narrow layout has no horizontal page overflow');
    await player.page.getByRole('button', { name: '工作台菜单', exact: true }).click();
    await player.page.getByRole('navigation', { name: '工作区模块' }).getByRole('button', { name: /^行动与反应/ }).click();
    await player.page.locator('.demo-action-card').filter({ hasText: '移动' }).click();
    await player.page.locator('.demo-targeting-banner').waitFor();
    await until(() => player.page.locator('.workspace-map').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.top >= 0 && rect.top < innerHeight / 2;
    }), 'selecting a skill brings the map into the narrow viewport');
    await player.page.locator('.demo-targeting-banner').getByRole('button', { name: '取消', exact: true }).click();
    await player.page.locator('.demo-targeting-banner').waitFor({ state: 'hidden' });
    await player.page.screenshot({ path: join(artifacts, 'workspace-player-narrow.png'), fullPage: true });
    await player.page.setViewportSize({ width: 1600, height: 1000 });
    assert.deepEqual(await player.page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('elysian-workspace-v3-PL') ?? '{}');
      return Object.fromEntries(Object.entries(saved.panels ?? {}).map(([id, value]) => [id, (value as { pinned?: boolean }).pinned]));
    }), savedDesktopPins, 'compact use preserves the desktop pin preferences');
    await player.page.getByRole('button', { name: '工作台菜单', exact: true }).click();
    await player.page.getByRole('button', { name: '恢复默认布局', exact: true }).click();
    await pinCommonPanels(player.page);
  });

  // Complete only eligible idle slots through their owning page. Never inject
  // an engine command, store mutation or network intent to drive gameplay.
  const fillBarrier = async () => {
    const state = gm.snapshot!;
    for (const slot of state.plan.slots) {
      const actor = state.entities.find(item => item.id === slot.entityId);
      if (!actor || actor.type !== 'ACTOR' || actor.currentActionContext || slot.ready || (slot.readyAtTick ?? 0) > state.tick) continue;
      const index = ids.indexOf(actor.id);
      const view = index >= 0 && index < 3 ? players[index] : gm;
      if (view === gm) await select(gm, actor.id);
      const button = view.page.getByRole('button', { name: '等待 +5 Tick', exact: true });
      if (await button.isEnabled()) await waitAction(view);
    }
  };
  const drain = async (predicate: () => boolean, label: string) => {
    for (let attempt = 0; attempt < 35; attempt++) {
      if (predicate()) return;
      if (gm.snapshot?.decisions.length) {
        const pass = gm.page.getByRole('button', { name: '全部放弃反应', exact: true });
        if (await pass.isVisible()) await pass.click();
      } else await fillBarrier();
      await new Promise<void>(resolve => setTimeout(resolve, 75));
    }
    assert.ok(predicate(), label);
  };
  await scenario('player moves on the hex map and server timeline advances', async () => {
    await action(players[0], '移动', { x: 3, y: 2 });
    assert.ok(players[0].snapshot?.actions.some(plan => plan.actorId === ids[0]), 'movement declaration is visible on the authoritative timeline');
    await drain(() => entity(gm, ids[0])?.transform.coords.x === 3 && !entity(gm, ids[0])?.currentActionContext, 'movement did not finish');
    assert.ok(gm.snapshot!.tick > 0);
    assert.ok(await gm.page.locator('.demo-log-row').count() > 0);
  });
  await scenario('GM records a resource correction through the panel', async () => {
    await gm.page.getByRole('button', { name: '工作台菜单', exact: true }).click();
    await gm.page.getByRole('navigation', { name: '工作区模块' }).getByRole('button', { name: /^主持工具/ }).click();
    await pinPanel(gm.page, 'gm');
    await select(gm, ids[3]);
    await gm.page.getByPlaceholder('HP', { exact: true }).fill('60');
    await gm.page.locator('.demo-gm-section > summary').filter({ hasText: '裁决与历史' }).click();
    await gm.page.getByPlaceholder('写明 GM、原因与修改依据').fill('LAN automatic correction');
    await gm.page.getByRole('button', { name: '记录修正', exact: true }).click();
    await until(() => entity(gm, ids[3])?.resources.current.hp === 60, 'GM correction not applied');
    assert.ok(await gm.page.getByText('GM 修正：LAN automatic correction', { exact: false }).count() > 0);
  });
  await scenario('attack opens a reaction and player selects an interrupt', async () => {
    await drain(() => !entity(gm, ids[0])?.currentActionContext && !(gm.snapshot!.plan.slots.find(slot => slot.entityId === ids[0])?.ready), 'attacker not idle');
    if (await players[1].page.getByRole('button', { name: '等待 +5 Tick', exact: true }).isEnabled()) {
      await waitAction(players[1]);
      await until(() => Boolean(gm.snapshot?.plan.slots.find(slot => slot.entityId === ids[1])?.ready), 'reactor wait plan not ready');
    } else {
      const slot = gm.snapshot?.plan.slots.find(item => item.entityId === ids[1]);
      assert.ok(slot?.ready || (slot?.readyAtTick ?? 0) > (gm.snapshot?.tick ?? 0), 'reactor already has a pending wait');
    }
    await players[1].page.getByRole('button', { name: '取消固定行动与反应', exact: true }).click();
    await players[1].page.getByRole('button', { name: '隐藏行动与反应', exact: true }).click();
    await players[1].page.getByRole('region', { name: '行动与反应窗口', exact: true }).waitFor({ state: 'hidden' });
    await action(players[0], '近战突击', ids[3]);
    await gm.page.getByRole('button', { name: '暂停', exact: true }).click();
    await until(() => Boolean(gm.snapshot?.paused), 'GM pause before plan review was not applied');
    await gm.page.getByRole('button', { name: '取消固定主持工具', exact: true }).click();
    await gm.page.getByRole('button', { name: '隐藏主持工具', exact: true }).click();
    const timelineWindow = gm.page.getByRole('region', { name: '战术时间轴窗口', exact: true });
    await timelineWindow.locator('.demo-timeline-unknown, .demo-timeline-action').filter({ hasText: '近战突击' }).first().click();
    await timelineWindow.getByRole('button', { name: '在 GM 裁决台编辑此动作', exact: true }).click();
    const editor = gm.page.locator('[data-demo-gm-edit-plan]');
    await editor.waitFor({ state: 'visible' });
    assert.ok(await editor.evaluate(node => node.closest('details')?.open), 'timeline edit expands the collapsed action group');
    const pendingActionId = gm.snapshot?.actions.find(plan => plan.actorId === ids[0])?.actionId;
    await until(async () => await gm.page.getByLabel('选择待裁决动作', { exact: true }).inputValue() === pendingActionId, 'timeline edit selects the requested action');
    await gm.page.mouse.move(800, 500);
    await new Promise<void>(resolve => setTimeout(resolve, 750));
    assert.ok(await editor.isVisible(), 'a timeline-opened editor remains available before pointer entry');
    assert.ok(await panel(gm.page, 'gm').getByRole('button', { name: '固定主持工具', exact: true }).isVisible(), 'timeline editing does not silently pin the host tools');
    await pinPanel(gm.page, 'gm');
    await gm.page.getByRole('button', { name: '继续', exact: true }).click();
    await until(() => gm.snapshot?.paused === false, 'GM resume after plan review was not applied');
    await fillBarrier();
    await until(() => Boolean(players[1].snapshot?.decisions.length), 'reaction did not open');
    const card = players[1].page.locator('.demo-reaction-card.actionable').first();
    await players[1].page.getByRole('region', { name: '行动与反应窗口', exact: true }).waitFor({ state: 'visible' });
    await players[1].page.mouse.move(800, 500);
    await new Promise<void>(resolve => setTimeout(resolve, 750));
    assert.ok(await panel(players[1].page, 'actions').isVisible(), 'pending reaction forces an unpinned hidden window to remain expanded');
    assert.equal(await players[1].page.getByRole('button', { name: '隐藏行动与反应', exact: true }).isDisabled(), true, 'pending reaction cannot be hidden');
    assert.equal(await players[1].page.getByRole('button', { name: '最小化行动与反应', exact: true }).isDisabled(), true, 'pending reaction cannot be minimized');
    await card.getByRole('button', { name: '接入反应', exact: true }).click();
    await gm.page.getByRole('region', { name: '战术时间轴窗口', exact: true }).screenshot({ path: join(artifacts, 'timeline-reaction.png') });
    await card.getByRole('button', { name: /打断/ }).click();
    await until(() => !players[1].snapshot?.decisions.some(decision => !decision.resolved && decision.reactorEntityId === ids[1]), 'the player reaction did not settle');
    await panel(players[1].page, 'actions').waitFor({ state: 'hidden' });
    assert.ok(await panel(players[1].page, 'actions').evaluate(node => (node as HTMLElement).hidden), 'settling the reaction restores the original hidden preference');
    assert.equal(await panel(players[1].page, 'actions').locator('.workspace-pin').getAttribute('aria-pressed'), 'false', 'reaction attention never changes the saved pin preference');
    await players[1].page.getByRole('button', { name: '工作台菜单', exact: true }).click();
    await players[1].page.getByRole('navigation', { name: '工作区模块' }).getByRole('button', { name: /^行动与反应/ }).click();
    await drain(() => !gm.snapshot?.decisions.length && !entity(gm, ids[0])?.currentActionContext, 'reaction did not settle');
    assert.ok(entity(gm, ids[1])!.resources.current.focus < entity(gm, ids[1])!.resources.max.focus);
  });
  await scenario('pending decision survives player offline/reconnect and times out automatically', async () => {
    await drain(() => !entity(gm, ids[0])?.currentActionContext && !(gm.snapshot!.plan.slots.find(slot => slot.entityId === ids[0])?.ready), 'attacker not idle');
    const hpBefore = entity(gm, ids[3])!.resources.current.hp;
    await action(players[0], '近战突击', ids[3]);
    await fillBarrier();
    await until(() => Boolean(gm.snapshot?.decisions.length), 'timeout scenario has no decision');
    await players[2].context.setOffline(true);
    await until(() => gm.snapshot?.controls.find(control => control.entityId === ids[2])?.connectedSocketIds.length === 0, 'offline connection not detached');
    await players[2].context.setOffline(false);
    await until(() => Boolean(gm.snapshot?.controls.find(control => control.entityId === ids[2])?.connectedSocketIds.length), 'reconnect did not restore control');
    await until(() => gm.snapshot?.decisions.length === 0, 'reaction did not expire automatically', 18000);
    await drain(() => entity(gm, ids[3])!.resources.current.hp < hpBefore, 'timeout attack dealt no damage');
    await until(() => players[2].snapshot?.revision === gm.snapshot?.revision, 'reconnected snapshot did not catch up');
  });
  await scenario('same player has two sockets; closing one keeps the other connected', async () => {
    // A user-opened tab inherits sessionStorage from its opener. This exercises
    // the real session restoration path without writing browser storage.
    const popupPromise = players[0].page.waitForEvent('popup');
    await players[0].page.evaluate(() => { window.open(window.location.href, '_blank'); });
    const popup = await popupPromise;
    await popup.getByRole('button', { name: '工作台菜单', exact: true }).waitFor();
    await until(() => gm.snapshot?.controls.find(control => control.entityId === ids[0])?.connectedSocketIds.length === 2, 'second socket not attached');
    await popup.close();
    await until(() => gm.snapshot?.controls.find(control => control.entityId === ids[0])?.connectedSocketIds.length === 1, 'closing one socket detached the player');
  });
  await scenario('player UI and all received payloads omit hidden entities', async () => {
    for (const [index, player] of players.entries()) {
      const controlsBefore = JSON.stringify(player.snapshot!.controls);
      await player.page.locator(`.demo-entity-token[data-entity-id="${ids[3]}"]`).click();
      assert.equal(await player.page.locator('.demo-actor-strip strong').innerText(), entity(player, ids[3])?.displayName, 'map selection displays the inspected entity');
      assert.match(await player.page.locator('.workspace-window[data-panel="actions"]').innerText(), /角色不在你的控制权内/);
      for (const button of await player.page.locator('.demo-action-card, .demo-action-secondary button').all()) {
        assert.equal(await button.isEnabled(), false, 'inspecting another entity must not enable its actions');
      }
      assert.equal(JSON.stringify(player.snapshot!.controls), controlsBefore, 'map selection cannot change authoritative control');
      assert.deepEqual(player.leaks, []);
      assert.deepEqual(player.errors, []);
      assert.ok(!(await player.page.locator('body').innerText()).includes('LAN_SECRET_ENTITY'));
      assert.ok(!player.snapshot?.entities.some(item => item.id === 'lan-secret-prop'));
      await player.page.locator(`.demo-entity-roster-row[data-entity-id="${ids[index]}"] .demo-entity-roster-select`).click();
    }
    assert.ok(gm.snapshot?.entities.some(item => item.id === 'lan-secret-prop'));
  });
  await scenario('GM ends encounter and settlement is saved once', async () => {
    await drain(() => !gm.snapshot?.decisions.length && !gm.snapshot?.entities.some(actor => actor.currentActionContext), 'committed action recovery did not finish');
    await gm.page.getByRole('button', { name: '明确结束遭遇', exact: true }).click();
    await gm.page.locator('.demo-result-banner').waitFor();
    await until(async () => (await gm.page.locator('.demo-result-banner').innerText()).includes('已保存'), 'settlement not saved');
    const saved = await persistence();
    assert.ok(saved.record.result);
    assert.equal(saved.history.length, 1);
  });
  await scenario('real process restart preserves saved result and permits fresh UI login', async () => {
    const before = await persistence();
    await stopServer();
    const nextPid = await startServer(fixture);
    assert.notEqual(nextPid, firstPid);
    const restored = await persistence();
    assert.deepEqual(restored.record.result, before.record.result);
    assert.deepEqual(restored.history, before.history);
    const fresh = await newView('GM');
    await login(fresh, 'LAN Restored GM');
    assert.ok(await fresh.page.getByRole('heading', { name: '在线玩家', exact: true }).count());
    assert.equal((await persistence()).history.length, 1, 'login must not duplicate settlement');
  });
}

async function finish(failure?: unknown): Promise<void> {
  const cleanupErrors: string[] = [];
  for (const [index, view] of views.entries()) {
    if (failure && !view.page.isClosed()) {
      await view.page.screenshot({ path: join(artifacts, `failure-${index}.png`), fullPage: true,
        mask: [view.page.locator('input'), view.page.locator('.demo-room-code')] }).catch(() => {});
    }
  }
  for (const [index, context] of contexts.entries()) {
    const raw = join(temporary, `trace-${index}.zip`);
    try {
      await context.tracing.stop({ path: raw });
      if (failure) {
        const files = unzipSync(readFileSync(raw));
        for (const name of Object.keys(files)) {
          // Trace network resources can contain binary data; discard them.
          if (name.startsWith('resources/')) delete files[name];
          else files[name] = strToU8(redact(strFromU8(files[name])));
        }
        writeFileSync(join(artifacts, `trace-${index}.zip`), zipSync(files));
      }
    } catch (error) { output.push(`Trace cleanup: ${String(error)}`); }
  }
  const cleanup = await Promise.allSettled([browser?.close(), stopServer()]);
  for (const result of cleanup) if (result.status === 'rejected') cleanupErrors.push(String(result.reason));
  const databaseUnchanged = hash() === originalHash;
  if (!databaseUnchanged) cleanupErrors.push('development database changed');
  try {
    assert.equal(dirname(temporary), realpathSync(tmpdir()));
    assert.ok(basename(temporary).startsWith('elysian-lan-browser-'));
    rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) { cleanupErrors.push(String(error)); }
  const failed = Boolean(failure || cleanupErrors.length);
  if (cleanupErrors.length) process.exitCode = 2;
  writeFileSync(join(artifacts, 'report.json'), redact(JSON.stringify({
    status: failed ? (environmentStage || cleanupErrors.length ? 'environment-error' : 'failed') : 'passed',
    scenarios: reports, error: failure ? String(failure) : undefined, cleanupErrors, databaseUnchanged,
    socketMetrics: socketMetricsReport(),
  }, null, 2)));
  writeFileSync(join(artifacts, 'diagnostics.log'), redact(output.join('\n')));
  console.log(`[browser] ${failed ? 'FAILED' : 'PASSED'} report: ${join(artifacts, 'report.json')}`);
}
let watchdog: ReturnType<typeof setTimeout>;
void (async () => {
  let failure: unknown;
  const deadline = new Promise<never>((_, reject) => { watchdog = setTimeout(() => {
    const error = new Error('BROWSER_SCENARIO_TIMEOUT');
    cancellation.abort(error);
    reject(error);
  }, 180000); });
  try { await Promise.race([main(), deadline]); }
  catch (error) {
    failure = serverFailure ?? error;
    if (serverFailure || /SERVER_START_FAILED/.test(String(error))) environmentStage = true;
    cancellation.abort(error);
    console.error(redact(String(failure)));
    process.exitCode = environmentStage ? 2 : 1;
  }
  finally {
    clearTimeout(watchdog!);
    await finish(failure);
  }
})().catch(error => { console.error(redact(String(error))); process.exitCode = 2; child?.kill(); });
