import { io, Socket } from 'socket.io-client';
import type { CombatEndPayload } from '@hard-vtt/shared';
import type {
    ClientIntent,
    FogUpdatePayload,
    HookPreset,
    StateMutationPayload,
    VisualEventPayload,
    ActionScheduledPayload,
    DecisionPollPayload,
    DecisionResponsePayload,
} from '@hard-vtt/shared';

const SOCKET_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3000';

interface SocketResponse {
    ok: boolean;
    code?: string;
    message?: string;
    [key: string]: unknown;
}

interface JoinSuccessResponse {
    sceneId: string;
    serverTime: number;
    message: string;
    permissionSnapshot: unknown;
}

interface HookSyncPayload {
    action: string;
    hook: HookPreset;
}

function isSocketResponse(value: unknown): value is SocketResponse {
    if (typeof value !== 'object' || value === null) return false;
    const response = value as Record<string, unknown>;
    return typeof response.ok === 'boolean'
        && (response.code === undefined || typeof response.code === 'string')
        && (response.message === undefined || typeof response.message === 'string');
}

class SocketClient {
    private socket: Socket;
    private _authFailedCallbacks: Array<(response: SocketResponse) => void> = [];
    /** 当为 true 时，跳过 App.tsx 的自动 joinScene（用于身份切换） */
    public skipAutoJoin = false;

    constructor() {
        this.socket = io(SOCKET_URL, {
            autoConnect: false,
            transports: ['websocket'],
        });

        this.socket.on('connect', () => {
            console.log('[Socket] Connected to server:', this.socket.id);
        });

        this.socket.on('disconnect', (reason) => {
            console.log('[Socket] Disconnected:', reason);
        });

        this.socket.on('connect_error', (err) => {
            console.error('[Socket] Connection Error:', err.message);
        });
    }

    public get connected(): boolean {
        return this.socket.connected;
    }

    public onConnect(callback: () => void) {
        this.socket.on('connect', callback);
    }
    public offConnect(callback: () => void) {
        this.socket.off('connect', callback);
    }

    public connect() {
        if (!this.socket.connected) {
            this.socket.connect();
        }
    }

    public disconnect() {
        if (this.socket.connected) {
            this.socket.disconnect();
        }
    }

    public authenticate(token: string) {
        this.socket.emit('AUTHENTICATE', { token }, (rawResponse: unknown) => {
            const response = isSocketResponse(rawResponse)
                ? rawResponse
                : { ok: false, code: 'INVALID_RESPONSE', message: '认证响应无效' };
            if (response?.ok) {
                console.log('[Socket] Authenticated successfully');
            } else {
                console.error('[Socket] Authentication failed:', response.message);
                this._authFailedCallbacks.forEach(cb => cb(response));
            }
        });
    }

    public joinScene(sceneId: string, actorId?: string) {
        this.socket.emit('JOIN_SCENE', { sceneId, actorId });
        console.log(`[Socket] Requested to join scene: ${sceneId} as ${actorId ?? 'guest'}`);
    }

    public leaveScene() {
        this.socket.emit('LEAVE_SCENE');
    }

    /**
     * 请求场景重新同步（RESYNC → SCENE_SYNC）
     */
    public resync() {
        this.socket.emit('RESYNC');
    }

    public sendIntent(intent: ClientIntent) {
        this.socket.emit('CLIENT_INTENT', intent);
    }

    /**
     * Ping 延迟测试：发送 PING 事件并测量往返时间
     * @returns 延迟毫秒数，超时或失败返回 -1
     */
    public ping(timeout = 3000): Promise<number> {
        return new Promise((resolve) => {
            const t0 = performance.now();
            const timer = setTimeout(() => resolve(-1), timeout);

            this.socket.emit('PING', { t: t0 }, (rawResponse: unknown) => {
                clearTimeout(timer);
                if (isSocketResponse(rawResponse) && rawResponse.ok) {
                    const latency = Math.round(performance.now() - t0);
                    resolve(latency);
                } else {
                    resolve(-1);
                }
            });
        });
    }

    public onAuthSuccess(callback: (response: SocketResponse) => void) {
        this.socket.on('AUTH_SUCCESS', callback);
    }
    public offAuthSuccess(callback: (response: SocketResponse) => void) {
        this.socket.off('AUTH_SUCCESS', callback);
    }

    public onAuthFailed(callback: (response: SocketResponse) => void) {
        this._authFailedCallbacks.push(callback);
    }
    public offAuthFailed(callback: (response: SocketResponse) => void) {
        this._authFailedCallbacks = this._authFailedCallbacks.filter(cb => cb !== callback);
    }

    public onJoinSuccess(callback: (response: JoinSuccessResponse) => void) {
        this.socket.on('JOIN_SUCCESS', callback);
    }
    public offJoinSuccess(callback: (response: JoinSuccessResponse) => void) {
        this.socket.off('JOIN_SUCCESS', callback);
    }

    public onStateMutated(callback: (payload: StateMutationPayload) => void) {
        this.socket.on('STATE_MUTATED', callback);
    }
    public offStateMutated(callback: (payload: StateMutationPayload) => void) {
        this.socket.off('STATE_MUTATED', callback);
    }

    public onVisualFx(callback: (payload: VisualEventPayload) => void) {
        this.socket.on('VISUAL_FX', callback);
    }
    public offVisualFx(callback: (payload: VisualEventPayload) => void) {
        this.socket.off('VISUAL_FX', callback);
    }

    public onSceneSync(callback: (payload: { tick: number, entities: import('@hard-vtt/shared').Entity[] }) => void) {
        this.socket.on('SCENE_SYNC', callback);
    }
    public offSceneSync(callback: (payload: { tick: number, entities: import('@hard-vtt/shared').Entity[] }) => void) {
        this.socket.off('SCENE_SYNC', callback);
    }

    public onCombatEnd(callback: (payload: CombatEndPayload) => void) {
        this.socket.on('COMBAT_END', callback);
    }
    public offCombatEnd(callback: (payload: CombatEndPayload) => void) {
        this.socket.off('COMBAT_END', callback);
    }

    public onActionScheduled(callback: (payload: ActionScheduledPayload) => void) {
        this.socket.on('ACTION_SCHEDULED', callback);
    }
    public offActionScheduled(callback: (payload: ActionScheduledPayload) => void) {
        this.socket.off('ACTION_SCHEDULED', callback);
    }

    public onDecisionPoll(callback: (payload: DecisionPollPayload) => void) {
        this.socket.on('DECISION_POLL', callback);
    }
    public offDecisionPoll(callback: (payload: DecisionPollPayload) => void) {
        this.socket.off('DECISION_POLL', callback);
    }

    public onHookFired(callback: (payload: { hookId: string, source: string, label: string }) => void) {
        this.socket.on('HOOK_FIRED', callback);
    }
    public offHookFired(callback: (payload: { hookId: string, source: string, label: string }) => void) {
        this.socket.off('HOOK_FIRED', callback);
    }

    public onDecisionAllResolved(callback: (payload: { windowCount?: number }) => void) {
        this.socket.on('DECISION_ALL_RESOLVED', callback);
    }
    public offDecisionAllResolved(callback: (payload: { windowCount?: number }) => void) {
        this.socket.off('DECISION_ALL_RESOLVED', callback);
    }

    public onHookSync(callback: (payload: HookSyncPayload) => void) {
        this.socket.on('HOOK_SYNC', callback);
    }
    public offHookSync(callback: (payload: HookSyncPayload) => void) {
        this.socket.off('HOOK_SYNC', callback);
    }

    public sendDecisionResponse(payload: DecisionResponsePayload) {
        this.socket.emit('DECISION_RESPONSE', payload);
    }

    public onFogUpdated(callback: (payload: FogUpdatePayload) => void) {
        this.socket.on('FOG_UPDATED', callback);
    }
    public offFogUpdated(callback: (payload: FogUpdatePayload) => void) {
        this.socket.off('FOG_UPDATED', callback);
    }

    public sendDecisionEngage(windowId: string) {
        this.socket.emit('DECISION_ENGAGE', { windowId });
    }

    /** GM 强制中断当前所有决策窗口，跳到下一个结算里程碑 */
    public sendGmForceResolve() {
        this.socket.emit('GM_FORCE_RESOLVE');
    }
}

export const socketClient = new SocketClient();
