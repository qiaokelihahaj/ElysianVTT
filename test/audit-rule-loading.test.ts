import assert from 'node:assert/strict';

async function main(): Promise<void> {
  if (!process.env.ELYSIAN_AUTH_TEST_DB?.includes('elysian-auth-test-')) {
    throw new Error('Rule loading audit requires auth-isolated.runner.ts');
  }
  const [{ prisma }, { RulePackLoader }, { Dictionary }, { DiceProcessor }] = await Promise.all([
    import('../packages/backend/src/db/prisma.js'),
    import('../packages/backend/src/db/RulePackLoader.js'),
    import('../packages/backend/src/db/Dictionary.js'),
    import('../packages/backend/src/utils/dice/DiceProcessor.js'),
  ]);
  try {
    await prisma.rulePack.create({ data: {
      id: 'audit-invalid-pack', name: 'invalid', attributeDefsJson: '[null]',
      resourceDefsJson: '[]', phaseDefsJson: '[]', defenseModelJson: '{}',
    } });
    await assert.rejects(RulePackLoader.load('audit-invalid-pack'), /Invalid attribute definitions/);
    await prisma.rulePack.update({ where: { id: 'audit-invalid-pack' }, data: {
      attributeDefsJson: '[]', resourceDefsJson: '[{"key":"hp","label":"HP","default":"10","min":0}]',
    } });
    await assert.rejects(RulePackLoader.load('audit-invalid-pack'), /Invalid resource definitions/);
    await prisma.rulePack.update({ where: { id: 'audit-invalid-pack' }, data: {
      resourceDefsJson: '[]', phaseDefsJson: '[{"key":["DELAY"],"label":"Delay","canInterrupt":true,"canReact":true}]',
    } });
    await assert.rejects(RulePackLoader.load('audit-invalid-pack'), /Invalid phase definitions/);
    await prisma.rulePack.update({ where: { id: 'audit-invalid-pack' }, data: {
      phaseDefsJson: '[]', defenseModelJson: '{"drFormula":3}',
    } });
    await assert.rejects(RulePackLoader.load('audit-invalid-pack'), /Invalid defense model/);
    await prisma.rulePack.update({ where: { id: 'audit-invalid-pack' }, data: { defenseModelJson: '{}' } });
    assert.equal((await RulePackLoader.load('audit-invalid-pack'))?.id, 'audit-invalid-pack');
    await prisma.actionTemplate.create({ data: {
      id: 'audit-invalid-action', name: 'invalid', startupTicks: -1, recoveryTicks: 1,
      effectsJson: '[]', rulePackId: 'audit-invalid-pack',
    } });
    await assert.rejects(Dictionary.loadByRulePackId('audit-invalid-pack'), /Invalid action timing/);
    const original = [{ id: 'audit-die', sides: 6, faceValue: 2 }];
    const result = DiceProcessor.process(original, [], { 'audit-die': 5 });
    assert.equal(result.total, 5);
    assert.equal(result.dice[0]?.isOverridden, true);
    assert.equal(original[0]?.faceValue, 2, 'manual overrides must preserve the original roll for audit/replay');
    console.log('audit-rule-loading: invalid configuration rejected; valid definitions and immutable raw dice passed');
  } finally {
    RulePackLoader.clearCache();
    await prisma.$disconnect();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
