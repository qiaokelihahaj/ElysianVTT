import { Server } from 'socket.io';
import type { Entity, IEngineInstance } from '@hard-vtt/shared';
import type { PermissionSubject } from '../permissions/PermissionService.js';
import { AuthenticationService } from '../auth/AuthenticationService.js';
import { CombatEngine } from '../campaigns/engines/CombatEngine.js';
import { ExploreEngine } from '../campaigns/engines/ExploreEngine.js';
import { SettlementService, type CombatEndPayload } from '../campaigns/SettlementService.js';
import { VisibilityFilter } from './VisibilityFilter.js';
import { Logger } from '../utils/Logger.js';

const logger = Logger.create('Network:StateBroadcaster');

export class StateBroadcaster {
    private io: Server;
    private settlementService: SettlementService;
    private sceneBroadcasts = new Map<string, Promise<void>>();

    constructor(io: Server) {
        this.io = io;
        this.settlementService = new SettlementService();
    }

    wireEngine(engine: IEngineInstance, sceneId: string): void {
        if (engine.engineType === 'COMBAT') {
            this.wireCombatEngine(engine as CombatEngine, sceneId);
        } else {
            this.wireExploreEngine(engine as ExploreEngine, sceneId);
        }
        logger.info(`Engine events wired for scene ${sceneId} (type: ${engine.engineType})`, { sceneId });
    }

    private wireCombatEngine(engine: CombatEngine, sceneId: string): void {
        engine.on('STATE_MUTATED', (payload) => {
            void this.broadcastFiltered(engine, sceneId, 'STATE_MUTATED', viewer => VisibilityFilter.filterStateMutation(sceneId, payload, viewer));
        });

        engine.on('VISUAL_FX', (payload) => {
            void this.broadcastFiltered(engine, sceneId, 'VISUAL_FX', viewer => VisibilityFilter.filterVisualFx(sceneId, payload, viewer));
        });

        engine.on('ACTION_SCHEDULED', (payload) => {
            void this.broadcastFiltered(engine, sceneId, 'ACTION_SCHEDULED', viewer => VisibilityFilter.filterAction(payload, viewer));
        });

        engine.on('COMBAT_END', (payload: CombatEndPayload) => {
            void this.handleCombatEnd(engine, sceneId, payload);
        });

        engine.on('ENTITY_DIED', (entity) => {
            void this.broadcastFiltered(engine, sceneId, 'ENTITY_DIED', viewer =>
                VisibilityFilter.isEntityVisibleTo(entity.id, viewer) ? { entityId: entity.id } : null);
        });

        engine.on('HOOK_FIRED', (hook) => {
            void this.broadcastFiltered(engine, sceneId, 'HOOK_FIRED', viewer => viewer.role === 'GM'
                || viewer.controlledEntityIds.includes(hook.entityId)
                ? { hookId: hook.id, source: hook.source, label: hook.label } : null);
        });

        engine.on('HOOK_SYNC', (payload) => {
            void this.broadcastFiltered(engine, sceneId, 'HOOK_SYNC', viewer => viewer.role === 'GM'
                || viewer.controlledEntityIds.includes(payload.hook.entityId) ? payload : null);
        });

        engine.on('DECISION_ALL_RESOLVED', (payload) => {
            void this.broadcastFiltered(engine, sceneId, 'DECISION_ALL_RESOLVED', () => payload);
        });

        engine.on('DECISION_POLL', (payload) => {
            void this.broadcastFiltered(engine, sceneId, 'DECISION_POLL', viewer => VisibilityFilter.filterDecisionPoll(payload, viewer));
        });
    }

    private wireExploreEngine(engine: ExploreEngine, sceneId: string): void {
        engine.on('STATE_MUTATED', (payload) => {
            void this.broadcastFiltered(engine, sceneId, 'STATE_MUTATED', viewer => VisibilityFilter.filterStateMutation(sceneId, payload, viewer));
        });

        engine.on('VISUAL_FX', (payload) => {
            void this.broadcastFiltered(engine, sceneId, 'VISUAL_FX', viewer => VisibilityFilter.filterVisualFx(sceneId, payload, viewer));
        });

        engine.on('ENTITY_MOVED', (payload) => {
            void this.broadcastFiltered(engine, sceneId, 'ENTITY_MOVED', viewer => VisibilityFilter.isEntityVisibleTo(payload.entityId, viewer) ? payload : null);
        });

        engine.on('ZONE_ENTERED', (payload) => {
            void this.broadcastFiltered(engine, sceneId, 'ZONE_ENTERED', viewer => VisibilityFilter.isEntityVisibleTo(payload.entityId, viewer) ? payload : null);
        });

        engine.on('ZONE_TRIGGERED', (payload) => {
            void this.broadcastFiltered(engine, sceneId, 'ZONE_TRIGGERED', viewer => VisibilityFilter.isEntityVisibleTo(payload.entityId, viewer) ? payload : null);
        });

        engine.on('INTERACT_TRIGGERED', (payload) => {
            void this.broadcastFiltered(engine, sceneId, 'INTERACT_TRIGGERED', viewer => VisibilityFilter.isEntityVisibleTo(payload.actorId, viewer)
                && VisibilityFilter.isEntityVisibleTo(payload.targetId, viewer) ? payload : null);
        });

        engine.on('EXAMINE_RESULT', (payload) => {
            void this.broadcastFiltered(engine, sceneId, 'EXAMINE_RESULT', viewer => VisibilityFilter.isEntityVisibleTo(payload.entityId, viewer) ? payload : null);
        });

        engine.on('SKILL_CHECK_RESULT', (payload) => {
            void this.broadcastFiltered(engine, sceneId, 'SKILL_CHECK_RESULT', () => payload);
        });

        engine.on('FOG_UPDATED', (payload) => {
            void this.broadcastFiltered(engine, sceneId, 'FOG_UPDATED', viewer => viewer.role === 'GM'
                || viewer.controlledEntityIds.includes(payload.entityId) ? payload : null);
        });
    }

    private broadcastFiltered(
        engine: IEngineInstance,
        sceneId: string,
        event: string,
        filter: (viewer: PermissionSubject) => unknown | null,
    ): Promise<void> {
        const entities = engine.getAllEntities();
        return this.queueBroadcast(sceneId, event, () => this.deliverFiltered(entities, sceneId, event, filter));
    }

    private queueBroadcast(sceneId: string, event: string, operation: () => Promise<void>): Promise<void> {
        // Socket lookup and settlement can yield; retain the engine's event order per scene.
        const previous = this.sceneBroadcasts.get(sceneId) ?? Promise.resolve();
        const next = previous.then(operation).catch(error => {
            logger.error(`Failed to broadcast ${event} to scene ${sceneId}`, error, { sceneId });
        }).finally(() => {
            if (this.sceneBroadcasts.get(sceneId) === next) this.sceneBroadcasts.delete(sceneId);
        });
        this.sceneBroadcasts.set(sceneId, next);
        return next;
    }

    private async deliverFiltered(
        entities: Entity[],
        sceneId: string,
        event: string,
        filter: (viewer: PermissionSubject) => unknown | null,
    ): Promise<void> {
        try {
            const sockets = await this.io.in(sceneId).fetchSockets();
            for (const socket of sockets) {
                const state = socket.data as { permissionSubject?: PermissionSubject; accessToken?: string };
                if (!state.permissionSubject) continue;
                if (state.accessToken && !AuthenticationService.verify(state.accessToken).valid) continue;
                const viewer = VisibilityFilter.forScene(state.permissionSubject, entities);
                const payload = filter(viewer);
                if (payload !== null) socket.emit(event, payload);
            }
        } catch (error) {
            logger.error(`Failed to broadcast ${event} to scene ${sceneId}`, error, { sceneId });
        }
    }

    private handleCombatEnd(engine: CombatEngine, sceneId: string, payload: CombatEndPayload): Promise<void> {
        const entities = engine.getAllEntities();
        return this.queueBroadcast(sceneId, 'COMBAT_END', async () => {
            try {
                await this.settlementService.settleCombat(payload);
                await this.deliverFiltered(entities, sceneId, 'COMBAT_END', viewer => viewer.role === 'GM' ? payload : {
                    sceneId: payload.sceneId, tick: payload.tick,
                    survivors: payload.survivors.filter(id => VisibilityFilter.isEntityVisibleTo(id, viewer)),
                    casualties: payload.casualties.filter(id => VisibilityFilter.isEntityVisibleTo(id, viewer)),
                });
                logger.info(`Combat end broadcast for scene ${sceneId}`, { sceneId });
            } catch (error) {
                logger.error(`Failed to settle combat for scene ${sceneId}`, error, { sceneId });
            }
        });
    }

}
