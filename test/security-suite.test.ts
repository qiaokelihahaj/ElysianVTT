import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const testDir = path.dirname(fileURLToPath(import.meta.url));

const testFiles = [
    'auth.test.ts',
    'permission-snapshot.test.ts',
    'permission-matrix.test.ts',
    'visibility-and-logs.test.ts',
    'security-regression.test.ts'
];

function runTest(fileName: string): { code: number; output: string } {
    const result = process.platform === 'win32'
        ? spawnSync('cmd.exe', ['/d', '/s', '/c', `pnpm exec tsx ${fileName}`], {
            encoding: 'utf-8',
            stdio: 'pipe',
            cwd: testDir
        })
        : spawnSync('pnpm', ['exec', 'tsx', fileName], {
            encoding: 'utf-8',
            stdio: 'pipe',
            cwd: testDir
        });

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.error) {
        return {
            code: 1,
            output: `${output}\n[runner-error] ${result.error.message}`
        };
    }

    return {
        code: result.status ?? 1,
        output
    };
}

console.log('============================================================');
console.log('  安全测试统一入口');
console.log('============================================================');

let failed = false;

for (const fileName of testFiles) {
    console.log(`\n>>> Running ${fileName}`);
    const result = runTest(fileName);
    process.stdout.write(result.output);

    if (result.code !== 0) {
        failed = true;
        console.error(`\n❌ ${fileName} failed with exit code ${result.code}`);
        break;
    }
}

console.log('\n============================================================');
console.log(failed ? '  安全测试统一入口: FAILED' : '  安全测试统一入口: PASSED');
console.log('============================================================');

process.exit(failed ? 1 : 0);
