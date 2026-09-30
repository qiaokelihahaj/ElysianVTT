import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ActionTemplate } from '../packages/shared/src/index.js';

const isolatedDatabase = process.env.ELYSIAN_AUTH_TEST_DB;
if (!isolatedDatabase
    || !isolatedDatabase.startsWith('file:')
    || !isolatedDatabase.includes('elysian-auth-test-')) {
  throw new Error('ENGINE_RULEPACK_TEST_REQUIRES_ISOLATED_DB');
}

const id = (prefix: string): string => `${prefix}-${randomUUID()}`;

function actionRecord(action: ActionTemplate, rulePackId: string): {
  id: string;
  name: string;
  startupTicks: number;
  recoveryTicks: number;
  effectsJson: string;
  priorityExpr: string | null;
  sustainResourcesJson: string;
  channelOptionsJson: string | null;
  tagsJson: string;
  resourceCostJson: string;
  rangeJson: string;
  rulePackId: string;
} {
  return {
    id: action.id,
    name: action.id,
    startupTicks: action.timeCost.startupTicks,
    recoveryTicks: action.timeCost.recoveryTicks,
    effectsJson: JSON.stringify(action.effects),
    priorityExpr: action.priorityExpr ?? null,
    sustainResourcesJson: JSON.stringify(action.sustainResources ?? []),
    channelOptionsJson: action.channelOptions === undefined ? null : JSON.stringify(action.channelOptions),
    tagsJson: JSON.stringify(action.tags),
    resourceCostJson: JSON.stringify(action.resourceCost),
    rangeJson: JSON.stringify(action.range),
    rulePackId,
  };
}

function action(
  actionId: string,
  startupTicks: number,
  recoveryTicks: number,
  resourceCost: number,
  damage: number,
): ActionTemplate {
  return {
    id: actionId,
    tags: ['MELEE'],
    timeCost: { startupTicks, recoveryTicks },
    resourceCost: { focus: String(resourceCost) },
    range: { type: 'MELEE', distanceExpr: '2' },
    effects: [{
      type: 'DAMAGE',
      targetSelector: 'PRIMARY',
      parameters: { resource: 'hp', amountExpr: String(damage) },
    }],
  };
}

async function main(): Promise<void> {
  // Keep runtime imports behind the database guard so a direct invocation can
  // never initialize a Prisma client against the development database.
  const [{ prisma }, { CombatEngine }, { Dictionary }, { RulePackLoader }, { InMemoryActionCatalog }] = await Promise.all([
    import('../packages/backend/src/db/prisma.js'),
    import('../packages/backend/src/campaigns/engines/CombatEngine.js'),
    import('../packages/backend/src/db/Dictionary.js'),
    import('../packages/backend/src/db/RulePackLoader.js'),
    import('../packages/backend/src/rules/ActionCatalog.js'),
  ]);

  const packAId = id('engine-rulepack-a');
  const packBId = id('engine-rulepack-b');
  const actionAId = id('engine-shared-action-a');
  const actionBId = id('engine-shared-action-b');
  const packIds = [packAId, packBId];
  const actionIds = [actionAId, actionBId];
  const actionA = action(actionAId, 2, 3, 2, 7);
  const actionB = action(actionBId, 11, 13, 5, 19);
  let engineA: InstanceType<typeof CombatEngine> | undefined;
  let engineB: InstanceType<typeof CombatEngine> | undefined;
  let missingEngine: InstanceType<typeof CombatEngine> | undefined;

  try {
    await prisma.rulePack.create({
      data: {
        id: packAId,
        name: 'Engine isolation A',
        description: 'Rule pack A',
        attributeDefsJson: JSON.stringify([{ key: 'mightA', label: 'Might A', default: 3 }]),
        resourceDefsJson: JSON.stringify([{ key: 'focusA', label: 'Focus A', default: 10, min: 0 }]),
        phaseDefsJson: JSON.stringify([]),
        defenseModelJson: JSON.stringify({ drFormula: '0' }),
      },
    });
    await prisma.rulePack.create({
      data: {
        id: packBId,
        name: 'Engine isolation B',
        description: 'Rule pack B',
        attributeDefsJson: JSON.stringify([{ key: 'mightB', label: 'Might B', default: 8 }]),
        resourceDefsJson: JSON.stringify([{ key: 'focusB', label: 'Focus B', default: 20, min: 0 }]),
        phaseDefsJson: JSON.stringify([]),
        defenseModelJson: JSON.stringify({ drFormula: '1' }),
      },
    });
    await prisma.actionTemplate.create({ data: actionRecord(actionA, packAId) });
    await prisma.actionTemplate.create({ data: actionRecord(actionB, packBId) });

    engineA = new CombatEngine(`engine-a-${randomUUID()}`, packAId, new InMemoryActionCatalog());
    engineB = new CombatEngine(`engine-b-${randomUUID()}`, packBId);
    await Promise.all([engineA.ready(), engineB.ready()]);

    const defsA = engineA.getRulePackDefs();
    const defsB = engineB.getRulePackDefs();
    assert.equal(defsA?.id, packAId);
    assert.equal(defsA?.name, 'Engine isolation A');
    assert.equal(defsB?.id, packBId);
    assert.equal(defsB?.name, 'Engine isolation B');

    // Rule definitions are returned as an engine-owned snapshot. Mutating A's
    // result must not alter B's definitions or nested data.
    assert.ok(defsA?.attributeDefs[0]);
    defsA.name = 'mutated outside engine A';
    defsA.attributeDefs[0]!.label = 'mutated nested definition';
    assert.equal(engineA.getRulePackDefs()?.name, 'Engine isolation A');
    assert.equal(engineA.getRulePackDefs()?.attributeDefs[0]?.label, 'Might A');
    assert.equal(engineB.getRulePackDefs()?.name, 'Engine isolation B');
    assert.equal(engineB.getRulePackDefs()?.attributeDefs[0]?.label, 'Might B');
    const cachedDefs = RulePackLoader.getCached(packAId);
    assert.ok(cachedDefs);
    cachedDefs.name = 'mutated shared loader cache';
    assert.equal(engineA.getRulePackDefs()?.name, 'Engine isolation A', 'binding snapshots the shared loader cache');

    const loadedA = engineA.getActionCatalog().getAction(actionAId);
    const loadedB = engineB.getActionCatalog().getAction(actionBId);
    assert.deepEqual(loadedA?.timeCost, actionA.timeCost, 'engine A loads only pack A timing');
    assert.deepEqual(loadedA?.resourceCost, actionA.resourceCost, 'engine A loads pack A resources');
    assert.equal(loadedA?.effects[0]?.parameters?.amountExpr, '7');
    assert.deepEqual(loadedB?.timeCost, actionB.timeCost, 'engine B loads only pack B timing');
    assert.deepEqual(loadedB?.resourceCost, actionB.resourceCost, 'engine B loads pack B resources');
    assert.equal(loadedB?.effects[0]?.parameters?.amountExpr, '19');
    assert.equal(engineA.getActionCatalog().getAction(actionBId), undefined, 'engine A cannot resolve pack B action');
    assert.equal(engineB.getActionCatalog().getAction(actionAId), undefined, 'engine B cannot resolve pack A action');

    // A process-wide template with the same id is deliberately different. It
    // must not replace an action already loaded into either rule-pack catalog.
    const globalOverride: ActionTemplate = {
      ...actionA,
      timeCost: { startupTicks: 97, recoveryTicks: 101 },
      resourceCost: { focus: '97' },
      effects: [{
        type: 'DAMAGE',
        targetSelector: 'PRIMARY',
        parameters: { resource: 'hp', amountExpr: '997' },
      }],
    };
    Dictionary.registerAction(globalOverride);
    assert.deepEqual(engineA.getActionCatalog().getAction(actionAId)?.timeCost, actionA.timeCost);
    assert.deepEqual(engineA.getActionCatalog().getAction(actionAId)?.resourceCost, actionA.resourceCost);
    assert.equal(engineA.getActionCatalog().getAction(actionAId)?.effects[0]?.parameters?.amountExpr, '7');
    assert.equal(engineB.getActionCatalog().getAction(actionAId), undefined);

    missingEngine = new CombatEngine(`engine-missing-${randomUUID()}`, id('engine-missing-pack'));
    await assert.rejects(missingEngine.ready(), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /RulePack 'engine-missing-pack-[0-9a-f-]+' not found/);
      return true;
    }, 'missing rule pack must reject with its id');
    assert.match(missingEngine.getRulePackLoadError()?.message ?? '', /not found/);
    console.log('engine-rulepack-isolation: two rule-pack engines and missing-pack diagnostics passed');
  } finally {
    engineA?.removeAllListeners();
    engineB?.removeAllListeners();
    missingEngine?.removeAllListeners();
    Dictionary.clearRuntimeActions();
    RulePackLoader.clearCache();
    await prisma.actionTemplate.deleteMany({ where: { id: { in: actionIds } } });
    await prisma.rulePack.deleteMany({ where: { id: { in: packIds } } });
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
