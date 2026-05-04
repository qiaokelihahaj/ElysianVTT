// ==========================================
// 权限快照持久化集成测试
// 覆盖: PermissionSnapshotRepository 的 create/read/refresh/revoke
// ==========================================

import { PermissionSnapshotRepository } from '../packages/backend/src/db/PermissionSnapshotRepository.js';
import { PermissionService, type PermissionSnapshot } from '../packages/backend/src/permissions/PermissionService.js';

// ==========================================
// 测试工具
// ==========================================
let testCount = 0;
let passCount = 0;

function assert(condition: boolean, label: string): void {
    testCount++;
    if (condition) {
        passCount++;
        console.log(`  ✅ ${label}`);
    } else {
        console.error(`  ❌ FAIL: ${label}`);
        process.exitCode = 1;
    }
}

function section(title: string): void {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${title}`);
    console.log(`${'='.repeat(60)}`);
}

// ==========================================
// 测试: PermissionSnapshotRepository
// ==========================================

section('PermissionSnapshotRepository (权限快照持久化)');

// 1. 创建快照
{
    const sessionId = `test_sess_${Date.now()}`;
    const snapshot: PermissionSnapshot = {
        sessionId,
        userId: 'alice',
        role: 'PL',
        version: 1,
        controllableEntities: ['pc_alice'],
        visibleEntities: ['pc_alice', 'pc_bob'],
        capabilities: ['move_own_pc', 'cast_action', 'interact', 'read_own_log'],
        currentSceneIds: ['room_1'],
        issuedAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        refreshedAt: Date.now()
    };

    (async () => {
        try {
            await PermissionSnapshotRepository.createSnapshot(sessionId, snapshot);
            assert(true, '快照创建成功');

            // 2. 查询快照
            const retrieved = await PermissionSnapshotRepository.getLatestSnapshot(sessionId);
            assert(retrieved !== undefined, '快照查询成功');
            assert(retrieved?.userId === 'alice', '快照包含正确的 userId');
            assert(retrieved?.role === 'PL', '快照包含正确的 role');
            assert(retrieved?.version === 1, '快照包含正确的版本号');
            assert(JSON.stringify(retrieved?.controllableEntities) === JSON.stringify(['pc_alice']), '快照包含正确的可控实体');

            // 3. 刷新快照（创建新版本）
            const newSnapshot: PermissionSnapshot = {
                ...snapshot,
                version: 2,
                issuedAt: Date.now(),
                refreshedAt: Date.now()
            };

            await PermissionSnapshotRepository.refreshSnapshot(sessionId, newSnapshot);
            assert(true, '快照刷新成功');

            const refreshed = await PermissionSnapshotRepository.getLatestSnapshot(sessionId);
            assert(refreshed?.version === 2, '刷新后快照版本号已更新');

            // 4. 撤销快照
            await PermissionSnapshotRepository.revokeSnapshot(sessionId);
            const revoked = await PermissionSnapshotRepository.getLatestSnapshot(sessionId);
            assert(revoked === undefined, '撤销后快照已删除');
        } catch (error) {
            console.error('测试执行错误:', error);
            process.exitCode = 1;
        }

        // ==========================================
        // 测试汇总
        // ==========================================
        console.log(`\n${'='.repeat(60)}`);
        console.log(`✅ 通过: ${passCount}/${testCount}`);
        console.log(`❌ 失败: ${testCount - passCount}`);
        console.log(`${'='.repeat(60)}\n`);

        if ((testCount - passCount) > 0) {
            process.exit(1);
        } else {
            process.exit(0);
        }
    })();
}
