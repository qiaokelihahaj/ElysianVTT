import assert from 'node:assert/strict';
import type { Socket } from 'socket.io';
import { IntentRouter } from '../packages/backend/src/network/IntentRouter.js';
import type { CampaignManager } from '../packages/backend/src/campaigns/CampaignManager.js';
import { PermissionService } from '../packages/backend/src/permissions/PermissionService.js';
import type { ClientIntent } from '@hard-vtt/shared';

async function main(): Promise<void> {
    const routed: ClientIntent[] = [];
    const errors: Array<{ code: string }> = [];
    const subject = PermissionService.createSubject({
        sessionId: 'audit-session', userId: 'audit-gm', role: 'GM',
        controlledEntityIds: [], visibleEntityIds: [], allowedSceneIds: ['audit-scene'],
    });
    const socket = {
        id: 'audit-socket',
        data: { authenticated: true, currentSceneId: 'audit-scene', permissionSubject: subject,
            permissionSnapshot: PermissionService.buildSnapshot(subject, 'audit-scene') },
        emit: (_event: string, payload: { code: string }) => errors.push(payload),
    } as unknown as Socket;
    const manager = {
        getEngine: async () => ({ receiveIntent: (intent: ClientIntent) => routed.push(intent) }),
    } as unknown as CampaignManager;
    const router = new IntentRouter(manager);
    for (const input of [
        null,
        { actorId: 'actor', intentType: 'BATCH_CAST', payload: { batchIntents: {} } },
        { actorId: 'actor', intentType: 'BATCH_CAST', payload: { batchIntents: [null] } },
        { actorId: 'actor', intentType: 'MOVE', payload: { targetCoords: { x: NaN, y: 0, z: 0 } } },
        { actorId: 'actor', intentType: 'PRIORITY_TOGGLE', payload: { toggleMode: 'UNKNOWN' } },
        { actorId: 'actor', intentType: 'HOOK_PRESET', payload: { hookPreset: { trigger: { type: 'UNKNOWN' } } } },
    ]) {
        await assert.doesNotReject(() => router.routeIntent(socket, input as ClientIntent));
        assert.equal(errors.at(-1)?.code, 'INVALID_INTENT');
    }
    assert.equal(routed.length, 0);
    await router.routeIntent(socket, { actorId: 'actor', intentType: 'MOVE', clientTick: 0,
        payload: { targetCoords: { x: 1, y: 0, z: 0 } } });
    assert.equal(routed.length, 1);
    console.log('audit network input: malformed intents rejected; valid intent routed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
