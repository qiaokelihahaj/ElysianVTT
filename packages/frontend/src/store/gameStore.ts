import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Entity, StateMutationPayload, Vector3D, ActionScheduledPayload } from '@hard-vtt/shared';
import { setNestedProperty } from '../utils/objectUtils';

export interface UiState {
    mode: 'IDLE' | 'SELECT_MOVE_TARGET' | 'SELECT_ACTION_TARGET';
    pendingMoveCoords: Vector3D | null;
    activeActionId: string | null;
}

interface GameState {
    tick: number;
    entities: Record<string, Entity>;
    selectedEntityId: string | null;
    uiState: UiState;
    movementTargets: Record<string, Vector3D>;
    scheduledActions: ActionScheduledPayload[];   // 时间轴渲染数据
    
    // Actions
    setInitialScene: (entities: Entity[], tick: number) => void;
    applyStateMutation: (payload: StateMutationPayload) => void;
    addEntity: (entity: Entity) => void;
    removeEntity: (entityId: string) => void;
    setSelectedEntityId: (entityId: string | null) => void;
    
    // UI Actions
    setUiMode: (mode: UiState['mode']) => void;
    setPendingMoveCoords: (coords: Vector3D | null) => void;
    setActiveActionId: (actionId: string | null) => void;
    resetUiState: () => void;

    // Movement Actions
    setMovementTarget: (entityId: string, coords: Vector3D) => void;
    clearMovementTarget: (entityId: string) => void;

    // Timeline Actions
    scheduleAction: (payload: ActionScheduledPayload) => void;
    clearExpiredActions: (currentTick: number) => void;
}

export const useGameStore = create<GameState>()(
    immer((set) => ({
            tick: 0,
            entities: {},
            selectedEntityId: null,
            uiState: {
                mode: 'IDLE',
                pendingMoveCoords: null,
                activeActionId: null
            },
            movementTargets: {},
            scheduledActions: [],

        setInitialScene: (entities, tick) => set((state) => {
            state.tick = tick;
            state.entities = {};
            state.selectedEntityId = null;
            entities.forEach((entity) => {
                state.entities[entity.id] = entity;
            });
        }),

        applyStateMutation: (payload: StateMutationPayload) => set((state) => {
            state.tick = payload.tick;
            
            payload.mutations.forEach(mutation => {
                const entity = state.entities[mutation.entityId];
                if (!entity) {
                    console.warn(`[Store] Received mutation for unknown entity: ${mutation.entityId}`);
                    return;
                }

                Object.entries(mutation.changes).forEach(([path, value]) => {
                    setNestedProperty(entity, path, value);
                });
            });
        }),

        addEntity: (entity) => set((state) => {
            state.entities[entity.id] = entity;
        }),

        removeEntity: (entityId) => set((state) => {
            delete state.entities[entityId];
            if (state.selectedEntityId === entityId) {
                state.selectedEntityId = null;
            }
        }),

        setSelectedEntityId: (entityId) => set((state) => {
            state.selectedEntityId = entityId;
        }),

        setUiMode: (mode) => set((state) => { 
            state.uiState.mode = mode; 
            if (mode === 'IDLE') {
                state.uiState.pendingMoveCoords = null;
                state.uiState.activeActionId = null;
            }
        }),
        setPendingMoveCoords: (coords) => set((state) => { state.uiState.pendingMoveCoords = coords; }),
        setActiveActionId: (actionId) => set((state) => { state.uiState.activeActionId = actionId; }),
            resetUiState: () => set((state) => {
                state.uiState.mode = 'IDLE';
                state.uiState.pendingMoveCoords = null;
                state.uiState.activeActionId = null;
            }),
            setMovementTarget: (entityId, coords) => set((state) => {
                state.movementTargets[entityId] = coords;
            }),
            clearMovementTarget: (entityId) => set((state) => {
                delete state.movementTargets[entityId];
            }),
            scheduleAction: (payload) => set((state) => {
                state.scheduledActions.push(payload);
            }),
            clearExpiredActions: (currentTick) => set((state) => {
                state.scheduledActions = state.scheduledActions.filter(
                    a => a.timeline.end > currentTick
                );
            }),
        }))
);
