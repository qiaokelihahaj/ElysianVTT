import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { createElement } from '../packages/frontend/node_modules/react/index.js';
import { renderToStaticMarkup } from '../packages/frontend/node_modules/react-dom/server.node.js';
import { ActionPanel } from '../packages/frontend/src/demo/Panels.tsx';
import { Battlefield } from '../packages/frontend/src/demo/Battlefield.tsx';
import { useActionTargeting, useTargetingStore, type ActionTargeting } from '../packages/frontend/src/demo/useActionTargeting.ts';
import { useDemoStore } from '../packages/frontend/src/demo/store.ts';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.ts';
import { createDemoRoster, installDemoContent } from '../packages/backend/src/demo/DemoContent.ts';
import type { DemoCatalog, DemoSessionInfo } from '../packages/frontend/src/demo/types.ts';
import type { EncounterActionPlan } from '../packages/shared/src/index.ts';

Object.assign(globalThis, { React });
const content = installDemoContent();
const coordinator = new EncounterCoordinator({ content, entities: createDemoRoster() });
const snapshot = coordinator.getSnapshot();
snapshot.status = 'ACTIVE';
snapshot.paused = false;
const actor = snapshot.entities[0];
const action = { id: 'DEMO_MELEE_STRIKE', label: '近战突击', tags: ['ATTACK'], startupTicks: 2, recoveryTicks: 2, resourceCost: {} };
const catalog: DemoCatalog = { map: content.map!, capabilities: { actionPreview: true }, entries: [{ templateId: actor.templateId, label: '先锋', faction: 'PLAYERS', actions: [action] }] };
const session: DemoSessionInfo = { accessToken: 'test', snapshot, session: { sessionId: 'test', userId: 'gm', role: 'GM', displayName: 'GM', expiresAt: 1, reconnectUntil: 1, connectedSocketCount: 1, controlledEntityIds: [] } };
const panel = (choosing: boolean) => renderToStaticMarkup(createElement(ActionPanel, {
  session, snapshot, catalog, selectedEntityId: actor.id, selectedTargetId: null, selectedCell: null,
  onCommand: () => {}, ...(choosing ? { onChooseAction: () => {} } : {}),
}));
assert.match(panel(false), /disabled=""[^>]*>[\s\S]*近战突击/);
assert.doesNotMatch(panel(true).split('demo-action-card')[1].split('</button>')[0], /disabled=/, '动作优先流程无需先选择目标');
const interaction: ActionTargeting = {
  enabled: true, state: null, label: '', detail: '', isGm: true, controlledIds: [],
  choose: () => {}, cancel: () => {}, pickEntity: () => {}, pickCell: () => {}, selectEntity: () => {}, immediate: () => {},
};
const mapProps = { entities: snapshot.entities, catalog, selectedEntityId: actor.id, selectedTargetId: null, selectedCell: { x: 9, y: 5 }, onSelectEntity: () => {}, onSelectTarget: () => {}, onSelectCell: () => {}, interaction };
let html = renderToStaticMarkup(createElement(Battlefield, mapProps));
assert.doesNotMatch(html, /TACTICAL MAP|demo-panel-heading|demo-map-selection|操控实体/, 'the battlefield has no permanent title or entity selector above the map');
assert.doesNotMatch(renderToStaticMarkup(createElement(Battlefield, mapProps)), /demo-inspected/, 'entity information belongs to the roster rather than a map summary strip');
assert.doesNotMatch(html, /地图点选实体|<span>目标<\/span>/);
interaction.state = { actorId: actor.id, action, phase: 'cell', loading: false, generation: 1, preview: { revision: snapshot.revision, actorId: actor.id, actionTemplateId: action.id, targetKind: 'cell', available: true, entities: [], cells: [{ x: 1, y: 2, allowed: true }] } };
html = renderToStaticMarkup(createElement(Battlefield, mapProps));
assert.match(html, /demo-targeting-banner/);
assert.match(html, /demo-map-cell is-legal/);
assert.doesNotMatch(html, /class="demo-map-cell-selected"/, '动作目标不得复用 GM 残留选中格');
interaction.enabled = false;
interaction.state = null;
assert.match(renderToStaticMarkup(createElement(Battlefield, mapProps)), /列表选施放者、地图点选目标/, '旧服务保留列表选择施放者、地图选择目标的流程');

// Capture a handler before a submission starts, as a queued click can retain an
// older render. It must consult the current stores rather than its old closure.
const originalDemoState = useDemoStore.getState();
const originalTargetingState = useTargetingStore.getState();
const selectionHandler: { select?: ActionTargeting['selectEntity'] } = {};
let sentCommands = 0;
function SelectionHarness() {
  selectionHandler.select = useActionTargeting(() => { sentCommands++; }).selectEntity;
  return null;
}
try {
  const playerSession = { ...session, session: { ...session.session, role: 'PL' as const, controlledEntityIds: [actor.id] } };
  useDemoStore.setState({ snapshot, session: playerSession, selectedEntityId: actor.id });
  renderToStaticMarkup(createElement(SelectionHarness));
  assert.ok(selectionHandler.select);
  const selectEntity = selectionHandler.select;
  const foreignId = snapshot.entities[1].id;
  selectEntity(foreignId);
  assert.equal(useDemoStore.getState().selectedEntityId, foreignId, 'players can inspect visible entities without gaining control');
  assert.deepEqual(useDemoStore.getState().session?.session.controlledEntityIds, [actor.id]);
  selectEntity('not-visible');
  assert.equal(useDemoStore.getState().selectedEntityId, foreignId, 'missing entities cannot become the selection');
  selectEntity(actor.id);
  useTargetingStore.getState().update({ actorId: actor.id, action, phase: 'entity', loading: true, generation: 1 });
  selectEntity(foreignId);
  assert.equal(useTargetingStore.getState().selection, null, 'changing selection invalidates an in-flight preview');
  selectEntity(actor.id);
  useTargetingStore.getState().update({ actorId: actor.id, action, phase: 'submitting', loading: false, generation: 2 });
  const submitting = useTargetingStore.getState().selection;
  selectEntity(foreignId);
  selectEntity(null);
  assert.equal(useDemoStore.getState().selectedEntityId, actor.id, 'a stale handler cannot switch or clear an actor during submission');
  assert.equal(useTargetingStore.getState().selection, submitting, 'selection cannot discard the pending acknowledgement');
  assert.equal(sentCommands, 0, 'selection never sends a gameplay command');
} finally {
  useDemoStore.setState(originalDemoState, true);
  useTargetingStore.setState(originalTargetingState, true);
}

const fixtureActions: EncounterActionPlan[] = [
  {
    actionId: 'ux-move', actorId: 'demo-player-melee', actionTemplateId: 'DEMO_MOVE', targetIds: [],
    targetCoords: { x: 5, y: 2, z: 0 }, arrivalTick: 18, phase: 'STARTUP', declaredTick: 0,
    effectiveTick: 0, priority: 1, paidResources: {}, decisionVersion: 1, controlEpoch: 0, causationId: 'ux-move-cause',
  },
  {
    actionId: 'ux-attack', actorId: 'demo-player-ranged', actionTemplateId: 'DEMO_MELEE_STRIKE', targetIds: ['demo-monster-bruiser'],
    relation: 'ATTACK', phase: 'STARTUP', declaredTick: 0, effectiveTick: 2, priority: 2, paidResources: {}, decisionVersion: 1, controlEpoch: 0, causationId: 'ux-attack-cause',
  },
  {
    actionId: 'ux-heal', actorId: 'demo-monster-bruiser', actionTemplateId: 'DEMO_RECOVER_WOUND', targetIds: ['demo-player-ranged'],
    relation: 'HEAL', phase: 'STARTUP', declaredTick: 0, effectiveTick: 2, priority: 2, paidResources: {}, decisionVersion: 1, controlEpoch: 0, causationId: 'ux-heal-cause',
  },
  {
    actionId: 'ux-self-heal', actorId: 'demo-player-guide', actionTemplateId: 'DEMO_RECOVER_WOUND', targetIds: ['demo-player-guide'],
    relation: 'HEAL', selfTarget: true, phase: 'STARTUP', declaredTick: 0, effectiveTick: 3, priority: 1, paidResources: {}, decisionVersion: 1, controlEpoch: 0, causationId: 'ux-self-heal-cause',
  },
];
const previewInteraction: ActionTargeting = {
  ...interaction,
  enabled: true,
  state: {
    actorId: actor.id,
    action,
    phase: 'entity',
    loading: false,
    generation: 9,
    preview: {
      revision: snapshot.revision,
      actorId: actor.id,
      actionTemplateId: action.id,
      targetKind: 'entity',
      available: true,
      entities: snapshot.entities.map(entity => ({ entityId: entity.id, allowed: entity.id === 'demo-monster-bruiser' })),
      cells: [{ x: 0, y: 2, allowed: true }, { x: 1, y: 2, allowed: true }, { x: 2, y: 2, allowed: false, reason: '超出动作范围' }],
    },
  },
};
const renderFixture = (actions: EncounterActionPlan[], currentTick = 6): string => renderToStaticMarkup(createElement(Battlefield, {
  ...mapProps,
  interaction: previewInteraction,
  actions,
  currentTick,
}));
const previewMarkup = renderFixture(fixtureActions);
assert.match(previewMarkup, /demo-map-cell is-range/, 'server entity range cells are rendered below entities');
assert.match(previewMarkup, /class="demo-entity-token\b[^"\n]*\bis-legal\b[^"\n]*"/, 'legacy preview without inRange keeps the target selectable');
assert.doesNotMatch(previewMarkup, /class="demo-entity-token\b[^"\n]*\bis-pending-range\b[^"\n]*"/, 'legacy allowed target falls back to current range');
assert.match(previewMarkup, /demo-action-overlays[^>]*pointer-events="none"/, 'action relationships never intercept map clicks');
assert.match(previewMarkup, /demo-action-overlay-move/, 'movement relation is rendered');
assert.match(previewMarkup, /demo-action-label-plate/, 'action labels keep a high-contrast plate');
assert.match(previewMarkup, /攻击/, 'attack relationship is labeled');
assert.match(previewMarkup, /治疗/, 'heal relationship is labeled');
assert.match(previewMarkup, /自身/, 'explicit self-heal relationship is labeled');

// A newer preview server can keep an out-of-range target lockable when the
// target may enter range before the action's active window.  The token stays
// clickable, but the UI must explain the timing constraint instead of calling
// it currently in range.
const previewState = previewInteraction.state;
if (!previewState?.preview) throw new Error('Expected an entity preview fixture');
const basePreviewState = previewState;
const originalPreview = previewState.preview;
previewInteraction.state = {
  ...basePreviewState,
  preview: {
    ...originalPreview,
    entities: originalPreview.entities.map((candidate) => candidate.entityId === 'demo-monster-bruiser'
      ? { ...candidate, allowed: true, inRange: false }
      : candidate),
  },
};
const pendingRangeMarkup = renderFixture(fixtureActions);
assert.match(pendingRangeMarkup, /当前在范围外，生效窗口内进入才命中/, 'future-window target lock explains the current range constraint');
assert.match(pendingRangeMarkup, /class="demo-entity-token\b[^"\n]*\bis-legal\b[^"\n]*\bis-pending-range\b[^"\n]*"/, 'future-window target remains selectable with a distinct state');
assert.doesNotMatch(pendingRangeMarkup, /class="demo-entity-token\b[^"\n]*\bis-range\b[^"\n]*"/, 'future-window target is not marked as currently in range');
previewInteraction.state = { ...basePreviewState, preview: originalPreview };

previewInteraction.state = {
  ...basePreviewState,
  preview: {
    ...originalPreview,
    entities: originalPreview.entities.map((candidate) => candidate.entityId === 'demo-monster-bruiser'
      ? { ...candidate, allowed: true, inRange: true }
      : candidate),
  },
};
const currentRangeMarkup = renderFixture(fixtureActions);
assert.match(currentRangeMarkup, /class="demo-entity-token\b[^"\n]*\bis-legal\b[^"\n]*"/, 'in-range target keeps the normal selectable state');
assert.doesNotMatch(currentRangeMarkup, /is-pending-range/, 'in-range target does not show the future-window hint');
previewInteraction.state = { ...basePreviewState, preview: originalPreview };

previewInteraction.state = {
  ...basePreviewState,
  phase: 'cell',
  preview: {
    ...originalPreview,
    targetKind: 'cell',
    entities: [],
    cells: [{ x: 1, y: 2, allowed: true }, { x: 2, y: 2, allowed: false, reason: '超出动作范围' }],
  },
};
const movementPreviewMarkup = renderFixture(fixtureActions);
assert.match(movementPreviewMarkup, /demo-map-cell is-legal/, 'movement preview still marks allowed cells');
assert.match(movementPreviewMarkup, /demo-map-cell is-illegal/, 'movement preview keeps rejecting disallowed cells');
previewInteraction.state = {
  ...basePreviewState,
  phase: 'entity',
  preview: originalPreview,
};

const lifecycleMarkup = renderFixture([
  ...fixtureActions,
  {
    actionId: 'ux-zero-move', actorId: 'demo-player-melee', actionTemplateId: 'DEMO_MOVE', targetIds: [],
    targetCoords: { x: 4, y: 3, z: 0 }, arrivalTick: 6, phase: 'STARTUP', declaredTick: 0,
    effectiveTick: 0, priority: 1, paidResources: {}, decisionVersion: 1, controlEpoch: 0, causationId: 'ux-zero-move-cause',
  },
  {
    actionId: 'ux-recovery', actorId: 'demo-player-ranged', actionTemplateId: 'DEMO_MELEE_STRIKE', targetIds: ['demo-monster-bruiser'],
    relation: 'ATTACK', phase: 'RECOVERY', declaredTick: 0, effectiveTick: 2, priority: 2, paidResources: {}, decisionVersion: 1, controlEpoch: 0, causationId: 'ux-recovery-cause',
  },
  {
    actionId: 'ux-cancelled', actorId: 'demo-player-ranged', actionTemplateId: 'DEMO_MELEE_STRIKE', targetIds: ['demo-monster-bruiser'],
    relation: 'ATTACK', phase: 'CANCELLED', cancelled: true, declaredTick: 0, effectiveTick: 2, priority: 2, paidResources: {}, decisionVersion: 1, controlEpoch: 0, causationId: 'ux-cancelled-cause',
  },
  {
    actionId: 'ux-resolved', actorId: 'demo-player-ranged', actionTemplateId: 'DEMO_MELEE_STRIKE', targetIds: ['demo-monster-bruiser'],
    relation: 'ATTACK', phase: 'RESOLVED', declaredTick: 0, effectiveTick: 2, priority: 2, paidResources: {}, decisionVersion: 1, controlEpoch: 0, causationId: 'ux-resolved-cause',
  },
  {
    actionId: 'ux-no-relation', actorId: 'demo-player-ranged', actionTemplateId: 'DEMO_MELEE_STRIKE', targetIds: ['demo-monster-bruiser'],
    phase: 'STARTUP', declaredTick: 0, effectiveTick: 2, priority: 2, paidResources: {}, decisionVersion: 1, controlEpoch: 0, causationId: 'ux-no-relation-cause',
  },
]);
assert.equal((lifecycleMarkup.match(/demo-action-overlay-relation/g) ?? []).length, 2, 'only explicit active attack/heal relationships render arrows');
assert.equal((lifecycleMarkup.match(/demo-action-overlay-self/g) ?? []).length, 1, 'explicit self-heal remains visible');
assert.equal((lifecycleMarkup.match(/demo-action-overlay-move/g) ?? []).length, 2, 'movement arrows remain visible while awaiting settlement');
assert.match(lifecycleMarkup, /移动 · 到达待结算/, 'zero remaining ticks wait for authoritative position');
assert.doesNotMatch(lifecycleMarkup, /移动 · 已到达/, 'zero remaining ticks do not claim arrival before the entity moves');

// Optional visual fixture for browser screenshot review.  It renders the
// real Battlefield and ships the production demo stylesheet beside it; no
// production route or running encounter is touched.
const previewPath = process.env.DEMO_UX_PREVIEW_HTML;
if (previewPath) {
  const stylesheet = readFileSync(resolve(process.cwd(), 'packages/frontend/src/demo/styles.css'), 'utf8');
  const outputFile = resolve(previewPath);
  writeFileSync(outputFile, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${stylesheet}</style></head><body><main class="demo-app"><div class="demo-main-grid"><div class="demo-main-column">${previewMarkup}</div></div></main></body></html>`, 'utf8');
  console.log(`DEMO_UX_PREVIEW_HTML written: ${outputFile}`);
}
coordinator.close();
console.log('PASS: action-first availability, legacy fallback, target banner and separate GM selection.');
