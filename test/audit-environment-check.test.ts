import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

const repoRoot = path.resolve('.');
const script = fs.readFileSync(path.join(repoRoot, 'verify-env.js'), 'utf8');

function runCheck(available: boolean): number | undefined {
  const checkProcess: { exitCode?: number } = {};
  runInNewContext(script, {
    __dirname: repoRoot,
    process: checkProcess,
    console: { log: () => undefined },
    require: (name: string) => {
      if (name === 'fs') return available ? fs : { ...fs, existsSync: () => false };
      if (name === 'path') return path;
      if (name === 'child_process') return { execSync: () => {
        if (!available) throw new Error('Tool unavailable');
        return Buffer.from('test-version');
      } };
      throw new Error(`Unexpected environment-check dependency: ${name}`);
    },
  });
  return checkProcess.exitCode;
}

assert.equal(runCheck(false), 1, 'missing tools/files must fail the command');
assert.equal(runCheck(true), 0, 'valid workspace must succeed');
console.log('audit-environment-check: environment check exit status matches diagnostics');
