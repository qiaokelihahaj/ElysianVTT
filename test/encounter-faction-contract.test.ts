import assert from 'node:assert/strict';
import {
  getEntityFaction, getEncounterSide, getEncounterRelation, isEncounterFaction,
  isEncounterSide, normalizeEncounterFaction, sameEncounterSide,
} from '../packages/shared/src/encounterFactions.ts';
import type { EncounterSide, EncounterSideRelation } from '../packages/shared/src/index.ts';

for (const value of ['赤砂商会', '城镇 守卫', 'faction-10', 'A'.repeat(64)]) assert.equal(isEncounterFaction(value), true);
for (const value of ['', ' ', ' leading', 'trailing ', 'A'.repeat(65), 'line\nbreak', '__proto__', 'constructor', null, 1, {}]) {
  assert.equal(isEncounterFaction(value), false, `invalid faction ${JSON.stringify(value)}`);
}
assert.equal(normalizeEncounterFaction('PLAYER'), 'PLAYERS');
assert.equal(normalizeEncounterFaction('ENEMY'), 'ENEMIES');
assert.equal(getEntityFaction({ tags: ['PLAYER'] }), 'PLAYERS');
assert.equal(getEntityFaction({ faction: null, tags: ['PLAYER'] }), null, 'explicit independence overrides old tags');
assert.equal(getEntityFaction({ faction: 'NEUTRAL', tags: ['PLAYER'] }), null, 'legacy neutral does not create one shared team');
assert.equal(getEntityFaction({ faction: '第三方', tags: ['PLAYER'] }), '第三方');

const faction = (id: string): EncounterSide => ({ kind: 'FACTION', id });
const first = getEncounterSide({ id: '独行者1', faction: null });
const second = getEncounterSide({ id: '独行者2', faction: null });
assert.equal(sameEncounterSide(first, second), false);
assert.equal(sameEncounterSide(first, faction('独行者1')), false, 'entity IDs and faction IDs use different namespaces');
assert.equal(sameEncounterSide(faction('PLAYER'), faction('PLAYERS')), true);
assert.equal(getEncounterRelation(first, second), 'UNKNOWN', 'independence neither allies nor antagonizes unrelated actors');
assert.equal(getEncounterRelation(faction('商会'), faction('商会')), 'ALLY');
assert.equal(getEncounterRelation(faction('PLAYER'), faction('ENEMY')), 'HOSTILE', 'legacy demo defaults remain playable');
const relations: EncounterSideRelation[] = [
  { a: first, b: second, relation: 'HOSTILE' },
  { a: faction('商会'), b: faction('守卫'), relation: 'ALLY' },
  { a: faction('PLAYERS'), b: faction('ENEMIES'), relation: 'NEUTRAL' },
];
assert.equal(getEncounterRelation(second, first, relations), 'HOSTILE', 'relations apply in either direction');
assert.equal(getEncounterRelation(faction('守卫'), faction('商会'), relations), 'ALLY');
assert.equal(getEncounterRelation(faction('PLAYER'), faction('ENEMY'), relations), 'NEUTRAL', 'explicit relations override legacy defaults');
assert.equal(getEncounterRelation(first, faction('商会'), relations), 'UNKNOWN');
assert.equal(isEncounterSide(first), true);
assert.equal(isEncounterSide(faction('商会')), true);
for (const value of [{ kind: 'FACTION', id: 'NEUTRAL' }, { kind: 'PLAYER', id: 'A' }, { kind: 'ENTITY', id: '' }, { kind: 'ENTITY', id: 'x'.repeat(129) }, null]) {
  assert.equal(isEncounterSide(value), false);
}
console.log('encounter-faction-contract: custom factions, aliases, independent identities and symmetric relations passed');
