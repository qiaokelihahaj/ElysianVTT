import { EventEmitter } from 'events';
import type { Entity, EntityId, ClientIntent, Tick, StateMutationPayload } from '@hard-vtt/shared';
import { CombatEngine } from '../../campaigns/engines/CombatEngine.js';
import { Logger } from '../../utils/Logger.js';

/**
 * 战斗系统协调器
 * 提供高层 API 封装 CombatEngine 的生命周期管理
 */
export class CombatSystem extends EventEmitter {
    private engine: CombatEngine;
    private logger: Logger;
    private active: boolean = false;

    constructor(engineId: string) {
        super();
        this.engine = new CombatEngine(engineId);
        this.logger = Logger.create(`CombatSystem:${engineId}`);

        // 透传引擎事件
        this.engine.on('STATE_MUTATED', (payload: StateMutationPayload) => {
            this.emit('STATE_MUTATED', payload);
        });
        this.engine.on('COMBAT_END', (result: any) => {
            this.active = false;
            this.emit('COMBAT_END', result);
        });
        this.engine.on('VISUAL_FX', (fx: any) => this.emit('VISUAL_FX', fx));
        this.engine.on('ACTION_SCHEDULED', (payload: any) => this.emit('ACTION_SCHEDULED', payload));
        this.engine.on('ENTITY_DIED', (entity: Entity) => this.emit('ENTITY_DIED', entity));
    }

    /** 开始战斗 */
    public start(): void {
        this.active = true;
        this.logger.info('Combat started', null, { sceneId: this.engine.engineId });
    }

    /** 结束战斗 */
    public end(): void {
        this.active = false;
        this.logger.info('Combat ended (forced)', null, { sceneId: this.engine.engineId });
    }

    /** 是否战斗中 */
    public isActive(): boolean {
        return this.active;
    }

    /** 添加实体 */
    public addEntity(entity: Entity): void {
        this.engine.mountEntities([entity]);
    }

    /** 移除实体 */
    public removeEntity(entityId: EntityId): void {
        this.engine.unmountEntities([entityId]);
    }

    /** 获取引擎实例 */
    public getEngine(): CombatEngine {
        return this.engine;
    }

    /** 获取当前Tick */
    public get currentTick(): Tick {
        return this.engine.currentTick;
    }

    /** 处理玩家意图 */
    public processIntent(intent: ClientIntent): void {
        if (!this.active) {
            this.logger.warn('Intent dropped: combat not active', {
                intentType: intent.intentType,
                actorId: intent.actorId
            });
            return;
        }
        this.engine.receiveIntent(intent);
    }
}
