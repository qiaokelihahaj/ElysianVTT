import assert from 'node:assert/strict';
import React, { createElement } from '../packages/frontend/node_modules/react/index.js';
import { renderToStaticMarkup } from '../packages/frontend/node_modules/react-dom/server.node.js';
import type { DemoCatalogAction, EncounterActionPlan, EncounterEntity, EncounterSnapshot } from '../packages/shared/src/index.ts';
import type { DemoCatalog, DemoSessionInfo } from '../packages/frontend/src/demo/types.ts';
import { SpatialTacticsPanel } from '../packages/frontend/src/demo/SpatialTacticsPanel.tsx';
import { Battlefield } from '../packages/frontend/src/demo/Battlefield.tsx';
import { BattlefieldSpatialOverlays } from '../packages/frontend/src/demo/BattlefieldSpatialOverlays.tsx';
import { LobbyPanel } from '../packages/frontend/src/demo/Panels.tsx';
import type { ActionTargeting } from '../packages/frontend/src/demo/useActionTargeting.ts';

Object.assign(globalThis, { React });
const hero: EncounterEntity = {
  id: 'hero', templateId: 'hero', type: 'ACTOR', displayName: '先锋', faction: 'PLAYERS',
  transform: { coords: { x: 1, y: 1, z: 0 }, planeId: 'test', facing: 60 },
  physics: { scaleClass: 1, collisionRadius: .45, mass: 60, movementModes: ['WALK'] },
  resources: { current: { hp: 90, focus: 8 }, max: { hp: 100, focus: 8 } }, activeEffects: [],
  equippedWeaponId: 'spear', currentStance: 'ADS', bodyBlocking: true,
  coverState: { coverDefId: 'sandbag', coverType: 'HALF', coverDr: 4, coverThreshold: 10, facing: 120, height: 1 },
  bodyParts: { HEAD: { currentHp: 0, maxHp: 24, destroyed: true }, TORSO: { currentHp: 36, maxHp: 40, destroyed: false } },
  formationContext: {
    interceptConfig: { interceptRange: 1.2, interceptionRating: 20, interceptDamageReduction: .5, failurePenaltyPoise: 2, failureKnockback: 1 },
    blockZones: [{ id: 'zone-1', center: { x: 3, y: 2, z: 0 }, radius: 1.2, durationTicks: 9, triggerDamage: 8, ownerId: 'hero' }],
  },
};
const snapshot: EncounterSnapshot = {
  encounterId: 'tactical-ui', revision: 1, tick: 5, status: 'ACTIVE', paused: false,
  entities: [hero], actions: [], decisions: [], controls: [], logs: [],
  plan: { windowTick: 5, slots: [{ entityId: 'hero', connected: true, ready: false, waiting: false, controlEpoch: 0 }], committed: false, actions: [], barrierVersion: 1 },
};
const action = { id: 'TACTIC_LOB', label: '抛射爆弹', description: '抛射落地爆炸，包括友军。', tags: ['ATTACK', 'PROJECTILE', 'AOE'], targetKind: 'cell' as const, startupTicks: 4, recoveryTicks: 3, resourceCost: { focus: '2' } };
const catalog: DemoCatalog = {
  map: { id: 'test', name: '断桥堡垒', width: 5, height: 4, tiles: [] },
  capabilities: { actionPreview: true },
  entries: [{ templateId: 'hero', label: '先锋', faction: 'PLAYERS', actions: [action] }],
  scenario: { id: 'spatial-tactics', title: '断桥堡垒 · 空间战术演练', summary: '从河岸推进到堡垒。', objectives: [
    { id: 'blast', title: '范围攻击与友伤', description: '检查队友位置再选择落点。', actionIds: ['TACTIC_LOB'] },
  ] },
};
const session: DemoSessionInfo = { accessToken: 'test-only', snapshot, session: {
  sessionId: 'test', userId: 'player', role: 'PL', displayName: '玩家', expiresAt: 10000, reconnectUntil: 10000, connectedSocketCount: 1, controlledEntityIds: ['hero'],
} };
const guide = (view = snapshot, viewer = session) => renderToStaticMarkup(createElement(SpatialTacticsPanel, {
  catalog, snapshot: view, session: viewer, selectedEntityId: 'hero', onChooseAction: () => {},
}));
const html = guide();
assert.match(html, /断桥堡垒 · 空间战术演练/);
assert.match(html, /包括友军/);
assert.match(html, /演练动作：抛射爆弹/);
assert.doesNotMatch(html.match(/<button[^>]*aria-label="演练动作：抛射爆弹"[^>]*>/)?.[0] ?? '', /disabled=/, 'an idle controlled actor can enter the authoritative action picker');
assert.match(html, /瞄准射击/);
assert.match(html, /半掩体/);
assert.match(html, /团队拦截/);
assert.match(html, /头部 0\/24 · 已破坏/);
assert.match(html, /持续 9T/, 'the rule duration is not presented as a countdown');
assert.match(guide({ ...snapshot, paused: true }), /<button[^>]*disabled=""[^>]*aria-label="演练动作：抛射爆弹"/, 'a paused encounter cannot submit from the guide');
assert.match(guide(snapshot, { ...session, session: { ...session.session, controlledEntityIds: [] } }), /<button[^>]*disabled=""[^>]*aria-label="演练动作：抛射爆弹"/, 'inspecting a foreign actor cannot submit from the guide');
assert.equal(renderToStaticMarkup(createElement(SpatialTacticsPanel, { catalog: { ...catalog, scenario: undefined }, snapshot, session, selectedEntityId: 'hero' })), '', 'older and classic catalogs do not fabricate a spatial scenario');

const cover: EncounterEntity = { ...structuredClone(hero), id: 'cover', type: 'PROP', displayName: '可破坏沙袋', formationContext: undefined, bodyParts: undefined };
const projectile: EncounterEntity = { ...structuredClone(hero), id: 'projectile', type: 'PROJECTILE', displayName: '在途爆弹', formationContext: undefined, coverState: undefined, bodyParts: undefined };
const interaction: ActionTargeting = {
  enabled: true, state: { actorId: hero.id, action, phase: 'cell', loading: false, generation: 1, preview: {
    revision: 1, actorId: hero.id, actionTemplateId: action.id, targetKind: 'cell', available: true, entities: [], cells: [{ x: 3, y: 2, allowed: true }],
  } }, label: '抛射爆弹', detail: '2 专注', isGm: false, controlledIds: ['hero'],
  choose: () => {}, cancel: () => {}, pickEntity: () => {}, pickCell: () => {}, selectEntity: () => {}, immediate: () => {},
};
const map = renderToStaticMarkup(createElement(Battlefield, {
  entities: [hero, cover, projectile], catalog, selectedEntityId: 'hero', selectedTargetId: null, selectedCell: null,
  interaction, onSelectEntity: () => {}, onSelectTarget: () => {}, onSelectCell: () => {},
}));
assert.match(map, /点击六边格指定位置/, 'cell targeting also describes blast centers and block zones');
assert.doesNotMatch(map, /点击六边格移动|可移动/, 'blast targeting must not claim to move the actor');
assert.match(map, /data-cover-prop="cover"/, 'cover is visually distinct from actor tokens');
assert.match(map, /data-projectile="projectile"/, 'actual server projectile entities have a distinct glyph');
assert.match(map, /data-cover-facing="120"/, 'cover defense direction comes from the filtered entity');
assert.match(map, /data-guard-cell="1,1"/);
assert.match(map, /data-block-zone="zone-1"/);
assert.match(map, /demo-spatial-overlays[^>]*pointer-events="none"/, 'tactical overlays cannot intercept targeting clicks');
const filteredMap = renderToStaticMarkup(createElement(Battlefield, {
  entities: [], catalog, selectedEntityId: null, selectedTargetId: null, selectedCell: null,
  onSelectEntity: () => {}, onSelectTarget: () => {}, onSelectCell: () => {},
}));
assert.doesNotMatch(filteredMap, /data-cover-prop|data-projectile|data-block-zone|data-guard-cell/, 'nothing is reconstructed from entities absent in the filtered snapshot');

const gm = { ...session, session: { ...session.session, role: 'GM' as const } };
const lobby = (demoCatalog: DemoCatalog) => renderToStaticMarkup(createElement(LobbyPanel, {
  catalog: demoCatalog, session: gm, snapshot: { ...snapshot, status: 'LOBBY' }, room: null,
  onAssign: () => {}, onStart: () => {}, onRefresh: () => {},
}));
assert.match(lobby(catalog), /可由主持人控制双方/);
assert.doesNotMatch(lobby(catalog).match(/<button[^>]*>开始战术演练<\/button>/)?.[0] ?? '', /disabled=/, 'the integrated tactics demo supports solo GM rehearsal');
assert.match(lobby({ ...catalog, scenario: undefined }), /<button[^>]*disabled=""[^>]*>等待 3 名玩家/, 'the classic demo still requires its existing three-player lobby');

const livePlan: EncounterActionPlan = {
  actionId: 'area-plan', actorId: hero.id, actionTemplateId: 'AREA', targetIds: [], phase: 'STARTUP',
  declaredTick: 5, priority: 1, paidResources: {}, decisionVersion: 1, controlEpoch: 0, causationId: 'area', relation: 'ATTACK',
};
function areaMarkup(aoe: NonNullable<DemoCatalogAction['aoe']>, facing: number, targetCoords?: EncounterActionPlan['targetCoords'], phase: EncounterActionPlan['phase'] = 'STARTUP'): string {
  const template = { ...action, id: 'AREA', aoe };
  return renderToStaticMarkup(createElement(BattlefieldSpatialOverlays, {
    entities: [{ ...hero, transform: { ...hero.transform, facing } }], selectedEntityId: null,
    width: 5, height: 4, actions: [{ ...livePlan, targetCoords, phase }],
    catalog: { ...catalog, entries: [{ ...catalog.entries[0], actions: [template] }] },
  }));
}
const cone = areaMarkup({ shape: 'CONICAL', radius: 4, angle: 90 }, 0);
assert.match(cone, /data-aoe-cell="4,1"/, 'a forward cell lies inside the declared cone');
assert.doesNotMatch(cone, /data-aoe-cell="0,1"|data-aoe-cell="1,3"/, 'cone shading excludes the rear and sideways cells');
const turnedCone = areaMarkup({ shape: 'CONICAL', radius: 4, angle: 90 }, 90);
assert.match(turnedCone, /data-aoe-cell="1,3"/, 'turning changes the geometric area');
assert.doesNotMatch(turnedCone, /data-aoe-cell="4,1"/);
const line = areaMarkup({ shape: 'LINEAR', radius: 3, width: .6 }, 0);
assert.match(line, /data-aoe-cell="4,1"/);
assert.doesNotMatch(line, /data-aoe-cell="2,2"/, 'linear coverage respects the half-width');
const blast = areaMarkup({ shape: 'CIRCULAR', radius: 1.2 }, 0, { x: 3, y: 2, z: 0 });
assert.match(blast, /data-aoe-cell="3,2"/);
assert.doesNotMatch(blast, /data-aoe-cell="1,1"/, 'a lobbed blast uses its declared landing point rather than the caster');
assert.doesNotMatch(areaMarkup({ shape: 'CIRCULAR', radius: 2 }, 0, undefined, 'RECOVERY'), /data-aoe-action/, 'recovery never implies a future attack area');
const hiddenAreaCatalog = { ...catalog, entries: [{ ...catalog.entries[0], actions: [{ ...action, id: 'AREA', aoe: { shape: 'CIRCULAR' as const, radius: 4 } }] }] };
const redactedArea = renderToStaticMarkup(createElement(BattlefieldSpatialOverlays, {
  entities: [hero], selectedEntityId: null, width: 5, height: 4, catalog: hiddenAreaCatalog,
  actions: [{ ...livePlan, relation: undefined, targetIds: [] }],
}));
assert.doesNotMatch(redactedArea, /data-aoe-action/, 'catalog metadata cannot reconstruct the relationship of a recipient-redacted action');
console.log('Spatial demo UI regression tests passed.');
