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
}
export interface ActionEffectPayload {
    type: 'DAMAGE' | 'HEAL' | 'APPLY_BUFF' | 'PUSH' | 'INTERRUPT';
    targetSelector: 'PRIMARY' | 'ALL_IN_AOE' | 'SELF';
    conditions?: ExpressionString[];
    parameters: Record<string, any>;
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