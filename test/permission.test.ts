// ==========================================
// 权限系统集成测试
// 合并自: permission-matrix.test.ts + permission-snapshot.test.ts
// 覆盖: PermissionMatrix (GM/PL/OB 授权规则) + PermissionSnapshot CRUD
// ==========================================

import { PermissionService, type PermissionSnapshot } from '../packages/backend/src/permissions/PermissionService.js';
import { PermissionSnapshotRepository } from '../packages/backend/src/db/PermissionSnapshotRepository.js';
import type { ClientIntent, EntityId } from '@hard-vtt/shared';

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
// 测试数据工厂
// ==========================================

function createSubject(role: 'GM' | 'PL' | 'OB', userId: string, controlledEntityIds: string[] = [], allowedSceneIds: string[] = ['scene_1']) {
    return PermissionService.createSubject({
        sessionId: `test_${role}_${userId}`,
        userId,
        role,
        controlledEntityIds,
        visibleEntityIds: controlledEntityIds,
        allowedSceneIds,
        permissionSnapshotVersion: 1
    });
}

function createIntent(intentType: 'CAST_ACTION' | 'MOVE' | 'INTERACT', actorId: EntityId): ClientIntent {
    return {
        actorId,
        intentType,
        clientTick: 0,
        payload: {}
    } as ClientIntent;
}

// ==========================================
// Part 1: 权限矩阵测试
// ==========================================

section('权限矩阵: GM 角色');

{
    const gm = createSubject('GM', 'gm_1', ['any_entity']);

    const result1 = PermissionService.authorizeIntent(gm, 'scene_1', createIntent('MOVE', 'pc_gm'));
    assert(result1.allowed, 'GM 可以控制自己的 PC');

    const result2 = PermissionService.authorizeIntent(gm, 'scene_1', createIntent('MOVE', 'pc_player1'));
    assert(result2.allowed, 'GM 可以控制玩家的 PC');

    const result3 = PermissionService.authorizeIntent(gm, 'scene_1', createIntent('MOVE', 'enemy_1'));
    assert(result3.allowed, 'GM 可以控制敌人');

    const result4 = PermissionService.authorizeIntent(gm, 'scene_1', createIntent('CAST_ACTION', 'pc_gm'));
    assert(result4.allowed, 'GM 可以施法');

    const result5 = PermissionService.authorizeIntent(gm, 'scene_1', createIntent('INTERACT', 'pc_gm'));
    assert(result5.allowed, 'GM 可以交互');
}

section('权限矩阵: PL 角色');

{
    const pl = createSubject('PL', 'player1', ['pc_player1']);

    const result1 = PermissionService.authorizeIntent(pl, 'scene_1', createIntent('MOVE', 'pc_player1'));
    assert(result1.allowed, 'PL 可以控制自己的 PC');

    const result2 = PermissionService.authorizeIntent(pl, 'scene_1', createIntent('MOVE', 'pc_player2'));
    assert(!result2.allowed && result2.code === 'UNAUTHORIZED', 'PL 不能控制其他玩家的 PC');

    const result3 = PermissionService.authorizeIntent(pl, 'scene_1', createIntent('MOVE', 'enemy_1'));
    assert(!result3.allowed && result3.code === 'UNAUTHORIZED', 'PL 不能控制敌人');

    const result4 = PermissionService.authorizeIntent(pl, 'scene_1', createIntent('CAST_ACTION', 'pc_player1'));
    assert(result4.allowed, 'PL 可以施法');

    const result5 = PermissionService.authorizeIntent(pl, 'scene_1', createIntent('INTERACT', 'pc_player1'));
    assert(result5.allowed, 'PL 可以交互');

    const result6 = PermissionService.authorizeIntent(pl, 'scene_unauthorized', createIntent('MOVE', 'pc_player1'));
    assert(!result6.allowed && result6.code === 'NOT_IN_SCENE', 'PL 在未授权场景中无权操作');
}

section('权限矩阵: OB 角色');

{
    const ob = createSubject('OB', 'observer1', []);

    const result1 = PermissionService.authorizeIntent(ob, 'scene_1', createIntent('MOVE', 'pc_player1'));
    assert(!result1.allowed, 'OB 不能控制玩家 PC');

    const result2 = PermissionService.authorizeIntent(ob, 'scene_1', createIntent('MOVE', 'enemy_1'));
    assert(!result2.allowed, 'OB 不能控制敌人');

    const result3 = PermissionService.authorizeIntent(ob, 'scene_1', createIntent('CAST_ACTION', 'pc_player1'));
    assert(!result3.allowed, 'OB 不能施法');

    const result4 = PermissionService.authorizeIntent(ob, 'scene_1', createIntent('INTERACT', 'pc_player1'));
    assert(!result4.allowed, 'OB 不能交互');
}

section('权限矩阵: 场景访问');

{
    const gm = createSubject('GM', 'gm_1', ['any'], ['scene_1']);
    const pl = createSubject('PL', 'player1', ['pc_player1'], ['scene_1']);

    const gmResult = PermissionService.authorizeJoinScene(gm, 'scene_999');
    assert(gmResult.allowed, 'GM 可以进入任何场景');

    const plAllowed = PermissionService.authorizeJoinScene(pl, 'scene_1');
    assert(plAllowed.allowed, 'PL 可以进入被授权的场景');

    const plDenied = PermissionService.authorizeJoinScene(pl, 'scene_999');
    assert(!plDenied.allowed && plDenied.code === 'NOT_IN_SCENE', 'PL 不能进入未授权的场景');
}

section('权限矩阵: 临时授权场景');

{
    const pl_with_grant = createSubject('PL', 'player1',
        ['pc_player1', 'ally_1']
    );

    const result1 = PermissionService.authorizeIntent(pl_with_grant, 'scene_1', createIntent('MOVE', 'ally_1'));
    assert(result1.allowed, 'PL 被授权后可以控制盟友');

    const result2 = PermissionService.authorizeIntent(pl_with_grant, 'scene_1', createIntent('MOVE', 'enemy_1'));
    assert(!result2.allowed, 'PL 被授权后仍不能控制未授权的实体');
}

section('权限矩阵: 无效意图');

{
    const pl = createSubject('PL', 'player1', ['pc_player1']);

    const result = PermissionService.authorizeIntent(pl, 'scene_1', {
        actorId: 'pc_player1',
        intentType: 'INVALID' as any,
        clientTick: 0,
        payload: {}
    });
    assert(!result.allowed && result.code === 'INVALID_INTENT', '无效的 intentType 被拒绝');
}

// ==========================================
// Part 2: 权限快照持久化测试
// ==========================================

section('PermissionSnapshotRepository (权限快照持久化)');

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

            const retrieved = await PermissionSnapshotRepository.getLatestSnapshot(sessionId);
            assert(retrieved !== undefined, '快照查询成功');
            assert(retrieved?.userId === 'alice', '快照包含正确的 userId');
            assert(retrieved?.role === 'PL', '快照包含正确的 role');
            assert(retrieved?.version === 1, '快照包含正确的版本号');
            assert(JSON.stringify(retrieved?.controllableEntities) === JSON.stringify(['pc_alice']), '快照包含正确的可控实体');

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

            await PermissionSnapshotRepository.revokeSnapshot(sessionId);
            const revoked = await PermissionSnapshotRepository.getLatestSnapshot(sessionId);
            assert(revoked === undefined, '撤销后快照已删除');
        } catch (error) {
            console.error('测试执行错误:', error);
            process.exitCode = 1;
        }

        const totalTests = testCount; // capture before summary prints
        console.log(`\n${'='.repeat(60)}`);
        console.log(`✅ 通过: ${passCount}/${totalTests}`);
        console.log(`❌ 失败: ${totalTests - passCount}`);
        console.log(`${'='.repeat(60)}\n`);

        process.exit((totalTests - passCount) > 0 ? 1 : 0);
    })();
}
