import assert from 'node:assert/strict';
import React, { createElement } from '../packages/frontend/node_modules/react/index.js';
import { renderToStaticMarkup } from '../packages/frontend/node_modules/react-dom/server.node.js';
import type { EncounterEntity, EncounterSnapshot } from '../packages/shared/src/index.ts';
import type { DemoSessionInfo } from '../packages/frontend/src/demo/types.ts';
import { EntityRoster } from '../packages/frontend/src/demo/EntityRoster.tsx';

Object.assign(globalThis, { React });
const hero: EncounterEntity = {
  id: 'hero', templateId: 'demo.player.melee', displayName: '先锋', faction: 'PLAYERS', type: 'ACTOR',
  transform: { coords: { x: 1, y: 2, z: 0 }, planeId: 'test', facing: 0 },
  physics: { scaleClass: 1, collisionRadius: .4, mass: 60, movementModes: ['WALK'] },
  resources: { current: { hp: 75, poise: 12, focus: 4 }, max: { hp: 100, poise: 20, focus: 8 } }, activeEffects: [],
};
function fixture(): EncounterSnapshot {
  return {
    encounterId: 'roster-ui', revision: 1, tick: 5, status: 'ACTIVE', paused: false,
    entities: [structuredClone(hero)], actions: [], controls: [], decisions: [], logs: [],
    plan: { windowTick: 5, committed: false, actions: [], barrierVersion: 2,
      slots: [{ entityId: 'hero', connected: true, ready: false, waiting: false, controllerUserId: 'player', controlEpoch: 0 }] },
  };
}
function render(snapshot: EncounterSnapshot, selectedEntityId: string | null = 'hero', selectionDisabled = false): string {
  const session: DemoSessionInfo = {
    accessToken: 'test-only', snapshot,
    session: { sessionId: 'test', userId: 'player', role: 'PL', displayName: '玩家',
      expiresAt: 20_000, reconnectUntil: 20_000, connectedSocketCount: 1, controlledEntityIds: ['hero'] },
  };
  return renderToStaticMarkup(createElement(EntityRoster, {
    snapshot, session, catalog: null, selectedEntityId, selectionDisabled, onSelectEntity: () => {},
  }));
}
function row(snapshot: EncounterSnapshot): string {
  const markup = render(snapshot).match(/<article\b[\s\S]*?<\/article>/);
  assert.ok(markup, 'a visible entity has a row');
  return markup[0];
}
const idle = render(fixture());
assert.match(idle, /先锋/);
assert.match(idle, /生命/);
assert.match(idle, /75/);
assert.match(idle, /专注/);
assert.match(idle, /待提交/);
assert.doesNotMatch(idle, /当前 Tick|提交窗口/, 'global clock and submission-window headings belong to the timeline');
assert.match(idle, /aria-label="选择先锋"/);
assert.match(render(fixture(), 'hero', true), /aria-label="选择先锋"[^>]*disabled=""/, 'entity selection is visibly locked during submission');
assert.doesNotMatch(idle, /玩家阵营|敌对阵营/, 'affiliation is not an absolute player/enemy relationship');
const mainRow = row(fixture()).split('<details')[0];
assert.doesNotMatch(mainRow, /demo-entity-roster-glyph/, 'decorative avatar glyphs do not consume the name column');
for (const label of ['生命', '韧性', '专注']) {
  assert.ok(mainRow.includes(`aria-label="先锋${label}"`), `${label} remains in the primary row rather than collapsed details`);
}
for (const values of ['75/100', '12/20', '4/8']) assert.ok(mainRow.includes(values), `${values} remains explicit alongside the resource graphic`);
const zeroResources = fixture();
zeroResources.entities[0].resources = { current: { hp: 0, poise: 0, focus: 0 }, max: { hp: 0, poise: 20, focus: 0 } };
assert.doesNotMatch(render(zeroResources), /NaN|Infinity/, 'zero maximums cannot create invalid meter values');
const aboveMaximum = fixture();
aboveMaximum.entities[0].resources.current.hp = 125;
assert.ok(row(aboveMaximum).split('<details')[0].includes('125/100'), 'meter clamping never changes authoritative numeric values');
const ready = fixture();
ready.plan.slots[0].ready = true;
assert.match(render(ready), /已提交/);
for (const reason of ['等待该玩家提交行动', 'GM 取消后等待重新提交']) {
  const awaitingSubmission = fixture();
  awaitingSubmission.plan.slots[0].blockedReason = reason;
  assert.match(row(awaitingSubmission), /demo-entity-roster-slot is-pending/, 'server submission prompts use the pending symbol rather than the blocked symbol');
}
const waiting = fixture();
waiting.plan.slots[0].waiting = true;
waiting.plan.slots[0].readyAtTick = 11;
assert.match(render(waiting), /等待.*T\s*11/);
const delayed = fixture();
delayed.plan.slots[0].readyAtTick = 11;
assert.match(render(delayed), /等待.*T\s*11/);
assert.doesNotMatch(row(delayed), /待提交/, 'future readiness is not an actionable submission');
const recovery = fixture();
recovery.entities[0].currentActionContext = { type: 'CASTING', actionId: 'cast', phase: 'RECOVERY', resolveTick: 9 };
assert.match(render(recovery), /收招|后摇/);
assert.match(render(recovery), /T\s*9/);
recovery.actions = [{ actionId: 'plan-id-not-event-id', actorId: 'hero', actionTemplateId: 'DEMO_MELEE_STRIKE',
  targetIds: [], phase: 'RECOVERY', declaredTick: 2, priority: 0, paidResources: {}, decisionVersion: 1, controlEpoch: 0, causationId: 'test' }];
assert.match(render(recovery), /近战突击/, 'context event IDs must not prevent finding the actor action');
const down = fixture();
down.entities[0].resources.current.hp = 0;
assert.match(render(down), /倒下/);
assert.doesNotMatch(row(down), /待提交/, 'downed entities are not prompted to submit');
const paused = fixture();
paused.paused = true;
assert.match(render(paused), /暂停/);
assert.doesNotMatch(row(paused), /待提交/, 'paused encounters are not actionable');
const blocked = fixture();
blocked.plan.slots[0].blockedReason = '资源不足，无法提交';
assert.doesNotMatch(row(blocked), /待提交/, 'short labels must not turn a rejected submission into an actionable prompt');
assert.match(row(blocked), /资源不足，无法提交/, 'the full reason remains available');
const offline = fixture();
offline.plan.slots[0].connected = false;
assert.match(render(offline), /断线|离线/);
const unmanaged = fixture();
unmanaged.plan.slots = [];
const noSlot = row(unmanaged);
assert.doesNotMatch(noSlot, /待提交|玩家断线|玩家离线/, 'missing slots do not imply a blocked player');
const filtered = fixture();
filtered.plan.slots.push({ entityId: 'not-in-visible-entities', connected: false, ready: false, waiting: false, controlEpoch: 0 });
assert.doesNotMatch(render(filtered), /not-in-visible-entities/, 'rows come only from the visible snapshot entities');
const prop = fixture();
prop.entities[0].type = 'PROP';
prop.entities[0].displayName = '石柱';
prop.entities[0].resources = { current: {}, max: {} };
prop.plan.slots = [];
assert.match(render(prop), /石柱/, 'non-actor visible entities are included');
assert.doesNotMatch(row(prop), /待提交|玩家断线|玩家离线/);
assert.match(row(prop).split('<details')[0], /—\/—/, 'missing resources are not fabricated as zero');
prop.entities[0].resources.max.hp = 100;
assert.match(row(prop), /role="group" aria-label="石柱生命"/, 'unknown current values do not expose an invalid accessible meter');
const gmControlled = fixture();
gmControlled.plan.slots[0].connected = false;
gmControlled.controls = [{ entityId: 'hero', role: 'GM', controlEpoch: 1, connectedSocketIds: [], takenOverByGm: true }];
assert.match(render(gmControlled), /GM/);
assert.doesNotMatch(render(gmControlled), /断线|离线/, 'GM takeover is not shown as a disconnected player');
gmControlled.controls[0].takenOverByGm = false;
gmControlled.controls[0].userId = 'gm';
assert.doesNotMatch(row(gmControlled), /玩家控制|断线|离线/, 'ordinary GM control is not classified as a player connection');
const diplomacy = fixture();
diplomacy.entities[0].faction = '赤砂商会';
diplomacy.entities.push({ ...structuredClone(hero), id: 'guard', displayName: '守卫', faction: '城镇守卫' },
  { ...structuredClone(hero), id: 'wanderer', displayName: '独行者', faction: null });
diplomacy.relations = [
  { a: { kind: 'FACTION', id: '赤砂商会' }, b: { kind: 'FACTION', id: '城镇守卫' }, relation: 'HOSTILE' },
  { a: { kind: 'FACTION', id: '城镇守卫' }, b: { kind: 'ENTITY', id: 'wanderer' }, relation: 'ALLY' },
];
assert.match(render(diplomacy), /aria-label="守卫相对先锋：敌对"/);
assert.match(render(diplomacy), /aria-label="独行者相对先锋：关系未设置"/);
assert.match(render(diplomacy, 'guard'), /aria-label="独行者相对守卫：同盟"/, 'relationships use the selected actor as their reference');
assert.match(render(diplomacy), /赤砂商会|城镇守卫/);
assert.match(render(diplomacy), /独立/, 'unaffiliated actors do not form a neutral faction');
assert.doesNotMatch(render(diplomacy, null), /class="demo-entity-roster-relation/, 'no selected reference means no guessed friend/foe marker');
console.log('demo-entity-roster-ui: resources, submission, recovery, downed, offline and missing-slot states passed');
