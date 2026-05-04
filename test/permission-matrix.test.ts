// ==========================================
// 权限矩阵集成测试
// 验证 GM/PL/OB 角色在各权限域的授权规则
// ==========================================

import { PermissionService } from '../packages/backend/src/permissions/PermissionService.js';
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
// 测试: GM 权限
// ==========================================

section('权限矩阵: GM 角色');

{
    const gm = createSubject('GM', 'gm_1', ['any_entity']);

    // 1. GM 可以控制自己的 PC
    const result1 = PermissionService.authorizeIntent(gm, 'scene_1', createIntent('MOVE', 'pc_gm'));
    assert(result1.allowed, 'GM 可以控制自己的 PC');

    // 2. GM 可以控制玩家的 PC
    const result2 = PermissionService.authorizeIntent(gm, 'scene_1', createIntent('MOVE', 'pc_player1'));
    assert(result2.allowed, 'GM 可以控制玩家的 PC');

    // 3. GM 可以控制敌人
    const result3 = PermissionService.authorizeIntent(gm, 'scene_1', createIntent('MOVE', 'enemy_1'));
    assert(result3.allowed, 'GM 可以控制敌人');

    // 4. GM 可以施法
    const result4 = PermissionService.authorizeIntent(gm, 'scene_1', createIntent('CAST_ACTION', 'pc_gm'));
    assert(result4.allowed, 'GM 可以施法');

    // 5. GM 可以交互
    const result5 = PermissionService.authorizeIntent(gm, 'scene_1', createIntent('INTERACT', 'pc_gm'));
    assert(result5.allowed, 'GM 可以交互');
}

// ==========================================
// 测试: PL 权限
// ==========================================

section('权限矩阵: PL 角色');

{
    const pl = createSubject('PL', 'player1', ['pc_player1']);

    // 1. PL 可以控制自己的 PC
    const result1 = PermissionService.authorizeIntent(pl, 'scene_1', createIntent('MOVE', 'pc_player1'));
    assert(result1.allowed, 'PL 可以控制自己的 PC');

    // 2. PL 不能控制其他玩家的 PC
    const result2 = PermissionService.authorizeIntent(pl, 'scene_1', createIntent('MOVE', 'pc_player2'));
    assert(!result2.allowed && result2.code === 'UNAUTHORIZED', 'PL 不能控制其他玩家的 PC');

    // 3. PL 不能控制敌人
    const result3 = PermissionService.authorizeIntent(pl, 'scene_1', createIntent('MOVE', 'enemy_1'));
    assert(!result3.allowed && result3.code === 'UNAUTHORIZED', 'PL 不能控制敌人');

    // 4. PL 可以施法
    const result4 = PermissionService.authorizeIntent(pl, 'scene_1', createIntent('CAST_ACTION', 'pc_player1'));
    assert(result4.allowed, 'PL 可以施法');

    // 5. PL 可以交互
    const result5 = PermissionService.authorizeIntent(pl, 'scene_1', createIntent('INTERACT', 'pc_player1'));
    assert(result5.allowed, 'PL 可以交互');

    // 6. PL 在未授权场景中无权操作
    const result6 = PermissionService.authorizeIntent(pl, 'scene_unauthorized', createIntent('MOVE', 'pc_player1'));
    assert(!result6.allowed && result6.code === 'NOT_IN_SCENE', 'PL 在未授权场景中无权操作');
}

// ==========================================
// 测试: OB 权限
// ==========================================

section('权限矩阵: OB 角色');

{
    const ob = createSubject('OB', 'observer1', []);

    // 1. OB 不能控制任何实体
    const result1 = PermissionService.authorizeIntent(ob, 'scene_1', createIntent('MOVE', 'pc_player1'));
    assert(!result1.allowed, 'OB 不能控制玩家 PC');

    // 2. OB 不能控制敌人
    const result2 = PermissionService.authorizeIntent(ob, 'scene_1', createIntent('MOVE', 'enemy_1'));
    assert(!result2.allowed, 'OB 不能控制敌人');

    // 3. OB 不能施法
    const result3 = PermissionService.authorizeIntent(ob, 'scene_1', createIntent('CAST_ACTION', 'pc_player1'));
    assert(!result3.allowed, 'OB 不能施法');

    // 4. OB 不能交互
    const result4 = PermissionService.authorizeIntent(ob, 'scene_1', createIntent('INTERACT', 'pc_player1'));
    assert(!result4.allowed, 'OB 不能交互');
}

// ==========================================
// 测试: 场景访问权限
// ==========================================

section('权限矩阵: 场景访问');

{
    const gm = createSubject('GM', 'gm_1', ['any'], ['scene_1']);
    const pl = createSubject('PL', 'player1', ['pc_player1'], ['scene_1']);

    // 1. GM 可以进入任何场景
    const gmResult = PermissionService.authorizeJoinScene(gm, 'scene_999');
    assert(gmResult.allowed, 'GM 可以进入任何场景');

    // 2. PL 可以进入被授权的场景
    const plAllowed = PermissionService.authorizeJoinScene(pl, 'scene_1');
    assert(plAllowed.allowed, 'PL 可以进入被授权的场景');

    // 3. PL 不能进入未授权的场景
    const plDenied = PermissionService.authorizeJoinScene(pl, 'scene_999');
    assert(!plDenied.allowed && plDenied.code === 'NOT_IN_SCENE', 'PL 不能进入未授权的场景');
}

// ==========================================
// 测试: 被授权后的权限
// ==========================================

section('权限矩阵: 临时授权场景');

{
    // PL 被授权控制盟友
    const pl_with_grant = createSubject('PL', 'player1', 
        ['pc_player1', 'ally_1']  // 包含被授权的实体
    );

    // 1. 授权后可以控制盟友
    const result1 = PermissionService.authorizeIntent(pl_with_grant, 'scene_1', createIntent('MOVE', 'ally_1'));
    assert(result1.allowed, 'PL 被授权后可以控制盟友');

    // 2. 但仍然不能控制敌人
    const result2 = PermissionService.authorizeIntent(pl_with_grant, 'scene_1', createIntent('MOVE', 'enemy_1'));
    assert(!result2.allowed, 'PL 被授权后仍不能控制未授权的实体');
}

// ==========================================
// 测试: Intent 无效检查
// ==========================================

section('权限矩阵: 无效意图');

{
    const pl = createSubject('PL', 'player1', ['pc_player1']);

    // 1. 无效的 intentType
    const result = PermissionService.authorizeIntent(pl, 'scene_1', {
        actorId: 'pc_player1',
        intentType: 'INVALID' as any,
        clientTick: 0,
        payload: {}
    });
    assert(!result.allowed && result.code === 'INVALID_INTENT', '无效的 intentType 被拒绝');
}

// ==========================================
// 测试汇总
// ==========================================
section('权限矩阵测试汇总');

console.log(`✅ 通过: ${passCount}/${testCount}`);
console.log(`❌ 失败: ${testCount - passCount}`);
console.log(`${'='.repeat(60)}\n`);

if ((testCount - passCount) > 0) {
    process.exit(1);
} else {
    process.exit(0);
}
