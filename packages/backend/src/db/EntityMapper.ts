import type { Entity, ResourcePool, Transform, PhysicsBody } from '@hard-vtt/shared';
import { safeParse } from '../utils/SafeJsonParser.js';

const DEFAULT_PHYSICS: PhysicsBody = { scaleClass: 1, collisionRadius: 0.5, mass: 50, movementModes: ['WALK'] };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isResourcePool(value: unknown): value is ResourcePool {
    return isRecord(value) && isRecord(value.current) && isRecord(value.max)
        && Object.values(value.current).every(isFiniteNumber) && Object.values(value.max).every(isFiniteNumber);
}

function isTransform(value: unknown): value is Transform {
    return isRecord(value) && isRecord(value.coords)
        && isFiniteNumber(value.coords.x) && isFiniteNumber(value.coords.y) && isFiniteNumber(value.coords.z)
        && typeof value.planeId === 'string' && isFiniteNumber(value.facing);
}

function isPhysicsBody(value: unknown): value is PhysicsBody {
    return isRecord(value) && isFiniteNumber(value.scaleClass) && value.scaleClass >= 0
        && isFiniteNumber(value.collisionRadius) && value.collisionRadius >= 0
        && isFiniteNumber(value.mass) && value.mass >= 0
        && Array.isArray(value.movementModes) && value.movementModes.every(mode => typeof mode === 'string');
}

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
            resources: safeParse(sheet.resourcesJson, { current: {}, max: {} }, `resourcesJson of ${sheet.id}`, isResourcePool),
            transform: safeParse(sheet.transformJson, defaultTransformForScene(sceneId), `transformJson of ${sheet.id}`, isTransform),
            physics: safeParse(sheet.physicsJson, structuredClone(DEFAULT_PHYSICS), `physicsJson of ${sheet.id}`, isPhysicsBody),
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
