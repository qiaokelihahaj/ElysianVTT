import { Entity } from '@hard-vtt/shared';
import { CharacterSheetRepository } from '../db/CharacterSheetRepository.js';
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
		await CharacterSheetRepository.upsertCombatResults(
			payload.entities,
			payload.casualties,
			payload.sceneId
		);

		logger.info(`Settled combat for scene ${payload.sceneId}`, {
			tick: payload.tick,
			survivors: payload.survivors,
			casualties: payload.casualties
		}, { sceneId: payload.sceneId, tick: payload.tick });
	}
}
