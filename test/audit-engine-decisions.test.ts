import assert from 'node:assert/strict';
import type { ActionTemplate, Entity } from '../packages/shared/src/index.js';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { InMemoryActionCatalog } from '../packages/backend/src/rules/ActionCatalog.js';

function entity(id: string): Entity {
    return { id, templateId: 'audit', type: 'ACTOR', activeEffects: [],
        transform: { coords: { x: 0, y: 0, z: 0 }, planeId: 'test', facing: 0 },
        physics: { scaleClass: 1, collisionRadius: 0.5, mass: 1, movementModes: [] },
        resources: { current: { hp: 100, focus: 10 }, max: { hp: 100, focus: 10 } } };
}

function manualWindows(): CombatEngine {
    const engine = new CombatEngine('audit-two-sockets', new InMemoryActionCatalog());
    engine.setAutoProcess(false);
    engine.mountEntities([entity('a'), entity('b')]);
    for (const actorId of ['a', 'b']) {
        engine.receiveIntent({ actorId, clientTick: 0, intentType: 'HOOK_PRESET', payload: {
            hookPreset: { id: actorId, entityId: actorId, label: actorId, enabled: true,
                trigger: { type: 'TICK_REACHED', targetTick: 0 } },
        } });
    }
    return engine;
}

function reactionWindow(): CombatEngine {
    const attack: ActionTemplate = { id: 'attack', tags: ['ATTACK'], timeCost: { startupTicks: 2, recoveryTicks: 2 },
        resourceCost: {}, range: { type: 'MELEE', distanceExpr: '1' }, effects: [] };
    const parry: ActionTemplate = { id: 'PARRY', tags: ['REACTION'], timeCost: { startupTicks: 0, recoveryTicks: 1 },
        resourceCost: { focus: '2' }, range: { type: 'SELF', distanceExpr: '0' }, effects: [] };
    const engine = new CombatEngine('audit-reaction-owner', new InMemoryActionCatalog([attack, parry]));
    engine.setAutoProcess(false);
    engine.mountEntities([entity('source'), entity('reactor')]);
    engine.setPlayerControlledEntities(['reactor']);
    engine.receiveIntent({ actorId: 'source', clientTick: 0, intentType: 'CAST_ACTION',
        payload: { actionTemplateId: 'attack', targetIds: ['reactor'] } });
    assert.equal(engine.getPendingDecisionCount(), 1);
    return engine;
}

let failures = 0;
function check(label: string, run: () => void): void {
    try { run(); console.log(`PASS ${label}`); }
    catch (error) { failures++; console.error(`FAIL ${label}`, error); }
}

check('one resolved window disappears immediately while another socket still decides', () => {
    const engine = manualWindows();
    const [first, second] = engine.getActiveDecisionPolls();
    engine.handleDecisionEngage(first.windowId, 'socket-a');
    engine.handleDecisionEngage(second.windowId, 'socket-b');
    engine.handleDecisionResponse({ windowId: first.windowId, chosenOptionId: null }, 'socket-a');
    assert.equal(engine.getPendingDecisionCount(), 1);
    assert.deepEqual(engine.getActiveDecisionPolls().map(poll => poll.windowId), [second.windowId]);
    engine.handleDecisionResponse({ windowId: first.windowId, chosenOptionId: null }, 'socket-a');
    assert.equal(engine.getPendingDecisionCount(), 1);
    engine.expireDecisionWindow(second.windowId);
    assert.equal(engine.getPendingDecisionCount(), 0);
});

check('engagement cannot be overwritten by the second socket', () => {
    const engine = reactionWindow();
    const windowId = engine.getActiveDecisionPoll()!.windowId;
    engine.handleDecisionEngage(windowId, 'socket-a');
    engine.handleDecisionEngage(windowId, 'socket-b');
    engine.handleDecisionResponse({ windowId, chosenOptionId: null }, 'socket-a');
    assert.equal(engine.getPendingDecisionCount(), 0);
});

check('a second socket cannot select a reaction owned by the first socket', () => {
    const engine = reactionWindow();
    const windowId = engine.getActiveDecisionPoll()!.windowId;
    const reactor = engine.getAllEntities().find(actor => actor.id === 'reactor')!;
    engine.handleDecisionEngage(windowId, 'socket-a');
    engine.handleDecisionResponse({ windowId, chosenOptionId: 'PARRY' }, 'socket-b');
    assert.equal(engine.getPendingDecisionCount(), 1);
    assert.equal(reactor.resources.current.focus, 10);
    assert.equal(reactor.currentActionContext, undefined);
    engine.handleDecisionResponse({ windowId, chosenOptionId: 'PARRY' }, 'socket-a');
    assert.equal(engine.getPendingDecisionCount(), 0);
    assert.equal(reactor.resources.current.focus, 8);
});

check('disconnect releases only its socket\'s windows and duplicate disconnect is harmless', () => {
    const engine = manualWindows();
    const [first, second] = engine.getActiveDecisionPolls();
    engine.handleDecisionEngage(first.windowId, 'socket-a');
    engine.handleDecisionEngage(second.windowId, 'socket-b');
    const release: unknown = Reflect.get(engine, 'releaseSocketDecisionWindows');
    assert.equal(typeof release, 'function');
    assert.equal(Reflect.apply(release as (...args: unknown[]) => unknown, engine, ['socket-a']), 1);
    assert.equal(engine.getPendingDecisionCount(), 1);
    assert.deepEqual(engine.getActiveDecisionPolls().map(poll => poll.windowId), [second.windowId]);
    assert.equal(Reflect.apply(release as (...args: unknown[]) => unknown, engine, ['socket-a']), 0);
    assert.equal(engine.getPendingDecisionCount(), 1);
    engine.handleDecisionResponse({ windowId: second.windowId, chosenOptionId: null }, 'socket-b');
    assert.equal(engine.getPendingDecisionCount(), 0);
});

check('reconnecting can reclaim a window without ending its decision deadline', () => {
    const engine = reactionWindow();
    const windowId = engine.getActiveDecisionPoll()!.windowId;
    engine.handleDecisionEngage(windowId, 'socket-old');
    const release: unknown = Reflect.get(engine, 'releaseSocketDecisionEngagement');
    assert.equal(typeof release, 'function');
    assert.equal(Reflect.apply(release as (...args: unknown[]) => unknown, engine, ['socket-old']), 1);
    assert.equal(engine.getPendingDecisionCount(), 1);
    assert.equal(engine.getActiveDecisionPoll()!.windowId, windowId);
    assert.equal(Reflect.apply(release as (...args: unknown[]) => unknown, engine, ['socket-old']), 0);
    engine.handleDecisionEngage(windowId, 'socket-new');
    engine.handleDecisionResponse({ windowId, chosenOptionId: 'PARRY' }, 'socket-old');
    assert.equal(engine.getPendingDecisionCount(), 1);
    engine.handleDecisionResponse({ windowId, chosenOptionId: null }, 'socket-new');
    assert.equal(engine.getPendingDecisionCount(), 0);
});

check('fired hooks carry their owner for visibility filtering', () => {
    const engine = new CombatEngine('audit-hook-owner', new InMemoryActionCatalog());
    engine.mountEntities([entity('owner')]);
    let owner: string | undefined;
    engine.on('HOOK_FIRED', (event: { entityId?: string }) => { owner = event.entityId; });
    engine.receiveIntent({ actorId: 'owner', clientTick: 0, intentType: 'HOOK_PRESET', payload: {
        hookPreset: { id: 'private', entityId: 'owner', label: 'private', enabled: true,
            trigger: { type: 'TICK_REACHED', targetTick: 0 } },
    } });
    assert.equal(owner, 'owner');
});

check('removing an actor resolves its decision window without resolving another actor', () => {
    const engine = manualWindows();
    const [first, second] = engine.getActiveDecisionPolls();
    engine.unmountEntities([first.actorId]);
    assert.equal(engine.getPendingDecisionCount(), 1);
    assert.deepEqual(engine.getActiveDecisionPolls().map(poll => poll.windowId), [second.windowId]);
    engine.unmountEntities([first.actorId]);
    assert.equal(engine.getPendingDecisionCount(), 1);
    engine.expireDecisionWindow(second.windowId);
    assert.equal(engine.getPendingDecisionCount(), 0);
});

if (failures) throw new Error(`${failures} engine decision audit checks failed`);
console.log('audit-engine-decisions: passed');
