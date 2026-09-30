import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LogLevel, LogVisibility, type EncounterLogEntry } from '../packages/shared/src/index.js';
import { EventBus, InternalEvent } from '../packages/backend/src/core/events/EventBus.js';
import { DemoGameLogBridge } from '../packages/backend/src/demo/DemoGameLogBridge.js';

const engine = new EventEmitter();
const entries: EncounterLogEntry[] = [];
const bridge = new DemoGameLogBridge(engine, { sceneId: 'log-test', currentTick: () => 7, append: entry => entries.push(entry) });
const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;
const emit = (sceneId: string, visibility: LogVisibility) => EventBus.emit(InternalEvent.GAME_LOG, { payload: {
    timestamp: 0, sceneId, namespace: 'Test', level: LogLevel.GAME, visibility,
    message: '[actor] 施放了 [action] 造成 7 点伤害', meta: { targetId: 'target', cyclic },
} });
try {
    emit('other-scene', LogVisibility.PLAYER);
    emit('log-test', LogVisibility.DEV);
    emit('log-test', LogVisibility.GM);
    assert.equal(entries.length, 0, 'calculation logs remain private until the state commit');
    engine.emit('STATE_MUTATED', {});
    assert.equal(entries.length, 1, 'cross-scene and developer-only logs never enter the player/GM feed');
    assert.equal(entries[0].visibility, LogVisibility.GM);
    assert.equal(entries[0].meta?.targetId, 'target');
    assert.doesNotThrow(() => JSON.stringify(entries), 'depth truncation must drop live/cyclic objects instead of returning them');
    bridge.close(engine);
    emit('log-test', LogVisibility.PLAYER);
    engine.emit('STATE_MUTATED', {});
    assert.equal(entries.length, 1, 'closing detaches both listeners');
    console.log('PASS: committed log boundary, scene/privacy isolation, bounded metadata and listener cleanup');
} finally { bridge.close(engine); }
