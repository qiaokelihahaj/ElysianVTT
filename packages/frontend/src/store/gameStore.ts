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
    frozenTick: number | null;        // hook 触发时的 tick，决策期间冻结显示
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
    upsertHookPreset: (hookData: any) => void;
    removeHookPresetLocal: (id: string) => void;
    setSyncHookPresets: (presets: any[]) => void;
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
                frozenTick: null,
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
            console.log(`[Store] tick updated to ${payload.tick}, mutations: ${payload.mutations?.length ?? 0}`);
            
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
            setActiveWindow: (window) => set((state) => {
                console.log('[STORE] setActiveWindow windowId=', window?.windowId, ', reactionTriggered=', state.tactical.reactionTriggered);
                state.tactical.activeWindow = window;
                if (window && typeof window.tick === 'number') {
                    state.tactical.frozenTick = window.tick;
                }
            }),

            clearActiveWindow: () => set((state) => {
                console.log('[STORE] clearActiveWindow called', new Error().stack?.split('\n').slice(1, 4).join('\n'));
                state.tactical.activeWindow = null;
                state.tactical.frozenTick = null;
                state.tactical.countdownEnd = null;
                state.tactical.reactionTriggered = false;
            }),

            setCountdownEnd: (ms) => set((state) => {
                console.log('[STORE] setCountdownEnd ms=', ms, ', reactionTriggered=', state.tactical.reactionTriggered);
                state.tactical.countdownEnd = ms;
            }),

            triggerReaction: () => set((state) => {
                console.log('[STORE] triggerReaction');
                state.tactical.reactionTriggered = true;
            }),

            resetReaction: () => set((state) => { state.tactical.reactionTriggered = false; }),

            sendDecisionResponse: (chosenOptionId) => {
                const currentState = useGameStore.getState();
                const window = currentState.tactical.activeWindow;
                const triggered = currentState.tactical.reactionTriggered;
                const cEnd = currentState.tactical.countdownEnd;
                const now = Date.now();
                const rem = cEnd ? cEnd - now : 'N/A';
                console.trace(
                    `[DEBUG sendDecisionResponse] chosenOptionId=${chosenOptionId}, ` +
                    `reactionTriggered=${triggered}, countdownRemaining=${rem}, ` +
                    `hasWindow=${!!window}`
                );
                if (!window) {
                    console.log('[DEBUG sendDecisionResponse] No active window, returning');
                    return;
                }
                import('../network/socketClient').then(({ socketClient }) => {
                    socketClient.sendDecisionResponse({ windowId: window.windowId, chosenOptionId });
                });
                // 仅当用户已接战（手动跳过/选择）时清除本地窗口。
                // 自动跳过（倒计时到期但未按空格）不清除 → 等待后端 DECISION_ALL_RESOLVED，
                // 保证 HUD 状态栏和GM强制跳过按钮在其他标签页上持续可见。
                if (triggered) {
                    useGameStore.getState().clearActiveWindow();
                }
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
                    const preset_ = preset;
                    import('../network/IntentDispatcher').then(({ IntentDispatcher }) => {
                        IntentDispatcher.dispatchHookPreset(actorId, preset_);
                    }).catch(e => console.warn('[Store] Failed to dispatch hook preset:', e));
                }
            }),

            removeHookPreset: (id) => set((state) => {
                const preset = state.tactical.hookPresets.find(p => p.id === id);
                state.tactical.hookPresets = state.tactical.hookPresets.filter(p => p.id !== id);
                if (preset?.entityId) {
                    const entityId = preset.entityId;
                    const disabled = { ...preset, enabled: false };
                    import('../network/IntentDispatcher').then(({ IntentDispatcher }) => {
                        IntentDispatcher.dispatchHookPreset(entityId, disabled);
                    }).catch(e => console.warn('[Store] Failed to dispatch hook disable:', e));
                }
            }),

            upsertHookPreset: (hookData) => set((state) => {
                const idx = state.tactical.hookPresets.findIndex(p => p.id === hookData.id);
                if (idx >= 0) {
                    state.tactical.hookPresets[idx] = hookData;
                } else {
                    state.tactical.hookPresets.push(hookData);
                }
            }),

            removeHookPresetLocal: (id) => set((state) => {
                state.tactical.hookPresets = state.tactical.hookPresets.filter(p => p.id !== id);
            }),

            setSyncHookPresets: (presets) => set((state) => {
                // Merge synced hooks: keep local-only, overwrite synced, add new
                const localIds = new Set(state.tactical.hookPresets.map(p => p.id));
                for (const p of presets) {
                    const idx = state.tactical.hookPresets.findIndex(x => x.id === p.id);
                    if (idx >= 0) {
                        state.tactical.hookPresets[idx] = p;
                    } else {
                        state.tactical.hookPresets.push(p);
                    }
                }
            }),
        }))
);

// Re-export shared types for UI components
export type PlayerToggleMode = PlayerPriorityToggle;
export type { DecisionPollPayload, HookPreset, HookTrigger } from '@hard-vtt/shared';
