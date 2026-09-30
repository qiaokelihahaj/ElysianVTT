import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Entity, LogPayload } from '../packages/shared/src/index.js';

async function main(): Promise<void> {
  if (!process.env.ELYSIAN_AUTH_TEST_DB?.includes('elysian-auth-test-')) {
    throw new Error('Repository audit requires auth-isolated.runner.ts');
  }
  const [{ prisma }, { CharacterSheetRepository: repository }, { EntityMapper }, { LogRepository }, { Dictionary }, shared] = await Promise.all([
    import('../packages/backend/src/db/prisma.js'),
    import('../packages/backend/src/db/CharacterSheetRepository.js'),
    import('../packages/backend/src/db/EntityMapper.js'),
    import('../packages/backend/src/db/LogRepository.js'),
    import('../packages/backend/src/db/Dictionary.js'),
    import('../packages/shared/src/index.js'),
  ]);
  const prefix = randomUUID();
  const sceneA = `${prefix}-a`;
  const sceneB = `${prefix}-b`;
  const ids = [`${prefix}-first`, `${prefix}-second`];
  const row = (id: string) => ({
    id, name: id, type: 'ACTOR', currentSceneId: sceneA,
    resourcesJson: JSON.stringify({ current: { hp: 10 }, max: { hp: 10 } }),
    transformJson: JSON.stringify({ coords: { x: 0, y: 0, z: 0 }, planeId: sceneA, facing: 0 }),
    physicsJson: JSON.stringify({ scaleClass: 1, collisionRadius: 0.5, mass: 50, movementModes: ['WALK'] }),
  });
  const failures: string[] = [];
  const check = async (name: string, run: () => void | Promise<void>) => {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}`, error); }
  };
  try {
    await check('invalid character JSON uses independent valid defaults', () => {
      const first = EntityMapper.sheetToEntity({ ...row(ids[0]!), resourcesJson: '{', physicsJson: '{' }, sceneA);
      const second = EntityMapper.sheetToEntity({ ...row(ids[1]!), resourcesJson: '{', physicsJson: '{' }, sceneA);
      first.resources.current.hp = 3;
      first.physics.movementModes.push('FLY');
      assert.deepEqual(second.resources.current, {});
      assert.deepEqual(second.physics.movementModes, ['WALK']);
      const malformed = EntityMapper.sheetToEntity({ ...row(ids[0]!), resourcesJson: 'null', physicsJson: '{}', transformJson: '[]' }, sceneA);
      assert.deepEqual(malformed.resources, { current: {}, max: {} });
      assert.equal(malformed.transform.planeId, sceneA);
      assert.deepEqual(malformed.physics.movementModes, ['WALK']);
    });
    await prisma.characterSheet.createMany({ data: ids.map(row) });
    await check('mixed cached/fetched lookups preserve requested order', async () => {
      repository.invalidateAll();
      await repository.findById(ids[0]!);
      assert.deepEqual((await repository.findByIds([ids[1]!, ids[0]!])).map(entity => entity.id), [ids[1], ids[0]]);
    });
    await check('repository snapshots do not share live combat mutations', async () => {
      repository.invalidateAll();
      const entities = await repository.findBySceneId(sceneA);
      const first = entities.find(entity => entity.id === ids[0])!;
      first.resources.current.hp = 1;
      assert.equal((await repository.findById(first.id))?.resources.current.hp, 10);
      assert.equal((await repository.findBySceneId(sceneA)).find(entity => entity.id === first.id)?.resources.current.hp, 10);
    });
    await check('moving entities invalidates source and destination caches', async () => {
      repository.invalidateAll();
      const entities = await repository.findBySceneId(sceneA);
      assert.deepEqual(await repository.findBySceneId(sceneB), []);
      await repository.setEntitiesScene([entities.find(entity => entity.id === ids[1])!], sceneB, false);
      assert.deepEqual((await repository.findBySceneId(sceneA)).map(entity => entity.id), [ids[0]]);
      assert.deepEqual((await repository.findBySceneId(sceneB)).map(entity => entity.id), [ids[1]]);
    });
    await check('settlement invalidates entities loaded outside a scene cache', async () => {
      repository.invalidateAll();
      const entity = await repository.findById(ids[1]!) as Entity;
      const updated = structuredClone(entity);
      updated.resources.current.hp = 7;
      await repository.upsertCombatResults([updated], [], sceneB);
      assert.equal((await repository.findById(entity.id))?.resources.current.hp, 7);
    });
    await check('deleting entities invalidates cached rosters', async () => {
      repository.invalidateAll();
      await repository.findBySceneId(sceneA);
      await repository.deleteByIds([ids[0]!]);
      assert.deepEqual(await repository.findBySceneId(sceneA), []);
    });
    for (const tick of [0, 1, 2]) {
      const payload: LogPayload = {
        timestamp: Date.now() + tick, namespace: 'audit', level: shared.LogLevel.GAME,
        visibility: shared.LogVisibility.PLAYER, message: `tick-${tick}`, tick,
      };
      await LogRepository.createLog(sceneA, payload);
    }
    await check('log ranges apply both bounds and preserve tick zero', async () => {
      const logs = await LogRepository.queryLogs({ sceneId: sceneA, beforeTick: 1, afterTick: 1 });
      assert.deepEqual(logs.map(log => log.tick), [1]);
      assert.equal((await LogRepository.queryLogs({ sceneId: sceneA, beforeTick: 0 }))[0]?.tick, 0);
    });
    await check('one corrupt metadata field does not discard all logs', async () => {
      await prisma.logEntry.updateMany({ where: { sceneId: sceneA, tick: 1 }, data: { metaJson: '{' } });
      const logs = await LogRepository.queryLogs({ sceneId: sceneA });
      assert.equal(logs.length, 3);
      assert.equal(logs.find(log => log.tick === 1)?.meta, undefined);
    });
    await check('dictionary reload removes deleted persistent templates', async () => {
      const actionId = `${prefix}-action`;
      await prisma.actionTemplate.create({ data: { id: actionId, name: 'audit', startupTicks: 1, recoveryTicks: 1, effectsJson: '[]' } });
      await Dictionary.loadAllFromDb();
      assert.ok(Dictionary.getAction(actionId));
      await prisma.actionTemplate.delete({ where: { id: actionId } });
      await Dictionary.loadAllFromDb();
      assert.equal(Dictionary.getAction(actionId), undefined);
    });
  } finally {
    repository.invalidateAll();
    await prisma.$disconnect();
  }
  assert.deepEqual(failures, [], `${failures.length} repository audit regressions failed`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
