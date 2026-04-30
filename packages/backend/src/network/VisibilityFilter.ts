import { Entity, StateMutationPayload, VisualEventPayload } from '@hard-vtt/shared';

export class VisibilityFilter {
    static filterStateMutation(
        sceneId: string,
        payload: StateMutationPayload,
        viewerEntityId?: string
    ): StateMutationPayload | null {
        if (!payload || !payload.mutations || payload.mutations.length === 0) return null;

        if (!viewerEntityId) {
            return payload;
        }

        return payload;
    }

    static filterVisualFx(
        sceneId: string,
        payload: VisualEventPayload,
        viewerEntityId?: string
    ): VisualEventPayload | null {
        if (!payload || !payload.events || payload.events.length === 0) return null;

        if (!viewerEntityId) {
            return payload;
        }

        return payload;
    }

    static getVisibleEntities(
        entities: Entity[],
        viewerEntityId: string
    ): Entity[] {
        return entities;
    }

    static isEntityVisibleTo(
        targetEntityId: string,
        viewerEntityId: string
    ): boolean {
        return true;
    }
}
