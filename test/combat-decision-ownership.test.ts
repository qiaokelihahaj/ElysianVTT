import assert from 'node:assert/strict';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import type { Entity } from '../packages/shared/src/index.js';

const entity: Entity = {
    id: 'reactor', templateId: 'unit', type: 'ACTOR',
    transform: { coords: { x: 0, y: 0, z: 0 }, planeId: 'test', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: 1, mass: 1, movementModes: [] },
    resources: { current: { hp: 100 }, max: { hp: 100 } }, activeEffects: []
};
const engine = new CombatEngine('decision-ownership');
engine.mountEntities([entity]);
engine.receiveIntent({ actorId: entity.id, intentType: 'HOOK_PRESET', clientTick: 0, payload: {
    hookPreset: { id: 'manual', entityId: entity.id, label: 'decision', enabled: true,
        trigger: { type: 'TICK_REACHED', targetTick: 0 } }
} });
const window = engine.getActiveDecisionPoll();
assert.ok(window);
assert.equal(engine.getPendingDecisionCount(), 1);
engine.handleDecisionEngage(window.windowId, 'socket-a');
engine.handleDecisionResponse({ windowId: window.windowId, chosenOptionId: null }, 'socket-b');
assert.equal(engine.getPendingDecisionCount(), 1, '其他连接的自动跳过不能关闭已接战窗口');
engine.handleDecisionResponse({ windowId: window.windowId, chosenOptionId: null }, 'socket-a');
assert.equal(engine.getPendingDecisionCount(), 0, '接战者仍可响应并解除暂停');
assert.equal(engine.getActiveDecisionPolls().length, 0);
engine.handleDecisionResponse({ windowId: window.windowId, chosenOptionId: null }, 'socket-a');
assert.equal(engine.getPendingDecisionCount(), 0, '重复响应不能使计数变负');
console.log('combat-decision-ownership: passed');
