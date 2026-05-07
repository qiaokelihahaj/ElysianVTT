import { io, Socket } from 'socket.io-client';
import type { ClientIntent, StateMutationPayload, VisualEventPayload, ActionScheduledPayload, DecisionPollPayload, DecisionResponsePayload } from '@hard-vtt/shared';

const SOCKET_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3000';

class SocketClient {
    private socket: Socket;
    private _authFailedCallbacks: Array<(response: any) => void> = [];
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
        this.socket.emit('AUTHENTICATE', { token }, (response: any) => {
            if (response?.ok) {
                console.log('[Socket] Authenticated successfully');
                this.socket.emit('AUTH_SUCCESS', response);
            } else {
                console.error('[Socket] Authentication failed:', response?.message);
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

            this.socket.emit('PING', { t: t0 }, (response: any) => {
                clearTimeout(timer);
                if (response?.ok) {
                    const latency = Math.round(performance.now() - t0);
                    resolve(latency);
                } else {
                    resolve(-1);
                }
            });
        });
    }

    public onAuthSuccess(callback: (response: any) => void) {
        this.socket.on('AUTH_SUCCESS', callback);
    }
    public offAuthSuccess(callback: (response: any) => void) {
        this.socket.off('AUTH_SUCCESS', callback);
    }

    public onAuthFailed(callback: (response: any) => void) {
        this._authFailedCallbacks.push(callback);
    }
    public offAuthFailed(callback: (response: any) => void) {
        this._authFailedCallbacks = this._authFailedCallbacks.filter(cb => cb !== callback);
    }

    public onJoinSuccess(callback: (response: any) => void) {
        this.socket.on('JOIN_SUCCESS', callback);
    }
    public offJoinSuccess(callback: (response: any) => void) {
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

    public sendDecisionResponse(payload: DecisionResponsePayload) {
        this.socket.emit('DECISION_RESPONSE', payload);
    }
}

export const socketClient = new SocketClient();
