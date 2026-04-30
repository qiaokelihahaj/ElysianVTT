// ==========================================
// 前端游戏状态存储单元测试
// 覆盖: gameStore (状态管理与选中系统)
// ==========================================

// ==========================================
// Mock Types
// ==========================================
type EntityId = string;
type PlaneId = string;

interface Vector3D {
    x: number;
    y: number;
    z: number;
}

interface Transform {
    coords: Vector3D;
    planeId: PlaneId;
    facing: number;
}

interface PhysicsBody {
    scaleClass: number;
    collisionRadius: number;
    mass: number;
    movementModes: string[];
}

interface ResourcePool {
    current: Record<string, number>;
    max: Record<string, number>;
}

interface Entity {
    id: EntityId;
    templateId: string;
    type: 'ACTOR' | 'PROP' | 'PROJECTILE';
    transform: Transform;
    physics: PhysicsBody;
    resources: ResourcePool;
    activeEffects: any[];
}

interface UiState {
    mode: 'IDLE' | 'SELECT_MOVE_TARGET' | 'SELECT_ACTION_TARGET';
    pendingMoveCoords: Vector3D | null;
    activeActionId: string | null;
}

interface GameState {
    tick: number;
    entities: Record<string, Entity>;
    selectedEntityId: string | null;
    uiState: UiState;
    
    setInitialScene: (entities: Entity[], tick: number) => void;
    applyStateMutation: (payload: any) => void;
    addEntity: (entity: Entity) => void;
    removeEntity: (entityId: string) => void;
    setSelectedEntityId: (entityId: string | null) => void;
    setUiMode: (mode: UiState['mode']) => void;
    setPendingMoveCoords: (coords: Vector3D | null) => void;
    resetUiState: () => void;
}

// ==========================================
// 简化 GameStore 实现
// ==========================================
function createGameStore(): GameState {
    const state = {
        tick: 0,
        entities: {} as Record<string, Entity>,
        selectedEntityId: null as string | null,
        uiState: {
            mode: 'IDLE' as const,
            pendingMoveCoords: null as Vector3D | null,
            activeActionId: null as string | null
        }
    };

    return {
        get tick() { return state.tick; },
        set tick(v) { state.tick = v; },
        
        get entities() { return state.entities; },
        set entities(v) { state.entities = v; },
        
        get selectedEntityId() { return state.selectedEntityId; },
        set selectedEntityId(v) { state.selectedEntityId = v; },
        
        get uiState() { return state.uiState; },
        set uiState(v) { state.uiState = v; },

        setInitialScene: (entities: Entity[], tick: number) => {
            state.tick = tick;
            state.entities = {};
            state.selectedEntityId = null;
            entities.forEach(entity => {
                state.entities[entity.id] = entity;
            });
        },

        applyStateMutation: (payload: any) => {
            state.tick = payload.tick;
            payload.mutations.forEach((mutation: any) => {
                const entity = state.entities[mutation.entityId];
                if (!entity) return;

                Object.entries(mutation.changes).forEach(([path, value]: [string, any]) => {
                    const keys = path.split('.');
                    let current = entity as any;
                    for (let i = 0; i < keys.length - 1; i++) {
                        if (!current[keys[i]]) current[keys[i]] = {};
                        current = current[keys[i]];
                    }
                    current[keys[keys.length - 1]] = value;
                });
            });
        },

        addEntity: (entity: Entity) => {
            state.entities[entity.id] = entity;
        },

        removeEntity: (entityId: string) => {
            delete state.entities[entityId];
            if (state.selectedEntityId === entityId) {
                state.selectedEntityId = null;
            }
        },

        setSelectedEntityId: (entityId: string | null) => {
            state.selectedEntityId = entityId;
        },

        setUiMode: (mode: UiState['mode']) => {
            state.uiState.mode = mode;
            if (mode === 'IDLE') {
                state.uiState.pendingMoveCoords = null;
                state.uiState.activeActionId = null;
            }
        },

        setPendingMoveCoords: (coords: Vector3D | null) => {
            state.uiState.pendingMoveCoords = coords;
        },

        resetUiState: () => {
            state.uiState.mode = 'IDLE';
            state.uiState.pendingMoveCoords = null;
            state.uiState.activeActionId = null;
        }
    } as GameState;
}

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
    console.log(`\n📋 ${title}`);
}

// ==========================================
// 测试: GameStore 初始状态
// ==========================================

section('GameStore 初始状态');

{
    const store = createGameStore();
    assert(store.tick === 0, 'tick 初始为 0');
    assert(Object.keys(store.entities).length === 0, 'entities 初始为空');
    assert(store.selectedEntityId === null, 'selectedEntityId 初始为 null');
    assert(store.uiState.mode === 'IDLE', 'uiState.mode 初始为 IDLE');
    assert(store.uiState.pendingMoveCoords === null, 'pendingMoveCoords 初始为 null');
}

// ==========================================
// 测试: 场景初始化
// ==========================================

section('GameStore 场景初始化 (setInitialScene)');

{
    const store = createGameStore();
    const mockEntities: Entity[] = [
        {
            id: 'actor_warrior',
            templateId: 'hero',
            type: 'ACTOR',
            transform: { coords: { x: 100, y: 100, z: 0 }, planeId: 'ground', facing: 0 },
            physics: { scaleClass: 1, collisionRadius: 20, mass: 100, movementModes: ['WALK'] },
            resources: { current: { hp: 100 }, max: { hp: 100 } },
            activeEffects: []
        }
    ];

    store.setInitialScene(mockEntities, 42);

    assert(store.tick === 42, '场景初始化后 tick 正确');
    assert(Object.keys(store.entities).length === 1, '实体加载成功');
    assert(store.entities['actor_warrior'].resources.current.hp === 100, '实体数据正确');
    assert(store.selectedEntityId === null, '场景初始化时 selectedEntityId 清空');
}

// ==========================================
// 测试: 选中系统
// ==========================================

section('GameStore 选中系统 (setSelectedEntityId)');

{
    const store = createGameStore();
    
    store.setSelectedEntityId('actor_warrior');
    assert(store.selectedEntityId === 'actor_warrior', '选中实体成功');

    store.setSelectedEntityId(null);
    assert(store.selectedEntityId === null, '取消选中成功');
}

// ==========================================
// 测试: 实体添加与删除
// ==========================================

section('GameStore 实体管理 (addEntity, removeEntity)');

{
    const store = createGameStore();
    
    const newEntity: Entity = {
        id: 'test_entity',
        templateId: 'prop',
        type: 'PROP',
        transform: { coords: { x: 50, y: 50, z: 0 }, planeId: 'ground', facing: 0 },
        physics: { scaleClass: 1, collisionRadius: 10, mass: 50, movementModes: [] },
        resources: { current: {}, max: {} },
        activeEffects: []
    };

    store.addEntity(newEntity);
    assert(store.entities['test_entity'] !== undefined, '实体添加成功');

    // 测试删除时清空选中
    store.setSelectedEntityId('test_entity');
    store.removeEntity('test_entity');
    assert(store.entities['test_entity'] === undefined, '实体删除成功');
    assert(store.selectedEntityId === null, '删除实体时清空选中');
}

// ==========================================
// 测试: 状态变更应用
// ==========================================

section('GameStore 状态变更 (applyStateMutation)');

{
    const store = createGameStore();
    
    store.addEntity({
        id: 'actor_test',
        templateId: 'hero',
        type: 'ACTOR',
        transform: { coords: { x: 100, y: 100, z: 0 }, planeId: 'ground', facing: 0 },
        physics: { scaleClass: 1, collisionRadius: 20, mass: 100, movementModes: ['WALK'] },
        resources: { current: { hp: 100 }, max: { hp: 100 } },
        activeEffects: []
    });

    store.applyStateMutation({
        tick: 50,
        mutations: [
            {
                entityId: 'actor_test',
                changes: {
                    'transform.coords.x': 150,
                    'resources.current.hp': 80
                }
            }
        ]
    });

    assert(store.tick === 50, '状态变更后 tick 正确');
    assert(store.entities['actor_test'].transform.coords.x === 150, '位置状态变更成功');
    assert(store.entities['actor_test'].resources.current.hp === 80, '血量状态变更成功');
}

// ==========================================
// 测试: UI 模式切换
// ==========================================

section('GameStore UI 模式 (setUiMode)');

{
    const store = createGameStore();
    
    store.setUiMode('SELECT_MOVE_TARGET');
    assert(store.uiState.mode === 'SELECT_MOVE_TARGET', 'UI 模式切换成功');
    
    store.setPendingMoveCoords({ x: 200, y: 200, z: 0 });
    assert(store.uiState.pendingMoveCoords?.x === 200, '待定坐标设置成功');

    store.setUiMode('IDLE');
    assert(store.uiState.mode === 'IDLE', '回到 IDLE 模式');
    assert(store.uiState.pendingMoveCoords === null, '切换到 IDLE 时清空待定坐标');
}

// ==========================================
// 测试: UI 状态重置
// ==========================================

section('GameStore UI 重置 (resetUiState)');

{
    const store = createGameStore();
    
    store.setUiMode('SELECT_MOVE_TARGET');
    store.setPendingMoveCoords({ x: 100, y: 100, z: 0 });
    
    store.resetUiState();
    assert(store.uiState.mode === 'IDLE', 'resetUiState 恢复模式');
    assert(store.uiState.pendingMoveCoords === null, 'resetUiState 清空坐标');
}

// ==========================================
// 测试: 选中实体与操作的集成
// ==========================================

section('GameStore 选中系统集成');

{
    const store = createGameStore();
    
    // 创建多个实体
    const warrior: Entity = {
        id: 'warrior',
        templateId: 'hero',
        type: 'ACTOR',
        transform: { coords: { x: 0, y: 0, z: 0 }, planeId: 'ground', facing: 0 },
        physics: { scaleClass: 1, collisionRadius: 20, mass: 100, movementModes: ['WALK'] },
        resources: { current: { hp: 100 }, max: { hp: 100 } },
        activeEffects: []
    };

    const enemy: Entity = {
        id: 'goblin',
        templateId: 'goblin',
        type: 'ACTOR',
        transform: { coords: { x: 50, y: 50, z: 0 }, planeId: 'ground', facing: 180 },
        physics: { scaleClass: 1, collisionRadius: 15, mass: 50, movementModes: ['WALK'] },
        resources: { current: { hp: 30 }, max: { hp: 30 } },
        activeEffects: []
    };

    store.addEntity(warrior);
    store.addEntity(enemy);

    // 选中敌人，验证血条数据
    store.setSelectedEntityId('goblin');
    const selectedEntity = store.entities[store.selectedEntityId!];
    assert(selectedEntity.resources.current.hp === 30, '选中敌人后可获取其血量');

    // 进行状态变更，验证选中实体的状态更新
    store.applyStateMutation({
        tick: 10,
        mutations: [
            {
                entityId: 'goblin',
                changes: { 'resources.current.hp': 15 }
            }
        ]
    });

    const updatedEnemy = store.entities['goblin'];
    assert(updatedEnemy.resources.current.hp === 15, '选中实体的状态变更反映正确');
}

// ==========================================
// 测试汇总
// ==========================================
console.log(`\n${'='.repeat(50)}`);
console.log(`✅ 通过: ${passCount}/${testCount}`);
console.log(`❌ 失败: ${testCount - passCount}`);
console.log(`${'='.repeat(50)}\n`);

if ((testCount - passCount) > 0) {
    process.exit(1);
}
