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
    
    // 状态机上下文：记录当前正在执行的长前摇动作
    currentActionContext?: {
        actionId: string;
        phase: 'STARTUP' | 'ACTIVE' | 'RECOVERY';
        resolveTick: number;
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
}

export interface ActionEffectPayload {
    type: 'DAMAGE' | 'HEAL' | 'APPLY_BUFF' | 'PUSH' | 'INTERRUPT';
    targetSelector: 'PRIMARY' | 'ALL_IN_AOE' | 'SELF';
    conditions?: ExpressionString[]; 
    parameters: Record<string, any>;
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
        eventType: 'FX_SPAWN' | 'ANIM_PLAY' | 'SOUND_PLAY' | 'UI_FLOATING_TEXT';
        sourceId: EntityId;
        targetId?: EntityId;
        targetCoords?: Vector3D;
        fxTemplateId: string; 
        durationMs?: number;
        text?: string;        
    }>;
}
