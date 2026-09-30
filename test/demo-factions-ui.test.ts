import assert from 'node:assert/strict';
import React, { createElement } from '../packages/frontend/node_modules/react/index.js';
import { renderToStaticMarkup } from '../packages/frontend/node_modules/react-dom/server.node.js';
import type { EncounterEntity, EncounterResult, EncounterSnapshot } from '../packages/shared/src/index.ts';
import type { DemoCatalog, DemoRoomInfo, DemoSessionInfo } from '../packages/frontend/src/demo/types.ts';
import { FactionControls } from '../packages/frontend/src/demo/FactionControls.tsx';
import { GmPanel, LobbyPanel } from '../packages/frontend/src/demo/Panels.tsx';

Object.assign(globalThis, { React });

function actor(id: string, displayName: string, faction: string | null): EncounterEntity {
  return {
    id, displayName, faction, templateId: 'test.actor', type: 'ACTOR', tags: ['PLAYER'],
    transform: { coords: { x: 1, y: 2, z: 0 }, planeId: 'test', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: .4, mass: 60, movementModes: ['WALK'] },
    resources: { current: { hp: 100, poise: 20, focus: 8 }, max: { hp: 100, poise: 20, focus: 8 } }, activeEffects: [],
  };
}

function fixture(): EncounterSnapshot {
  return {
    encounterId: 'factions-ui', revision: 1, tick: 0, status: 'ACTIVE', paused: false,
    victoryCondition: 'MANUAL', relations: [],
    entities: [
      actor('red', '红方斥候', '赤铜公会'), actor('red-ally', '红方守卫', '赤铜公会'),
      actor('blue', '蓝方术士', 'ENEMIES'), actor('wanderer', '无名旅者', null), actor('mercenary', '独行佣兵', null),
      { ...actor('prop', '石柱', '环境'), type: 'PROP' },
    ],
    actions: [], controls: [], decisions: [], logs: [],
    plan: { windowTick: 0, committed: false, actions: [], barrierVersion: 0, slots: [] },
  };
}

function session(snapshot: EncounterSnapshot, role: 'GM' | 'PL' = 'GM'): DemoSessionInfo {
  return {
    accessToken: 'test-only', snapshot, joinCode: role === 'GM' ? 'TEST' : undefined,
    session: { sessionId: 'ui-session', userId: 'viewer', role, displayName: '测试玩家',
      expiresAt: 20_000, reconnectUntil: 20_000, connectedSocketCount: 1, controlledEntityIds: ['wanderer'] },
  };
}

const catalog: DemoCatalog = {
  map: { id: 'ui-map', name: '测试战场', width: 4, height: 4, tiles: [], spawnPoints: {} },
  entries: [{ templateId: 'test.actor', label: '测试角色模板', faction: null, actions: [] }],
};

function control(markup: string, tag: 'input' | 'select' | 'button', label: string): string {
  const closing = tag === 'input' ? '' : `[\\s\\S]*?<\\/${tag}>`;
  const matched = markup.match(new RegExp(`<${tag}\\b[^>]*aria-label="${label}"[^>]*>${closing}`));
  assert.ok(matched, `${label} exposes an accessible ${tag}`);
  return matched[0];
}

function options(markup: string): { value: string; text: string; selected: boolean }[] {
  return [...markup.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(match => ({
    value: match[1].match(/\bvalue="([^"]*)"/)?.[1] ?? '',
    text: match[2], selected: /\bselected=/.test(match[1]),
  }));
}

function gmPanel(snapshot: EncounterSnapshot, role: 'GM' | 'PL' = 'GM'): string {
  return renderToStaticMarkup(createElement(GmPanel, {
    session: session(snapshot, role), snapshot, catalog, selectedEntityId: 'red', selectedTargetId: null,
    selectedCell: null, onCommand: () => {}, onRestart: () => {}, settlement: { status: 'saved', retryable: false },
  }));
}

const state = fixture();
const controls = renderToStaticMarkup(createElement(FactionControls, {
  snapshot: state, catalog, selectedEntityId: 'red', onCommand: () => {},
}));
assert.match(control(controls, 'input', '阵营名称'), /value="赤铜公会"/, 'custom allegiance populates the editable name');
assert.doesNotMatch(control(controls, 'button', '应用阵营'), /\bdisabled=/, 'an arbitrary valid faction can be applied');
assert.doesNotMatch(control(controls, 'button', '设为独立'), /\bdisabled=/, 'selected actors can leave a faction');
assert.ok(options(control(controls, 'select', '选择已有阵营')).some(option => option.value === '赤铜公会'));
assert.ok(options(control(controls, 'select', '刷出阵营')).some(option => option.value === '' && option.text === '独立'));
assert.ok(options(control(controls, 'select', '刷出阵营')).some(option => option.value === '赤铜公会'));
assert.match(control(controls, 'input', '刷出阵营名称'), /placeholder="或输入新阵营"/);
assert.deepEqual(options(control(controls, 'select', '胜负条件')).map(option => [option.value, option.selected]), [
  ['LAST_SIDE', false], ['MANUAL', true],
], 'the authoritative victory policy initializes the control');
assert.deepEqual(options(control(controls, 'select', '双方关系')).map(option => option.value), ['', 'ALLY', 'NEUTRAL', 'HOSTILE']);

const independentControls = renderToStaticMarkup(createElement(FactionControls, {
  snapshot: state, catalog, selectedEntityId: 'wanderer', onCommand: () => {},
}));
assert.match(control(independentControls, 'input', '阵营名称'), /value=""/, 'explicit null does not inherit the old PLAYER tag');
assert.match(control(independentControls, 'button', '应用阵营'), /\bdisabled=/, 'an empty name is not submitted as a faction');
const unselectedControls = renderToStaticMarkup(createElement(FactionControls, {
  snapshot: state, catalog, selectedEntityId: null, onCommand: () => {},
}));
assert.match(control(unselectedControls, 'button', '设为独立'), /\bdisabled=/, 'entity mutations require a selection');

const room: DemoRoomInfo = {
  encounterId: state.encounterId, snapshot: state,
  entries: [{ userId: 'player-one', displayName: '甲玩家', role: 'PL', connected: true, connectedSocketCount: 1, controlledEntityIds: [] }],
};
const lobby = (role: 'GM' | 'PL'): string => renderToStaticMarkup(createElement(LobbyPanel, {
  session: session(state, role), room, snapshot: state, onAssign: () => {}, onStart: () => {}, onRefresh: () => {},
}));
assert.deepEqual(options(control(lobby('GM'), 'select', '甲玩家 的角色')).map(option => option.value), [
  '', 'red', 'red-ally', 'blue', 'wanderer', 'mercenary',
], 'assignment candidates include every ACTOR regardless of allegiance, while excluding props');
assert.doesNotMatch(lobby('PL'), /aria-label="甲玩家 的角色"/, 'players never receive GM assignment controls');

const winnerOptions = options(control(gmPanel(state), 'select', '手动胜方'));
assert.deepEqual(winnerOptions.map(option => option.text), ['不指定胜方', '赤铜公会', '队伍 B', '无名旅者（独立）', '独行佣兵（独立）'],
  'manual winners deduplicate a shared faction but keep independent actors separate');
assert.equal(gmPanel(state, 'PL'), '', 'the entire GM panel, including faction and victory controls, is absent for PL');

function resultMarkup(winningSides: EncounterResult['winningSides']): string {
  const ended = fixture();
  ended.status = 'ENDED';
  ended.result = { status: 'ENDED', endedBy: 'GM', resolvedTick: 8, survivors: ['red', 'wanderer'], casualties: [], winningSides };
  return gmPanel(ended);
}
const multipleWinners = resultMarkup([{ kind: 'FACTION', id: '赤铜公会' }, { kind: 'ENTITY', id: 'wanderer' }]);
assert.match(multipleWinners, /<h3>赤铜公会、无名旅者获胜<\/h3>/, 'multi-side outcomes use the actual winning names');
assert.match(control(multipleWinners, 'select', '手动胜方'), /\bdisabled=/, 'a settled winner is no longer editable');
assert.match(resultMarkup([{ kind: 'ENTITY', id: 'mercenary' }]), /<h3>独行佣兵获胜<\/h3>/, 'an independent winner is identified individually');
assert.match(resultMarkup(undefined), /<h3>遭遇已结束<\/h3>/, 'manual ending without a winner does not invent victory or defeat');

console.log('demo-factions-ui: arbitrary allegiance controls, independent actors, actor assignment, GM ownership and multi-side outcome labels passed');
