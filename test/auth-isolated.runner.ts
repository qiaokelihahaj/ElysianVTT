/** Run authentication tests against current TS sources and a fresh SQLite DB.
 * Only the Prisma datasource is replaced; HTTP, Socket and permission code are real.
 * Usage: pnpm exec tsx test/auth-isolated.runner.ts auth.test.ts
 */
import { build, type Plugin } from 'esbuild';
import { builtinModules, createRequire } from 'node:module';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const testRoot = __dirname;
const repoRoot = path.dirname(testRoot);
const backendRequire = createRequire(path.join(repoRoot, 'packages/backend/package.json'));
const schemaPath = path.join(repoRoot, 'packages/backend/prisma/schema.prisma');
const devDatabase = path.join(path.dirname(schemaPath), 'dev.db');
const prismaSource = path.join(repoRoot, 'packages/backend/src/db/prisma.ts');
const sharedSource = path.join(repoRoot, 'packages/shared/src/index.ts');
const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);

function hashFile(filename: string): string | null {
    return existsSync(filename)
        ? createHash('sha256').update(readFileSync(filename)).digest('hex')
        : null;
}

function sourcePlugin(): Plugin {
    return {
        name: 'auth-current-typescript-and-isolated-db',
        setup(builder) {
            builder.onResolve({ filter: /.*/ }, args => {
                if (builtins.has(args.path)) return { path: args.path, external: true };
                if (args.path === '@hard-vtt/shared') return { path: sharedSource };
                if (path.isAbsolute(args.path) || args.path.startsWith('.')) {
                    const resolved = path.resolve(args.resolveDir || repoRoot, args.path);
                    const candidates = /\.js$/.test(resolved)
                        ? [resolved.replace(/\.js$/, '.ts'), resolved.replace(/\.js$/, '.tsx'), resolved]
                        : [resolved, `${resolved}.ts`, `${resolved}.tsx`, path.join(resolved, 'index.ts')];
                    const actual = candidates.find(candidate => existsSync(candidate));
                    if (!actual) return undefined;
                    if (actual === prismaSource) return { path: 'prisma', namespace: 'auth-isolated-db' };
                    return { path: actual };
                }
                // Dependencies use the importing package's real workspace installation.
                const resolver = args.namespace === 'auth-isolated-db' || !args.importer
                    ? backendRequire
                    : createRequire(args.importer);
                return { path: resolver.resolve(args.path), external: true };
            });
            builder.onLoad({ filter: /.*/, namespace: 'auth-isolated-db' }, () => ({
                loader: 'ts',
                contents: `
                    import { PrismaClient } from '@prisma/client';
                    const url = process.env.ELYSIAN_AUTH_TEST_DB;
                    if (!url || !url.startsWith('file:') || !url.includes('elysian-auth-test-')) {
                        throw new Error('AUTH_TEST_ENVIRONMENT_ERROR: missing isolated database');
                    }
                    export const prisma = new PrismaClient({ datasources: { db: { url } } });
                `,
            }));
        },
    };
}

function redactOutput(output: string): string {
    return output.replace(/\b[A-Za-z0-9+/]{60,}={0,2}\.[a-f0-9]{16}\b/g, '[test-token-redacted]');
}

async function main(): Promise<void> {
    const browserMode = process.argv[2] === '--browser';
    const requested = process.argv.slice(browserMode ? 3 : 2);
    if (browserMode && (requested.length !== 1 || requested[0] !== 'combat-browser.test.ts')) {
        throw new Error('--browser only supports combat-browser.test.ts');
    }
    if (requested.length === 0) throw new Error('Pass one or more test/*.test.ts filenames.');
    const files = requested.map(name => {
        const filename = path.resolve(testRoot, name);
        if (path.dirname(filename) !== testRoot || !filename.endsWith('.test.ts') || !existsSync(filename)) {
            throw new Error(`Not an existing top-level test file: ${name}`);
        }
        return filename;
    });
    const databaseBefore = hashFile(devDatabase);
    const schemaBefore = hashFile(schemaPath);
    const prismaCli = backendRequire.resolve('prisma/build/index.js');
    // Generates DDL from the schema, without connecting to its configured dev.db.
    const ddl = execFileSync(process.execPath, [
        prismaCli, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', schemaPath, '--script',
    ], {
        cwd: repoRoot, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
        maxBuffer: 8 * 1024 * 1024,
    });
    let failures = 0;
    let environmentFailures = 0;
    try {
        for (const filename of files) {
            const temporaryRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'elysian-auth-test-')));
            try {
                const dbPath = path.join(temporaryRoot, 'test.db');
                const sqlite = new DatabaseSync(dbPath);
                try { sqlite.exec(ddl); } finally { sqlite.close(); }
                const outputFile = path.join(temporaryRoot, 'test.cjs');
                const bundle = await build({
                    entryPoints: [filename], outfile: outputFile,
                    absWorkingDir: repoRoot, bundle: true, platform: 'node',
                    format: 'cjs', target: 'node22', sourcemap: 'inline',
                    metafile: true, plugins: [sourcePlugin()], logLevel: 'warning',
                });
                const inputs = Object.keys(bundle.metafile!.inputs);
                const shadowJs = inputs.filter(input => /packages\/(backend|shared)\/src\/.*\.js$/.test(input.replaceAll('\\', '/')));
                if (shadowJs.length) throw new Error(`Unexpected source JS: ${shadowJs.join(', ')}`);
                console.log(`\n[isolated] ${path.basename(filename)} | current TS inputs=${inputs.length} | fresh SQLite | real Prisma datasource override`);
                const options = {
                    cwd: repoRoot, encoding: 'utf8' as const, timeout: browserMode ? 1800000 : 60000,
                    maxBuffer: 8 * 1024 * 1024,
                    env: {
                        ...process.env,
                        ELYSIAN_AUTH_TEST_DB: `file:${dbPath.replaceAll('\\', '/')}`,
                        JWT_SECRET: randomBytes(32).toString('hex'),
                        ALLOWED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
                        NODE_ENV: 'test',
                        ELYSIAN_ENABLE_DEV_LOGIN: '1',
                        ELYSIAN_BROWSER_SMOKE: browserMode ? '1' : '',
                    },
                };
                const result = browserMode
                    ? await new Promise<{ status: number | null; signal: NodeJS.Signals | null; error?: Error; stdout: string; stderr: string }>((resolve) => {
                        const child = spawn(process.execPath, [outputFile], { ...options, stdio: 'inherit' });
                        child.on('error', error => resolve({ status: null, signal: null, error, stdout: '', stderr: '' }));
                        child.on('exit', (status, signal) => resolve({ status, signal, stdout: '', stderr: '' }));
                    })
                    : spawnSync(process.execPath, [outputFile], options);
                const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
                process.stdout.write(redactOutput(output));
                if (result.error || result.signal || result.status === 2 || output.includes('AUTH_TEST_ENVIRONMENT_ERROR')) {
                    environmentFailures++;
                    console.error(`[result] ${path.basename(filename)} ENVIRONMENT_ERROR: ${result.error?.message ?? result.signal ?? 'fixture/setup failure'}`);
                } else {
                    if (result.status !== 0) failures++;
                    console.log(`[result] ${path.basename(filename)} exit=${result.status}`);
                }
            } finally {
                // Only delete the exact freshly-created directory; never follow workspace paths.
                if (path.basename(temporaryRoot).startsWith('elysian-auth-test-') &&
                    path.dirname(temporaryRoot) === realpathSync(tmpdir())) {
                    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
                } else {
                    throw new Error('Refusing to clean an unexpected temporary directory.');
                }
            }
        }
    } finally {
        if (hashFile(devDatabase) !== databaseBefore || hashFile(schemaPath) !== schemaBefore) {
            throw new Error('Development DB/schema changed during the run; investigate concurrent writers.');
        }
        console.log('[isolation] development DB and schema SHA-256 unchanged');
    }
    console.log(`[summary] files=${files.length} failing=${failures} environmentErrors=${environmentFailures}`);
    process.exitCode = environmentFailures ? 2 : failures ? 1 : 0;
}

main().catch(error => {
    console.error('AUTH_TEST_ENVIRONMENT_ERROR:', error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
});
