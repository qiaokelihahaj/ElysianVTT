import assert from 'node:assert/strict';
import React, { createElement } from '../packages/frontend/node_modules/react/index.js';
import { renderToStaticMarkup } from '../packages/frontend/node_modules/react-dom/server.node.js';
import type { EncounterDecisionWindow, EncounterEntity, EncounterSnapshot } from '../packages/shared/src/index.ts';
import { ActionPanel } from '../packages/frontend/src/demo/Panels.tsx';
import type { DemoSessionInfo } from '../packages/frontend/src/demo/types.ts';

Object.assign(globalThis, { React });

function snapshot(): EncounterSnapshot {
  const hero: EncounterEntity = {
    id: 'hero', templateId: 'demo.player.melee', displayName: '先锋', faction: 'PLAYERS', type: 'ACTOR',
    transform: { coords: { x: 1, y: 2, z: 0 }, planeId: 'test', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: .4, mass: 60, movementModes: ['WALK'] },
    resources: { current: { hp: 100 }, max: { hp: 100 } }, activeEffects: [],
  };
  return {
    encounterId: 'status-ui', revision: 1, tick: 5, status: 'ACTIVE', paused: false,
    entities: [hero, { ...structuredClone(hero), id: 'ally', displayName: '游侠' }],
    actions: [], controls: [], decisions: [], logs: [],
    plan: { windowTick: 5, committed: false, actions: [], barrierVersion: 1,
      slots: ['hero', 'ally'].map(entityId => ({ entityId, connected: true, ready: false, waiting: false, controlEpoch: 0 })) },
  };
}

function decision(reactorEntityId: string): EncounterDecisionWindow {
  return {
    windowId: `reaction-${reactorEntityId}`, reactorEntityId, sourceEntityId: 'enemy', sourceActionId: 'attack',
    stage: 'REACTION_JOIN', causationId: 'cause', openedTick: 5, joinDeadlineAt: 10_000,
    joinRemainingMs: 5000, version: 1, controlEpoch: 0, availableOptions: [], respondedSocketIds: [], resolved: false,
  };
}

function status(state: EncounterSnapshot, controlledEntityIds = ['hero'], selectedEntityId: string | null = 'hero'): string {
  const session: DemoSessionInfo = {
    accessToken: 'test-only', snapshot: state,
    session: { sessionId: 'test', userId: 'player', role: 'PL', displayName: '玩家',
      expiresAt: 20_000, reconnectUntil: 20_000, connectedSocketCount: 1, controlledEntityIds },
  };
  const markup = renderToStaticMarkup(createElement(ActionPanel, {
    session, snapshot: state, catalog: null, selectedEntityId, selectedTargetId: null, selectedCell: null,
    onCommand: () => {}, onChooseAction: () => {}, now: 5000,
  }));
  const primary = markup.match(/class="action-status-primary"[^>]*>[\s\S]*?<strong>(.*?)<\/strong>/);
  assert.ok(primary, 'action bar exposes one primary status');
  return primary[1];
}

assert.match(status(snapshot()), /选择行动/, 'idle controlled actor is prompted to act');

const otherReaction = snapshot();
otherReaction.decisions = [decision('ally')];
assert.match(status(otherReaction), /等待.*反应/, 'another actor reaction blocks main actions and must not prompt the player to act');
assert.match(status(otherReaction, ['hero', 'ally']), /待反应|需要.*反应/, 'a reaction on another controlled actor still belongs to this player');

const down = snapshot();
down.entities[0].resources.current.hp = 0;
assert.match(status(down), /倒下/, 'downed actors cannot be prompted to choose an action');

const ownReaction = snapshot();
ownReaction.decisions = [decision('hero')];
assert.match(status(ownReaction), /待反应|需要.*反应/, 'own pending reaction takes priority over choosing a main action');
assert.doesNotMatch(status(ownReaction, []), /本人待反应|你.*反应/, 'a character outside current control is not described as the player reaction');

const paused = snapshot();
paused.paused = true;
paused.decisions = [decision('hero')];
assert.match(status(paused), /暂停/, 'paused deadlines are not presented as an active decision');

const recovery = snapshot();
recovery.entities[0].currentActionContext = { type: 'CASTING', actionId: 'previous', phase: 'RECOVERY', resolveTick: 9 };
assert.match(status(recovery), /收招/, 'recovery is distinguished from waiting for player input');

const ready = snapshot();
ready.plan.slots[0].ready = true;
assert.match(status(ready), /已提交/, 'a committed player is not prompted to submit again');
assert.match(status(snapshot(), [], 'hero'), /可控|控制权/, 'unowned characters do not present an actionable prompt');
assert.match(status(snapshot(), ['hero'], null), /选择.*角色|选择.*实体/, 'no selection asks for a character before an action');

console.log('demo-action-status-ui: actionable, blocked, reaction ownership, pause, recovery and ready states passed');
