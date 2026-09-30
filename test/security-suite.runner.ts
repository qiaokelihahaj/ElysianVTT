// 保留旧入口，统一委托当前 TypeScript 与临时数据库执行器。
process.argv.splice(2, process.argv.length - 2,
    'auth.test.ts', 'permission.test.ts', 'visibility-and-logs.test.ts', 'security-regression.test.ts');

void import('./auth-isolated.runner.js').catch((error: unknown) => {
    console.error('Security runner failed:', error);
    process.exitCode = 2;
});
