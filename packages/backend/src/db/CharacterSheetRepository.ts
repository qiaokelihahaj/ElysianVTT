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

    private static invalidateEntities(ids: EntityId[]): void {
        const changedIds = new Set(ids);
        for (const id of changedIds) this.entityCache.delete(id);
        for (const [sceneId, entities] of this.sceneCache) {
            if (entities.some(entity => changedIds.has(entity.id))) this.sceneCache.delete(sceneId);
        }
    }

    static async findBySceneId(sceneId: string, useCache = true): Promise<Entity[]> {
        if (useCache && this.sceneCache.has(sceneId)) {
            return structuredClone(this.sceneCache.get(sceneId)!);
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
        return useCache ? structuredClone(entities) : entities;
    }

    /** 获取所有角色卡（探索模式用，不按场景过滤） */
    static async findAll(): Promise<Entity[]> {
        const sheets = await prisma.characterSheet.findMany() as CharacterSheetRow[];
        return EntityMapper.sheetsToEntities(sheets, '__explore__');
    }

    static async findByIds(ids: EntityId[]): Promise<Entity[]> {
        const missing = [...new Set(ids.filter(id => !this.entityCache.has(id)))];
        if (missing.length > 0) {
            const sheets = await prisma.characterSheet.findMany({
                where: { id: { in: missing } }
            });
            for (const sheet of sheets) {
                const entity = EntityMapper.sheetToEntity(sheet, sheet.currentSceneId ?? '');
                this.entityCache.set(entity.id, entity);
            }
        }
        return ids.flatMap(id => {
            const entity = this.entityCache.get(id);
            return entity ? [structuredClone(entity)] : [];
        });
    }

    static async findById(id: EntityId): Promise<Entity | null> {
        const cached = this.entityCache.get(id);
        if (cached) return structuredClone(cached);

        const sheet = await prisma.characterSheet.findUnique({
            where: { id }
        }) as CharacterSheetRow | null;

        if (!sheet) return null;

        const entity = EntityMapper.sheetToEntity(sheet, sheet.currentSceneId ?? '');
        this.entityCache.set(entity.id, entity);
        return structuredClone(entity);
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

        this.invalidateEntities(entityIds);
        this.invalidateScene(sceneId);
        logger.info(`Upserted ${entities.length} entities for scene ${sceneId}`, { sceneId, casualties: casualties.length });
    }

    static async setEntitiesScene(entities: Entity[], sceneId: string, unset: boolean): Promise<void> {
        const entityIds = entities.map(e => e.id);
        await prisma.characterSheet.updateMany({
            where: { id: { in: entityIds } },
            data: { currentSceneId: unset ? null : sceneId }
        });

        this.invalidateEntities(entityIds);
        this.invalidateScene(sceneId);
    }

    static async deleteByIds(ids: EntityId[]): Promise<void> {
        await prisma.characterSheet.deleteMany({
            where: { id: { in: ids } }
        });
        this.invalidateEntities(ids);
    }
}
