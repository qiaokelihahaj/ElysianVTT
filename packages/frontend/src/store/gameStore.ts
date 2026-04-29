import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Entity, StateMutationPayload } from '@hard-vtt/shared';
import { setNestedProperty } from '../utils/objectUtils';

interface GameState {
    tick: number;
    entities: Record<string, Entity>;
    
    // Actions
    setInitialScene: (entities: Entity[], tick: number) => void;
    applyStateMutation: (payload: StateMutationPayload) => void;
    addEntity: (entity: Entity) => void;
    removeEntity: (entityId: string) => void;
}

export const useGameStore = create<GameState>()(
    immer((set) => ({
        tick: 0,
        entities: {},

        setInitialScene: (entities, tick) => set((state) => {
            state.tick = tick;
            state.entities = {};
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
        }),
    }))
);
