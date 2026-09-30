import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EncounterSnapshot } from '../packages/shared/src/index.js';
import { DemoPersistence } from '../packages/backend/src/demo/DemoPersistence.js';

const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'elysian-demo-persistence-')));
const persistence = new DemoPersistence({ dataDirectory: temporaryRoot });
const snapshot: EncounterSnapshot = {
    encounterId: 'persistence-test', revision: 1, tick: 0, status: 'LOBBY', paused: false,
    entities: [{
        id: 'actor', templateId: 'warrior', type: 'ACTOR',
        transform: { coords: { x: 0, y: 0, z: 0 }, facing: 0, planeId: 'arena' },
        physics: { collisionRadius: 0.4, mass: 60, scaleClass: 1, movementModes: ['WALK'] },
        resources: { current: { hp: 100 }, max: { hp: 100 } }, activeEffects: [],
    }],
    actions: [], decisions: [], controls: [], logs: [],
    plan: { windowTick: 0, slots: [], committed: false, actions: [], barrierVersion: 1 },
};

let failures = 0;
function check(name: string, run: () => void): void {
    try { run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}`, error); }
}

try {
    check('a stored opening snapshot is independent of subsequent memory mutation', () => {
        const input = structuredClone(snapshot);
        assert.ok(persistence.saveOpeningSnapshot(input).ok);
        input.entities[0].resources.current.hp = 1;
        assert.equal(persistence.loadOpeningSnapshot()?.entities[0].resources.current.hp, 100);
    });

    for (const [name, corrupted] of [
        ['unknown encounter state', { ...snapshot, status: 'ARBITRARY_STATE' }],
        ['missing entity resources', { ...snapshot, entities: [{ id: 'broken' }] }],
        ['nonnumeric resource', { ...snapshot, entities: [{ ...snapshot.entities[0], resources: { current: { hp: '100' }, max: { hp: 100 } } }] }],
        ['malformed ready slots', { ...snapshot, plan: { ...snapshot.plan, slots: [null] } }],
    ] as const) {
        check(`corrupted snapshot is rejected: ${name}`, () => {
            assert.ok(persistence.saveOpeningSnapshot(snapshot).ok);
            const db = new DatabaseSync(persistence.databasePath);
            try {
                db.prepare('UPDATE demo_encounters SET opening_snapshot_json = ?, latest_snapshot_json = ? WHERE encounter_id = ?')
                    .run(JSON.stringify(corrupted), JSON.stringify(corrupted), snapshot.encounterId);
            } finally { db.close(); }
            let loaded: unknown;
            try { loaded = persistence.loadOpeningSnapshot(); }
            catch { loaded = undefined; }
            assert.equal(loaded, undefined, 'corrupted data must not reach the combat engine as a typed snapshot');
        });
    }
} finally {
    persistence.close();
    assert.equal(dirname(temporaryRoot), realpathSync(tmpdir()));
    assert.ok(basename(temporaryRoot).startsWith('elysian-demo-persistence-'));
    rmSync(temporaryRoot, { recursive: true, force: true });
}

assert.equal(failures, 0, `${failures} demo persistence regressions failed`);
console.log('demo-persistence-regression: all 5 scenarios passed');
