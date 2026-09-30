import assert from 'node:assert/strict';
import type { EncounterCommand, EncounterSnapshot } from '../packages/shared/src/index.js';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.js';
import { createDemoEntity, DEMO_ACTION_IDS } from '../packages/backend/src/demo/DemoContent.js';

const gm = { userId: 'combat-acceptance-gm', role: 'GM' as const, socketId: 'combat-acceptance-socket' };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let sequence = 0;

async function run(): Promise<void> {
    const coordinator = new EncounterCoordinator({ entities: [
        createDemoEntity('player-melee', 'attacker', { x: 2, y: 2, z: 0 }),
        createDemoEntity('monster-bruiser', 'defender', { x: 3, y: 2, z: 0 }),
    ] });
    coordinator.connect(gm);
    const send = (command: Omit<EncounterCommand, 'requestId'>) => {
        const result = coordinator.handleCommand(gm, { ...command, requestId: `combat-${++sequence}` } as EncounterCommand);
        assert.ok(result.ok, `${command.type}: ${result.reason ?? result.message}`);
        return result.snapshot;
    };
    async function until(predicate: (snapshot: EncounterSnapshot) => boolean): Promise<EncounterSnapshot> {
        for (let index = 0; index < 100; index++) {
            const snapshot = coordinator.getSnapshot();
            if (predicate(snapshot)) return snapshot;
            await delay(10);
        }
        const snapshot = coordinator.getSnapshot();
        throw new Error(`Combat stalled: ${JSON.stringify({ tick: snapshot.tick, plan: snapshot.plan, decisions: snapshot.decisions, actions: snapshot.actions })}`);
    }
    try {
        send({ type: 'START', payload: {} });
        send({ type: 'ACTION', payload: { entityId: 'attacker', actionTemplateId: DEMO_ACTION_IDS.MELEE, targetIds: ['defender'] } });
        await delay(50);
        assert.equal(coordinator.getSnapshot().tick, 0, 'an attack must remain uncommitted before the final ready slot');
        assert.equal(coordinator.getSnapshot().entities.find(entity => entity.id === 'defender')?.resources.current.hp, 80);
        send({ type: 'WAIT', payload: { entityId: 'defender' } });
        const declaration = await until(snapshot => snapshot.decisions.length > 0);
        assert.equal(declaration.tick, 0, 'reaction windows must open at declaration/startup, not postpone an already due hit');
        assert.equal(declaration.entities.find(entity => entity.id === 'defender')?.resources.current.hp, 80, 'reaction must open before the first hit');
        assert.ok(declaration.decisions.some(window => window.reactorEntityId === 'defender'), 'waiting defender retains reaction eligibility');
        send({ type: 'GM_PASS_ALL', payload: {} });
        const settled = await until(snapshot => (snapshot.entities.find(entity => entity.id === 'defender')?.resources.current.hp ?? 80) < 80);
        assert.equal(settled.entities.find(entity => entity.id === 'defender')?.resources.current.hp, 62, 'the real melee template deals 18 HP damage');
        const waiting = await until(snapshot => snapshot.tick === 5);
        assert.equal(waiting.entities.find(entity => entity.id === 'attacker')?.currentActionContext?.phase, 'RECOVERY');
        send({ type: 'WAIT', payload: { entityId: 'defender' } });
        const ready = await until(snapshot => !snapshot.entities.find(entity => entity.id === 'attacker')?.currentActionContext);
        assert.equal(ready.tick, 7, 'two startup Ticks, three ACTIVE Ticks and two recovery Ticks');
        await delay(100);
        assert.equal(coordinator.getSnapshot().tick, 7, 'the next main-action barrier must remain stable');
        console.log('PASS: real melee declaration, pre-hit reaction, damage, recovery and mixed wait barrier');
    } finally {
        coordinator.close();
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
