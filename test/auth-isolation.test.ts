import assert from 'node:assert/strict';
import { prisma } from '../packages/backend/src/db/prisma.js';

async function main(): Promise<void> {
    const url = process.env.ELYSIAN_AUTH_TEST_DB;
    assert.ok(url?.includes('elysian-auth-test-'), 'Run through auth-isolated.runner.ts');
    const databases = await prisma.$queryRawUnsafe<Array<{ name: string; file: string }>>('PRAGMA database_list');
    const activeFile = databases.find(database => database.name === 'main')?.file.replaceAll('\\', '/');
    assert.equal(activeFile, url.slice('file:'.length), 'Real Prisma must use the isolated SQLite file');
    assert.equal(await prisma.user.count(), 0, 'Isolation must start without development users');
    await prisma.user.create({ data: { id: 'isolation-fixture', displayName: 'Isolation fixture', status: 'ACTIVE' } });
    assert.equal(await prisma.user.count(), 1, 'Real database writes must work inside the temporary database');
    console.log('PASS: real Prisma datasource, empty fixture DB, isolated write (3 checks)');
}

main().catch(error => {
    console.error('AUTH_TEST_ENVIRONMENT_ERROR:', error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
}).finally(() => prisma.$disconnect());
