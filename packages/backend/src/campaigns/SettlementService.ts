import { Entity } from '@hard-vtt/shared';
import { prisma } from '../db/prisma.js';
import { Logger } from '../utils/Logger.js';

const logger = Logger.create('Campaign:Settlement');

export interface CombatEndPayload {
	sceneId: string;
	tick: number;
	survivors: string[];
	casualties: string[];
	entities: Entity[];
}

export class SettlementService {
	public async settleCombat(payload: CombatEndPayload): Promise<void> {
		const entityIds = payload.entities.map(entity => entity.id);
		const existingSheets = await prisma.characterSheet.findMany({
			where: { id: { in: entityIds } }
		});

		const sheetById = new Map(existingSheets.map(sheet => [sheet.id, sheet]));

		await Promise.all(payload.entities.map(async (entity) => {
			const existing = sheetById.get(entity.id);
			const isCasualty = payload.casualties.includes(entity.id);

			await prisma.characterSheet.upsert({
				where: { id: entity.id },
				update: {
					name: existing?.name ?? entity.id,
					type: existing?.type ?? entity.type,
					currentSceneId: isCasualty ? null : payload.sceneId,
					resourcesJson: JSON.stringify(entity.resources),
					transformJson: JSON.stringify(entity.transform),
					physicsJson: JSON.stringify(entity.physics)
				},
				create: {
					id: entity.id,
					name: existing?.name ?? entity.id,
					type: existing?.type ?? entity.type,
					currentSceneId: isCasualty ? null : payload.sceneId,
					resourcesJson: JSON.stringify(entity.resources),
					transformJson: JSON.stringify(entity.transform),
					physicsJson: JSON.stringify(entity.physics)
				}
			});
		}));

		logger.info(`Settled combat for scene ${payload.sceneId}`, {
			tick: payload.tick,
			survivors: payload.survivors,
			casualties: payload.casualties
		}, { sceneId: payload.sceneId, tick: payload.tick });
	}
}
