import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionTemplate, DemoActionPreviewResponse, DemoSessionResponse, EncounterRulePack } from '../packages/shared/src/index.js';
import { createDemoServer, type DemoServerHandle } from '../packages/backend/src/demo/DemoServer.js';
import { DEMO_ACTION_IDS, createDemoEntity, installDemoContent } from '../packages/backend/src/demo/DemoContent.js';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';

const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'elysian-demo-action-preview-')));
let server: DemoServerHandle | undefined;

async function main(): Promise<void> {
  server = await createDemoServer({
    dataDirectory: temporaryRoot,
    hostCredential: 'preview-test-host-credential',
    joinCode: 'PREVIEW',
    host: '127.0.0.1',
    port: 0,
  });
  try {
    const { url } = await server.listen();
    async function http(path: string, body?: unknown, token?: string): Promise<Response> {
      return fetch(`${url}/api/demo/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    async function login(path: 'host' | 'join', body: unknown): Promise<DemoSessionResponse['data']> {
      const response = await http(path, body);
      assert.equal(response.status, 200);
      return (await response.json() as DemoSessionResponse).data;
    }
    async function preview(token: string, body: unknown): Promise<DemoActionPreviewResponse> {
      const response = await http('action-preview', body, token);
      assert.equal(response.status, 200);
      return await response.json() as DemoActionPreviewResponse;
    }

    assert.equal((await http('action-preview', {
      entityId: 'demo-player-melee',
      actionTemplateId: DEMO_ACTION_IDS.MELEE,
    })).status, 401, 'preview requires a bearer session');

    const gm = await login('host', { credential: 'preview-test-host-credential', displayName: 'Preview GM' });
    const player = await login('join', { joinCode: 'PREVIEW', displayName: 'Preview Player' });
    const catalog = await (await http('catalog', undefined, gm.accessToken)).json() as {
      data: { capabilities?: { actionPreview?: boolean } };
    };
    assert.equal(catalog.data.capabilities?.actionPreview, true, 'catalog advertises the preview capability');

    const actorId = 'demo-player-melee';
    const enemyId = 'demo-monster-bruiser';
    const lobbyPreview = await preview(gm.accessToken, {
      entityId: actorId,
      actionTemplateId: DEMO_ACTION_IDS.MELEE,
    });
    assert.equal(lobbyPreview.data.targetKind, 'entity');
    assert.equal(lobbyPreview.data.available, false);
    assert.equal(lobbyPreview.data.reason, '当前没有可提交的行动窗口');
    assert.equal(lobbyPreview.data.revision, server.coordinator.getSnapshot().revision);

    const assigned = await http('assign', {
      userId: player.session.userId,
      entityId: actorId,
    }, gm.accessToken);
    assert.equal(assigned.status, 200, 'GM assignment remains available before START');

    const start = server.coordinator.handleCommand(
      { userId: 'preview-gm', role: 'GM', socketId: 'preview-gm' },
      { requestId: 'preview-start', type: 'START', payload: {} },
    );
    assert.equal(start.ok, true);

    const gmMelee = await preview(gm.accessToken, { entityId: actorId, actionTemplateId: DEMO_ACTION_IDS.MELEE });
    assert.equal(gmMelee.data.targetKind, 'entity');
    assert.equal(gmMelee.data.available, true, 'a nearby public entity is a valid melee target');
    assert.equal(gmMelee.data.cells.length, 60, 'entity preview covers the complete 10 by 6 offset map');
    assert.ok(gmMelee.data.cells.some(cell => cell.x === 1 && cell.y === 2 && cell.allowed));
    assert.ok(gmMelee.data.cells.some(cell => cell.x === 9 && cell.y === 5 && !cell.allowed));
    const farMeleeTarget = gmMelee.data.entities.find(candidate => candidate.entityId === enemyId);
    assert.ok(farMeleeTarget?.allowed, 'a visible target can be locked ahead of the ACTIVE window');
    assert.equal(farMeleeTarget.inRange, false, 'lock permission does not imply current range');

    const rangedId = 'demo-player-ranged';
    const rangedPreview = await preview(gm.accessToken, { entityId: rangedId, actionTemplateId: DEMO_ACTION_IDS.RANGED });
    assert.equal(rangedPreview.data.available, true);
    const zeroFocus = server.coordinator.handleCommand(
      { userId: 'preview-gm', role: 'GM', socketId: 'preview-gm' },
      {
        requestId: 'preview-zero-focus',
        type: 'GM_ADJUST_ENTITY',
        payload: { entityId: rangedId, reason: 'resource parity test', resources: { focus: 0 } },
      },
    );
    assert.equal(zeroFocus.ok, true);
    const noResourcePreview = await preview(gm.accessToken, { entityId: rangedId, actionTemplateId: DEMO_ACTION_IDS.RANGED });
    assert.equal(noResourcePreview.data.available, false);
    assert.equal(noResourcePreview.data.reason, '资源不足');
    const formalNoResource = server.coordinator.handleCommand(
      { userId: 'preview-gm', role: 'GM', socketId: 'preview-gm' },
      {
        requestId: 'preview-formal-resource',
        type: 'ACTION',
        payload: { entityId: rangedId, actionTemplateId: DEMO_ACTION_IDS.RANGED, targetIds: [enemyId] },
      },
    );
    assert.equal(formalNoResource.ok, false);
    assert.equal(formalNoResource.code, 'INSUFFICIENT_RESOURCE', 'formal ACTION uses the same resource decision as preview');

    const movement = await preview(gm.accessToken, { entityId: actorId, actionTemplateId: DEMO_ACTION_IDS.MOVE });
    assert.equal(movement.data.targetKind, 'cell');
    assert.equal(movement.data.available, true);
    assert.equal(movement.data.cells.length, 60, 'preview covers the 10 by 6 offset map');
    assert.ok(movement.data.cells.some(cell => cell.x === 0 && cell.y === 0 && cell.allowed));
    assert.ok(movement.data.cells.some(cell => cell.x === 9 && cell.y === 5 && cell.allowed));

    const recover = await preview(gm.accessToken, { entityId: actorId, actionTemplateId: DEMO_ACTION_IDS.RECOVER });
    assert.equal(recover.data.targetKind, 'none');
    assert.equal(recover.data.available, true, 'self-only recovery does not enter target mode');

    const previewBaseline = server.coordinator.getSnapshot();
    const baselineFocus = previewBaseline.entities.find(entity => entity.id === actorId)?.resources.current.focus;
    const repeatedA = await preview(gm.accessToken, { entityId: actorId, actionTemplateId: DEMO_ACTION_IDS.MELEE });
    const repeatedB = await preview(gm.accessToken, { entityId: actorId, actionTemplateId: DEMO_ACTION_IDS.MELEE });
    assert.deepEqual(repeatedB, repeatedA, 'repeating a preview is deterministic and idempotent');
    const previewAfter = server.coordinator.getSnapshot();
    assert.equal(previewAfter.revision, previewBaseline.revision, 'preview does not bump the encounter revision');
    assert.deepEqual(previewAfter.plan, previewBaseline.plan, 'preview does not create or alter an action plan');
    assert.equal(previewAfter.entities.find(entity => entity.id === actorId)?.resources.current.focus, baselineFocus, 'preview does not spend resources');

    const playerUnauthorized = await preview(player.accessToken, { entityId: rangedId, actionTemplateId: DEMO_ACTION_IDS.MELEE });
    assert.equal(playerUnauthorized.data.available, false);
    assert.equal(playerUnauthorized.data.reason, '没有该实体的控制权');

    const takeover = server.coordinator.handleCommand(
      { userId: 'preview-gm', role: 'GM', socketId: 'preview-gm' },
      { requestId: 'preview-takeover', type: 'GM_TAKEOVER', payload: { entityId: actorId } },
    );
    assert.equal(takeover.ok, true);
    const takenOverPreview = await preview(player.accessToken, { entityId: actorId, actionTemplateId: DEMO_ACTION_IDS.MELEE });
    assert.equal(takenOverPreview.data.available, false);
    assert.equal(takenOverPreview.data.reason, '没有该实体的控制权');
    const release = server.coordinator.handleCommand(
      { userId: 'preview-gm', role: 'GM', socketId: 'preview-gm' },
      { requestId: 'preview-release', type: 'GM_RELEASE', payload: { entityId: actorId } },
    );
    assert.equal(release.ok, true);

    const pause = server.coordinator.handleCommand(
      { userId: 'preview-gm', role: 'GM', socketId: 'preview-gm' },
      { requestId: 'preview-pause', type: 'GM_PAUSE', payload: { reason: 'preview pause' } },
    );
    assert.equal(pause.ok, true);
    const pausedPreview = await preview(gm.accessToken, { entityId: actorId, actionTemplateId: DEMO_ACTION_IDS.MELEE });
    assert.equal(pausedPreview.data.available, false);
    assert.equal(pausedPreview.data.reason, '当前没有可提交的行动窗口');
    const resume = server.coordinator.handleCommand(
      { userId: 'preview-gm', role: 'GM', socketId: 'preview-gm' },
      { requestId: 'preview-resume', type: 'GM_RESUME', payload: {} },
    );
    assert.equal(resume.ok, true);

    const emptyContent = installDemoContent();
    const hiddenActor = createDemoEntity('player-melee', 'preview-hidden-actor');
    hiddenActor.visibility = 'GM';
    const emptyCoordinator = new EncounterCoordinator({
      encounterId: 'preview-no-targets',
      content: emptyContent,
      entities: [hiddenActor],
    });
    try {
      const emptyGm = { userId: 'empty-gm', role: 'GM' as const, socketId: 'empty-gm' };
      const emptyPlayer = { userId: 'empty-player', role: 'PL' as const, socketId: 'empty-player' };
      assert.equal(emptyCoordinator.handleCommand(emptyGm, { requestId: 'empty-assign', type: 'GM_ASSIGN_ENTITY', payload: { entityId: hiddenActor.id, userId: emptyPlayer.userId } }).ok, true);
      assert.equal(emptyCoordinator.handleCommand(emptyGm, { requestId: 'empty-start', type: 'START', payload: {} }).ok, true);
      const noTarget = emptyCoordinator.previewAction(emptyPlayer, hiddenActor.id, DEMO_ACTION_IDS.MELEE);
      assert.equal(noTarget.available, true, 'an action remains selectable when no visible target is legal');
      assert.equal(noTarget.reason, '没有合法目标');
      assert.deepEqual(noTarget.entities, []);
    } finally {
      emptyCoordinator.close();
    }

    const adjusted = server.coordinator.handleCommand(
      { userId: 'preview-gm', role: 'GM', socketId: 'preview-gm' },
      {
        requestId: 'preview-hide-enemy',
        type: 'GM_ADJUST_ENTITY',
        payload: { entityId: enemyId, reason: 'visibility preview test', visibility: 'GM' },
      },
    );
    assert.equal(adjusted.ok, true);
    const playerMelee = await preview(player.accessToken, { entityId: actorId, actionTemplateId: DEMO_ACTION_IDS.MELEE });
    assert.equal(playerMelee.data.entities.some(candidate => candidate.entityId === enemyId), false, 'PL preview omits hidden targets');

    const randomAction: ActionTemplate = {
      id: 'PREVIEW_RANDOM_ACTION',
      tags: ['ATTACK'],
      resourceCost: { focus: '1d6' },
      timeCost: { startupTicks: 1, recoveryTicks: 1 },
      range: { type: 'RANGED', distanceExpr: '1d6' },
      effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '1' } }],
      rulePackId: 'elysian-lan-demo-v1',
    };
    const randomContent: EncounterRulePack = installDemoContent();
    randomContent.actionTemplates.push(randomAction);
    Dictionary.registerAction(randomAction);
    const randomActor = createDemoEntity('player-ranged', 'preview-random-actor', { x: 1, y: 1, z: 0 });
    const randomTarget = createDemoEntity('monster-bruiser', 'preview-random-target', { x: 2, y: 1, z: 0 });
    const randomCoordinator = new EncounterCoordinator({
      encounterId: 'preview-random-expression',
      content: randomContent,
      entities: [randomActor, randomTarget],
    });
    try {
      const randomGm = { userId: 'random-gm', role: 'GM' as const, socketId: 'random-gm' };
      assert.equal(randomCoordinator.handleCommand(randomGm, { requestId: 'random-start', type: 'START', payload: {} }).ok, true);
      const originalRandom = Math.random;
      let randomCalls = 0;
      Math.random = () => {
        randomCalls += 1;
        return 0.5;
      };
      try {
        const randomPreviewA = randomCoordinator.previewAction(randomGm, randomActor.id, randomAction.id);
        const randomPreviewB = randomCoordinator.previewAction(randomGm, randomActor.id, randomAction.id);
        assert.equal(randomPreviewA.available, false);
        assert.equal(randomPreviewA.reason, '动作包含随机资源或范围表达式，暂不支持此动作的目标预览');
        assert.deepEqual(randomPreviewB, randomPreviewA, 'random-expression rejection is stable');
        assert.equal(randomCalls, 0, 'preview never rolls random resource/range expressions');
      } finally {
        Math.random = originalRandom;
      }
    } finally {
      randomCoordinator.close();
      Dictionary.unregisterAction(randomAction.id);
    }

    const unknownAction = await preview(gm.accessToken, { entityId: actorId, actionTemplateId: 'UNKNOWN_PREVIEW_ACTION' });
    assert.equal(unknownAction.data.available, false);
    assert.equal(unknownAction.data.reason, '动作模板不存在: UNKNOWN_PREVIEW_ACTION');

    const beforeLock = server.coordinator.getSnapshot();
    const formalOutOfRange = server.coordinator.handleCommand(
      { userId: 'preview-gm', role: 'GM', socketId: 'preview-gm' },
      {
        requestId: 'preview-formal-range', type: 'ACTION',
        payload: { entityId: actorId, actionTemplateId: DEMO_ACTION_IDS.MELEE, targetIds: [enemyId] },
      },
    );
    assert.equal(formalOutOfRange.ok, true, 'formal ACTION permits locking before entering range');
    const afterLock = server.coordinator.getSnapshot();
    assert.equal(afterLock.tick, beforeLock.tick, 'locking alone does not advance the collection barrier');
    assert.equal(afterLock.entities.find(entity => entity.id === enemyId)?.resources.current.hp,
      beforeLock.entities.find(entity => entity.id === enemyId)?.resources.current.hp, 'locking does not deal damage');

    console.log('demo-action-preview: auth, lifecycle, target/cell previews, no side effects, and visibility filtering passed');
  } finally {
    await server.close();
  }
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
