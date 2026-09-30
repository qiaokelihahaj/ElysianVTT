import assert from 'node:assert/strict';
import React, { createElement } from '../packages/frontend/node_modules/react/index.js';
import { renderToStaticMarkup } from '../packages/frontend/node_modules/react-dom/server.node.js';
import { hexOffsetToPixel } from '../packages/shared/src/index.ts';
import { Battlefield } from '../packages/frontend/src/demo/Battlefield.tsx';
import { BattlefieldOverlays } from '../packages/frontend/src/demo/BattlefieldOverlays.tsx';
import { DemoSocket } from '../packages/frontend/src/demo/socket.ts';
import { useDemoStore } from '../packages/frontend/src/demo/store.ts';
import type { EncounterActionPlan, EncounterEntity, EncounterSnapshot } from '../packages/shared/src/index.ts';
import type { DemoSessionInfo } from '../packages/frontend/src/demo/types.ts';

Object.assign(globalThis, { React });

function entity(id: string, x: number, y: number): EncounterEntity {
  return {
    id,
    templateId: `demo.${id}`,
    type: 'ACTOR',
    transform: { coords: { x, y, z: 0 }, planeId: 'elysian-demo', facing: 0 },
    physics: { scaleClass: 1, collisionRadius: .45, mass: 60, movementModes: ['WALK'] },
    resources: { current: { hp: 100 }, max: { hp: 100 } },
    activeEffects: [],
    faction: id === 'actor' ? 'PLAYERS' : 'ENEMIES',
    displayName: id,
  };
}

function action(partial: Partial<EncounterActionPlan> & Pick<EncounterActionPlan, 'actionId' | 'actorId' | 'actionTemplateId' | 'phase'>): EncounterActionPlan {
  return {
    targetIds: [],
    declaredTick: 0,
    priority: 1,
    paidResources: {},
    decisionVersion: 1,
    controlEpoch: 0,
    causationId: `${partial.actionId}-cause`,
    ...partial,
  };
}

function render(entities: EncounterEntity[], actions: EncounterActionPlan[], currentTick = 0, focusedActionId?: string): string {
  return renderToStaticMarkup(createElement(BattlefieldOverlays, {
    entities,
    actions,
    catalog: null,
    currentTick,
    focusedActionId,
  }));
}

function snapshot(revision: number, tick: number, entities: EncounterEntity[], actions: EncounterActionPlan[]): EncounterSnapshot {
  return {
    encounterId: 'arrow-sync',
    revision,
    tick,
    status: 'ACTIVE',
    paused: false,
    entities,
    actions,
    plan: { windowTick: tick, slots: [], committed: false, actions: [], barrierVersion: revision },
    decisions: [],
    controls: [],
    logs: [],
  };
}

function insetPoint(from: { x: number; y: number }, to: { x: number; y: number }, inset: number): { x: number; y: number } {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  return {
    x: from.x + ((to.x - from.x) / length) * inset,
    y: from.y + ((to.y - from.y) / length) * inset,
  };
}

const actor = entity('actor', 1, 1);
const target = entity('target', 4, 2);
const attack = action({
  actionId: 'attack-1',
  actorId: actor.id,
  actionTemplateId: 'DEMO_MELEE_STRIKE',
  targetIds: [target.id],
  relation: 'ATTACK',
  phase: 'STARTUP',
});

const firstMarkup = render([actor, target], [attack]);
const firstFrom = insetPoint(hexOffsetToPixel(1, 1), hexOffsetToPixel(4, 2), .34);
const firstTo = insetPoint(hexOffsetToPixel(4, 2), hexOffsetToPixel(1, 1), .42);
assert.ok(firstMarkup.includes(`M ${firstFrom.x} ${firstFrom.y} Q`), 'relationship arrow starts at the current actor position');
assert.ok(firstMarkup.includes(`${firstTo.x} ${firstTo.y}`), 'relationship arrow ends at the current target position');

const focusMarkup = render([actor, target], [attack], 0, attack.actionId);
assert.match(focusMarkup, /demo-action-overlay-relation is-timeline-focused/, 'timeline focus marks the selected relationship');
assert.match(focusMarkup, /stroke-width="\.13"/, 'timeline focus makes the selected relationship legible');

const moveForFocus = action({
  actionId: 'move-for-focus',
  actorId: actor.id,
  actionTemplateId: 'DEMO_MOVE',
  targetCoords: { x: 7, y: 3, z: 0 },
  phase: 'STARTUP',
});
const mixedFocusMarkup = render([actor, target], [attack, moveForFocus], 0, attack.actionId);
assert.match(mixedFocusMarkup, /demo-action-overlay-move is-timeline-unfocused/, 'non-focused relationships recede while inspecting one action');
assert.match(mixedFocusMarkup, /style="opacity:0\.22"/, 'unfocused relationships stay visible without covering the map');

const focusedMapMarkup = renderToStaticMarkup(createElement(Battlefield, {
  entities: [actor, target],
  actions: [attack],
  currentTick: 0,
  focusedActionId: attack.actionId,
  catalog: null,
  selectedEntityId: null,
  selectedTargetId: null,
  selectedCell: null,
  onSelectEntity: () => {},
  onSelectTarget: () => {},
  onSelectCell: () => {},
}));
assert.match(focusedMapMarkup, /demo-entity-token is-timeline-focus is-timeline-focus-actor/, 'timeline focus outlines the action actor');
assert.match(focusedMapMarkup, /demo-entity-token is-timeline-focus is-timeline-focus-target/, 'timeline focus outlines the action target');
assert.match(focusedMapMarkup, /demo-map-timeline-focus-ring-actor/, 'focused actor gets an explicit focus shape');
assert.match(focusedMapMarkup, /demo-map-timeline-focus-ring-target/, 'focused target gets a distinct focus shape');

const movedActor = entity('actor', 2, 1);
const movedTarget = entity('target', 5, 3);
const movedMarkup = render([movedActor, movedTarget], [attack]);
const movedFrom = insetPoint(hexOffsetToPixel(2, 1), hexOffsetToPixel(5, 3), .34);
const movedTo = insetPoint(hexOffsetToPixel(5, 3), hexOffsetToPixel(2, 1), .42);
assert.ok(movedMarkup.includes(`M ${movedFrom.x} ${movedFrom.y} Q`), 'relationship arrow follows a moved actor');
assert.ok(movedMarkup.includes(`${movedTo.x} ${movedTo.y}`), 'relationship arrow follows a moved target');
assert.equal(movedMarkup.includes(`M ${firstFrom.x} ${firstFrom.y} Q`), false, 'relationship arrow does not retain the prior actor endpoint');

const move = action({
  actionId: 'move-1',
  actorId: actor.id,
  actionTemplateId: 'DEMO_MOVE',
  targetCoords: { x: 7, y: 3, z: 0 },
  arrivalTick: 12,
  phase: 'STARTUP',
});
const moveMarkup = render([actor], [move], 4);
const moveStart = insetPoint(hexOffsetToPixel(1, 1), hexOffsetToPixel(7, 3), .34);
const moveEnd = insetPoint(hexOffsetToPixel(7, 3), hexOffsetToPixel(1, 1), .4);
assert.ok(moveMarkup.includes(`x1="${moveStart.x}" y1="${moveStart.y}" x2="${moveEnd.x}" y2="${moveEnd.y}"`), 'movement arrow points from the current position to the planned landing point');

assert.equal(render([target], [attack]).includes('demo-action-overlay-relation'), false, 'removing the actor removes its relationship arrow');
assert.equal(render([actor], [attack]).includes('demo-action-overlay-relation'), false, 'removing the target removes its relationship arrow');

// Exercise the same snapshot handoff used by the DemoSocket listeners.  A
// higher revision at the same Tick must replace both endpoints and a later GM
// edit must replace the movement destination without allowing an old snapshot
// to roll the map back.
const firstSnapshot = snapshot(10, 4, [actor, target], [attack]);
const editedMove = action({
  actionId: 'move-edit',
  actorId: actor.id,
  actionTemplateId: 'DEMO_MOVE',
  targetCoords: { x: 6, y: 2, z: 0 },
  arrivalTick: 12,
  phase: 'STARTUP',
});
const nextSnapshot = snapshot(11, 4, [movedActor, movedTarget], [editedMove]);
useDemoStore.getState().clear();
useDemoStore.getState().setSnapshot(firstSnapshot);
const socketSession: DemoSessionInfo = {
  accessToken: 'arrow-test-token',
  session: {
    sessionId: 'arrow-test-session', userId: 'arrow-test-user', role: 'GM', displayName: 'GM',
    expiresAt: 1, reconnectUntil: 1, connectedSocketCount: 1, controlledEntityIds: [],
  },
  snapshot: firstSnapshot,
  joinCode: undefined,
};
const transport = new DemoSocket(socketSession);
const unsubscribe = transport.on('snapshot', (next) => useDemoStore.getState().setSnapshot(next));
(transport as unknown as { emitSnapshot(value: unknown): void }).emitSnapshot({ snapshot: nextSnapshot });
unsubscribe();
const liveSnapshot = useDemoStore.getState().snapshot;
assert.equal(liveSnapshot?.revision, 11, 'socket snapshot handoff accepts the newer same-Tick revision');
assert.ok(liveSnapshot, 'newer socket snapshot remains available to the renderer');
const liveMarkup = render(liveSnapshot.entities, liveSnapshot.actions, liveSnapshot.tick);
const liveMoveStart = insetPoint(hexOffsetToPixel(2, 1), hexOffsetToPixel(6, 2), .34);
const liveMoveEnd = insetPoint(hexOffsetToPixel(6, 2), hexOffsetToPixel(2, 1), .4);
assert.ok(liveMarkup.includes(`x1="${liveMoveStart.x}" y1="${liveMoveStart.y}" x2="${liveMoveEnd.x}" y2="${liveMoveEnd.y}"`), 'renderer consumes the edited movement endpoint from the live snapshot');
const staleSnapshot = snapshot(10, 4, [actor, target], [attack]);
useDemoStore.getState().setSnapshot(staleSnapshot);
assert.equal(useDemoStore.getState().snapshot?.revision, 11, 'a delayed socket snapshot cannot restore stale arrow coordinates');
useDemoStore.getState().clear();

console.log('demo-arrow-sync: live actor/target endpoints, movement destination, and removed-entity cleanup passed');
