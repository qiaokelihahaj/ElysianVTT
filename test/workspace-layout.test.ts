import assert from 'node:assert/strict';
import { defaultWorkspaceLayout, fitDockedPanel, fitPanel, layoutDockTabs, nearestDockEdge, PANEL_IDS, readWorkspaceLayout } from '../packages/frontend/src/demo/workspaceLayout.ts';

const defaults = defaultWorkspaceLayout();
assert.deepEqual(readWorkspaceLayout('bad JSON'), defaults);
assert.deepEqual(readWorkspaceLayout('{"version":1,"panels":{}}'), defaults);
assert.deepEqual(readWorkspaceLayout(null), defaults);
assert.ok(defaults.timeline.x + defaults.timeline.width < defaults.entities.x, 'default timeline leaves a separate roster column');
assert.equal(defaults.timeline.y, 80, 'timeline leaves only a margin below optional room information');
for (const panel of Object.values(defaults)) {
  assert.equal(panel.pinned, false, 'new windows start in auto-hide mode');
  assert.equal(panel.collapsed, false, 'automatic retraction does not set manual minimization');
}
assert.deepEqual(PANEL_IDS.map((id) => defaults[id].dockEdge), ['bottom', 'right', 'top', 'left', 'left']);
const restored = readWorkspaceLayout(JSON.stringify({ version: 2, panels: {
  logs: { floating: true, collapsed: false, hidden: true, x: 20000, y: -500, width: 'wrong', height: 500 },
  actions: null, gm: { hidden: 'yes' }, unexpected: { floating: true },
} }));
assert.equal(restored.logs.collapsed, false);
assert.equal(restored.logs.hidden, true);
assert.equal(restored.logs.x, 4000);
assert.equal(restored.logs.y, 0);
assert.equal(restored.logs.width, defaults.logs.width);
assert.deepEqual(restored.actions, defaults.actions);
assert.deepEqual(restored.entities, defaults.entities, 'old v2 layouts gain the entity window without resetting saved panels');
assert.equal(restored.gm.hidden, false);
const migrated = readWorkspaceLayout(JSON.stringify({ version: 2, panels: {
  logs: { collapsed: true, hidden: true, x: 700, y: 400, width: 300, height: 350 },
} }), { width: 1280, height: 800, headerHeight: 0 });
assert.equal(migrated.logs.pinned, false, 'v2 windows migrate to automatic retraction');
assert.equal(migrated.logs.collapsed, false, 'v2 title-only windows become hoverable edge labels');
assert.equal(migrated.logs.hidden, true, 'migration preserves explicitly hidden windows');
assert.deepEqual([migrated.logs.x, migrated.logs.y, migrated.logs.width, migrated.logs.height], [700, 400, 300, 350]);
assert.equal(migrated.logs.dockEdge, 'bottom', 'migration chooses the closest edge from expanded bounds');
const saved = { ...defaults, actions: { ...defaults.actions, pinned: true, collapsed: true, dockEdge: 'left' as const } };
assert.deepEqual(readWorkspaceLayout(JSON.stringify({ version: 3, panels: saved })), saved, 'v3 persists pin, manual minimization and dock edge');
const invalid = readWorkspaceLayout(JSON.stringify({ version: 3, panels: {
  actions: { pinned: 'yes', collapsed: 1, dockEdge: 'diagonal', width: null, height: -5 },
} }));
assert.equal(invalid.actions.pinned, false);
assert.equal(invalid.actions.collapsed, false);
assert.equal(invalid.actions.dockEdge, 'bottom');
assert.equal(invalid.actions.width, defaults.actions.width);
assert.equal(invalid.actions.height, 0, 'invalid negative geometry is clamped before viewport fitting');
const moved = fitPanel({ ...defaults.logs, collapsed: false, x: 10000, y: 10000, width: 2000, height: 2000 }, { width: 1280, height: 800 });
assert.ok(moved.x >= 0 && moved.x + moved.width <= 1280);
assert.ok(moved.y >= 80 && moved.y + moved.height <= 800);
const resized = fitPanel({ ...moved, width: 1, height: 1 }, { width: 1280, height: 800 });
assert.equal(resized.width, 300);
assert.equal(resized.height, 180);
const collapsed = fitPanel({ ...defaults.logs, collapsed: true, y: 10000 }, { width: 1280, height: 800 });
assert.ok(collapsed.y + 42 <= 800, 'collapsed header remains reachable');
assert.equal(defaultWorkspaceLayout().logs.hidden, false, 'fresh defaults are not shared mutable state');
const headerlessViewport = { width: 1280, height: 800, headerHeight: 0 };
const headerless = fitPanel({ ...defaults.timeline, y: 0 }, headerlessViewport);
assert.equal(headerless.y, 12, 'no toolbar reserves a vertical band');
assert.equal(defaultWorkspaceLayout(headerlessViewport).timeline.y, 12, 'reset respects hidden header');
assert.equal(fitPanel(headerless, { ...headerlessViewport, headerHeight: 68 }).y, 80, 'expanded room information keeps window controls reachable');

for (const viewport of [
  { width: 1280, height: 720, headerHeight: 0 },
  { width: 1366, height: 768, headerHeight: 0 },
  { width: 1366, height: 768, headerHeight: 68 },
]) {
  const layout = defaultWorkspaceLayout(viewport);
  const timeline = fitPanel(layout.timeline, viewport);
  const actions = fitPanel(layout.actions, viewport);
  assert.ok(timeline.y + timeline.height <= actions.y,
    `${viewport.width}×${viewport.height}: default timeline and actions must not overlap`);
  if (!viewport.headerHeight) {
    const entities = fitPanel(layout.entities, viewport);
    assert.ok(entities.x >= timeline.x + timeline.width && entities.x >= actions.x + actions.width,
      'default entity roster does not cover timeline or common actions on laptop viewports');
    assert.equal(entities.height, 420, 'roster reserves vertical space for ten compact rows');
    const dockedEntities = fitDockedPanel(layout.entities, viewport);
    for (const id of ['timeline', 'actions'] as const) {
      const docked = fitDockedPanel(layout[id], viewport);
      assert.ok(docked.x + docked.width < dockedEntities.x,
        'default docked windows reserve the edge tracks without covering roster names');
    }
  }
}
for (const viewport of [{ width: 820, height: 900 }, { width: 320, height: 480 }, { width: 280, height: 220 }]) {
  for (const panel of Object.values(defaultWorkspaceLayout(viewport))) {
    const fitted = fitPanel(panel, viewport);
    assert.ok(fitted.x + fitted.width <= viewport.width);
    assert.ok(fitted.y + (fitted.collapsed ? 42 : fitted.height) <= viewport.height);
  }
}

const edgeViewport = { width: 1000, height: 800, headerHeight: 0 };
const centered = { ...defaults.logs, x: 100, y: 100, width: 800, height: 600 };
assert.equal(nearestDockEdge(centered, edgeViewport, 'right'), 'right', 'equidistant edges preserve the existing direction');
assert.equal(nearestDockEdge({ ...centered, x: 10, width: 300 }, edgeViewport), 'left');
assert.equal(nearestDockEdge({ ...centered, x: 690, width: 300 }, edgeViewport), 'right');
assert.equal(nearestDockEdge({ ...centered, y: 10, height: 200 }, edgeViewport), 'top');
assert.equal(nearestDockEdge({ ...centered, y: 590, height: 200 }, edgeViewport), 'bottom');
assert.equal(nearestDockEdge({ ...centered, collapsed: true, x: 300, y: 200, width: 300, height: 590 }, edgeViewport), 'bottom', 'edge selection uses expanded height even after manual minimization');
assert.equal(nearestDockEdge({ ...centered, x: 150, y: 100, width: 500, height: 400 }, { ...edgeViewport, headerHeight: 80 }), 'top', 'distance starts below optional room information');

const bottomLeft = { ...defaults.logs, x: 12, y: 568, width: 300, height: 220 };
for (const preferred of ['top', 'right'] as const) {
  assert.equal(nearestDockEdge(bottomLeft, edgeViewport, preferred, { x: -8, y: 0 }), 'left', 'last leftward movement breaks a bottom-left tie when the old edge is not tied');
  assert.equal(nearestDockEdge(bottomLeft, edgeViewport, preferred, { x: 0, y: 8 }), 'bottom', 'last downward movement breaks a bottom-left tie when the old edge is not tied');
  assert.equal(nearestDockEdge(bottomLeft, edgeViewport, preferred), 'bottom', 'absent movement preserves the previous deterministic fallback');
  assert.equal(nearestDockEdge(bottomLeft, edgeViewport, preferred, { x: 0, y: 0 }), 'bottom', 'zero movement preserves the previous deterministic fallback');
}
assert.equal(nearestDockEdge(bottomLeft, edgeViewport, 'left', { x: 0, y: 8 }), 'left', 'a tied old left edge wins over downward movement');
assert.equal(nearestDockEdge(bottomLeft, edgeViewport, 'bottom', { x: -8, y: 0 }), 'bottom', 'a tied old bottom edge wins over leftward movement');
assert.equal(nearestDockEdge({ ...bottomLeft, x: 8 }, edgeViewport, 'bottom', { x: 0, y: 100 }), 'left', 'a unique nearest edge overrides movement toward another edge');
const topRight = { ...bottomLeft, x: 688, y: 12 };
assert.equal(nearestDockEdge(topRight, edgeViewport, 'bottom', { x: 8, y: 0 }), 'right', 'rightward movement breaks a top-right tie');
assert.equal(nearestDockEdge(topRight, edgeViewport, 'left', { x: 0, y: -8 }), 'top', 'upward movement breaks a top-right tie');

for (const dockEdge of ['left', 'right', 'top', 'bottom'] as const) {
  const original = { ...defaults.logs, dockEdge, x: 400, y: 300, width: 320, height: 240 };
  const docked = fitDockedPanel(original, edgeViewport);
  assert.equal(docked.width, original.width, `${dockEdge}: docking retains expanded width`);
  assert.equal(docked.height, original.height, `${dockEdge}: docking retains expanded height`);
  assert.equal(docked.dockEdge, dockEdge);
  if (dockEdge === 'left') assert.equal(docked.x, 28);
  if (dockEdge === 'right') assert.equal(docked.x + docked.width, edgeViewport.width - 28);
  if (dockEdge === 'top') assert.equal(docked.y, 28);
  if (dockEdge === 'bottom') assert.equal(docked.y + docked.height, edgeViewport.height - 28);
  const belowHeader = fitDockedPanel({ ...original, y: 0 }, { ...edgeViewport, headerHeight: 68 });
  assert.ok(belowHeader.y >= 96, 'docked windows remain below room information and its label track');
  for (const viewport of [
    { width: 1280, height: 720, headerHeight: 0 },
    { width: 320, height: 480, headerHeight: 68 },
    { width: 40, height: 40, headerHeight: 68 },
    { width: 1, height: 1, headerHeight: 0 },
  ]) {
    const fitted = fitDockedPanel({ ...original, x: 10000, y: 10000, width: 2000, height: 2000 }, viewport);
    assert.ok(fitted.width > 0 && fitted.height > 0);
    assert.ok(fitted.x >= 0 && fitted.x + fitted.width <= viewport.width, `${dockEdge}: docked window fits viewport width`);
    assert.ok(fitted.y >= 0 && fitted.y + fitted.height <= viewport.height, `${dockEdge}: docked window fits viewport height`);
  }
}
assert.equal(fitDockedPanel({ ...defaults.logs, collapsed: true, y: 10000 }, edgeViewport).height, defaults.logs.height, 'manual minimization never replaces remembered expanded size');

function assertTabsFit(rail: ReturnType<typeof layoutDockTabs>) {
  assert.ok(rail.tabs.every(tab => tab.offset >= 0 && tab.offset + tab.length <= rail.extent), 'all tabs fit the scrollable rail extent');
  for (let index = 1; index < rail.tabs.length; index++) {
    assert.ok(rail.tabs[index].offset >= rail.tabs[index - 1].offset + rail.tabs[index - 1].length + 4, 'adjacent tabs retain their gap without overlapping');
  }
}
const tabViewport = { width: 1600, height: 1200, headerHeight: 68 };
for (const edge of ['top', 'bottom'] as const) {
  const panels = [
    { id: 'actions' as const, panel: { ...defaults.actions, dockEdge: edge, x: 650, width: 300 } },
    { id: 'logs' as const, panel: { ...defaults.logs, dockEdge: edge, x: 1160, width: 300 } },
    { id: 'gm' as const, panel: { ...defaults.gm, dockEdge: edge, x: 112, width: 300 } },
  ];
  const rail = layoutDockTabs(panels, edge, tabViewport);
  assert.deepEqual(rail.tabs.map(tab => tab.id), ['gm', 'actions', 'logs'], `${edge}: spatial order takes precedence over module order`);
  assert.deepEqual(rail.tabs.map(tab => rail.start + tab.offset + tab.length / 2), [262, 800, 1310], `${edge}: left, center and right windows retain distinct aligned labels`);
  assert.ok(rail.tabs.every(tab => tab.length === 96));
  assert.equal(rail.start, 36);
  assert.equal(rail.end, tabViewport.width - 58, 'horizontal labels reserve the right corner for the workspace menu');
  assert.equal(rail.extent, rail.end - rail.start);
  assertTabsFit(rail);
}
for (const edge of ['left', 'right'] as const) {
  const panels = [140, 500, 850].map((y, index) => ({ id: PANEL_IDS[index], panel: { ...defaults[PANEL_IDS[index]], dockEdge: edge, y, height: 180 } }));
  const rail = layoutDockTabs(panels, edge, tabViewport);
  assert.deepEqual(rail.tabs.map(tab => rail.start + tab.offset + tab.length / 2), [230, 590, 940], `${edge}: vertical labels preserve expanded window y positions`);
  assert.ok(rail.tabs.every(tab => tab.length === 90));
  assert.equal(rail.start, tabViewport.headerHeight + (edge === 'left' ? 36 : 58));
  assert.equal(rail.end, tabViewport.height - 36);
  assertTabsFit(rail);
}
const crowded = layoutDockTabs([
  { id: 'logs', panel: { ...defaults.logs, dockEdge: 'bottom', x: 660, width: 300 } },
  { id: 'gm', panel: { ...defaults.gm, dockEdge: 'bottom', x: 664, width: 300 } },
  { id: 'actions', panel: { ...defaults.actions, dockEdge: 'bottom', x: 660, width: 300 } },
], 'bottom', edgeViewport);
assert.deepEqual(crowded.tabs.map(tab => tab.id), ['actions', 'logs', 'gm'], 'equal anchors use module order, while nearby distinct anchors keep spatial order');
assertTabsFit(crowded);
assert.equal(crowded.extent, crowded.end - crowded.start, 'backward correction fits crowded labels into an available full-size rail');
for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
  const panels = [{ id: 'logs' as const, panel: { ...defaults.logs, dockEdge: edge, x: 10000, y: 10000, width: 300, height: 180 } }];
  const rail = layoutDockTabs(panels, edge, edgeViewport);
  const fitted = fitDockedPanel(panels[0].panel, edgeViewport);
  const center = edge === 'top' || edge === 'bottom' ? fitted.x + fitted.width / 2 : fitted.y + fitted.height / 2;
  assert.equal(rail.start + rail.tabs[0].offset + rail.tabs[0].length / 2, center, `${edge}: offscreen saved positions anchor to the fitted expanded window`);
  assertTabsFit(rail);
}
const shortRail = layoutDockTabs([...PANEL_IDS].reverse().map(id => ({ id, panel: { ...defaults[id], dockEdge: 'bottom' as const, x: 50, width: 300 } })), 'bottom', { width: 200, height: 400, headerHeight: 0 });
assert.deepEqual(shortRail.tabs.map(tab => tab.id), [...PANEL_IDS], 'coincident labels retain module order regardless of input order');
assert.equal(shortRail.extent, PANEL_IDS.length * 96 + (PANEL_IDS.length - 1) * 4, 'a short rail grows to the packed label length for scrolling');
assert.ok(shortRail.extent > shortRail.end - shortRail.start);
assertTabsFit(shortRail);
console.log('workspace-layout: migration, persistence, docking, malformed storage, viewport bounds and resize limits passed');
