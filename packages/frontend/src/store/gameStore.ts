import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Entity, StateMutationPayload, Vector3D, ActionScheduledPayload, DecisionPollPayload, PlayerPriorityToggle, HookPreset } from '@hard-vtt/shared';
import { setNestedProperty } from '../utils/objectUtils';

export type ViewerRole = 'GM' | 'PL' | 'OB';

export interface PermissionProfile {
    userId: string;
    role: ViewerRole;
    sessionId: string;
    controlledEntityIds: string[];
    visibleEntityIds: string[];
    allowedSceneIds: string[];
    capabilities: string[];
    snapshotVersion: number;
    expiresAt?: number;
    source: 'server' | 'local' | 'anonymous';
}

export interface UiState {
    mode: 'IDLE' | 'SELECT_MOVE_TARGET' | 'SELECT_ACTION_TARGET';
    pendingMoveCoords: Vector3D | null;
    activeActionId: string | null;
}

interface TacticalState {
    activeWindow: DecisionPollPayload | null;
    countdownEnd: number | null;
    reactionTriggered: boolean;
    playerToggle: PlayerPriorityToggle;
    hookPresets: HookPreset[];
}

interface GameState {
    tick: number;
    entities: Record<string, Entity>;
    selectedEntityId: string | null;
    uiState: UiState;
    movementTargets: Record<string, Vector3D>;
    scheduledActions: ActionScheduledPayload[];   // 时间轴渲染数据
    permission: PermissionProfile;
    cameraMode: boolean; // 相机拖拽和缩放状态
    centerOnEntity: boolean; // 点击实体时镜头居中
    tactical: TacticalState;

    // Actions
    setInitialScene: (entities: Entity[], tick: number, scheduledActions?: ActionScheduledPayload[]) => void;
    applyStateMutation: (payload: StateMutationPayload) => void;
    addEntity: (entity: Entity) => void;
    removeEntity: (entityId: string) => void;
    setSelectedEntityId: (entityId: string | null) => void;

    // UI Actions
    setUiMode: (mode: UiState['mode']) => void;
    setPendingMoveCoords: (coords: Vector3D | null) => void;
    setActiveActionId: (actionId: string | null) => void;
    resetUiState: () => void;
    setCameraMode: (enable: boolean) => void;
    setCenterOnEntity: (enable: boolean) => void;

    // Movement Actions
    setMovementTarget: (entityId: string, coords: Vector3D) => void;
    clearMovementTarget: (entityId: string) => void;

    // Permission Actions
    setPermission: (permission: PermissionProfile) => void;
    resetPermission: () => void;

    // Timeline Actions
    scheduleAction: (payload: ActionScheduledPayload) => void;
    clearExpiredActions: (currentTick: number) => void;

    // Tactical Decision Actions
    setActiveWindow: (window: DecisionPollPayload) => void;
    clearActiveWindow: () => void;
    setCountdownEnd: (ms: number) => void;
    triggerReaction: () => void;
    resetReaction: () => void;
    sendDecisionResponse: (chosenOptionId: string | null) => void;
    setPlayerToggle: (mode: PlayerPriorityToggle) => void;
    addHookPreset: (preset: HookPreset) => void;
    removeHookPreset: (id: string) => void;
}

export const useGameStore = create<GameState>()(
    immer((set) => ({
            tick: 0,
            entities: {},
            selectedEntityId: null,
            uiState: {
                mode: 'IDLE',
                pendingMoveCoords: null,
                activeActionId: null
            },
            cameraMode: false,
            centerOnEntity: false,
            movementTargets: {},
            scheduledActions: [],
            permission: {
                userId: 'guest',
                role: 'OB',
                sessionId: 'anonymous',
                controlledEntityIds: [],
                visibleEntityIds: [],
                allowedSceneIds: [],
                capabilities: [],
                snapshotVersion: 0,
                source: 'anonymous'
            },
            tactical: {
                activeWindow: null,
                countdownEnd: null,
                reactionTriggered: false,
                playerToggle: 'FULL_CONTROL',
                hookPresets: [],
            },

        setInitialScene: (entities, tick, scheduledActions) => set((state) => {
            state.tick = tick;
            state.entities = {};
            state.selectedEntityId = null;
            entities.forEach((entity) => {
                state.entities[entity.id] = entity;
            });
            if (scheduledActions) {
                state.scheduledActions = scheduledActions;
            }
        }),

        applyStateMutation: (payload: StateMutationPayload) => set((state) => {
            state.tick = payload.tick;
            
            payload.mutations.forEach(mutation => {
                const entity = state.entities[mutation.entityId];
                if (!entity) {
                    console.warn(`[Store] Received mutation for unknown entity: ${mutation.entityId}`);
                    return;
                }

                Object.entries(mutation.changes).forEach(([path, value]) => {
                    setNestedProperty(entity, path, value);
                });
            });
        }),

        addEntity: (entity) => set((state) => {
            state.entities[entity.id] = entity;
        }),

        removeEntity: (entityId) => set((state) => {
            delete state.entities[entityId];
            if (state.selectedEntityId === entityId) {
                state.selectedEntityId = null;
            }
        }),

        setSelectedEntityId: (entityId) => set((state) => {
            state.selectedEntityId = entityId;
        }),

        setUiMode: (mode) => set((state) => { 
            state.uiState.mode = mode; 
            if (mode === 'IDLE') {
                state.uiState.pendingMoveCoords = null;
                state.uiState.activeActionId = null;
            }
        }),
        setPendingMoveCoords: (coords) => set((state) => { state.uiState.pendingMoveCoords = coords; }),
        setActiveActionId: (actionId) => set((state) => { state.uiState.activeActionId = actionId; }),
            resetUiState: () => set((state) => {
                state.uiState.mode = 'IDLE';
                state.uiState.pendingMoveCoords = null;
                state.uiState.activeActionId = null;
            }),
            setCameraMode: (enable) => set((state) => {
                state.cameraMode = enable;
            }),
            setCenterOnEntity: (enable) => set((state) => {
                state.centerOnEntity = enable;
            }),
            setMovementTarget: (entityId, coords) => set((state) => {
                state.movementTargets[entityId] = coords;
            }),
            clearMovementTarget: (entityId) => set((state) => {
                delete state.movementTargets[entityId];
            }),
            setPermission: (permission) => set((state) => {
                state.permission = permission;
            }),
            resetPermission: () => set((state) => {
                state.permission = {
                    userId: 'guest',
                    role: 'OB',
                    sessionId: 'anonymous',
                    controlledEntityIds: [],
                    visibleEntityIds: [],
                    allowedSceneIds: [],
                    capabilities: [],
                    snapshotVersion: 0,
                    source: 'anonymous'
                };
            }),
            scheduleAction: (payload) => set((state) => {
                state.scheduledActions.push(payload);
            }),
            clearExpiredActions: (currentTick) => set((state) => {
                state.scheduledActions = state.scheduledActions.filter(
                    a => a.timeline.end > currentTick
                );
            }),

            // Tactical Decision Actions
            setActiveWindow: (window) => set((state) => { state.tactical.activeWindow = window; }),

            clearActiveWindow: () => set((state) => {
                state.tactical.activeWindow = null;
                state.tactical.countdownEnd = null;
                state.tactical.reactionTriggered = false;
            }),

            setCountdownEnd: (ms) => set((state) => { state.tactical.countdownEnd = ms; }),

            triggerReaction: () => set((state) => { state.tactical.reactionTriggered = true; }),

            resetReaction: () => set((state) => { state.tactical.reactionTriggered = false; }),

            sendDecisionResponse: (chosenOptionId) => {
                const window = useGameStore.getState().tactical.activeWindow;
                if (!window) return;
                import('../network/socketClient').then(({ socketClient }) => {
                    socketClient.sendDecisionResponse({ windowId: window.windowId, chosenOptionId });
                });
                useGameStore.getState().clearActiveWindow();
            },

            setPlayerToggle: (mode) => set((state) => {
                state.tactical.playerToggle = mode;
                const actorId = useGameStore.getState().selectedEntityId;
                if (actorId) {
                    import('../network/IntentDispatcher').then(({ IntentDispatcher }) => {
                        IntentDispatcher.dispatchPriorityToggle(actorId, mode);
                    });
                }
            }),

            addHookPreset: (preset) => set((state) => {
                state.tactical.hookPresets.push(preset);
                const actorId = preset.entityId || useGameStore.getState().selectedEntityId;
                if (actorId) {
                    import('../network/IntentDispatcher').then(({ IntentDispatcher }) => {
                        IntentDispatcher.dispatchHookPreset(actorId, preset);
                    });
                }
            }),

            removeHookPreset: (id) => set((state) => {
                const preset = state.tactical.hookPresets.find(p => p.id === id);
                state.tactical.hookPresets = state.tactical.hookPresets.filter(p => p.id !== id);
                if (preset?.entityId) {
                    const disabled = { ...preset, enabled: false };
                    import('../network/IntentDispatcher').then(({ IntentDispatcher }) => {
                        IntentDispatcher.dispatchHookPreset(preset.entityId!, disabled);
                    });
                }
            }),
        }))
);

// Re-export shared types for UI components
export type PlayerToggleMode = PlayerPriorityToggle;
export type { DecisionPollPayload, HookPreset, HookTrigger } from '@hard-vtt/shared';
