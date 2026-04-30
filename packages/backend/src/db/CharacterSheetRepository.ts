import { Entity, EntityId } from '@hard-vtt/shared';
import { prisma } from './prisma.js';
import { EntityMapper, type CharacterSheetRow } from './EntityMapper.js';
import { Logger } from '../utils/Logger.js';

const logger = Logger.create('DB:CharacterSheetRepository');

export class CharacterSheetRepository {
    private static sceneCache = new Map<string, Entity[]>();
    private static entityCache = new Map<string, Entity>();

    static invalidateScene(sceneId: string): void {
        const entities = this.sceneCache.get(sceneId) || [];
        for (const e of entities) {
            this.entityCache.delete(e.id);
        }
        this.sceneCache.delete(sceneId);
    }

    static invalidateAll(): void {
        this.sceneCache.clear();
        this.entityCache.clear();
    }

    static async findBySceneId(sceneId: string, useCache = true): Promise<Entity[]> {
        if (useCache && this.sceneCache.has(sceneId)) {
            return this.sceneCache.get(sceneId)!;
        }

        const sheets = await prisma.characterSheet.findMany({
            where: { currentSceneId: sceneId }
        }) as CharacterSheetRow[];

        const entities = EntityMapper.sheetsToEntities(sheets, sceneId);

        if (useCache) {
            this.sceneCache.set(sceneId, entities);
            for (const entity of entities) {
                this.entityCache.set(entity.id, entity);
            }
        }

        logger.info(`Loaded ${entities.length} entities from scene ${sceneId}`, { sceneId, count: entities.length });
        return entities;
    }

    static async findByIds(ids: EntityId[]): Promise<Entity[]> {
        const cached: Entity[] = [];
        const missing: EntityId[] = [];

        for (const id of ids) {
            const cachedEntity = this.entityCache.get(id);
            if (cachedEntity) {
                cached.push(cachedEntity);
            } else {
                missing.push(id);
            }
        }

        if (missing.length === 0) return cached;

        const sheets = await prisma.characterSheet.findMany({
            where: { id: { in: missing } }
        }) as CharacterSheetRow[];

        const sheetById = new Map(sheets.map(s => [s.id, s]));
        const fetched: Entity[] = [];

        for (const id of missing) {
            const sheet = sheetById.get(id);
            if (sheet) {
                const entity = EntityMapper.sheetToEntity(sheet, sheet.currentSceneId ?? '');
                this.entityCache.set(entity.id, entity);
                fetched.push(entity);
            }
        }

        return [...cached, ...fetched];
    }

    static async findById(id: EntityId): Promise<Entity | null> {
        const cached = this.entityCache.get(id);
        if (cached) return cached;

        const sheet = await prisma.characterSheet.findUnique({
            where: { id }
        }) as CharacterSheetRow | null;

        if (!sheet) return null;

        const entity = EntityMapper.sheetToEntity(sheet, sheet.currentSceneId ?? '');
        this.entityCache.set(entity.id, entity);
        return entity;
    }

    static async upsertCombatResults(
        entities: Entity[],
        casualties: EntityId[],
        sceneId: string
    ): Promise<void> {
        const casualtySet = new Set(casualties);
        const entityIds = entities.map(e => e.id);

        const existingSheets = await prisma.characterSheet.findMany({
            where: { id: { in: entityIds } },
            select: { id: true, name: true, type: true }
        });
        const existingById = new Map(existingSheets.map(s => [s.id, s]));

        await Promise.all(entities.map(async (entity) => {
            const existing = existingById.get(entity.id);
            const isCasualty = casualtySet.has(entity.id);

            await prisma.characterSheet.upsert({
                where: { id: entity.id },
                update: {
                    name: existing?.name ?? entity.id,
                    type: existing?.type ?? entity.type,
                    currentSceneId: isCasualty ? null : sceneId,
                    resourcesJson: JSON.stringify(entity.resources),
                    transformJson: JSON.stringify(entity.transform),
                    physicsJson: JSON.stringify(entity.physics)
                },
                create: {
                    id: entity.id,
                    name: existing?.name ?? entity.id,
                    type: existing?.type ?? entity.type,
                    currentSceneId: isCasualty ? null : sceneId,
                    resourcesJson: JSON.stringify(entity.resources),
                    transformJson: JSON.stringify(entity.transform),
                    physicsJson: JSON.stringify(entity.physics)
                }
            });
        }));

        this.invalidateScene(sceneId);
        logger.info(`Upserted ${entities.length} entities for scene ${sceneId}`, { sceneId, casualties: casualties.length });
    }

    static async setEntitiesScene(entities: Entity[], sceneId: string, unset: boolean): Promise<void> {
        const entityIds = entities.map(e => e.id);
        await prisma.characterSheet.updateMany({
            where: { id: { in: entityIds } },
            data: { currentSceneId: unset ? null : sceneId }
        });

        if (unset) {
            for (const entity of entities) {
                this.entityCache.delete(entity.id);
            }
            for (const [scId, cachedEntities] of this.sceneCache) {
                if (scId === sceneId) {
                    this.sceneCache.delete(scId);
                }
            }
        }
    }

    static async deleteByIds(ids: EntityId[]): Promise<void> {
        await prisma.characterSheet.deleteMany({
            where: { id: { in: ids } }
        });
        for (const id of ids) {
            this.entityCache.delete(id);
        }
    }
}
