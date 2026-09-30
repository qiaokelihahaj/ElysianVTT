import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { CampaignManager } from '../packages/backend/src/campaigns/CampaignManager.js';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { InMemoryActionCatalog } from '../packages/backend/src/rules/ActionCatalog.js';
import { CharacterSheetRepository } from '../packages/backend/src/db/CharacterSheetRepository.js';

async function main(): Promise<void> {
    const io = new Server(createServer());
    const manager = new CampaignManager(io);
    const originalFind = CharacterSheetRepository.findBySceneId;
    let reloads = 0;
    CharacterSheetRepository.findBySceneId = async () => { reloads++; return []; };
    try {
        const scene = manager.getOrCreateScene('audit-paused-campaign');
        const existing = new CombatEngine(scene.sceneId, new InMemoryActionCatalog());
        existing.scheduleWakeTick(7);
        existing.processPending();
        await scene.activate(existing);
        scene.pause();
        const recovered = await manager.getOrCreateEngine(scene.sceneId);
        assert.ok(recovered === existing, 'a paused scene must retain its in-memory engine');
        assert.equal(recovered.currentTick, 7, 'returning to a paused scene preserves time');
        assert.equal(reloads, 0, 'retained scenes do not reload saved entities');
        console.log('audit-engine-campaigns: passed');
    } finally {
        CharacterSheetRepository.findBySceneId = originalFind;
        await manager.destroyScene('audit-paused-campaign');
        await new Promise<void>(resolve => { io.close(() => resolve()); });
    }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
