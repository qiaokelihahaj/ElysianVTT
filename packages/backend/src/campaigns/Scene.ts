import { EventEmitter } from 'events';
import { CombatEngine } from './engines/CombatEngine.js';
import { Logger } from '../utils/Logger.js';

const logger = Logger.create('Campaign:Scene');

export enum SceneState {
    CREATED   = 'CREATED',
    LOADING   = 'LOADING',
    ACTIVE    = 'ACTIVE',
    PAUSED    = 'PAUSED',
    ENDING    = 'ENDING',
    DESTROYED = 'DESTROYED'
}

export interface SceneConfig {
    idleTimeoutMs: number;
    autoEvict: boolean;
}

const DEFAULT_SCENE_CONFIG: SceneConfig = {
    idleTimeoutMs: 5 * 60 * 1000,
    autoEvict: true
};

export class Scene extends EventEmitter {
    public readonly sceneId: string;
    private state: SceneState = SceneState.CREATED;
    private config: SceneConfig;

    private combatEngine: CombatEngine | null = null;
    private exploreEngine: any = null;

    private playerRefCount = 0;
    private playerIds = new Set<string>();

    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private lastActivityTimestamp: number;

    constructor(sceneId: string, config?: Partial<SceneConfig>) {
        super();
        this.sceneId = sceneId;
        this.config = { ...DEFAULT_SCENE_CONFIG, ...config };
        this.lastActivityTimestamp = Date.now();
        logger.info(`Scene ${sceneId} created`, { sceneId });
    }

    get currentState(): SceneState {
        return this.state;
    }

    get playerCount(): number {
        return this.playerRefCount;
    }

    get isIdle(): boolean {
        return this.playerRefCount === 0;
    }

    get activeCombatEngine(): CombatEngine | null {
        return this.combatEngine;
    }

    isActive(): boolean {
        return this.state === SceneState.ACTIVE;
    }

    canAcceptPlayers(): boolean {
        return this.state === SceneState.CREATED
            || this.state === SceneState.LOADING
            || this.state === SceneState.ACTIVE;
    }

    async startLoading(): Promise<void> {
        if (this.state !== SceneState.CREATED) {
            logger.warn(`Scene ${this.sceneId} cannot transition to LOADING from ${this.state}`, { sceneId: this.sceneId });
            return;
        }

        this.state = SceneState.LOADING;
        this.emit('scene:loading', { sceneId: this.sceneId });
        logger.info(`Scene ${this.sceneId} loading`, { sceneId: this.sceneId });
    }

    async activate(combatEngine: CombatEngine): Promise<void> {
        this.combatEngine = combatEngine;

        if (this.state === SceneState.CREATED) {
            this.state = SceneState.LOADING;
        }

        this.state = SceneState.ACTIVE;
        this.lastActivityTimestamp = Date.now();
        this.emit('scene:active', { sceneId: this.sceneId });
        logger.info(`Scene ${this.sceneId} activated`, { sceneId: this.sceneId });
    }

    pause(): void {
        if (this.state !== SceneState.ACTIVE) return;
        this.state = SceneState.PAUSED;
        this.clearIdleTimer();
        this.emit('scene:paused', { sceneId: this.sceneId });
        logger.info(`Scene ${this.sceneId} paused`, { sceneId: this.sceneId });
    }

    resume(): void {
        if (this.state !== SceneState.PAUSED) return;
        this.state = SceneState.ACTIVE;
        this.lastActivityTimestamp = Date.now();
        this.startIdleTimerIfNeeded();
        this.emit('scene:resumed', { sceneId: this.sceneId });
        logger.info(`Scene ${this.sceneId} resumed`, { sceneId: this.sceneId });
    }

    onPlayerJoin(playerId: string): void {
        if (!this.canAcceptPlayers()) {
            logger.warn(`Scene ${this.sceneId} cannot accept players in state ${this.state}`, { sceneId: this.sceneId });
            return;
        }

        if (!this.playerIds.has(playerId)) {
            this.playerIds.add(playerId);
            this.playerRefCount++;
        }

        this.lastActivityTimestamp = Date.now();
        this.clearIdleTimer();

        if (this.state === SceneState.PAUSED) {
            this.resume();
        }

        logger.info(`Player ${playerId} joined scene ${this.sceneId} (players: ${this.playerRefCount})`, { sceneId: this.sceneId, playerId });
        this.emit('player:joined', { sceneId: this.sceneId, playerId, playerCount: this.playerRefCount });
    }

    onPlayerLeave(playerId: string): void {
        if (!this.playerIds.has(playerId)) return;

        this.playerIds.delete(playerId);
        this.playerRefCount = Math.max(0, this.playerRefCount - 1);

        this.lastActivityTimestamp = Date.now();

        logger.info(`Player ${playerId} left scene ${this.sceneId} (players: ${this.playerRefCount})`, { sceneId: this.sceneId, playerId });
        this.emit('player:left', { sceneId: this.sceneId, playerId, playerCount: this.playerRefCount });

        if (this.playerRefCount <= 0) {
            this.startIdleTimerIfNeeded();
        }
    }

    private startIdleTimerIfNeeded(): void {
        if (!this.config.autoEvict || this.playerRefCount > 0) return;
        if (this.state !== SceneState.ACTIVE && this.state !== SceneState.PAUSED) return;

        this.clearIdleTimer();

        this.idleTimer = setTimeout(() => {
            this.onIdleTimeout();
        }, this.config.idleTimeoutMs);

        logger.info(`Scene ${this.sceneId} idle timer started (${this.config.idleTimeoutMs}ms)`, { sceneId: this.sceneId });
    }

    private clearIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    private onIdleTimeout(): void {
        if (this.playerRefCount > 0) return;

        logger.info(`Scene ${this.sceneId} idle timeout reached, evicting`, { sceneId: this.sceneId });
        this.emit('scene:idle_timeout', { sceneId: this.sceneId });
    }

    async destroy(): Promise<void> {
        if (this.state === SceneState.DESTROYED) return;

        this.state = SceneState.ENDING;
        this.clearIdleTimer();

        this.emit('scene:ending', { sceneId: this.sceneId });

        if (this.combatEngine) {
            this.combatEngine.removeAllListeners();
            this.combatEngine = null;
        }

        this.exploreEngine = null;

        this.state = SceneState.DESTROYED;
        this.emit('scene:destroyed', { sceneId: this.sceneId });
        logger.info(`Scene ${this.sceneId} destroyed`, { sceneId: this.sceneId });
    }

    getActivityTimestamp(): number {
        return this.lastActivityTimestamp;
    }
}
