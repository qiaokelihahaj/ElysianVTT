import { ActionExecutionEvent, MovementStepEvent, EntityId, Tick, Vector3D } from '@hard-vtt/shared';
import { generateId } from '../../utils/IdGenerator.js';

export class EventFactory {
    static createActionPhaseEvent(params: {
        actorId: EntityId;
        actionTemplateId: string;
        targetTick: Tick;
        phase: 'DELAY' | 'STARTUP' | 'ACTIVE' | 'RECOVERY';
        targetIds?: EntityId[];
    }): ActionExecutionEvent {
        return {
            eventId: generateId(),
            eventType: 'ACTION_PHASE',
            targetTick: params.targetTick,
            status: 'PENDING',
            actorId: params.actorId,
            targetIds: params.targetIds,
            actionTemplateId: params.actionTemplateId,
            phase: params.phase
        };
    }

    static createMovementStepEvent(params: {
        actorId: EntityId;
        targetTick: Tick;
        currentCoords: Vector3D;
        targetCoords: Vector3D;
        isLastStep: boolean;
    }): MovementStepEvent {
        return {
            eventId: generateId(),
            eventType: 'MOVEMENT_STEP',
            targetTick: params.targetTick,
            status: 'PENDING',
            actorId: params.actorId,
            currentCoords: params.currentCoords,
            targetCoords: params.targetCoords,
            isLastStep: params.isLastStep
        };
    }
}
