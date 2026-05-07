// ==========================================
// 1. 空间与物理基础 (Spatial & Physics)
// ==========================================
export type PlaneId = string; 

export interface Vector3D {
    x: number;
    y: number;
    z: number; 
}

export interface HexCoord {
    q: number;
    r: number;
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

// AttackTag 用于微闪避系统（micro-evasion）的攻击标签
export type AttackTag = 'HIGH' | 'LOW' | 'LINEAR';

// RulePack data-driven rule definitions
export interface RulePackDefs {
  id: string;
  name: string;
  description?: string;
  attributeDefs: AttributeDef[];
  resourceDefs: ResourceDef[];
  phaseDefs: PhaseDef[];
  defenseModel: DefenseModel;
}

export interface AttributeDef {
  key: string;
  label: string;
  default: number;
  min?: number;
  max?: number;
}

export interface ResourceDef {
  key: string;
  label: string;
  default: number;
  min: number;
  max?: number;
  sustain?: boolean;  // if true, resource must stay >0 during channeling
}

export interface PhaseDef {
  key: 'DELAY' | 'STARTUP' | 'ACTIVE' | 'RECOVERY';
  label: string;
  canInterrupt: boolean;
  canReact: boolean;
}

export interface DefenseModel {
  drFormula?: string;       // e.g., "max(0, armor - penetration)"
  parryFormula?: string;    // e.g., "agi * 2 + 10"
  dodgeFormula?: string;    // e.g., "agi * 1.5 + 5"
  interceptFormula?: string;
}

// ResourcePool 标准资源键: poise (PP/韧性) 和 focus (FP/专注)
// 引擎层不硬编码具体资源语义，由数据模板定义
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
    defenses?: {
        dr: number;        // Damage Reduction (flat)
        parry: number;     // Parry defense value
        dodge: number;     // Dodge defense value
    };
    resources: ResourcePool;
    activeEffects: AppliedEffect[];
    
    // 状态机上下文：记录当前正在执行的长前摇动作或移动
    currentActionContext?: {
        type: 'CASTING' | 'MOVING';
        actionId: string;                              // 当前压入优先队列的事件 ID（每次推新事件时更新）
        actionTemplateId?: string;                     // CASTING 时存储技能模板 ID，供 sustain 检测用
        phase: 'DELAY' | 'STARTUP' | 'ACTIVE' | 'CHANNELING' | 'RECOVERY';
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
    attackTags?: AttackTag[];  // Attack type tags for micro-evasion
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
    rulePackId?: string;
}

export interface ActionEffectPayload {
    type: 'DAMAGE' | 'HEAL' | 'APPLY_BUFF' | 'PUSH' | 'INTERRUPT';
    targetSelector: 'PRIMARY' | 'ALL_IN_AOE' | 'SELF';
    conditions?: ExpressionString[];
    parameters: Record<string, any>;  // Supported keys: amount, formula, ignoreDr (boolean), pushDistance, etc.
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
    phase: 'DELAY' | 'STARTUP' | 'ACTIVE' | 'RECOVERY';
    whiffed?: boolean;
    punishBonus?: number;
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
    intentType: 'CAST_ACTION' | 'MOVE' | 'INTERACT' | 'CANCEL_ACTION' | 'BATCH_CAST'
        | 'DEFEND' | 'DODGE' | 'REACTION' | 'MICRO_EVADE'
        | 'PRIORITY_TOGGLE' | 'GAMBIT_PRESET' | 'HOOK_PRESET';
    clientTick: Tick;
    payload: {
        actionTemplateId?: string;
        targetIds?: EntityId[];
        targetCoords?: Vector3D;
        cancelSubType?: 'DELAY_CANCEL' | 'FORCE_CANCEL';
        batchIntents?: Array<{ actorId: EntityId; actionTemplateId: string; targetIds?: EntityId[] }>;
        defendSubType?: 'PARRY' | 'BLOCK';
        evadeSubType?: 'DUCK' | 'HOP' | 'SLIP';
        reactionTargetId?: EntityId;
        toggleMode?: PlayerPriorityToggle;
        hookPreset?: HookPreset;
        gambitPreset?: { actionTemplateId: string; condition: HookTrigger };
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
        eventType: 'FX_SPAWN' | 'ANIM_PLAY' | 'SOUND_PLAY' | 'UI_FLOATING_TEXT' | 'MUTUAL_KILL' | 'INTERRUPTED' | 'REACTION_AVAILABLE' | 'WHIFF' | 'DECISION_POLL';
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
        start: Tick;                         // 意图发出时刻
        startupEnd: Tick;                    // 前摇结束（第一个 ACTIVE 帧）
        recoveryStart: Tick;                 // 收招开始（最后一个 ACTIVE + 1）
        end: Tick;                           // 收招结束
        pulseTicks?: number[];               // 每个判定帧的具体 Tick（用于帧数条高亮）
    };
    tags?: string[];
}

// ==========================================
// 6. 决策窗口系统 (Decision Window)
// ==========================================

export interface DecisionPollPayload {
  windowId: string;
  windowType: 'ACTIVE' | 'REACTION';
  actorId: EntityId;
  sourceAction?: { actorId: EntityId; actionName: string; startupRemainingTicks: number };
  countdownMs: number;
  availableOptions: DecisionOption[];
  tick: Tick;
}

export interface DecisionOption {
  id: string;
  label: string;
  resourceCost: Record<string, number>;
  canAfford: boolean;
}

export interface DecisionResponsePayload {
  windowId: string;
  chosenOptionId: string | null;
  targetCoords?: Vector3D;
}

export type PlayerPriorityToggle = 'PASS_ALL' | 'TARGET_ONLY' | 'FULL_CONTROL';

export interface HookPreset {
  id: string;
  entityId: EntityId;
  label: string;
  trigger: HookTrigger;
  enabled: boolean;
}

export type HookSource = 'MANUAL' | 'SYSTEM';

// 扩展 HookPreset 以支持系统钩子
export interface UnifiedHook extends HookPreset {
  source: HookSource;
  createdAtTick: Tick;
  ttl: number;        // 生存 tick 数，0=永久
  fired: boolean;
}

export type HookTrigger =
  | { type: 'ENTITY_MOVES_TO'; targetHex: HexCoord }
  | { type: 'ENTITY_ENTERS_AREA'; center: Vector3D; radius: number }
  | { type: 'ACTION_PHASE_DELAY'; sourceEntityId: EntityId; actionTemplateId: string; delayTicks: number }
  | { type: 'ENEMY_CASTS_SPELL'; sourceFilter?: string }
  | { type: 'ENEMY_ENTERS_RANGE'; range: number; originEntityId?: EntityId }
  | { type: 'TICK_REACHED'; targetTick: Tick };

// ==========================================
// 7. Socket 事件常量
// ==========================================
export const SOCKET_EVENTS = {
  DECISION_POLL: 'DECISION_POLL',
  DECISION_RESPONSE: 'DECISION_RESPONSE',
} as const;
