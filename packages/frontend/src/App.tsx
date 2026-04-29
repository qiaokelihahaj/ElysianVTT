import { useEffect } from 'react';
import { GameCanvas } from './canvas/GameCanvas';
import { socketClient } from './network/socketClient';
import { useGameStore } from './store/gameStore';
import { HUD } from './ui/HUD';

// [MVP] 假设测试场景名
const MOCK_SCENE_ID = 'room_1';

function App() {
    useEffect(() => {
        // Connect WS on mount
        socketClient.connect();

        // 建立连接后立刻尝试加入场景
        socketClient.joinScene(MOCK_SCENE_ID);

        // Subscribe to state mutation
        const handleMutation = (payload: any) => {
            useGameStore.getState().applyStateMutation(payload);
        };
        
        // Subscribe to visual fx
        const handleVisualFx = (payload: any) => {
            import('./canvas/RendererManager').then(({ RendererManager }) => {
                RendererManager.getInstance().handleVisualFx(payload);
            });
        };

        const handleSceneSync = (payload: { tick: number, entities: any[] }) => {
            console.log('[App] Received Scene Sync:', payload);
            useGameStore.getState().setInitialScene(payload.entities, payload.tick);
        };

        socketClient.onStateMutated(handleMutation);
        socketClient.onVisualFx(handleVisualFx);
        socketClient.onSceneSync(handleSceneSync);

        return () => {
            socketClient.offStateMutated(handleMutation);
            socketClient.offVisualFx(handleVisualFx);
            socketClient.offSceneSync(handleSceneSync);
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
