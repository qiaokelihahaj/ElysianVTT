import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type { DemoServerHandle, DemoServerOptions } from '../packages/backend/src/demo/DemoServer.js';

async function main(): Promise<void> {
    const root = process.cwd();
    const entry = resolve(root, 'packages/backend/dist/demo/DemoServer.js');
    assert.ok(existsSync(entry), 'Run pnpm build before browser acceptance');
    const require = createRequire(join(root, 'test/package.json'));
    const { createDemoServer } = require(entry) as { createDemoServer: (options: DemoServerOptions) => Promise<DemoServerHandle> };
    const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'elysian-spatial-browser-')));
    const evidence = resolve(root, '.tmp', 'spatial-tactics-browser');
    mkdirSync(evidence, { recursive: true });
    let browser: Browser | undefined;
    let server: DemoServerHandle | undefined;
    const errors: string[] = [];
    try {
        server = await createDemoServer({ scenario: 'tactics', dataDirectory: temporaryRoot, host: '127.0.0.1', port: 0 });
        const { url } = await server.listen();
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
        await context.addInitScript(() => {
            const panels = {
                actions: { x: 28, y: 640, width: 1100, height: 330, collapsed: false, hidden: false, pinned: true, dockEdge: 'bottom' },
                entities: { x: 1145, y: 40, width: 420, height: 450, collapsed: false, hidden: false, pinned: false, dockEdge: 'right' },
                timeline: { x: 28, y: 28, width: 1000, height: 220, collapsed: false, hidden: false, pinned: false, dockEdge: 'top' },
                logs: { x: 28, y: 300, width: 300, height: 300, collapsed: false, hidden: false, pinned: false, dockEdge: 'left' },
                gm: { x: 28, y: 300, width: 300, height: 400, collapsed: false, hidden: false, pinned: false, dockEdge: 'left' },
            };
            localStorage.setItem('elysian-workspace-v3-GM', JSON.stringify({ version: 3, panels }));
        });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(url);
        await page.getByLabel('昵称', { exact: true }).fill('战术验收主持');
        await page.getByLabel('主持凭据', { exact: true }).fill(server.credentials.hostCredential);
        await page.getByRole('button', { name: '进入主持大厅', exact: true }).click();
        await page.getByRole('heading', { name: '断桥堡垒 · 空间战术演练', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '开始战术演练', exact: true }).isEnabled(), true, 'GM may practice alone');
        assert.equal(await page.locator('.demo-spatial-guide li').count(), 5);
        await page.getByRole('button', { name: '开始战术演练', exact: true }).click();
        await page.getByRole('img', { name: '可点击六边形战场网格' }).waitFor();
        assert.equal(await page.locator('g.demo-map-cell').count(), 126);
        assert.equal(await page.getByLabel('战场图例').isVisible(), true);

        const poll = async (condition: () => boolean, message: string): Promise<void> => {
            const end = Date.now() + 5000;
            while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
            assert.ok(condition(), message);
        };
        const select = async (entityId: string): Promise<void> => {
            const token = page.locator(`g[data-entity-id="${entityId}"]`);
            await token.focus();
            await token.press('ArrowRight');
            assert.equal(await token.evaluate(element => element.matches(':focus-visible')), true, 'keyboard interaction exposes the SVG focus cue');
            assert.equal(await token.evaluate(element => getComputedStyle(element).outlineWidth), '0px', 'SVG token focus must not become a map-scaled solid block');
            const focusedCircle = await token.locator('.demo-entity-token-core').evaluate(element => ({ stroke: getComputedStyle(element).stroke, strokeWidth: getComputedStyle(element).strokeWidth, focusVisible: element.parentElement?.matches(':focus-visible') }));
            assert.ok(parseFloat(focusedCircle.strokeWidth) >= .06, `token keyboard focus retains the visible circle stroke: ${JSON.stringify(focusedCircle)}`);
            await token.press('Enter');
        };
        const action = async (entityId: string, label: string): Promise<void> => {
            await select(entityId);
            await page.locator('.demo-action-list').getByRole('button', { name: label, exact: true }).click();
            await poll(() => server!.coordinator.getSnapshot().plan.slots.find(slot => slot.entityId === entityId)?.ready === true, `${label} submits real plan`);
        };
        await action('tactics-ranger', '架枪姿态');
        assert.equal(server.coordinator.getSnapshot().entities.find(entity => entity.id === 'tactics-ranger')?.currentStance, 'NONE');
        await action('tactics-vanguard', '护卫阵型');
        await action('tactics-engineer', '右转 60°');
        const wait = async (entityId: string): Promise<void> => {
            const live = server!.coordinator.getSnapshot();
            const liveSlot = live.plan.slots.find(slot => slot.entityId === entityId);
            const liveEntity = live.entities.find(entity => entity.id === entityId);
            if (liveSlot?.ready || liveEntity?.currentActionContext || (liveSlot?.readyAtTick !== undefined && liveSlot.readyAtTick > live.tick)) return;
            const beforeTick = live.tick;
            await select(entityId);
            await page.getByRole('button', { name: '等待 +5 Tick', exact: true }).click();
            await poll(() => {
                const current = server!.coordinator.getSnapshot();
                return current.tick > beforeTick || current.plan.slots.some(slot => slot.entityId === entityId && slot.ready);
            }, 'UI WAIT submitted');
        };
        for (const id of ['tactics-sentinel', 'tactics-sniper', 'tactics-bombardier']) await wait(id);
        for (let i = 0; i < 12 && server.coordinator.getSnapshot().entities.find(entity => entity.id === 'tactics-ranger')?.currentStance !== 'ADS'; i++) {
            if (server.coordinator.getSnapshot().decisions.some(decision => !decision.resolved)) {
                await page.getByRole('button', { name: '全部放弃反应', exact: true }).click();
            }
            const current = server.coordinator.getSnapshot();
            for (const slot of current.plan.slots) {
                const entity = current.entities.find(candidate => candidate.id === slot.entityId);
                if (entity?.type === 'ACTOR' && !slot.ready && !entity.currentActionContext && (slot.readyAtTick === undefined || slot.readyAtTick <= current.tick)) await wait(slot.entityId);
            }
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        assert.equal(server.coordinator.getSnapshot().entities.find(entity => entity.id === 'tactics-ranger')?.currentStance, 'ADS');
        assert.equal(server.coordinator.getSnapshot().entities.find(entity => entity.id === 'tactics-engineer')?.transform.facing, 60);
        assert.ok(server.coordinator.getSnapshot().entities.find(entity => entity.id === 'tactics-vanguard')?.formationContext?.interceptConfig);
        await select('tactics-vanguard');
        const guide = page.locator('.demo-spatial-guide');
        await guide.locator('summary').click();
        await page.getByLabel('部位耐久').waitFor();
        assert.ok((await guide.innerText()).includes('团队拦截'));
        await guide.locator('summary').click();

        // Open a separate compiled server to exercise a clean cell attack picker.
        await browser.close();
        browser = undefined;
        await server.close();
        server = await createDemoServer({ scenario: 'tactics', dataDirectory: join(temporaryRoot, 'cell-picker'), host: '127.0.0.1', port: 0 });
        const next = await server.listen();
        browser = await chromium.launch({ headless: true });
        const cellPage: Page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
        cellPage.on('pageerror', error => errors.push(error.message));
        await cellPage.goto(next.url);
        await cellPage.getByLabel('昵称', { exact: true }).fill('落点验收主持');
        await cellPage.getByLabel('主持凭据', { exact: true }).fill(server.credentials.hostCredential);
        await cellPage.getByRole('button', { name: '进入主持大厅', exact: true }).click();
        await cellPage.getByRole('button', { name: '开始战术演练', exact: true }).click();
        await cellPage.getByRole('img', { name: '可点击六边形战场网格' }).waitFor();
        await cellPage.getByRole('button', { name: '展开行动与反应', exact: true }).click();
        const engineer = cellPage.locator('g[data-entity-id="tactics-engineer"]');
        await engineer.focus();
        await engineer.press('Enter');
        await cellPage.locator('.demo-action-list').getByRole('button', { name: '抛射爆弹', exact: true }).click();
        await cellPage.locator('.demo-map-cell.is-legal').first().waitFor();
        const landing = cellPage.getByRole('button', { name: '格10,6', exact: true });
        await landing.focus();
        await landing.press('ArrowRight');
        assert.equal(await landing.evaluate(element => element.matches(':focus-visible')), true, 'keyboard cell selection exposes the polygon focus cue');
        assert.equal(await landing.evaluate(element => getComputedStyle(element).outlineWidth), '0px', 'SVG cell focus uses its polygon stroke instead of a map-scaled outline');
        assert.ok(await landing.locator('polygon').first().evaluate(element => parseFloat(getComputedStyle(element).strokeWidth) >= .06), 'cell keyboard focus retains the visible polygon stroke');
        await landing.press('Enter');
        await poll(() => server!.coordinator.getSnapshot().actions.some(plan => plan.actionTemplateId === 'TACTIC_LOB'), 'cell attack sent real ACTION');
        const planned = server.coordinator.getSnapshot().actions.find(plan => plan.actionTemplateId === 'TACTIC_LOB');
        assert.deepEqual(planned?.targetCoords, { x: 10, y: 6, z: 0 });
        assert.equal(server.coordinator.getSnapshot().entities.find(entity => entity.id === 'tactics-bombardier')?.resources.current.hp, 90, 'selection alone cannot deal damage');
        await cellPage.screenshot({ path: join(evidence, 'battlefield.png'), fullPage: true });
        assert.deepEqual(errors, [], 'production browser has no page errors');
        writeFileSync(join(evidence, 'report.json'), JSON.stringify({ passed: true, checks: ['solo GM entry', '126 hex cells', 'scenario guide', 'real timed stance/guard/rotation via UI', 'body parts', 'cell-targeted explosive intent'], pageErrors: errors }, null, 2));
        console.log(`spatial-tactics-browser: production UI passed; evidence ${evidence}`);
    } catch (error) {
        if (browser) for (const context of browser.contexts()) for (const page of context.pages()) {
            await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
        }
        writeFileSync(join(evidence, 'failure-state.json'), JSON.stringify({
            message: error instanceof Error ? error.message : String(error), snapshot: server?.coordinator.getSnapshot(),
        }, null, 2));
        throw error;
    } finally {
        await browser?.close();
        await server?.close();
        rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
