import { useEffect } from 'react';
import { GameCanvas } from './canvas/GameCanvas';
import { socketClient } from './network/socketClient';
import { useGameStore } from './store/gameStore';
import { HUD } from './ui/HUD';
import './App.css';

function App() {
    useEffect(() => {
        // Connect WS on mount
        socketClient.connect();

        // Subscribe to state mutation
        const handleMutation = (payload: any) => {
            useGameStore.getState().applyStateMutation(payload);
        };
        
        socketClient.onStateMutated(handleMutation);

        return () => {
            socketClient.offStateMutated(handleMutation);
            socketClient.disconnect();
        };
    }, []);

    // For testing/mocking during dev before UI is complete
    useEffect(() => {
        // Mock add test entity if empty
        const store = useGameStore.getState();
        if (Object.keys(store.entities).length === 0) {
            store.addEntity({
                id: 'test-entity',
                templateId: 'hero',
                type: 'ACTOR',
                transform: {
                    coords: { x: 300, y: 300, z: 0 },
                    facing: 45,
                    planeId: 'ground'
                },
                physics: {
                    scaleClass: 1,
                    collisionRadius: 20,
                    mass: 100,
                    movementModes: ['WALK']
                },
                resources: {
                    current: { hp: 100 },
                    max: { hp: 100 }
                },
                activeEffects: []
            });
        }
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
