import { useEffect } from 'react';
import { GameCanvas } from './canvas/GameCanvas';
import { socketClient } from './network/socketClient';
import { useGameStore } from './store/gameStore';
import { HUD } from './ui/HUD';

const MOCK_SCENE_ID = 'room_1';

function App() {
    useEffect(() => {
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
