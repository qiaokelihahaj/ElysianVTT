import { Entity, ResourcePool, Transform, PhysicsBody, Vector3D } from '@hard-vtt/shared';
import { safeParse } from '../utils/SafeJsonParser.js';

const DEFAULT_RESOURCES: ResourcePool = { current: {}, max: {} };
const DEFAULT_TRANSFORM: Transform = { coords: { x: 0, y: 0, z: 0 }, planeId: '', facing: 0 };
const DEFAULT_PHYSICS: PhysicsBody = { scaleClass: 1, collisionRadius: 0.5, mass: 50, movementModes: ['WALK'] };

function defaultTransformForScene(sceneId: string): Transform {
    return { coords: { x: 0, y: 0, z: 0 }, planeId: sceneId, facing: 0 };
}

export interface CharacterSheetRow {
    id: string;
    name: string;
    type: string;
    resourcesJson: string;
    currentSceneId: string | null;
    transformJson: string;
    physicsJson: string;
}

export interface EntityUpsertInput {
    entityId: string;
    name: string;
    type: string;
    isCasualty: boolean;
    sceneId: string;
    resourcesJson: string;
    transformJson: string;
    physicsJson: string;
}

export class EntityMapper {
    static sheetToEntity(sheet: CharacterSheetRow, sceneId: string): Entity {
        return {
            id: sheet.id,
            templateId: sheet.id,
            type: sheet.type as 'ACTOR' | 'PROP' | 'PROJECTILE',
            resources: safeParse(sheet.resourcesJson, DEFAULT_RESOURCES, `resourcesJson of ${sheet.id}`),
            transform: safeParse(sheet.transformJson, defaultTransformForScene(sceneId), `transformJson of ${sheet.id}`),
            physics: safeParse(sheet.physicsJson, DEFAULT_PHYSICS, `physicsJson of ${sheet.id}`),
            activeEffects: []
        };
    }

    static sheetsToEntities(sheets: CharacterSheetRow[], sceneId: string): Entity[] {
        return sheets.map(sheet => this.sheetToEntity(sheet, sceneId));
    }

    static entityToDbJson(entity: Entity) {
        return {
            resourcesJson: JSON.stringify(entity.resources),
            transformJson: JSON.stringify(entity.transform),
            physicsJson: JSON.stringify(entity.physics)
        };
    }

    static entityToUpsertInput(entity: Entity, sceneId: string, isCasualty: boolean): EntityUpsertInput {
        const json = this.entityToDbJson(entity);
        return {
            entityId: entity.id,
            name: entity.id,
            type: entity.type,
            isCasualty,
            sceneId,
            ...json
        };
    }

    static entitiesToUpsertInputs(entities: Entity[], casualties: string[], sceneId: string): EntityUpsertInput[] {
        const casualtySet = new Set(casualties);
        return entities.map(entity =>
            this.entityToUpsertInput(entity, sceneId, casualtySet.has(entity.id))
        );
    }
}
