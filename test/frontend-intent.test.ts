// ==========================================
// 前端意图分发器单元测试
// 覆盖: IntentDispatcher (意图构建和发送)
// ==========================================

// ==========================================
// Mock Types (matches @hard-vtt/shared)
// ==========================================
type EntityId = string;

interface Vector3D {
    x: number;
    y: number;
    z: number;
}

interface ClientIntent {
    actorId: EntityId;
    intentType: 'MOVE' | 'CAST_ACTION' | 'INTERACT';
    clientTick: number;
    payload: Record<string, any>;
}

// ==========================================
// Mock socketClient
// ==========================================
class MockSocketClient {
    public lastSentIntent: ClientIntent | null = null;
    public sentIntents: ClientIntent[] = [];

    sendIntent(intent: ClientIntent) {
        this.lastSentIntent = intent;
        this.sentIntents.push(intent);
        console.log(`    📤 Mock: 已发送意图 (${intent.intentType})`);
    }

    clear() {
        this.lastSentIntent = null;
        this.sentIntents = [];
    }
}

const mockSocketClient = new MockSocketClient();

// ==========================================
// Mock useGameStore
// ==========================================
let mockGameStoreTick = 0;

function setMockGameStoreTick(tick: number) {
    mockGameStoreTick = tick;
}

// ==========================================
// IntentDispatcher (实现代码)
// ==========================================
class IntentDispatcher {
    private static createBaseIntent(actorId: EntityId, intentType: ClientIntent['intentType']): ClientIntent {
        return {
            actorId,
            intentType,
            clientTick: mockGameStoreTick,
            payload: {}
        };
    }

    public static dispatchMove(actorId: EntityId, targetCoords: Vector3D) {
        const intent: ClientIntent = {
            ...this.createBaseIntent(actorId, 'MOVE'),
            payload: { targetCoords }
        };
        mockSocketClient.sendIntent(intent);
    }

    public static dispatchCastAction(
        actorId: EntityId,
        actionTemplateId: string,
        targetIds?: EntityId[],
        targetCoords?: Vector3D
    ) {
        const intent: ClientIntent = {
            ...this.createBaseIntent(actorId, 'CAST_ACTION'),
            payload: { actionTemplateId, targetIds, targetCoords }
        };
        mockSocketClient.sendIntent(intent);
    }

    public static dispatchInteract(actorId: EntityId, targetId: EntityId) {
        const intent: ClientIntent = {
            ...this.createBaseIntent(actorId, 'INTERACT'),
            payload: { targetIds: [targetId] }
        };
        mockSocketClient.sendIntent(intent);
    }
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
// 测试: IntentDispatcher
// ==========================================

section('IntentDispatcher (意图构建和发送)');

// 1. MOVE 意图构建
{
    setMockGameStoreTick(10);
    mockSocketClient.clear();

    IntentDispatcher.dispatchMove('actor_warrior', { x: 150, y: 200, z: 0 });

    const intent = mockSocketClient.lastSentIntent;
    assert(intent !== null, 'MOVE 意图已发送');
    assert(intent?.intentType === 'MOVE', 'MOVE 意图类型正确');
    assert(intent?.actorId === 'actor_warrior', 'MOVE 意图 actorId 正确');
    assert(intent?.clientTick === 10, 'MOVE 意图 clientTick 正确');
    assert(intent?.payload.targetCoords.x === 150, 'MOVE 目标坐标 X 正确');
    assert(intent?.payload.targetCoords.y === 200, 'MOVE 目标坐标 Y 正确');
    assert(intent?.payload.targetCoords.z === 0, 'MOVE 目标坐标 Z 正确');
}

// 2. CAST_ACTION 意图构建（仅 actionTemplateId）
{
    setMockGameStoreTick(20);
    mockSocketClient.clear();

    IntentDispatcher.dispatchCastAction('actor_mage', 'fireball');

    const intent = mockSocketClient.lastSentIntent;
    assert(intent !== null, 'CAST_ACTION 意图已发送');
    assert(intent?.intentType === 'CAST_ACTION', 'CAST_ACTION 意图类型正确');
    assert(intent?.actorId === 'actor_mage', 'CAST_ACTION actorId 正确');
    assert(intent?.clientTick === 20, 'CAST_ACTION clientTick 正确');
    assert(intent?.payload.actionTemplateId === 'fireball', 'CAST_ACTION actionTemplateId 正确');
    assert(intent?.payload.targetIds === undefined, 'CAST_ACTION 无目标时 targetIds 为 undefined');
}

// 3. CAST_ACTION 意图构建（带目标）
{
    setMockGameStoreTick(30);
    mockSocketClient.clear();

    IntentDispatcher.dispatchCastAction('actor_warrior', 'heroic_strike', ['target_goblin']);

    const intent = mockSocketClient.lastSentIntent;
    assert(intent !== null, 'CAST_ACTION (带目标) 意图已发送');
    assert(intent?.payload.actionTemplateId === 'heroic_strike', 'CAST_ACTION actionTemplateId 正确');
    assert(Array.isArray(intent?.payload.targetIds), 'CAST_ACTION targetIds 是数组');
    assert(intent?.payload.targetIds?.[0] === 'target_goblin', 'CAST_ACTION 目标 ID 正确');
}

// 4. CAST_ACTION 意图构建（带坐标）
{
    setMockGameStoreTick(40);
    mockSocketClient.clear();

    IntentDispatcher.dispatchCastAction('actor_mage', 'meteor_storm', undefined, { x: 200, y: 300, z: 0 });

    const intent = mockSocketClient.lastSentIntent;
    assert(intent?.payload.targetCoords?.x === 200, 'CAST_ACTION targetCoords X 正确');
    assert(intent?.payload.targetCoords?.y === 300, 'CAST_ACTION targetCoords Y 正确');
}

// 5. INTERACT 意图构建
{
    setMockGameStoreTick(50);
    mockSocketClient.clear();

    IntentDispatcher.dispatchInteract('player_1', 'chest_treasure');

    const intent = mockSocketClient.lastSentIntent;
    assert(intent !== null, 'INTERACT 意图已发送');
    assert(intent?.intentType === 'INTERACT', 'INTERACT 意图类型正确');
    assert(intent?.actorId === 'player_1', 'INTERACT actorId 正确');
    assert(intent?.payload.targetIds?.[0] === 'chest_treasure', 'INTERACT 目标 ID 正确');
}

// 6. 多次发送意图时的历史记录
{
    setMockGameStoreTick(60);
    mockSocketClient.clear();

    IntentDispatcher.dispatchMove('actor_a', { x: 1, y: 1, z: 0 });
    IntentDispatcher.dispatchMove('actor_b', { x: 2, y: 2, z: 0 });
    IntentDispatcher.dispatchCastAction('actor_a', 'attack');

    assert(mockSocketClient.sentIntents.length === 3, '多次发送意图被记录');
    assert(mockSocketClient.sentIntents[0].actorId === 'actor_a', '第一个意图 actorId 正确');
    assert(mockSocketClient.sentIntents[1].actorId === 'actor_b', '第二个意图 actorId 正确');
    assert(mockSocketClient.sentIntents[2].intentType === 'CAST_ACTION', '第三个意图类型正确');
}

// 7. clientTick 随时间变化
{
    mockSocketClient.clear();

    setMockGameStoreTick(100);
    IntentDispatcher.dispatchMove('actor_1', { x: 0, y: 0, z: 0 });
    assert(mockSocketClient.sentIntents[0].clientTick === 100, 'Tick 100 时发送的意图正确');

    setMockGameStoreTick(150);
    IntentDispatcher.dispatchMove('actor_1', { x: 1, y: 1, z: 0 });
    assert(mockSocketClient.sentIntents[1].clientTick === 150, 'Tick 150 时发送的意图正确');
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
