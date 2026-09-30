import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd(), 'packages/backend/src');
const files = [
  'network/EncounterServer.ts',
  ...['sessions', 'encounters', 'persistence', 'rules'].flatMap(directory =>
    readdirSync(resolve(root, directory)).filter(file => file.endsWith('.ts')).map(file => `${directory}/${file}`),
  ),
];
for (const file of files) {
  const source = readFileSync(resolve(root, file), 'utf8');
  assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"][^'"]*\bdemo\//i, `${file} must not depend on Demo`);
  assert.doesNotMatch(source, /\b(?:DEMO_ACTION_IDS|DEMO_ACTION_TEMPLATES|createDemoRoster|createDemoContent|installDemoContent)\b/, `${file} must use supplied content`);
  if (file.startsWith('encounters/')) {
    assert.doesNotMatch(source, /\bDictionary\b/, `${file} must use its encounter's injected rule catalog`);
  }
}
for (const file of ['DemoSessionService.ts', 'DemoPersistence.ts', 'EncounterCoordinator.ts', 'DemoGameLogBridge.ts', 'GmCorrectionValidation.ts', 'DemoServer.ts']) {
  const source = readFileSync(resolve(root, 'demo', file), 'utf8');
  assert.ok(source.split('\n').length < 100, `${file} must remain a thin compatibility/composition layer`);
}
for (const file of [
  'campaigns/engines/CombatEngine.ts',
  'campaigns/engines/CombatActionTimeline.ts',
  'campaigns/engines/CombatProjectileRuntime.ts',
  'core/engine/ClashPool.ts',
  'core/systems/ProjectileSystem.ts',
]) {
  assert.doesNotMatch(readFileSync(resolve(root, file), 'utf8'), /Dictionary\.getAction\s*\(/,
    `${file} must resolve actions through its injected catalog`);
}
console.log('[result] LAN module dependency boundaries passed');
