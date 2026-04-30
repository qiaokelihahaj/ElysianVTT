// ==========================================
// 1. 空间与物理基础 (Spatial & Physics)
// ==========================================
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
    scaleClass: number;      // 尺度级别 (0:微观, 1:常规, 2:巨物)
    collisionRadius: number; // 碰撞半径
    mass: number;            // 质量基数
    movementModes: string[]; 
}

// ==========================================
// 2. 游戏实体与资源 (Entity & Resources)
// ==========================================
export type EntityId = string;

export interface ResourcePool {
    current: Record<string, number>; 
    max: Record<string, number>;
}

export interface AppliedEffect {
    instanceId: string;
    templateId: string;      
    sourceEntityId: EntityId;
    remainingTicks: number;  // -1 为永久
    stacks: number;
}

export interface Entity {
    id: EntityId;
    templateId: string;      // 指向数据库字典，后端不关心具体内容
    type: 'ACTOR' | 'PROP' | 'PROJECTILE'; 
    
    transform: Transform;
    physics: PhysicsBody;
    resources: ResourcePool;
    activeEffects: AppliedEffect[];
    
    // 状态机上下文：记录当前正在执行的长前摇动作或移动
    currentActionContext?: {
        type: 'CASTING' | 'MOVING';
        actionId: string;                              // 当前压入优先队列的事件 ID（每次推新事件时更新）
        actionTemplateId?: string;                     // CASTING 时存储技能模板 ID，供 sustain 检测用
        phase: 'STARTUP' | 'CHANNELING' | 'RECOVERY';
        resolveTick: number;
        pulseCount?: number;                           // CHANNELING 时记录已执行的脉冲次数
        eventIds?: string[];                           // [deprecated] 递归模式不再需要
        waypoints?: Vector3D[];                        // MOVING 时存储所有航点坐标
        currentWaypointIndex?: number;                 // MOVING 时当前已到达的航点索引
    };
}

// ==========================================
// 3. 数据驱动模板 (Data-Driven Rules Definition)
// 后端负责解析以下结构，不负责写死具体业务
// ==========================================
export type ExpressionString = string;

export interface ActionTemplate {
    id: string;              
    tags: string[];          
    timeCost: { startupTicks: number; recoveryTicks: number; };
    resourceCost: Record<string, ExpressionString>; 
    range: { type: string; distanceExpr: ExpressionString; radiusExpr?: ExpressionString; };
    effects: ActionEffectPayload[];
    diceRules?: DiceRule[];
    priorityExpr?: ExpressionString;  // 动态判定优先级公式（ClashPool 求值时用），如 "actor.agi + actor.reach * 2"
    sustainResources?: string[];      // STARTUP 阶段必须维持 >0 的资源列表，如 ["poise"] 或 ["concentration"]
    channelOptions?: {                // 持续引导/多段动作配置（递归调度模式）
        intervalTicks: number;        // 每段判定之间的 Tick 间隔
        maxPulses?: number;           // 最大触发次数（不填则无限，直到资源耗尽或手动取消）
        pulseResourceCost?: Record<string, ExpressionString>;  // 每次脉冲额外消耗
    };
}

export interface ActionEffectPayload {
    type: 'DAMAGE' | 'HEAL' | 'APPLY_BUFF' | 'PUSH' | 'INTERRUPT';
    targetSelector: 'PRIMARY' | 'ALL_IN_AOE' | 'SELF';
    conditions?: ExpressionString[]; 
    parameters: Record<string, any>;
}

// ==========================================
// 3b. 掷骰系统 (Dice Rolling Pipeline)
// ==========================================
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

// ==========================================
// 4. 日志协议 (Log Protocol)
// ==========================================
export enum LogLevel {
    DEBUG = 0,   // 引擎底层推演（堆排序、事件压入等）
    INFO = 1,    // 常规流程（连接建立、引擎初始化）
    WARN = 2,    // 异常但可恢复（未找到目标等）
    ERROR = 3,   // 引擎错误（沙箱执行崩溃等）
    GAME = 4     // 游戏内核心事件（造成伤害、施加Buff等），这部分用于前端展示和回放
}

export enum LogVisibility {
    DEV = 'DEV',       // 仅开发者可见（控制台及日志文件）
    GM = 'GM',         // 开发者 + GM可见（如怪物隐身时的走位）
    PLAYER = 'PLAYER'  // 所有人可见（战斗记录面板）
}

export interface LogPayload {
    timestamp: number;          // 真实时间戳
    sceneId?: string;           // 场景隔离上下文
    tick?: number;              // 引擎当前 Tick（关键！）
    namespace: string;          // 模块命名空间，如 'Network:Socket'
    level: LogLevel;
    visibility: LogVisibility;
    message: string;            // 人类可读文本
    meta?: any;                 // 附加结构化数据（如 Entity 差分、伤害数值）
}


// ==========================================
// 4. 引擎核心调度 (Engine & Tick Queue)
// ==========================================
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

export interface MovementStepEvent extends TickEvent {
    eventType: 'MOVEMENT_STEP';
    actorId: EntityId;
    currentCoords: Vector3D;    // 本次到达的坐标
    targetCoords: Vector3D;     // 最终终点（方便寻路纠正）
    isLastStep: boolean;        // 是否是最后一步（用于解除移动状态）
}

export interface IEngineInstance {
    engineId: string;
    engineType: 'COMBAT' | 'EXPLORE';
    currentTick: Tick;
    
    mountEntities(entities: Entity[]): void;
    unmountEntities(entityIds: EntityId[]): Entity[];
    receiveIntent(intent: ClientIntent): void;
    
    // 引擎输出事件流，供 Scene 或 SettlementService 订阅
    on(event: 'STATE_MUTATED', listener: (diff: StateMutationPayload) => void): void;
    on(event: 'VISUAL_FX', listener: (fx: VisualEventPayload) => void): void;
    on(event: 'ENTITY_DIED', listener: (entity: Entity) => void): void;
    on(event: 'ACTION_SCHEDULED', listener: (payload: ActionScheduledPayload) => void): void;
}

// ==========================================
// 5. 网络通讯协议 (WebSocket I/O)
// ==========================================
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
        changes: Record<string, any>; // 扁平化状态差分，例 {"resources.current.hp": 10}
    }>;
}

export interface VisualEventPayload {
    tick: Tick;
    events: Array<{
        eventId: string;
        eventType: 'FX_SPAWN' | 'ANIM_PLAY' | 'SOUND_PLAY' | 'UI_FLOATING_TEXT' | 'MUTUAL_KILL' | 'INTERRUPTED';
        sourceId: EntityId;
        targetId?: EntityId;
        targetCoords?: Vector3D;
        fxTemplateId: string; 
        durationMs?: number;
        text?: string;        
    }>;
}

export interface ActionScheduledPayload {
    entityId: EntityId;
    actionId: string;
    actionName: string;
    timeline: {
        start: Tick;
        active: Tick;
        end: Tick;
    };
    tags?: string[];
}
