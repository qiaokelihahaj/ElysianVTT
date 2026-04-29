import { io, Socket } from 'socket.io-client';
import type { ClientIntent, StateMutationPayload, VisualEventPayload } from '@hard-vtt/shared';

const SOCKET_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3000';

class SocketClient {
    private socket: Socket;

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

    public joinScene(sceneId: string) {
        this.socket.emit('JOIN_SCENE', { sceneId });
        console.log(`[Socket] Requested to join scene: ${sceneId}`);
    }

    public sendIntent(intent: ClientIntent) {
        this.socket.emit('CLIENT_INTENT', intent);
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
}

export const socketClient = new SocketClient();
