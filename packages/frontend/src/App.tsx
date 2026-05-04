import { useEffect } from 'react';
import { GameCanvas } from './canvas/GameCanvas';
import { socketClient } from './network/socketClient';
import { useGameStore } from './store/gameStore';
import { HUD } from './ui/HUD';

const MOCK_SCENE_ID = 'room_1';
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3000';

async function loadPermissionProfile() {
    const token = localStorage.getItem('accessToken') ?? new URLSearchParams(window.location.search).get('token');

    if (!token) {
        useGameStore.getState().resetPermission();
        return;
    }

    try {
        const response = await fetch(`${SERVER_URL}/permissions/me?token=${encodeURIComponent(token)}`);
        const data = await response.json();

        if (!response.ok || !data?.ok) {
            useGameStore.getState().resetPermission();
            return;
        }

        useGameStore.getState().setPermission({
            ...data.data,
            source: 'server'
        });
    } catch (error) {
        console.warn('[App] Failed to load permission profile:', error);
        useGameStore.getState().resetPermission();
    }
}

function App() {
    useEffect(() => {
        void loadPermissionProfile();

        socketClient.connect();
        socketClient.joinScene(MOCK_SCENE_ID);

        const handleMutation = (payload: any) => {
            useGameStore.getState().applyStateMutation(payload);
            // 清理已完成的时间轴条
            useGameStore.getState().clearExpiredActions(
                useGameStore.getState().tick
            );
        };
        
        const handleVisualFx = (payload: any) => {
            import('./canvas/RendererManager').then(({ RendererManager }) => {
                RendererManager.getInstance().handleVisualFx(payload);
            });
        };

        const handleSceneSync = (payload: { tick: number, entities: any[] }) => {
            console.log('[App] Received Scene Sync:', payload);
            useGameStore.getState().setInitialScene(payload.entities, payload.tick);
        };

        const handleActionScheduled = (payload: any) => {
            console.log('[App] Action Scheduled:', payload);
            useGameStore.getState().scheduleAction(payload);
        };

        socketClient.onStateMutated(handleMutation);
        socketClient.onVisualFx(handleVisualFx);
        socketClient.onSceneSync(handleSceneSync);
        socketClient.onActionScheduled(handleActionScheduled);

        return () => {
            socketClient.offStateMutated(handleMutation);
            socketClient.offVisualFx(handleVisualFx);
            socketClient.offSceneSync(handleSceneSync);
            socketClient.offActionScheduled(handleActionScheduled);
            socketClient.disconnect();
        };
    }, []);

    return (
        <div className="relative w-screen h-screen overflow-hidden bg-zinc-950">
            {/* Background Canvas */}
            <div className="absolute inset-0">
                <GameCanvas />
            </div>

            {/* HUD Overlay layer */}
            <HUD />
        </div>
    );
}

export default App;
