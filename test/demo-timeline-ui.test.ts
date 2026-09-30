import assert from 'node:assert/strict';
import React, { createElement } from '../packages/frontend/node_modules/react/index.js';
import { renderToStaticMarkup } from '../packages/frontend/node_modules/react-dom/server.node.js';
import { TimelinePanel } from '../packages/frontend/src/demo/TimelinePanel.tsx';
import type { ActionTimeline, EncounterActionPlan, EncounterEntity, EncounterSnapshot } from '../packages/shared/src/index.ts';
import type { DemoCatalog } from '../packages/frontend/src/demo/types.ts';

Object.assign(globalThis, { React });

function entity(id: string, displayName: string, faction: EncounterEntity['faction'] = 'PLAYERS', hp = 100): EncounterEntity {
  return {
    id,
    templateId: `demo.${id}`,
    displayName,
    faction,
    type: 'ACTOR',
    transform: { coords: { x: 1, y: 1, z: 0 }, planeId: 'timeline-test', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: .4, mass: 60, movementModes: ['WALK'] },
    resources: { current: { hp }, max: { hp: 100 } },
    activeEffects: [],
  };
}

function timeline(): ActionTimeline {
  return {
    start: 4,
    startupEnd: 7,
    recoveryStart: 16,
    end: 19,
    phaseSegments: [
      { phase: 'STARTUP', start: 4, end: 7 },
      { phase: 'SMALL_STARTUP', start: 7, end: 8, strikeIndex: 0 },
      { phase: 'ACTIVE', start: 8, end: 10, strikeIndex: 0 },
      { phase: 'SMALL_STARTUP', start: 10, end: 11, strikeIndex: 1 },
      { phase: 'ACTIVE', start: 11, end: 13, strikeIndex: 1 },
      { phase: 'SMALL_STARTUP', start: 13, end: 14, strikeIndex: 2 },
      { phase: 'ACTIVE', start: 14, end: 16, strikeIndex: 2 },
      { phase: 'RECOVERY', start: 16, end: 19 },
    ],
  };
}

function action(actionId: string, actorId: string, overrides: Partial<EncounterActionPlan> = {}): EncounterActionPlan {
  return {
    actionId,
    actorId,
    actionTemplateId: 'DEMO_MELEE_STRIKE',
    targetIds: ['enemy'],
    phase: 'STARTUP',
    declaredTick: 4,
    effectiveTick: 8,
    priority: 2,
    paidResources: {},
    decisionVersion: 1,
    controlEpoch: 0,
    causationId: `${actionId}-cause`,
    relation: 'ATTACK',
    timeline: timeline(),
    ...overrides,
  };
}

const striker = entity('striker', '先锋');
const idle = entity('idle', '待机者');
const down = entity('down', '倒下者', 'PLAYERS', 0);
const enemy = entity('enemy', '哨兵', 'ENEMIES');
const first = action('strike-1', striker.id);
const duplicate = action('strike-1', striker.id, { phase: 'ACTIVE', priority: 3 });
const legacy = action('legacy-1', enemy.id, { timeline: undefined, causationId: 'legacy-cause' });
const snapshot: EncounterSnapshot = {
  encounterId: 'timeline-ui',
  revision: 7,
  tick: 12,
  status: 'PAUSED',
  paused: true,
  entities: [striker, idle, down, enemy],
  actions: [first, duplicate, legacy],
  plan: {
    windowTick: 12,
    slots: [
      { entityId: striker.id, faction: 'PLAYERS', connected: true, ready: true, waiting: false, controlEpoch: 0 },
      { entityId: idle.id, faction: 'PLAYERS', connected: true, ready: false, waiting: false, controlEpoch: 0 },
    ],
    committed: false,
    actions: [],
    barrierVersion: 1,
  },
  decisions: [],
  controls: [],
  logs: [
    { id: 'result-1', tick: 9, message: '先锋命中哨兵，造成 18 伤害', actionId: 'strike-1', causationId: 'strike-1-cause' },
    { id: 'result-2', tick: 11, message: '落空：目标已离开作用范围', actionId: 'removed-action', causationId: 'removed-cause' },
    { id: 'result-3', tick: 12, message: '打断了引导', actionId: 'legacy-1', causationId: 'legacy-cause' },
  ],
};
const catalog: DemoCatalog = {
  map: { id: 'timeline-map', name: '测试战场', width: 4, height: 4, tiles: [] },
  entries: [{ templateId: striker.templateId, label: '先锋', faction: 'PLAYERS', actions: [{ id: 'DEMO_MELEE_STRIKE', label: '三连突击', tags: ['ATTACK'], startupTicks: 2, recoveryTicks: 2, resourceCost: {} }] }],
  capabilities: { actionPreview: true },
};

const markup = renderToStaticMarkup(createElement(TimelinePanel, {
  snapshot,
  entities: snapshot.entities,
  catalog,
  focusedActionId: first.actionId,
  onFocusAction: () => {},
  onRequestEditAction: () => {},
  isGm: true,
}));

assert.match(markup, /demo-timeline-panel/, 'timeline renders as a dedicated panel');
const header = markup.match(/<header\b[^>]*class="demo-timeline-header"[\s\S]*?<\/header>/)?.[0];
assert.ok(header, 'the timeline keeps its own visible header when the page toolbar is removed');
assert.match(header, /战术时间轴/, 'the local header identifies the timeline');
assert.match(header, /当前 Tick[^>]*>[\s\S]*?12/, 'current Tick is visible without opening options');
assert.match(header, /已暂停/, 'authoritative encounter status stays in the visible header');
assert.ok(markup.indexOf(header) < markup.indexOf('class="demo-timeline-scroll"'), 'the header sits above the tracks');
assert.match(markup, /T4–T19/, 'timeline displays authoritative action boundaries');
assert.match(markup, /大前摇/, 'timeline renders the large startup phase');
assert.match(markup, /小前摇/, 'timeline renders per-strike small startups from phaseSegments');
assert.equal((markup.match(/class="timeline-segment active/g) ?? []).length, 3, 'three ACTIVE windows render as three segments');
assert.match(markup, /后摇/, 'timeline renders recovery as a proportional segment');
assert.match(markup, /待机 · 可提交行动/, 'idle entities keep a stable lane');
assert.match(markup, /已倒下/, 'downed entities stay visible with a blocked status');
assert.equal((markup.match(/strike-1/g) ?? []).length > 0, true, 'action instance is present');
assert.match(markup, /近 10 TICK/, 'recent result strip is visible');
assert.match(markup, /未关联当前动作/, 'unattached recent result is shown without inventing a relationship');
assert.match(markup, /查看因果链/, 'causation stays behind an on-demand disclosure');
assert.match(markup, /在 GM 裁决台编辑此动作/, 'paused GM can open the existing plan editor');
assert.match(markup, /阶段数据需更新服务/, 'legacy action explains why exact proportions are unavailable');
assert.equal((markup.match(/class="demo-timeline-action(?: is-focused)?"/g) ?? []).length, 1, 'duplicate actionId is rendered only once');

const blockedSnapshot: EncounterSnapshot = {
  ...snapshot,
  status: 'ACTIVE',
  paused: false,
  entities: snapshot.entities.map((candidate) => candidate.id === idle.id
    ? { ...candidate, currentActionContext: { type: 'CASTING' as const, actionId: 'recovery-action', phase: 'RECOVERY' as const, resolveTick: 20 } }
    : candidate),
  plan: {
    ...snapshot.plan,
    slots: snapshot.plan.slots.map((slot) => slot.entityId === idle.id ? { ...slot, blockedReason: '实体正在收招' } : slot),
  },
};
const blockedMarkup = renderToStaticMarkup(createElement(TimelinePanel, { snapshot: blockedSnapshot, entities: blockedSnapshot.entities, catalog }));
assert.doesNotMatch(blockedMarkup, /等待多人提交/, 'blocked recovery slots do not count as awaiting player submissions');
assert.match(blockedMarkup, /服务器按事件推进/, 'active timeline with no actionable unready slot shows normal event progression');
const pendingPlan = action('pending-plan', striker.id, { phase: 'DECLARED', timeline: undefined });
const pendingSnapshot: EncounterSnapshot = {
  ...blockedSnapshot,
  actions: [pendingPlan],
  plan: { ...blockedSnapshot.plan, actions: [pendingPlan] },
};
const pendingMarkup = renderToStaticMarkup(createElement(TimelinePanel, { snapshot: pendingSnapshot, entities: pendingSnapshot.entities, catalog }));
assert.match(pendingMarkup, /已就绪，等待统一提交 · 执行时间尚未确定/, 'uncommitted plans explain that execution time is not assigned yet');
assert.doesNotMatch(pendingMarkup, /部分动作来自旧服务/, 'uncommitted plans do not claim the server is outdated');
const terminalMarkup = renderToStaticMarkup(createElement(TimelinePanel, { snapshot: { ...snapshot, status: 'VICTORY' }, entities: snapshot.entities, catalog }));
assert.match(terminalMarkup, /遭遇已结束 · 结果已记录/, 'terminal encounter status is explicit in the timeline header');

console.log('demo-timeline-ui: authoritative phase lanes, idle/down states, focus details, recent results and GM edit entry passed');
