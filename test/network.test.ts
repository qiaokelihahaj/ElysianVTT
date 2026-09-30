// test/network.test.ts
// 网络层测试：Intent 验证、VisibilityFilter 过滤、会话状态管理

// ==========================================
// 1. 内联共享类型
// ==========================================
type EntityId = string;
type Tick = number;

interface Vector3D { x: number; y: number; z?: number; }

interface ClientIntent {
    actorId: EntityId;
    intentType: string;
    clientTick: Tick;
    payload: Record<string, any>;
}

interface PermissionSubject {
    sessionId: string;
    userId: string;
    role: 'GM' | 'PL' | 'OB';
    controlledEntityIds: string[];
    visibleEntityIds: string[];
    allowedSceneIds: string[];
    permissionSnapshotVersion: number;
}

interface StateMutationPayload {
    tick: Tick;
    mutations: Array<{
        entityId: EntityId;
        changes: Record<string, any>;
    }>;
}

interface VisualEventPayload {
    tick: Tick;
    events: Array<{
        eventType: string;
        sourceId?: string;
        targetId?: string;
        fxTemplateId?: string;
        durationMs?: number;
    }>;
}

interface LogPayload {
    visibility: string;
    message: string;
    namespace: string;
    [key: string]: any;
}

// ==========================================
// 2. IntentValidator（复制自 IntentRouter.validateIntent）
// ==========================================
class IntentValidator {
    static validate(intent: ClientIntent): string | null {
        if (!intent.actorId) return 'actorId is required';
        if (!intent.intentType) return 'intentType is required';

        switch (intent.intentType) {
            case 'BATCH_CAST':
                if (!intent.payload?.batchIntents || intent.payload.batchIntents.length === 0) {
                    return 'batchIntents is required for BATCH_CAST';
                }
                for (const bi of intent.payload.batchIntents) {
                    if (!bi.actorId) return 'actorId is required in each batch intent';
                    if (!bi.actionTemplateId) return 'actionTemplateId is required in each batch intent';
                }
                break;
            case 'CAST_ACTION':
                if (!intent.payload?.actionTemplateId) return 'actionTemplateId is required for CAST_ACTION';
                break;
            case 'MOVE':
                if (!intent.payload?.targetCoords) return 'targetCoords is required for MOVE';
                break;
            case 'INTERACT':
                if (!intent.payload?.targetIds || intent.payload.targetIds.length === 0) {
                    return 'targetIds is required for INTERACT';
                }
                break;
            case 'CANCEL_ACTION':
                break;
            case 'DEFEND':
                break;
            case 'DODGE':
                if (!intent.payload?.targetCoords) return 'targetCoords is required for DODGE';
                break;
            case 'REACTION':
                if (!intent.payload?.actionTemplateId) return 'actionTemplateId is required for REACTION';
                if (!intent.payload?.reactionTargetId) return 'reactionTargetId is required for REACTION';
                break;
            case 'MICRO_EVADE':
                if (!intent.payload?.evadeSubType) return 'evadeSubType is required for MICRO_EVADE';
                if (!['DUCK', 'HOP', 'SLIP'].includes(intent.payload.evadeSubType)) return 'evadeSubType must be DUCK, HOP, or SLIP';
                break;
            case 'PRIORITY_TOGGLE':
                if (!intent.payload?.toggleMode) return 'toggleMode is required for PRIORITY_TOGGLE';
                break;
            case 'HOOK_PRESET':
                if (!intent.payload?.hookPreset) return 'hookPreset is required for HOOK_PRESET';
                break;
            default:
                return `Unknown intent type: ${intent.intentType}`;
        }

        return null;
    }
}

// ==========================================
// 3. VisibilityFilter（复制自生产代码）
// ==========================================
const LogVisibility = {
    DEV: 'DEV',
    GM: 'GM',
    PLAYER: 'PLAYER'
};

class VisibilityFilter {
    static filterStateMutation(
        payload: StateMutationPayload,
        viewer?: PermissionSubject | string
    ): StateMutationPayload | null {
        if (!payload || !payload.mutations || payload.mutations.length === 0) return null;

        const viewerEntityId = typeof viewer === 'string' ? viewer : viewer?.userId;

        if (!viewerEntityId) {
            return payload;
        }

        if (typeof viewer === 'object' && (viewer.role === 'PL' || viewer.role === 'OB')) {
            const filtered: StateMutationPayload = {
                ...payload,
                mutations: payload.mutations.filter(m =>
                    viewer.visibleEntityIds?.includes(m.entityId) || m.entityId === viewerEntityId
                )
            };
            return filtered.mutations.length > 0 ? filtered : null;
        }

        return payload;
    }

    static filterVisualFx(
        payload: VisualEventPayload,
        viewer?: PermissionSubject | string
    ): VisualEventPayload | null {
        if (!payload || !payload.events || payload.events.length === 0) return null;

        const viewerEntityId = typeof viewer === 'string' ? viewer : viewer?.userId;

        if (!viewerEntityId) {
            return payload;
        }

        if (typeof viewer === 'object' && (viewer.role === 'PL' || viewer.role === 'OB')) {
            const filtered: VisualEventPayload = {
                ...payload,
                events: payload.events.filter(e => {
                    const sourceVisible = !e.sourceId ||
                        viewer.visibleEntityIds?.includes(e.sourceId) ||
                        e.sourceId === viewerEntityId;

                    const targetVisible = !e.targetId ||
                        viewer.visibleEntityIds?.includes(e.targetId) ||
                        e.targetId === viewerEntityId;

                    return sourceVisible && targetVisible;
                })
            };
            return filtered.events.length > 0 ? filtered : null;
        }

        return payload;
    }

    static getVisibleEntities(
        entities: Array<{ id: string }>,
        viewer: PermissionSubject | string
    ): Array<{ id: string }> {
        const viewerEntityId = typeof viewer === 'string' ? viewer : viewer?.userId;

        if (!viewerEntityId) {
            return entities;
        }

        if (typeof viewer === 'object' && viewer.role === 'GM') {
            return entities;
        }

        if (typeof viewer === 'object') {
            return entities.filter(e =>
                viewer.visibleEntityIds?.includes(e.id) || e.id === viewerEntityId
            );
        }

        return entities.filter(e => e.id === viewerEntityId);
    }

    static isEntityVisibleTo(
        targetEntityId: string,
        viewer: PermissionSubject | string
    ): boolean {
        const viewerEntityId = typeof viewer === 'string' ? viewer : viewer?.userId;

        if (!viewerEntityId) {
            return false;
        }

        if (targetEntityId === viewerEntityId) {
            return true;
        }

        if (typeof viewer === 'object' && viewer.role === 'GM') {
            return true;
        }

        if (typeof viewer === 'object') {
            return viewer.visibleEntityIds?.includes(targetEntityId) || false;
        }

        return false;
    }

    static canViewLog(viewer: PermissionSubject, log: LogPayload): boolean {
        if (viewer.role === 'GM') {
            return true;
        }

        switch (log.visibility) {
            case LogVisibility.DEV:
            case LogVisibility.GM:
                return false;
            case LogVisibility.PLAYER:
                return true;
            default:
                return false;
        }
    }

    static filterLogs(viewer: PermissionSubject, logs: LogPayload[]): LogPayload[] {
        return logs.filter(log => this.canViewLog(viewer, log));
    }

    static groupViewersByRole(viewers: PermissionSubject[]): {
        gm: PermissionSubject[];
        pl: PermissionSubject[];
        ob: PermissionSubject[];
    } {
        const groups = { gm: [] as PermissionSubject[], pl: [] as PermissionSubject[], ob: [] as PermissionSubject[] };
        for (const viewer of viewers) {
            if (viewer.role === 'GM') groups.gm.push(viewer);
            else if (viewer.role === 'PL') groups.pl.push(viewer);
            else if (viewer.role === 'OB') groups.ob.push(viewer);
        }
        return groups;
    }

    static getVisibleRoles(visibility: string): string[] {
        switch (visibility) {
            case LogVisibility.DEV:
            case LogVisibility.GM:
                return ['GM'];
            case LogVisibility.PLAYER:
                return ['GM', 'PL', 'OB'];
            default:
                return ['GM'];
        }
    }
}

// ==========================================
// 4. 会话状态管理器（模拟 SocketServer 会话层）
// ==========================================
interface SessionState {
    currentSceneId?: string;
    permissionSubject?: PermissionSubject;
    authenticated: boolean;
    sceneEntityIds: string[];
}

class SessionManager {
    private sessions = new Map<string, SessionState>();

    createSession(socketId: string): SessionState {
        const session: SessionState = { authenticated: false, sceneEntityIds: [] };
        this.sessions.set(socketId, session);
        return session;
    }

    getSession(socketId: string): SessionState | undefined {
        return this.sessions.get(socketId);
    }

    authenticate(socketId: string, userId: string, role: 'GM' | 'PL' | 'OB', controlledEntities: string[] = []): boolean {
        const session = this.sessions.get(socketId);
        if (!session) return false;
        session.authenticated = true;
        session.permissionSubject = {
            sessionId: socketId,
            userId,
            role,
            controlledEntityIds: controlledEntities,
            visibleEntityIds: controlledEntities,
            allowedSceneIds: ['scene_1'],
            permissionSnapshotVersion: 1
        };
        return true;
    }

    joinScene(socketId: string, sceneId: string, entityIds: string[]): boolean {
        const session = this.sessions.get(socketId);
        if (!session || !session.authenticated) return false;
        session.currentSceneId = sceneId;
        session.sceneEntityIds = entityIds;
        return true;
    }

    leaveScene(socketId: string): void {
        const session = this.sessions.get(socketId);
        if (session) {
            session.currentSceneId = undefined;
            session.sceneEntityIds = [];
        }
    }

    disconnect(socketId: string): void {
        this.sessions.delete(socketId);
    }

    isAuthorized(socketId: string, sceneId: string): { allowed: boolean; code?: string } {
        const session = this.sessions.get(socketId);
        if (!session || !session.authenticated) {
            return { allowed: false, code: 'UNAUTHENTICATED' };
        }
        if (!session.currentSceneId || session.currentSceneId !== sceneId) {
            return { allowed: false, code: 'NOT_IN_SCENE' };
        }
        return { allowed: true };
    }

    canControl(socketId: string, entityId: string): boolean {
        const session = this.sessions.get(socketId);
        if (!session?.permissionSubject) return false;
        const subj = session.permissionSubject;
        if (subj.role === 'GM') return true;
        return subj.controlledEntityIds.includes(entityId);
    }
}

// ==========================================
// 5. 测试框架
// ==========================================
let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
    testCount++;
    if (cond) { passCount++; console.log(`  ✅ ${label}`); }
    else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}

function runTests() {
    // ============================================================
    // Part 1: Intent 验证 — 每种 intentType 的有效/无效输入
    // ============================================================
    console.log('=== 网络层测试: Intent 验证 ===\n');

    console.log('[Part 1] CAST_ACTION 验证');
    {
        assert(IntentValidator.validate({ actorId: '', intentType: 'CAST_ACTION', clientTick: 0, payload: {} }) !== null,
            '空 actorId → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: '', clientTick: 0, payload: {} }) !== null,
            '空 intentType → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'CAST_ACTION', clientTick: 0, payload: {} }) !== null,
            '缺少 actionTemplateId → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'CAST_ACTION', clientTick: 0, payload: { actionTemplateId: 'FIREBALL' } }) === null,
            '有效 CAST_ACTION → 通过');
    }

    console.log('\n[Part 2] MOVE 验证');
    {
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'MOVE', clientTick: 0, payload: {} }) !== null,
            '缺少 targetCoords → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'MOVE', clientTick: 0, payload: { targetCoords: { x: 10, y: 5, z: 0 } } }) === null,
            '有效 MOVE → 通过');
    }

    console.log('\n[Part 3] BATCH_CAST 验证');
    {
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'BATCH_CAST', clientTick: 0, payload: {} }) !== null,
            '缺少 batchIntents → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'BATCH_CAST', clientTick: 0, payload: { batchIntents: [] } }) !== null,
            '空 batchIntents → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'BATCH_CAST', clientTick: 0, payload: { batchIntents: [{ actorId: '', actionTemplateId: 'SLASH' }] } }) !== null,
            'batch intent 缺少 actorId → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'BATCH_CAST', clientTick: 0, payload: { batchIntents: [{ actorId: 'a', actionTemplateId: '' }] } }) !== null,
            'batch intent 缺少 actionTemplateId → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'BATCH_CAST', clientTick: 0, payload: { batchIntents: [{ actorId: 'a', actionTemplateId: 'SLASH' }, { actorId: 'b', actionTemplateId: 'FIREBALL' }] } }) === null,
            '有效 BATCH_CAST（2人）→ 通过');
    }

    console.log('\n[Part 4] INTERACT 验证');
    {
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'INTERACT', clientTick: 0, payload: {} }) !== null,
            '缺少 targetIds → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'INTERACT', clientTick: 0, payload: { targetIds: [] } }) !== null,
            '空 targetIds → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'INTERACT', clientTick: 0, payload: { targetIds: ['npc_1'] } }) === null,
            '有效 INTERACT → 通过');
    }

    console.log('\n[Part 5] CANCEL_ACTION & DEFEND（无必要 payload）');
    {
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'CANCEL_ACTION', clientTick: 0, payload: {} }) === null,
            'CANCEL_ACTION 无需 payload → 通过');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'DEFEND', clientTick: 0, payload: {} }) === null,
            'DEFEND 无需 payload → 通过');
    }

    console.log('\n[Part 6] DODGE 验证');
    {
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'DODGE', clientTick: 0, payload: {} }) !== null,
            'DODGE 缺少 targetCoords → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'DODGE', clientTick: 0, payload: { targetCoords: { x: 5, y: 0 } } }) === null,
            '有效 DODGE → 通过');
    }

    console.log('\n[Part 7] REACTION 验证');
    {
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'REACTION', clientTick: 0, payload: {} }) !== null,
            'REACTION 缺少 actionTemplateId → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'REACTION', clientTick: 0, payload: { actionTemplateId: 'COUNTER' } }) !== null,
            'REACTION 缺少 reactionTargetId → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'REACTION', clientTick: 0, payload: { actionTemplateId: 'COUNTER', reactionTargetId: 'enemy_1' } }) === null,
            '有效 REACTION → 通过');
    }

    console.log('\n[Part 8] MICRO_EVADE 验证');
    {
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'MICRO_EVADE', clientTick: 0, payload: {} }) !== null,
            '缺少 evadeSubType → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'MICRO_EVADE', clientTick: 0, payload: { evadeSubType: 'JUMP' } }) !== null,
            '非法 evadeSubType → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'MICRO_EVADE', clientTick: 0, payload: { evadeSubType: 'DUCK' } }) === null,
            'DUCK → 通过');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'MICRO_EVADE', clientTick: 0, payload: { evadeSubType: 'HOP' } }) === null,
            'HOP → 通过');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'MICRO_EVADE', clientTick: 0, payload: { evadeSubType: 'SLIP' } }) === null,
            'SLIP → 通过');
    }

    console.log('\n[Part 9] PRIORITY_TOGGLE & HOOK_PRESET');
    {
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'PRIORITY_TOGGLE', clientTick: 0, payload: {} }) !== null,
            '缺少 toggleMode → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'PRIORITY_TOGGLE', clientTick: 0, payload: { toggleMode: 'PASS_ALL' } }) === null,
            '有效 PRIORITY_TOGGLE → 通过');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'HOOK_PRESET', clientTick: 0, payload: {} }) !== null,
            '缺少 hookPreset → 拒绝');
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'HOOK_PRESET', clientTick: 0, payload: { hookPreset: { type: 'ENTER_RANGE' } } }) === null,
            '有效 HOOK_PRESET → 通过');
    }

    console.log('\n[Part 10] 未知 intentType');
    {
        assert(IntentValidator.validate({ actorId: 'hero', intentType: 'INVALID_TYPE', clientTick: 0, payload: {} }) !== null,
            '未知类型 → 拒绝');
    }

    // ============================================================
    // Part 2: VisibilityFilter 可见性过滤
    // ============================================================
    console.log('\n=== 网络层测试: VisibilityFilter ===\n');

    const gmViewer: PermissionSubject = {
        sessionId: 's1', userId: 'gm_1', role: 'GM',
        controlledEntityIds: ['any'], visibleEntityIds: ['any'],
        allowedSceneIds: ['scene_1'], permissionSnapshotVersion: 1
    };

    const plViewer: PermissionSubject = {
        sessionId: 's2', userId: 'pl_1', role: 'PL',
        controlledEntityIds: ['pc_hero'], visibleEntityIds: ['pc_hero', 'ally_1'],
        allowedSceneIds: ['scene_1'], permissionSnapshotVersion: 1
    };

    const mutationPayload: StateMutationPayload = {
        tick: 100,
        mutations: [
            { entityId: 'pc_hero', changes: { 'resources.current.hp': 50 } },
            { entityId: 'enemy_1', changes: { 'resources.current.hp': 30 } },
            { entityId: 'ally_1', changes: { 'resources.current.hp': 80 } },
            { entityId: 'npc_hidden', changes: { 'resources.current.hp': 100 } },
        ]
    };

    console.log('[Part 1] filterStateMutation — GM 可见全部');
    {
        const result = VisibilityFilter.filterStateMutation(mutationPayload, gmViewer);
        assert(result !== null, 'GM → 非空');
        assert(result!.mutations.length === 4, 'GM → 4 条变更全部可见');
    }

    console.log('\n[Part 2] filterStateMutation — PL 仅见可见实体');
    {
        const result = VisibilityFilter.filterStateMutation(mutationPayload, plViewer);
        assert(result !== null, 'PL → 非空');
        assert(result!.mutations.length === 2, `PL → 2 条可见 (pc_hero + ally_1), 实际 ${result!.mutations.length}`);
        assert(result!.mutations.every(m => ['pc_hero', 'ally_1'].includes(m.entityId)), 'PL → 只包含可见实体');
    }

    console.log('\n[Part 3] filterStateMutation — PL 无可见变更返回 null');
    {
        const invisiblePayload: StateMutationPayload = {
            tick: 101,
            mutations: [
                { entityId: 'enemy_hidden', changes: { 'resources.current.hp': 10 } }
            ]
        };
        const result = VisibilityFilter.filterStateMutation(invisiblePayload, plViewer);
        assert(result === null, 'PL → 无可现实体变更返回 null');
    }

    console.log('\n[Part 4] filterStateMutation — 空/无效 payload');
    {
        const nullPayload = VisibilityFilter.filterStateMutation(null as any, gmViewer);
        assert(nullPayload === null, 'null payload → 返回 null');

        const emptyPayload = VisibilityFilter.filterStateMutation({ tick: 0, mutations: [] }, gmViewer);
        assert(emptyPayload === null, '空 mutations → 返回 null');

        const noViewer = VisibilityFilter.filterStateMutation(mutationPayload, undefined);
        assert(noViewer !== null && noViewer!.mutations.length === 4, '无 viewer → 全部返回');
    }

    console.log('\n[Part 5] filterVisualFx — GM 可见全部');
    {
        const fxPayload: VisualEventPayload = {
            tick: 50,
            events: [
                { eventType: 'HIT', sourceId: 'pc_hero', targetId: 'enemy_1', fxTemplateId: 'slash' },
                { eventType: 'HEAL', sourceId: 'ally_1', targetId: 'pc_hero', fxTemplateId: 'heal' },
                { eventType: 'EXPLOSION', sourceId: 'enemy_1', targetId: 'enemy_1', fxTemplateId: 'boom' },
            ]
        };

        const gmResult = VisibilityFilter.filterVisualFx(fxPayload, gmViewer);
        assert(gmResult !== null && gmResult!.events.length === 3, 'GM → 全部 3 个 VFX 可见');

        const plResult = VisibilityFilter.filterVisualFx(fxPayload, plViewer);
        assert(plResult !== null, 'PL → 非空');
        // HIT: source=pc_hero(可见) target=enemy_1(不可见) → 过滤（目标不可见）
        // HEAL: source=ally_1(可见) target=pc_hero(可见) → 通过
        // EXPLOSION: source=enemy_1(不可见) target=enemy_1(不可见) → 过滤
        assert(plResult!.events.length === 1, `PL → 1 个 VFX 可见 (仅 HEAL), 实际 ${plResult!.events.length}`);
        assert(plResult!.events[0].eventType === 'HEAL', 'PL 可见的 VFX 是 HEAL');
    }

    console.log('\n[Part 6] getVisibleEntities');
    {
        const entities = [
            { id: 'pc_hero' }, { id: 'pc_rogue' }, { id: 'enemy_1' }, { id: 'ally_1' }, { id: 'npc_1' }
        ];

        const gmVisible = VisibilityFilter.getVisibleEntities(entities, gmViewer);
        assert(gmVisible.length === 5, 'GM → 全部 5 实体可见');

        const plVisible = VisibilityFilter.getVisibleEntities(entities, plViewer);
        assert(plVisible.length === 2, `PL → 2 实体可见 (pc_hero, ally_1), 实际 ${plVisible.length}`);
        assert(plVisible.every(e => ['pc_hero', 'ally_1'].includes(e.id)), 'PL → 只包含可见实体');
    }

    console.log('\n[Part 7] isEntityVisibleTo');
    {
        assert(VisibilityFilter.isEntityVisibleTo('pc_hero', plViewer) === true, 'PL → 自己可见');
        assert(VisibilityFilter.isEntityVisibleTo('ally_1', plViewer) === true, 'PL → 盟友可见');
        assert(VisibilityFilter.isEntityVisibleTo('enemy_1', plViewer) === false, 'PL → 敌人不可见');
        assert(VisibilityFilter.isEntityVisibleTo('enemy_1', gmViewer) === true, 'GM → 敌人可见');
        assert(VisibilityFilter.isEntityVisibleTo('unknown', gmViewer) === true, 'GM → 未知实体也可见');
    }

    console.log('\n[Part 8] 日志可见性（canViewLog / filterLogs / getVisibleRoles）');
    {
        const devLog: LogPayload = { visibility: 'DEV', message: 'debug', namespace: 'test' };
        const gmLog: LogPayload = { visibility: 'GM', message: 'gm secret', namespace: 'test' };
        const playerLog: LogPayload = { visibility: 'PLAYER', message: 'public', namespace: 'test' };
        const allLogs = [devLog, gmLog, playerLog];

        // GM 可见全部
        assert(VisibilityFilter.canViewLog(gmViewer, devLog) === true, 'GM → DEV 日志可见');
        assert(VisibilityFilter.canViewLog(gmViewer, gmLog) === true, 'GM → GM 日志可见');
        assert(VisibilityFilter.canViewLog(gmViewer, playerLog) === true, 'GM → PLAYER 日志可见');

        const gmFiltered = VisibilityFilter.filterLogs(gmViewer, allLogs);
        assert(gmFiltered.length === 3, 'GM → 全部 3 条日志可见');

        // PL 仅见 PLAYER 日志
        assert(VisibilityFilter.canViewLog(plViewer, devLog) === false, 'PL → DEV 日志不可见');
        assert(VisibilityFilter.canViewLog(plViewer, gmLog) === false, 'PL → GM 日志不可见');
        assert(VisibilityFilter.canViewLog(plViewer, playerLog) === true, 'PL → PLAYER 日志可见');

        const plFiltered = VisibilityFilter.filterLogs(plViewer, allLogs);
        assert(plFiltered.length === 1, `PL → 仅 1 条日志可见, 实际 ${plFiltered.length}`);

        // getVisibleRoles
        assert(VisibilityFilter.getVisibleRoles('DEV').length === 1, 'DEV → 仅 GM');
        assert(VisibilityFilter.getVisibleRoles('GM').length === 1, 'GM → 仅 GM');
        assert(VisibilityFilter.getVisibleRoles('PLAYER').length === 3, 'PLAYER → 全部 3 角色');
    }

    console.log('\n[Part 9] groupViewersByRole');
    {
        const obViewer: PermissionSubject = {
            sessionId: 's3', userId: 'ob_1', role: 'OB',
            controlledEntityIds: [], visibleEntityIds: [],
            allowedSceneIds: ['scene_1'], permissionSnapshotVersion: 1
        };

        const groups = VisibilityFilter.groupViewersByRole([gmViewer, plViewer, obViewer]);
        assert(groups.gm.length === 1, '1 GM');
        assert(groups.pl.length === 1, '1 PL');
        assert(groups.ob.length === 1, '1 OB');
    }

    console.log('\n[Part 10] filterStateMutation — PL 含自己 entityId 在 changes 中');
    {
        const selfPayload: StateMutationPayload = {
            tick: 200,
            mutations: [
                { entityId: 'pc_hero', changes: { 'resources.current.hp': 40 } },
                { entityId: 'enemy_1', changes: { 'resources.current.hp': 5 } },
            ]
        };
        const result = VisibilityFilter.filterStateMutation(selfPayload, plViewer);
        assert(result !== null, 'PL → 非空');
        assert(result!.mutations.length === 1, 'PL → 仅 pc_hero（自己是 userId 不匹配 entityId）');
    }

    // ============================================================
    // Part 3: 会话状态管理（Session 生命周期）
    // ============================================================
    console.log('\n=== 网络层测试: 会话状态管理 ===\n');

    console.log('[Part 1] 会话创建');
    {
        const sm = new SessionManager();
        const session = sm.createSession('socket_1');
        assert(session.authenticated === false, '新会话未认证');
        assert(session.currentSceneId === undefined, '新会话未加入场景');
    }

    console.log('\n[Part 2] 认证流程');
    {
        const sm = new SessionManager();
        sm.createSession('socket_1');
        const ok = sm.authenticate('socket_1', 'user_1', 'PL', ['pc_hero']);
        assert(ok === true, '认证成功');

        const session = sm.getSession('socket_1')!;
        assert(session.authenticated === true, '已认证');
        assert(session.permissionSubject?.role === 'PL', '角色为 PL');
        assert(session.permissionSubject?.controlledEntityIds.includes('pc_hero'), '控制 pc_hero');
    }

    console.log('\n[Part 3] 加入/离开场景');
    {
        const sm = new SessionManager();
        sm.createSession('socket_1');
        sm.authenticate('socket_1', 'user_1', 'PL', ['pc_hero']);

        const joined = sm.joinScene('socket_1', 'scene_1', ['pc_hero', 'ally_1']);
        assert(joined === true, '加入场景成功');

        const session = sm.getSession('socket_1')!;
        assert(session.currentSceneId === 'scene_1', '场景 ID 正确');
        assert(session.sceneEntityIds.length === 2, '2 个实体在场景中');

        sm.leaveScene('socket_1');
        assert(session.currentSceneId === undefined, '离开后无场景');
        assert(session.sceneEntityIds.length === 0, '实体列表清空');
    }

    console.log('\n[Part 4] 授权检查');
    {
        const sm = new SessionManager();
        sm.createSession('socket_1');
        sm.authenticate('socket_1', 'user_1', 'PL', ['pc_hero']);

        const withoutScene = sm.isAuthorized('socket_1', 'scene_1');
        assert(withoutScene.allowed === false && withoutScene.code === 'NOT_IN_SCENE', '未加入场景 → NOT_IN_SCENE');

        sm.joinScene('socket_1', 'scene_1', ['pc_hero']);
        const authorized = sm.isAuthorized('socket_1', 'scene_1');
        assert(authorized.allowed === true, '已认证+已加入 → 已授权');

        const unauthenticated = sm.isAuthorized('unknown', 'scene_1');
        assert(unauthenticated.allowed === false, '未知 socket → UNAUTHENTICATED');
    }

    console.log('\n[Part 5] 实体控制权限');
    {
        const sm = new SessionManager();

        // GM 控制一切
        sm.createSession('gm_socket');
        sm.authenticate('gm_socket', 'gm_1', 'GM', ['any']);
        assert(sm.canControl('gm_socket', 'pc_hero') === true, 'GM 控制 PC');
        assert(sm.canControl('gm_socket', 'enemy_1') === true, 'GM 控制敌人');

        // PL 仅控制自己的实体
        sm.createSession('pl_socket');
        sm.authenticate('pl_socket', 'pl_1', 'PL', ['pc_hero']);
        assert(sm.canControl('pl_socket', 'pc_hero') === true, 'PL 控制自己的 PC');
        assert(sm.canControl('pl_socket', 'pc_rogue') === false, 'PL 不能控制他人 PC');
        assert(sm.canControl('pl_socket', 'enemy_1') === false, 'PL 不能控制敌人');
    }

    console.log('\n[Part 6] 断开连接清理');
    {
        const sm = new SessionManager();
        sm.createSession('socket_1');
        sm.authenticate('socket_1', 'user_1', 'PL', ['pc_hero']);
        sm.joinScene('socket_1', 'scene_1', ['pc_hero']);

        sm.disconnect('socket_1');
        assert(sm.getSession('socket_1') === undefined, '断开后会话已删除');
        assert(sm.isAuthorized('socket_1', 'scene_1').allowed === false, '断开后未授权');
    }

    console.log('\n[Part 7] 未认证不能加入场景');
    {
        const sm = new SessionManager();
        sm.createSession('socket_1');
        // 未认证尝试加入场景
        const joined = sm.joinScene('socket_1', 'scene_1', ['pc_hero']);
        assert(joined === false, '未认证 → 加入场景被拒绝');
    }

    // ============================================================
    // 总结
    // ============================================================
    console.log(`\n${'='.repeat(50)}`);
    console.log(`网络层测试: ${passCount}/${testCount} 通过`);
    if (passCount < testCount) process.exit(1);
}

runTests();
