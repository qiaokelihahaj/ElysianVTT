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

// ==========================================
// 1b. AOE 与爆炸结算类型 (Phase 3.6)
// ==========================================
export type AoeShape = 'CIRCULAR' | 'CONICAL' | 'LINEAR';

export interface AoeConfig {
  origin: Vector3D;      // 爆炸中心坐标
  facing: number;        // 朝向（锥形/线形需要）
  shape: AoeShape;
  radius: number;        // 圆形半径 / 锥形长度 / 线形长度
  angle?: number;        // 锥形张开角度（默认 90°）
  width?: number;        // 线形宽度（默认 1）
}

export interface DamageFalloffConfig {
  fullDamageRadius: number;    // 全额伤害范围
  falloffStart: number;        // 开始衰减的距离
  minDamagePercent: number;    // 最低伤害百分比 (0-1)
}

// ==========================================
// 1c. 阵型与拦截系统类型 (Phase 3.5)
// ==========================================
export interface InterceptConfig {
  interceptRange: number;          // 拦截范围
  interceptionRating: number;      // 拦截判定值
  coopBonusPerAlly?: number;       // 每多一护卫协同加成
  maxCoopBonus?: number;           // 协同加成上限
  interceptDamageReduction: number; // 成功拦截后伤害减免比例 (0-1)
  failurePenaltyPoise: number;     // 拦截失败韧性质损
  failureKnockback: number;        // 拦截失败击退距离
}

export interface BlockZoneDef {
  id: string;
  center: Vector3D;
  radius: number;
  durationTicks: number;
  triggerDamage: number;           // 进入区域触发伤害
  ownerId: EntityId;
}

export interface EntityFormation {
  interceptConfig?: InterceptConfig;
  bodyBlocking?: boolean;          // 是否能阻挡路径
  blockZones?: BlockZoneDef[];     // 当前维护的封锁区域
}

export interface InterceptionResult {
  success: boolean;
  interceptorId: EntityId;
  interceptValue: number;
  attackValue: number;
  reducedDamage: number;           // 成功拦截后减免的伤害
  penaltyApplied?: string;         // 失败惩罚类型 (STAGGER)
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

// ==========================================
// 部位破坏与重击系统 (Body Part & Crit)
// ==========================================
export type BodyPart = 'HEAD' | 'TORSO' | 'LEFT_ARM' | 'RIGHT_ARM' | 'LEFT_LEG' | 'RIGHT_LEG';

export interface HitLocationEntry {
  part: BodyPart;
  weight: number;          // d100 权重 (1-100 归一化)
  damageCap?: number;      // 单次伤害上限
  critMultiplier?: number; // 部位专属暴击倍率（覆盖默认值）
}

export interface HitResult {
  part: BodyPart;
  isCrit: boolean;
  critMultiplier: number;
  rawDamage: number;       // 暴击加成后的原始伤害
  cappedDamage: number;    // 经过部位上限截断后的最终伤害
  overflowDamage: number;  // 溢出伤害（浪费）
  partDestroyed: boolean;  // 部位是否已破坏（打空）
}

export interface CritConfig {
  range: number;              // d20 暴击阈值 (>= range 即暴击)
  defaultMultiplier: number;  // 默认暴击倍率
}

export interface BodyPartState {
  currentHp: number;
  maxHp: number;
  destroyed: boolean;
}

// ==========================================
// 2b. 空间战术 (Spatial Tactics)
// ==========================================
export interface ReachConfig {
  maxReach: number;          // 武器最大触及距离
  minReach?: number;         // 武器最短有效距离（长武器死角）
  deadZoneRatio?: number;    // 死角区比例（默认 0.7 = 最后 30%）
}

export interface FacingCost {
  turnRate: number;          // 每 Tick 可转角度（默认 45°）
  baseTurnTicks: number;     // 基础转身耗时
}

export interface SprintMomentum {
  consecutiveMoves: number;  // 连续移动次数
  lastMoveTick: number;      // 上次移动发生的 Tick
  tickReductionPerStep: number; // 每步递减比例（默认 0.1）
  minTickCost: number;       // 最小 Tick 消耗（默认 1）
  maxReduction: number;      // 最大减幅比例（默认 0.5）
  breakThreshold: number;    // 中断阈值（超时重置，默认 20）
}

// ==========================================
// 2c. 掩体系统与战术姿态 (Cover & Stance)
// ==========================================
export type CoverType = 'NONE' | 'HALF' | 'FULL';

export interface CoverDef {
  id: string;
  coverType: CoverType;
  coverDr: number;              // 掩体提供的 DR
  coverThreshold: number;       // d20 命中掩体阈值
  height: number;               // 掩体 Z 高度
  maxHp?: number;               // 掩体耐久（可破坏）
  blastShadowRadius?: number;   // 爆风阴影半径
}

export interface CoverState {
  coverDefId: string;
  coverType: CoverType;
  coverDr: number;
  coverThreshold: number;
  facing: number;               // 掩体朝向（保护方向）
  height: number;
}

export type TacticalStance = 'ADS' | 'BLIND_FIRE' | 'NONE';

export interface StanceConfig {
  stance: TacticalStance;
  accuracyModifier: number;     // ADS: +2, BLIND_FIRE: -4
  exposedBodyParts: BodyPart[]; // ADS: [HEAD, LEFT_ARM, RIGHT_ARM]
  shotDeviation: number;        // 弹着点偏移半径
  switchCostTicks: number;      // 切换姿态消耗的 Tick
}

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
    /** Optional rule-defined behavior carried by a stateful effect. */
    metadata?: AppliedEffectMetadata;
}

export interface AppliedEffectMetadata {
    /** Multiplier applied to the next incoming DAMAGE effect. */
    damageMultiplier?: number;
    /** Negates the next incoming DAMAGE effect when true. */
    negateDamage?: boolean;
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
    tags?: string[];                          // Phase 3.6: 标签（FACTION_A, AOE_IMMUNE 等）
    bodyParts?: Record<string, BodyPartState>;  // 部位破坏状态（仅要害优先路线使用）
    coverState?: CoverState;                    // Phase 3.3: 掩体状态
    currentStance?: TacticalStance;             // Phase 3.3: 战术姿态
    equippedWeaponId?: string;
    droppedWeaponIds?: string[];
    bodyBlocking?: boolean;                    // Phase 3.5: 能否阻挡路径
    formationContext?: {                        // Phase 3.5: 阵型上下文
        interceptConfig?: InterceptConfig;
        blockZones?: BlockZoneDef[];
    };

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
        consecutiveMoves?: number;                     // Phase 3.4: 冲刺连击计数
        lastMoveTick?: number;                         // Phase 3.4: 上次移动 Tick
        pulseTickHistory?: number[];                   // Phase 5.1: 已执行脉冲的实际 Tick（增量时间轴修正）
        timelineStart?: number;                        // Phase 5.1: 动作开始 Tick（用于时间轴更新）
        /**
         * Event-driven ACTIVE window for the current strike/pulse.  The
         * interval is half-open: [activeWindowStart, activeWindowEnd).
         * `activeHitTargetIds` is the per-strike ledger; a target is consumed
         * once it is checked while in range, even if a guard reduces the
         * resulting damage to zero.
         */
        activeWindowStart?: Tick;
        activeWindowEnd?: Tick;
        activeStrikeIndex?: number;
        activeStrikeCount?: number;
        activeTargetIds?: EntityId[];
        activeHitTargetIds?: EntityId[];
        /** Preserved declaration priority for position-triggered rechecks. */
        priorityOverride?: number;
        /** Current channel pulse committed, but no subsequent pulse allowed. */
        stopAfterActiveWindow?: boolean;
    };
}

// ==========================================
// 3. 数据驱动模板 (Data-Driven Rules Definition)
// 后端负责解析以下结构，不负责写死具体业务
// ==========================================
export type ExpressionString = string;

/** Optional rule-defined spatial behavior committed at the action's ACTIVE boundary. */
export interface SpatialActionConfig {
    stance?: TacticalStance;
    rotationDelta?: number;
    reach?: { minReach?: number; deadZoneRatio?: number };
    backstabMultiplier?: number;
    weaponOperation?: { type: 'EQUIP' | 'DROP'; weaponId?: string };
    requiredWeaponId?: string;
    guard?: EntityFormation;
    blockZone?: { radius: number; durationTicks: number; triggerDamage: number };
    evade?: 'DUCK' | 'HOP' | 'SLIP';
}

export interface ActionTemplate {
    id: string;
    label?: string;
    description?: string;
    /** Explicit picker semantics for cell-targeted attacks and self actions. */
    targetKind?: 'entity' | 'cell' | 'none';
    spatial?: SpatialActionConfig;
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
    /**
     * Duration of one event-driven ACTIVE window.  The end boundary is
     * exclusive and entering RECOVERY never applies the effect.
     */
    activeWindowTicks?: number;
    /**
     * Optional finite multi-strike sequence.  The first strike uses the
     * action's normal (large) startupTicks plus this small startup; every
     * following strike uses this small startup between ACTIVE windows.  This
     * is deliberately separate from channelOptions because it has no
     * sustain/pulse-resource semantics unless a RulePack adds them elsewhere.
     */
    strikeSequence?: {
        count: number;
        startupTicks: number;
        activeWindowTicks?: number;
    };
    rulePackId?: string;
    launchProjectile?: {              // 实体弹道发射配置（Phase 3.2）
        trajectoryType: 'LINEAR' | 'PARABOLIC';
        speed: number;                // 每 Tick 推进速度
        launchHeight?: number;       // Optional firing height above actor/target ground coordinates
        maxHeight?: number;           // 抛物线最高点 Z
        minRange?: number;            // 最小射程盲区
        collisionDieSize?: number;    // 碰撞判定面数（默认 d20）
        dieThreshold?: number;        // 命中阈值（默认 10）
        ticksPerStep: number;         // 每步 Tick 间隔
    };
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
    targetCoords?: Vector3D;
    actionTemplateId: string;
    phase: 'DELAY' | 'STARTUP' | 'ACTIVE' | 'RECOVERY';
    /** Optional GM override; otherwise RulePack priorityExpr is evaluated. */
    priorityOverride?: number;
    causationId?: string;
    whiffed?: boolean;
    punishBonus?: number;
    /** Event-driven ACTIVE window metadata; optional for legacy events. */
    activeWindowStart?: Tick;
    activeWindowEnd?: Tick;
    strikeIndex?: number;
    strikeCount?: number;
    /** Marks a boundary event that closes an ACTIVE window without an effect. */
    activeWindowEndEvent?: boolean;
    /** Synthetic event raised by an entity position change. */
    positionTriggered?: boolean;
}

export interface MovementStepEvent extends TickEvent {
    eventType: 'MOVEMENT_STEP';
    actorId: EntityId;
    currentCoords: Vector3D;    // 本次到达的坐标
    targetCoords: Vector3D;     // 最终终点（方便寻路纠正）
    isLastStep: boolean;        // 是否是最后一步（用于解除移动状态）
}

// ==========================================
// 3c. 弹道系统 (Trajectory & Projectile)
// ==========================================
export type TrajectoryType = 'LINEAR' | 'PARABOLIC';

export interface ProjectileAdvanceEvent extends TickEvent {
    eventType: 'PROJECTILE_ADVANCE';
    projectileId: EntityId;
    waypointIndex: number;
    fromCoords: Vector3D;
    toCoords: Vector3D;
    isLastStep: boolean;
}

export interface CollisionRoll {
    d20: number;
    threshold: number;       // 尺度级别阈值（碰撞面数）
    isBlind: boolean;        // true = 非直瞄（碰撞掷骰）
    bodyPart?: BodyPart;     // Chaotic Impact 随机部位
}

export interface CollisionResult {
    hit: boolean;
    targetId?: EntityId;
    collisionRoll?: CollisionRoll;
    impactCoords: Vector3D;
}

export interface IEngineInstance {
    engineId: string;
    engineType: 'COMBAT' | 'EXPLORE';
    currentTick: Tick;

    mountEntities(entities: Entity[]): void;
    unmountEntities(entityIds: EntityId[]): Entity[];
    receiveIntent(intent: ClientIntent): void;
    removeAllListeners(): void;

    // SCENE_SYNC 兼容方法
    getAllEntities(): Entity[];
    getScheduledActions?(): ActionScheduledPayload[];
    getActiveHookPresets?(): { id: string; entityId: string; label: string; trigger: HookTrigger; enabled: boolean }[];
    getActiveDecisionPolls?(): DecisionPollPayload[];
    getPendingDecisionCount?(): number;
    getCombatResult?(): CombatSummary | null;

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
        | 'PRIORITY_TOGGLE' | 'GAMBIT_PRESET' | 'HOOK_PRESET'
        | 'CHANGE_STANCE' | 'ROTATE';
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
        stance?: TacticalStance;      // CHANGE_STANCE 时指定目标姿态
        rotationDelta?: number;        // ROTATE 时的朝向增量（角度）
        priority?: number;             // Coordinated demo GM ordering override
        effectiveTick?: Tick;          // Coordinated demo active boundary override
        causationId?: string;
        /** Coordinator plan id, preserved through the engine timeline. */
        actionId?: string;
    };
}

/** 已完成持久化结算的战斗结果通知。 */
export interface CombatSummary {
    sceneId: string;
    tick: Tick;
    survivors: EntityId[];
    casualties: EntityId[];
}

export interface CombatEndPayload extends CombatSummary {
    entities: Entity[];
}

export interface StateMutationPayload {
    tick: Tick;
    mutations: Array<{
        entityId: EntityId;
        changes: Record<string, any>; // 扁平化状态差分，例 {"resources.current.hp": 10}
    }>;
    /** 动作时间轴增量修正 — 每个脉冲结算后累积，随 STATE_MUTATED 统一广播 */
    actionPatches?: ActionTimelinePatch[];
}

/** A contiguous, authoritative phase interval on the Tick timeline. */
export type ActionTimelineSegmentPhase =
    | 'STARTUP'
    | 'SMALL_STARTUP'
    | 'ACTIVE'
    | 'CHANNELING'
    | 'MOVING'
    | 'RECOVERY';

export interface ActionTimelineSegment {
    phase: ActionTimelineSegmentPhase;
    start: Tick;
    end: Tick;
    /** Strike/pulse index for ACTIVE and its immediately preceding startup. */
    strikeIndex?: number;
}

export interface ActionTimeline {
    start: Tick;
    startupEnd: Tick;
    recoveryStart: Tick;
    end: Tick;
    pulseTicks?: Tick[];
    /** Every strike/pulse ACTIVE interval, half-open [start,end). */
    activeWindows?: Array<{ start: Tick; end: Tick; strikeIndex: number }>;
    /**
     * Explicit phase intervals. Optional for old payloads; when present this
     * is authoritative and distinguishes initial and per-strike startup.
     */
    phaseSegments?: ActionTimelineSegment[];
}

/** 动作时间轴增量补丁 — 前端按 entityId 替换对应动作的 timeline */
export interface ActionTimelinePatch {
    entityId: EntityId;
    actionId: string;
    actionName: string;
    timeline: ActionTimeline;
}

export interface VisualEventPayload {
    tick: Tick;
    events: Array<{
        eventId: string;
        eventType: 'FX_SPAWN' | 'ANIM_PLAY' | 'SOUND_PLAY' | 'UI_FLOATING_TEXT' | 'MUTUAL_KILL' | 'INTERRUPTED' | 'REACTION_AVAILABLE' | 'WHIFF' | 'DECISION_POLL' | 'COLLISION' | 'PROJECTILE_FLY';
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
    /** Runtime event/plan id; optional for legacy producers. */
    executionId?: string;
    targetIds?: EntityId[];
    targetCoords?: Vector3D;
    priority?: number;
    effectiveTick?: Tick;
    causationId?: string;
    timeline: ActionTimeline;
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
  /** Coordinated demo metadata; optional for legacy Hook consumers. */
  version?: number;
  controlEpoch?: number;
  causationId?: string;
  sourceActionId?: string;
  joinDeadlineAt?: number;
  selectDeadlineAt?: number;
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

// ==========================================
// 8. 地图与瓦片系统 (Map & Tile System — Phase 4.1c)
// ==========================================

export type TerrainType = 'GROUND' | 'WALL' | 'WATER' | 'OBSTACLE' | 'DOOR';

export interface TileDef {
  hex: HexCoord;
  terrain: TerrainType;
  height?: number;
  movementCost?: number;
}

export interface MapData {
  id: string;
  name: string;
  tiles: TileDef[];
  spawnPoints: Record<string, Vector3D>;
  width: number;
  height: number;
  metadata?: Record<string, any>;
}

// ==========================================
// 9. 区域触发系统 (Zone Trigger — Phase 4.3)
// ==========================================

export type ZoneTriggerType = 'COMBAT' | 'DIALOG' | 'TRAP';

export interface ZoneTriggerDef {
  id: string;
  center: Vector3D;
  radius: number;
  triggerType: ZoneTriggerType;
  cooldownTicks: number;
  oneShot: boolean;
  active: boolean;
  payload?: Record<string, any>;  // COMBAT: { encounterId }, DIALOG: { dialogId }, TRAP: { skillCheck, damage }
  lastTriggeredTick?: number;
}

// ==========================================
// Phase 4.1b: 探索引擎类型 (Explore Engine)
// ==========================================

export interface ExploreEntity extends Entity {
  /** Hexes this entity has explored (persistent map knowledge) */
  exploredHexes: HexCoord[];
  /** Maximum sight range in hexes */
  sightRange: number;
  /** Movement points available per exploration turn */
  movementPoints: number;
  /** Whether this entity can reveal fog of war */
  revealsFog: boolean;
}

export interface MovementResult {
  success: boolean;
  entityId: EntityId;
  fromHex: HexCoord;
  toHex: HexCoord;
  path: HexCoord[];
  cost: number;
  remainingMovement: number;
  triggeredHooks: string[];
  zoneEntries: string[];
  reason?: string;  // failure reason if !success
}

/**
 * Exploration intent: what an entity wants to do in explore mode.
 * Unlike combat, most explore actions resolve immediately (no tick timeline).
 */
export interface ExploreIntent {
  actorId: EntityId;
  intentType: 'MOVE' | 'INTERACT' | 'EXAMINE' | 'USE_SKILL' | 'TOGGLE_FOG' | 'ROTATE';
  /** Target hex for MOVE / EXAMINE */
  targetHex?: HexCoord;
  /** Target entity for INTERACT / USE_SKILL */
  targetEntityId?: EntityId;
  /** Skill check parameters for USE_SKILL */
  skillCheck?: {
    skillName: string;
    difficulty: number;
    attributeKey?: string;
    proficiencyBonus?: number;
  };
  /** Movement path (for multi-step moves) */
  path?: HexCoord[];
}

export interface SkillCheckResult {
  success: boolean;
  criticalSuccess: boolean;
  criticalFailure: boolean;
  roll: number;
  threshold: number;
  skillName: string;
  marginOfSuccess: number;
}

// ==========================================
// Phase 4.2: 战争迷雾系统类型 (Fog of War)
// ==========================================

/** Fog of war state for a single hex */
export type FogState = 'UNEXPLORED' | 'EXPLORED' | 'VISIBLE';

export interface FogCellState {
  hex: HexCoord;
  state: FogState;
  /** Tick when this hex was last seen (for auto-reveal decay) */
  lastSeenTick: number;
}

export interface FogOfWarState {
  /** Serialized fog map keyed by hex string "q,r" */
  cells: Record<string, FogCellState>;
  /** Current visible hex set for quick lookup */
  visibleHexes: HexCoord[];
}

export interface FogUpdatePayload {
  entityId: EntityId;
  /** Newly visible hexes (EXPLORED → VISIBLE) */
  revealedHexes: HexCoord[];
  /** Newly obscured hexes (VISIBLE → EXPLORED) */
  obscuredHexes: HexCoord[];
  /** Newly explored hexes (UNEXPLORED → EXPLORED) */
  exploredHexes: HexCoord[];
}

/** Terrain properties that affect visibility */
export interface TerrainVisibility {
  /** Whether this terrain type blocks line of sight entirely */
  blocksVision: boolean;
  /** Whether this terrain partially obscures (half cover for vision) */
  obscuresVision: boolean;
  /** Height advantage multiplier (>1 means higher ground sees farther) */
  heightMultiplier: number;
}

// ==========================================
// 10. 首个可玩遭遇协议 (Coordinated Encounter Demo)
// ==========================================

/**
 * Faction is deliberately independent from the viewer role.  The aliases
 * PLAYER/ENEMY are accepted while old callers migrate to PLAYERS/ENEMIES.
 */
export type EncounterFaction = string;

/** Faction membership, controller identity and diplomatic relations are independent. */
export interface EncounterSide {
  kind: 'FACTION' | 'ENTITY';
  id: string;
}
export type EncounterRelation = 'ALLY' | 'NEUTRAL' | 'HOSTILE';
/** Relations are symmetric. Omitted pairs are unknown, not automatically hostile. */
export interface EncounterSideRelation {
  a: EncounterSide;
  b: EncounterSide;
  relation: EncounterRelation;
}
export type EncounterVictoryCondition = 'LAST_SIDE' | 'MANUAL';
export type EncounterRole = 'GM' | 'PL' | 'OB';
export type EncounterStatus =
  | 'LOBBY'
  | 'ACTIVE'
  | 'PAUSED'
  | 'VICTORY'
  | 'DEFEAT'
  | 'MUTUAL_DEFEAT'
  | 'ENDED';

export type EncounterActionPhase =
  | 'DECLARED'
  | 'DELAY'
  | 'STARTUP'
  | 'ACTIVE'
  | 'CHANNELING'
  | 'RECOVERY'
  | 'CANCELLED'
  | 'RESOLVED';

export type EncounterDecisionStage = 'REACTION_JOIN' | 'REACTION_SELECT' | 'GM_REVIEW';

/**
 * Small, data-driven hint used by the encounter map overlay.  The rule
 * engine still owns the actual effects; this only describes the visible
 * relationship for a scheduled action.
 */
export type EncounterActionRelation = 'ATTACK' | 'HEAL' | 'SUPPORT';

export interface EncounterPrincipal {
  userId: string;
  role: EncounterRole;
  socketId: string;
}

export interface EncounterControl {
  entityId: EntityId;
  userId?: string;
  role: EncounterRole;
  /** Incremented whenever GM takes or releases this entity. */
  controlEpoch: number;
  connectedSocketIds: string[];
  takenOverByGm: boolean;
}

export interface EncounterEntity extends Entity {
  /** null explicitly means independent, even if legacy faction tags remain. */
  faction?: EncounterFaction | null;
  displayName?: string;
  /** Optional stable template key used by the GM spawn palette. */
  encounterTemplateId?: string;
  /** Public entities are visible to players; GM entities are server-filtered. */
  visibility?: 'PUBLIC' | 'GM';
}

export interface EncounterActionPlan {
  actionId: string;
  actorId: EntityId;
  actionTemplateId: string;
  targetIds: EntityId[];
  targetCoords?: Vector3D;
  phase: EncounterActionPhase;
  declaredTick: Tick;
  effectiveTick?: Tick;
  priority: number;
  /** Resources paid when the plan was accepted. Never pay twice on edit. */
  paidResources: Record<string, number>;
  decisionVersion: number;
  controlEpoch: number;
  causationId: string;
  /** Optional visual relationship derived from the RulePack effects. */
  relation?: EncounterActionRelation;
  /** True only for an effect whose RulePack selector targets the actor itself. */
  selfTarget?: boolean;
  /** Server-derived final arrival Tick for a movement action. */
  arrivalTick?: Tick;
  /**
   * Authoritative phase boundaries emitted by the combat engine.  This is
   * optional because declaration-barrier plans and older servers do not have
   * a scheduled timeline yet.  Consumers must not reconstruct durations from
   * the action template when this field is absent.
   */
  timeline?: ActionScheduledPayload['timeline'];
  cancelled?: boolean;
  source?: 'PLAYER' | 'GM' | 'SYSTEM';
}

export interface EncounterReadySlot {
  entityId: EntityId;
  faction?: EncounterFaction | null;
  controllerUserId?: string;
  connected: boolean;
  ready: boolean;
  waiting: boolean;
  /** Waiting defers this entity's next main action by this many ticks. */
  readyAtTick?: Tick;
  blockedReason?: string;
  controlEpoch: number;
}

export interface EncounterPlanState {
  windowTick: Tick;
  slots: EncounterReadySlot[];
  committed: boolean;
  /** All accepted plans for the current/next barrier. */
  actions: EncounterActionPlan[];
  barrierVersion: number;
}

export interface EncounterDecisionWindow {
  windowId: string;
  stage: EncounterDecisionStage;
  sourceActionId: string;
  sourceEntityId: EntityId;
  reactorEntityId: EntityId;
  causationId: string;
  openedTick: Tick;
  joinDeadlineAt: number;
  selectDeadlineAt?: number;
  joinRemainingMs: number;
  selectRemainingMs?: number;
  /** Window version changes when its source plan/control is edited. */
  version: number;
  controlEpoch: number;
  availableOptions: DecisionOption[];
  respondedSocketIds: string[];
  resolved: boolean;
}

export interface EncounterCausation {
  causationId: string;
  parentCausationId?: string;
  sourceActionId?: string;
  sourceEntityId?: EntityId;
  reactionActionId?: string;
  createdTick: Tick;
  /** Prevent a single entity from reacting more than once in one chain. */
  reactedEntityIds: EntityId[];
}

export interface EncounterLogEntry {
  id: string;
  tick: Tick;
  message: string;
  level?: LogLevel;
  visibility?: LogVisibility;
  actorId?: EntityId;
  actionId?: string;
  causationId?: string;
  meta?: Record<string, unknown>;
}

export interface EncounterResult {
  status: Exclude<EncounterStatus, 'LOBBY' | 'ACTIVE' | 'PAUSED'>;
  winningFaction?: EncounterFaction;
  /** Supports independent entities and several allied winners. */
  winningSides?: EncounterSide[];
  survivors: EntityId[];
  casualties: EntityId[];
  resolvedTick: Tick;
  endedBy: 'RULES' | 'GM';
  reason?: string;
}

export interface EncounterSnapshot {
  encounterId: string;
  revision: number;
  tick: Tick;
  status: EncounterStatus;
  paused: boolean;
  entities: EncounterEntity[];
  relations?: EncounterSideRelation[];
  victoryCondition?: EncounterVictoryCondition;
  actions: EncounterActionPlan[];
  plan: EncounterPlanState;
  decisions: EncounterDecisionWindow[];
  controls: EncounterControl[];
  logs: EncounterLogEntry[];
  result?: EncounterResult;
  /** GM has requested a pause immediately before the next event Tick. */
  tickBreakPending?: boolean;
  /** Remaining pause/decision deadlines are server-derived values. */
  serverTime?: number;
}

export type EncounterCommandType =
  | 'START'
  | 'WAIT'
  | 'ACTION'
  | 'RECOVER'
  | 'REACTION_JOIN'
  | 'REACTION_SELECT'
  | 'REACTION_PASS'
  | 'GM_PAUSE'
  | 'GM_RESUME'
  | 'GM_STEP'
  | 'GM_TICK_BREAK'
  | 'GM_TAKEOVER'
  | 'GM_RELEASE'
  | 'GM_ASSIGN_ENTITY'
  | 'GM_EDIT_ACTION'
  | 'CANCEL_ACTION'
  | 'GM_CANCEL_ACTION'
  | 'GM_ADJUST_ENTITY'
  | 'GM_SPAWN'
  | 'GM_REMOVE'
  | 'GM_SET_FACTION'
  | 'GM_SET_RELATION'
  | 'GM_SET_VICTORY_CONDITION'
  | 'GM_CORRECT'
  | 'GM_PASS'
  | 'GM_PASS_ALL'
  | 'GM_END'
  | 'GM_RESTART';

export interface EncounterCommandBase<T extends EncounterCommandType = EncounterCommandType> {
  requestId: string;
  expectedRevision?: number;
  /** Barrier-local optimistic concurrency token for main actions. */
  expectedBarrierVersion?: number;
  /** Decision-window-local optimistic concurrency token. */
  expectedDecisionVersion?: number;
  /** Per-entity control epoch. GM commands may omit it. */
  controlEpoch?: number;
  type: T;
  payload: Record<string, unknown>;
}

export type EncounterCommand =
  | (EncounterCommandBase<'START'> & { payload: { entityId?: EntityId } })
  | (EncounterCommandBase<'WAIT'> & { payload: { entityId: EntityId } })
  | (EncounterCommandBase<'ACTION'> & { payload: {
      entityId: EntityId;
      actionTemplateId: string;
      targetIds?: EntityId[];
      targetCoords?: Vector3D;
      priority?: number;
      effectiveTick?: Tick;
    } })
  | (EncounterCommandBase<'RECOVER'> & { payload: { entityId: EntityId; resource?: string } })
  | (EncounterCommandBase<'REACTION_JOIN'> & { payload: { windowId: string } })
  | (EncounterCommandBase<'REACTION_SELECT'> & { payload: {
      windowId: string;
      optionId: string | null;
      targetIds?: EntityId[];
      targetCoords?: Vector3D;
    } })
  | (EncounterCommandBase<'REACTION_PASS'> & { payload: { windowId: string } })
  | (EncounterCommandBase<'GM_PAUSE'> & { payload: { reason?: string } })
  | (EncounterCommandBase<'GM_RESUME'> & { payload: Record<string, never> })
  | (EncounterCommandBase<'GM_STEP' | 'GM_TICK_BREAK'> & { payload: { count?: number } })
  | (EncounterCommandBase<'GM_TAKEOVER' | 'GM_RELEASE'> & { payload: { entityId: EntityId } })
  | (EncounterCommandBase<'GM_ASSIGN_ENTITY'> & { payload: {
      entityId: EntityId;
      userId: string;
    } })
  | (EncounterCommandBase<'GM_EDIT_ACTION'> & { payload: {
      actionId: string;
      reason?: string;
      actionTemplateId?: string;
      targetIds?: EntityId[];
      targetCoords?: Vector3D;
      effectiveTick?: Tick;
      priority?: number;
      cancel?: boolean;
    } })
  | (EncounterCommandBase<'CANCEL_ACTION' | 'GM_CANCEL_ACTION'> & { payload: { actionId: string; reason?: string } })
  | (EncounterCommandBase<'GM_ADJUST_ENTITY'> & { payload: {
      entityId: EntityId;
      reason: string;
      position?: Vector3D;
      facing?: number;
      resources?: Record<string, number>;
      activeEffects?: AppliedEffect[];
      visibility?: 'PUBLIC' | 'GM';
    } })
  | (EncounterCommandBase<'GM_SPAWN'> & { payload: {
      templateId: string;
      faction?: EncounterFaction | null;
      position?: Vector3D;
      entityId?: EntityId;
    } })
  | (EncounterCommandBase<'GM_REMOVE'> & { payload: { entityId: EntityId } })
  | (EncounterCommandBase<'GM_SET_FACTION'> & { payload: { entityId: EntityId; faction: EncounterFaction | null } })
  | (EncounterCommandBase<'GM_SET_RELATION'> & { payload: { a: EncounterSide; b: EncounterSide; relation: EncounterRelation | null } })
  | (EncounterCommandBase<'GM_SET_VICTORY_CONDITION'> & { payload: { condition: EncounterVictoryCondition } })
  | (EncounterCommandBase<'GM_CORRECT'> & { payload: {
      entityId: EntityId;
      reason: string;
      changes: Record<string, unknown>;
      actionId?: string;
    } })
  | (EncounterCommandBase<'GM_PASS'> & { payload: { windowId: string } })
  | (EncounterCommandBase<'GM_PASS_ALL'> & { payload: Record<string, never> })
  | (EncounterCommandBase<'GM_END'> & { payload: { reason?: string; winningFaction?: EncounterFaction; winningSides?: EncounterSide[] } })
  | (EncounterCommandBase<'GM_RESTART'> & { payload: Record<string, never> });

export interface CommandAccepted {
  ok: true;
  success: true;
  requestId: string;
  revision: number;
  snapshot: EncounterSnapshot;
  message?: string;
}

export interface CommandRejected {
  ok: false;
  success: false;
  requestId: string;
  revision: number;
  code: string;
  reason: string;
  snapshot: EncounterSnapshot;
}

export type EncounterCommandResult = CommandAccepted | CommandRejected;
/** Short alias used by server and client adapters. */
export type CommandResult = EncounterCommandResult;

export interface GMCorrectionRecord {
  id: string;
  gmUserId: string;
  reason: string;
  tick: Tick;
  entityId?: EntityId;
  actionId?: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  causationId?: string;
}

export interface EncounterIncrement {
  encounterId: string;
  revision: number;
  tick: Tick;
  type: 'STATE' | 'PLAN' | 'DECISION' | 'LOG' | 'RESULT';
  payload: Partial<EncounterSnapshot>;
}

export interface EncounterRulePack {
  id: string;
  name: string;
  actionTemplates: ActionTemplate[];
  actorTemplates: Record<string, Omit<EncounterEntity, 'id'>>;
  map: MapData;
  reactionJoinMs: number;
  reactionSelectMs: number;
  priorityTolerance: 0;
  relations?: EncounterSideRelation[];
  victoryCondition?: EncounterVictoryCondition;
  scenario?: EncounterScenario;
}

/** Public scenario instructions, without hidden entities or server credentials. */
export interface EncounterScenario {
  id: string;
  title: string;
  summary: string;
  objectives: Array<{ id: string; title: string; description: string; actionIds: string[] }>;
}

// Socket payloads live in a separate file to keep the core contract readable.
export * from './demoNetwork.js';
export * from './encounterFactions.js';

export { hexOffsetToAxial, hexAxialToOffset, hexOffsetToPixel, pixelToHexOffset } from './hexGrid.js';
