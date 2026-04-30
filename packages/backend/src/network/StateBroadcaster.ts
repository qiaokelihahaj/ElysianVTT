import { Server } from 'socket.io';
import { CombatEngine } from '../campaigns/engines/CombatEngine.js';
import { SettlementService, type CombatEndPayload } from '../campaigns/SettlementService.js';
import { VisibilityFilter } from './VisibilityFilter.js';
import { Logger } from '../utils/Logger.js';

const logger = Logger.create('Network:StateBroadcaster');

export class StateBroadcaster {
    private io: Server;
    private settlementService: SettlementService;

    constructor(io: Server) {
        this.io = io;
        this.settlementService = new SettlementService();
    }

    wireEngine(engine: CombatEngine, sceneId: string): void {
        engine.on('STATE_MUTATED', (payload) => {
            this.broadcastStateMutation(sceneId, payload);
        });

        engine.on('VISUAL_FX', (payload) => {
            this.broadcastVisualFx(sceneId, payload);
        });

        engine.on('ACTION_SCHEDULED', (payload) => {
            this.broadcastActionScheduled(sceneId, payload);
        });

        engine.on('COMBAT_END', (payload: CombatEndPayload) => {
            void this.handleCombatEnd(sceneId, payload);
        });

        engine.on('ENTITY_DIED', (entity) => {
            this.io.to(sceneId).emit('ENTITY_DIED', { entityId: entity.id });
        });

        logger.info(`Engine events wired for scene ${sceneId}`, { sceneId });
    }

    private broadcastStateMutation(sceneId: string, payload: any): void {
        const filtered = VisibilityFilter.filterStateMutation(sceneId, payload);
        if (filtered && filtered.mutations?.length > 0) {
            this.io.to(sceneId).emit('STATE_MUTATED', filtered);
        }
    }

    private broadcastVisualFx(sceneId: string, payload: any): void {
        this.io.to(sceneId).emit('VISUAL_FX', payload);
    }

    private broadcastActionScheduled(sceneId: string, payload: any): void {
        this.io.to(sceneId).emit('ACTION_SCHEDULED', payload);
    }

    private async handleCombatEnd(sceneId: string, payload: CombatEndPayload): Promise<void> {
        try {
            await this.settlementService.settleCombat(payload);
            this.io.to(sceneId).emit('COMBAT_END', payload);
            logger.info(`Combat end broadcast for scene ${sceneId}`, { sceneId });
        } catch (error) {
            logger.error(`Failed to settle combat for scene ${sceneId}`, error, { sceneId });
        }
    }

    broadcastToScene(sceneId: string, event: string, payload: any): void {
        this.io.to(sceneId).emit(event, payload);
    }

    broadcastToSockets(socketIds: string[], event: string, payload: any): void {
        for (const socketId of socketIds) {
            this.io.to(socketId).emit(event, payload);
        }
    }
}
