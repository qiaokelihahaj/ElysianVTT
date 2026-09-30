// 手动浏览器联调夹具：pnpm exec tsx test/auth-isolated.runner.ts --browser combat-browser.test.ts
// 仅监听 loopback；POST /__test/finish 结束并清理临时数据库。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import type { Server } from 'socket.io';
import { createApp } from '../packages/backend/src/app.js';
import { SocketServer } from '../packages/backend/src/network/SocketServer.js';
import type { CampaignManager } from '../packages/backend/src/campaigns/CampaignManager.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';
import { prisma } from '../packages/backend/src/db/prisma.js';
import type { ActionTemplate } from '../packages/shared/src/index.js';

async function main() {
    assert.equal(process.env.ELYSIAN_BROWSER_SMOKE, '1');
    assert.ok(process.env.ELYSIAN_AUTH_TEST_DB?.includes('elysian-auth-test-'));
    const original = Dictionary.getAction;
    const strike: ActionTemplate = { id: 'HEAVY_STRIKE', tags: ['MELEE'], resourceCost: {},
        timeCost: { startupTicks: 3, recoveryTicks: 2 }, range: { type: 'MELEE', distanceExpr: '3' },
        effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '25' } }] };
    Dictionary.getAction = id => id === strike.id ? strike : original.call(Dictionary, id);
    const app = createApp();
    const http = createServer(app);
    const server = new SocketServer(http);
    const cleanup = server as unknown as { io: Server; campaignManager: CampaignManager };
    let finish: () => void = () => {};
    const finished = new Promise<void>(resolve => { finish = resolve; });
    app.post('/__test/finish', (_req, res) => { res.json({ ok: true }); finish(); });
    app.get('/__test/result', async (_req, res) => {
        const rows = await prisma.characterSheet.findMany({ where: { id: { in: ['browser-hero', 'browser-enemy'] } } });
        res.json(rows.map(row => ({ id: row.id, resources: JSON.parse(row.resourcesJson) })));
    });
    app.use((req, res, next) => {
        if (req.method !== 'GET') { next(); return; }
        res.sendFile(req.path === '/' ? 'index.html' : req.path.slice(1),
            { root: path.resolve('packages/frontend/dist') }, error => { if (error) next(error); });
    });
    try {
        for (const [index, id] of ['browser-hero', 'browser-enemy'].entries()) {
            await prisma.characterSheet.create({ data: { id, name: index ? '训练对手' : '测试勇者', type: 'ACTOR', currentSceneId: 'room_1',
                resourcesJson: JSON.stringify({ current: { hp: 50, poise: 50, focus: 50 }, max: { hp: 50, poise: 50, focus: 50 } }),
                transformJson: JSON.stringify({ coords: { x: index * 2, y: 0, z: 0 }, planeId: 'room_1', facing: 0 }),
                physicsJson: JSON.stringify({ scaleClass: 1, collisionRadius: 0.5, mass: 50, movementModes: ['WALK'] })
            } });
        }
        await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(3000, '127.0.0.1', resolve); });
        console.log('[browser] READY http://127.0.0.1:3000 ; isolated room_1, HEAVY_STRIKE=25 damage');
        await finished;
    } finally {
        await new Promise<void>(resolve => cleanup.io.close(() => resolve()));
        await cleanup.campaignManager.destroyScene('room_1');
        Dictionary.getAction = original;
        await prisma.$disconnect();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
