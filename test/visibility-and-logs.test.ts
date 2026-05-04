// ==========================================
// 可见性与日志过滤集成测试
// ==========================================

import { VisibilityFilter } from '../packages/backend/src/network/VisibilityFilter.js';
import { LogVisibility } from '../packages/shared/src/index.js';
import type { LogPayload, PermissionSubject } from '../packages/shared/src/index.js';

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
// 测试数据
// ==========================================

function createLog(visibility: LogVisibility, message: string): LogPayload {
    return {
        timestamp: Date.now(),
        namespace: 'Test',
        level: 0,
        visibility,
        message,
        sceneId: 'scene_1'
    };
}

function createSubject(role: 'GM' | 'PL' | 'OB', userId: string): any {
    return {
        userId,
        role,
        sessionId: `test_${role}`,
        controlledEntityIds: ['pc_' + userId],
        visibleEntityIds: ['pc_' + userId, 'pc_ally'],
        allowedSceneIds: ['scene_1'],
        permissionSnapshotVersion: 1
    };
}

// ==========================================
// 测试: 日志可见性过滤
// ==========================================

section('日志可见性过滤');

{
    const gmLogs: LogPayload[] = [
        createLog(LogVisibility.DEV, '系统启动'),
        createLog(LogVisibility.GM, 'GM日志'),
        createLog(LogVisibility.PLAYER, '玩家日志')
    ];

    const gm = createSubject('GM', 'gm_1');
    const pl = createSubject('PL', 'player1');
    const ob = createSubject('OB', 'observer1');

    // 1. GM 可见全部日志
    const gmView = VisibilityFilter.filterLogs(gm, gmLogs);
    assert(gmView.length === 3, 'GM 可见全部 3 条日志');

    // 2. PL 仅可见 PLAYER 日志
    const plView = VisibilityFilter.filterLogs(pl, gmLogs);
    assert(plView.length === 1, 'PL 仅可见 1 条 PLAYER 日志');
    assert(plView[0].visibility === LogVisibility.PLAYER, 'PL 看到的是 PLAYER 日志');

    // 3. OB 仅可见 PLAYER 日志
    const obView = VisibilityFilter.filterLogs(ob, gmLogs);
    assert(obView.length === 1, 'OB 仅可见 1 条 PLAYER 日志');
}

// ==========================================
// 测试: 单条日志可见性检查
// ==========================================

section('单条日志可见性检查');

{
    const devLog = createLog(LogVisibility.DEV, '开发日志');
    const gmLog = createLog(LogVisibility.GM, 'GM 日志');
    const playerLog = createLog(LogVisibility.PLAYER, '玩家日志');

    const gm = createSubject('GM', 'gm_1');
    const pl = createSubject('PL', 'player1');
    const ob = createSubject('OB', 'observer1');

    // DEV 日志
    assert(VisibilityFilter.canViewLog(gm, devLog), 'GM 可见 DEV 日志');
    assert(!VisibilityFilter.canViewLog(pl, devLog), 'PL 不可见 DEV 日志');
    assert(!VisibilityFilter.canViewLog(ob, devLog), 'OB 不可见 DEV 日志');

    // GM 日志
    assert(VisibilityFilter.canViewLog(gm, gmLog), 'GM 可见 GM 日志');
    assert(!VisibilityFilter.canViewLog(pl, gmLog), 'PL 不可见 GM 日志');
    assert(!VisibilityFilter.canViewLog(ob, gmLog), 'OB 不可见 GM 日志');

    // PLAYER 日志
    assert(VisibilityFilter.canViewLog(gm, playerLog), 'GM 可见 PLAYER 日志');
    assert(VisibilityFilter.canViewLog(pl, playerLog), 'PL 可见 PLAYER 日志');
    assert(VisibilityFilter.canViewLog(ob, playerLog), 'OB 可见 PLAYER 日志');
}

// ==========================================
// 测试: 实体可见性过滤
// ==========================================

section('实体可见性过滤');

{
    const entities = [
        { id: 'pc_player1', name: '玩家1' },
        { id: 'pc_player2', name: '玩家2' },
        { id: 'enemy_1', name: '敌人1' },
        { id: 'ally_1', name: '盟友1' }
    ];

    const pl = createSubject('PL', 'player1');
    pl.visibleEntityIds = ['pc_player1', 'ally_1'];

    const gm = createSubject('GM', 'gm_1');
    const ob = createSubject('OB', 'observer1');
    ob.visibleEntityIds = ['pc_player1', 'pc_player2', 'ally_1'];

    // 1. GM 看全部实体
    const gmEntities = VisibilityFilter.getVisibleEntities(entities, gm);
    assert(gmEntities.length === 4, 'GM 可见全部 4 个实体');

    // 2. PL 仅看可见列表的实体
    const plEntities = VisibilityFilter.getVisibleEntities(entities, pl);
    assert(plEntities.length === 2, 'PL 仅可见 2 个实体');
    assert(plEntities.some(e => e.id === 'pc_player1'), 'PL 能看到自己的 PC');
    assert(plEntities.some(e => e.id === 'ally_1'), 'PL 能看到盟友');

    // 3. OB 看可见列表的实体
    const obEntities = VisibilityFilter.getVisibleEntities(entities, ob);
    assert(obEntities.length === 3, 'OB 可见 3 个实体');
}

// ==========================================
// 测试: 实体单个可见性判断
// ==========================================

section('实体单个可见性判断');

{
    const gm = createSubject('GM', 'gm_1');
    const pl = createSubject('PL', 'player1');
    pl.visibleEntityIds = ['pc_player1', 'ally_1'];
    const ob = createSubject('OB', 'observer1');

    // 自己的实体总是可见
    assert(VisibilityFilter.isEntityVisibleTo('pc_player1', pl), 'PL 能看到自己的 PC');
    assert(VisibilityFilter.isEntityVisibleTo('pc_observer1', ob), 'OB 能看到自己的 PC');

    // 盟友
    assert(VisibilityFilter.isEntityVisibleTo('ally_1', pl), 'PL 能看到盟友');

    // 敌人
    assert(!VisibilityFilter.isEntityVisibleTo('enemy_1', pl), 'PL 不能看到未授权的敌人');

    // GM 看全部
    assert(VisibilityFilter.isEntityVisibleTo('enemy_1', gm), 'GM 能看到敌人');
    assert(VisibilityFilter.isEntityVisibleTo('anything', gm), 'GM 能看到任何实体');
}

// ==========================================
// 测试: 按角色分组
// ==========================================

section('按角色分组');

{
    const viewers = [
        createSubject('GM', 'gm_1'),
        createSubject('GM', 'gm_2'),
        createSubject('PL', 'player1'),
        createSubject('PL', 'player2'),
        createSubject('PL', 'player3'),
        createSubject('OB', 'observer1')
    ];

    const groups = VisibilityFilter.groupViewersByRole(viewers);

    assert(groups.gm.length === 2, 'GM 组有 2 个成员');
    assert(groups.pl.length === 3, 'PL 组有 3 个成员');
    assert(groups.ob.length === 1, 'OB 组有 1 个成员');
}

// ==========================================
// 测试: 日志可见性角色映射
// ==========================================

section('日志可见性角色映射');

{
    // DEV 日志仅 GM 可见
    const devRoles = VisibilityFilter.getVisibleRoles(LogVisibility.DEV);
    assert(devRoles.includes('GM'), 'DEV 日志对 GM 可见');
    assert(!devRoles.includes('PL'), 'DEV 日志对 PL 不可见');
    assert(!devRoles.includes('OB'), 'DEV 日志对 OB 不可见');

    // PLAYER 日志全部可见
    const playerRoles = VisibilityFilter.getVisibleRoles(LogVisibility.PLAYER);
    assert(playerRoles.includes('GM'), 'PLAYER 日志对 GM 可见');
    assert(playerRoles.includes('PL'), 'PLAYER 日志对 PL 可见');
    assert(playerRoles.includes('OB'), 'PLAYER 日志对 OB 可见');
}

// ==========================================
// 测试汇总
// ==========================================
section('可见性与日志测试汇总');

console.log(`✅ 通过: ${passCount}/${testCount}`);
console.log(`❌ 失败: ${testCount - passCount}`);
console.log(`${'='.repeat(60)}\n`);

if ((testCount - passCount) > 0) {
    process.exit(1);
} else {
    process.exit(0);
}
