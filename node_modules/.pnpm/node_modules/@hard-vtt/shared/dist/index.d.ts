export type PlaneId = string;
export interface Vector3D {
    x: number;
    y: number;
    z: number;
}
export interface Transform {
    coords: Vector3D;
    planeId: PlaneId;
    facing: number;
}
export interface PhysicsBody {
    scaleClass: number;
    collisionRadius: number;
    mass: number;
    movementModes: string[];
}
export type EntityId = string;
export interface ResourcePool {
    current: Record<string, number>;
    max: Record<string, number>;
}
export interface AppliedEffect {
    instanceId: string;
    templateId: string;
    sourceEntityId: EntityId;
    remainingTicks: number;
    stacks: number;
}
export interface Entity {
    id: EntityId;
    templateId: string;
    type: 'ACTOR' | 'PROP' | 'PROJECTILE';
    transform: Transform;
    physics: PhysicsBody;
    resources: ResourcePool;
    activeEffects: AppliedEffect[];
    currentActionContext?: {
        actionId: string;
        phase: 'STARTUP' | 'ACTIVE' | 'RECOVERY';
        resolveTick: number;
    };
}
export type ExpressionString = string;
export interface ActionTemplate {
    id: string;
    tags: string[];
    timeCost: {
        startupTicks: number;
        recoveryTicks: number;
    };
    resourceCost: Record<string, ExpressionString>;
    range: {
        type: string;
        distanceExpr: ExpressionString;
        radiusExpr?: ExpressionString;
    };
    effects: ActionEffectPayload[];
    diceRules?: DiceRule[];
}
export interface ActionEffectPayload {
    type: 'DAMAGE' | 'HEAL' | 'APPLY_BUFF' | 'PUSH' | 'INTERRUPT';
    targetSelector: 'PRIMARY' | 'ALL_IN_AOE' | 'SELF';
    conditions?: ExpressionString[];
    parameters: Record<string, any>;
}
export interface RawDie {
    id: string;
    sides: number;
    faceValue: number;
}
export interface DiceRule {
    condition: string;
    actionType: 'ADD_TAG' | 'EXPLODE' | 'REROLL';
    actionPayload?: string;
}
export interface ProcessedDie extends RawDie {
    finalValue: number;
    tags: string[];
    isOverridden: boolean;
}
export interface DicePoolResult {
    total: number;
    dice: ProcessedDie[];
    poolTags: string[];
}
export declare enum LogLevel {
    DEBUG = 0,// 引擎底层推演（堆排序、事件压入等）
    INFO = 1,// 常规流程（连接建立、引擎初始化）
    WARN = 2,// 异常但可恢复（未找到目标等）
    ERROR = 3,// 引擎错误（沙箱执行崩溃等）
    GAME = 4
}
export declare enum LogVisibility {
    DEV = "DEV",// 仅开发者可见（控制台及日志文件）
    GM = "GM",// 开发者 + GM可见（如怪物隐身时的走位）
    PLAYER = "PLAYER"
}
export interface LogPayload {
    timestamp: number;
    sceneId?: string;
    tick?: number;
    namespace: string;
    level: LogLevel;
    visibility: LogVisibility;
    message: string;
    meta?: any;
}
export type Tick = number;
export interface TickEvent {
    eventId: string;
    targetTick: Tick;
    status: 'PENDING' | 'RESOLVED' | 'CANCELLED';
}
export interface ActionExecutionEvent extends TickEvent {
    eventType: 'ACTION_PHASE';
    actorId: EntityId;
    targetIds?: EntityId[];
    actionTemplateId: string;
    phase: 'STARTUP' | 'ACTIVE' | 'RECOVERY';
}
export interface IEngineInstance {
    engineId: string;
    engineType: 'COMBAT' | 'EXPLORE';
    currentTick: Tick;
    mountEntities(entities: Entity[]): void;
    unmountEntities(entityIds: EntityId[]): Entity[];
    receiveIntent(intent: ClientIntent): void;
    on(event: 'STATE_MUTATED', listener: (diff: StateMutationPayload) => void): void;
    on(event: 'VISUAL_FX', listener: (fx: VisualEventPayload) => void): void;
    on(event: 'ENTITY_DIED', listener: (entity: Entity) => void): void;
}
export interface ClientIntent {
    actorId: EntityId;
    intentType: 'CAST_ACTION' | 'MOVE' | 'INTERACT';
    clientTick: Tick;
    payload: {
        actionTemplateId?: string;
        targetIds?: EntityId[];
        targetCoords?: Vector3D;
    };
}
export interface StateMutationPayload {
    tick: Tick;
    mutations: Array<{
        entityId: EntityId;
        changes: Record<string, any>;
    }>;
}
export interface VisualEventPayload {
    tick: Tick;
    events: Array<{
        eventId: string;
        eventType: 'FX_SPAWN' | 'ANIM_PLAY' | 'SOUND_PLAY' | 'UI_FLOATING_TEXT';
        sourceId: EntityId;
        targetId?: EntityId;
        targetCoords?: Vector3D;
        fxTemplateId: string;
        durationMs?: number;
        text?: string;
    }>;
}
//# sourceMappingURL=index.d.ts.map