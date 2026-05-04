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

    /**
     * 按权限角色分组广播
     * 获取场景中的所有 Socket，按权限级别分组，然后分别广播
     */
    async broadcastToSceneGrouped(
        sceneId: string,
        event: string,
        payload: any,
        shouldFilter?: (role: 'GM' | 'PL' | 'OB', data: any) => any
    ): Promise<void> {
        try {
            const sockets = await this.io.in(sceneId).fetchSockets();

            // 按角色分组
            const groups = {
                GM: [] as any[],
                PL: [] as any[],
                OB: [] as any[]
            };

            for (const socket of sockets) {
                const state = socket.data as any;
                const role: 'GM' | 'PL' | 'OB' = state.role || 'OB'; // 默认为 OB
                if (role === 'GM' || role === 'PL' || role === 'OB') {
                    groups[role].push(socket.id);
                }
            }

            // 针对每组分别广播
            for (const role of ['GM', 'PL', 'OB'] as const) {
                const socketIds = groups[role];
                if (socketIds.length > 0) {
                    const data = shouldFilter ? shouldFilter(role as 'GM' | 'PL' | 'OB', payload) : payload;
                    for (const socketId of socketIds) {
                        this.io.to(socketId).emit(event, data);
                    }
                }
            }
        } catch (error) {
            logger.error(`Failed to broadcast grouped message to scene ${sceneId}`, error, { tick: Date.now(), sceneId });
        }
    }

    /**
     * 仅向特定权限角色广播
     */
    async broadcastToRoleInScene(
        sceneId: string,
        roles: ('GM' | 'PL' | 'OB')[],
        event: string,
        payload: any
    ): Promise<void> {
        try {
            const sockets = await this.io.in(sceneId).fetchSockets();

            for (const socket of sockets) {
                const state = socket.data as any;
                const role = state.role || 'OB';
                if (roles.includes(role)) {
                    socket.emit(event, payload);
                }
            }
        } catch (error) {
            logger.error(`Failed to broadcast to roles in scene ${sceneId}`, error, { tick: Date.now(), sceneId });
        }
    }
}
