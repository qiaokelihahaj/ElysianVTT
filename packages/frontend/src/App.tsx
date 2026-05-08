import { useEffect } from 'react';
import { GameCanvas } from './canvas/GameCanvas';
import { socketClient } from './network/socketClient';
import { useGameStore } from './store/gameStore';
import { HUD } from './ui/HUD';

const SCENE_ID = 'room_1';
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3000';

async function demoLogin(): Promise<string | null> {
    try {
        const response = await fetch(`${SERVER_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 'demo_gm', role: 'GM' })
        });
        const data = await response.json();
        if (data?.ok && data?.data?.accessToken) {
            localStorage.setItem('accessToken', data.data.accessToken);
            return data.data.accessToken;
        }
    } catch (error) {
        console.warn('[App] Auto-login failed:', error);
    }
    return null;
}

/** 获取已有 token (URL 参数 > localStorage) */
function getStoredToken(): string | null {
    return new URLSearchParams(window.location.search).get('token') ?? localStorage.getItem('accessToken');
}

/** 清除失效的 token */
function clearStoredToken() {
    localStorage.removeItem('accessToken');
}

/** 加载权限配置，返回是否成功 */
async function loadPermissionProfile(token: string): Promise<boolean> {
    try {
        const response = await fetch(`${SERVER_URL}/permissions/me?token=${encodeURIComponent(token)}`);
        if (response.status === 401) return false;

        const data = await response.json();

        if (!data?.ok) {
            return false;
        }

        useGameStore.getState().setPermission({
            ...data.data,
            source: 'server'
        });
        return true;
    } catch (error) {
        console.warn('[App] Failed to load permission profile:', error);
        return false;
    }
}

function App() {
    useEffect(() => {
        (async () => {
            // 尝试使用已有 token
            let token = getStoredToken();

            // 若有 token 但权限查询失败（过期），清除并重新登录
            if (token) {
                const ok = await loadPermissionProfile(token);
                if (!ok) {
                    console.warn('[App] Stored token expired, re-logging in');
                    clearStoredToken();
                    token = null;
                }
            }

            // 无 token 时自动登录
            if (!token) {
                token = await demoLogin();
            }

            if (!token) {
                console.warn('[App] No auth token available, running in read-only mode');
                socketClient.connect();
                useGameStore.getState().resetPermission();
                return;
            }

            // Full auth flow: WebSocket connect → AUTHENTICATE → JOIN_SCENE
            socketClient.connect();

            // WebSocket 认证失败时清除 token 并刷新页面
            socketClient.onAuthFailed(() => {
                console.warn('[App] WebSocket auth failed, clearing token and reloading');
                clearStoredToken();
                window.location.reload();
            });

            const doAuth = () => {
                socketClient.authenticate(token);
                socketClient.onAuthSuccess(() => {
                    if (socketClient.skipAutoJoin) {
                        console.log('[App] Auth success (skip auto-join for identity switch)');
                        return;
                    }
                    console.log('[App] WebSocket authenticated, joining scene:', SCENE_ID);
                    socketClient.joinScene(SCENE_ID);
                });
            };

            if (socketClient.connected) {
                doAuth();
            } else {
                socketClient.onConnect(doAuth);
            }
        })();

        const handleMutation = (payload: any) => {
            if (payload.mutations?.length === 0) {
                console.log('[App] STATE_MUTATED (tick sync):', payload);
            }
            useGameStore.getState().applyStateMutation(payload);
        };

        const handleVisualFx = (payload: any) => {
            import('./canvas/RendererManager').then(({ RendererManager }) => {
                RendererManager.getInstance().handleVisualFx(payload);
            });
        };

        const handleSceneSync = (payload: { tick: number, entities: any[], scheduledActions?: any[], hookPresets?: any[], activeDecisionPoll?: any, activeDecisionPolls?: any[], pendingDecisionCount?: number }) => {
            console.log('[App] Received Scene Sync:', payload);
            useGameStore.getState().setInitialScene(payload.entities, payload.tick, payload.scheduledActions);
            if (payload.hookPresets) {
                useGameStore.getState().setSyncHookPresets(payload.hookPresets);
            }
            // 重连后恢复决策窗口 UI（强制中断按钮 + 状态栏）
            const polls = payload.activeDecisionPolls ?? (payload.activeDecisionPoll ? [payload.activeDecisionPoll] : []);
            for (const poll of polls) {
                const store = useGameStore.getState();
                store.setActiveWindow(poll);
                store.setCountdownEnd(Date.now() + (poll.countdownMs ?? 5000));
            }
        };

        const handleActionScheduled = (payload: any) => {
            console.log('[App] Action Scheduled:', payload);
            useGameStore.getState().scheduleAction(payload);
        };

        const handleDecisionPoll = (payload: any) => {
            console.log('[App] Decision Poll:', payload);
            const store = useGameStore.getState();
            // 不覆盖 tick：STATE_MUTATED 已有最新值，DECISION_POLL 的 tick 可能滞后
            store.setActiveWindow(payload);
            store.setCountdownEnd(Date.now() + payload.countdownMs);
        };

        const handleJoinSuccess = (payload: any) => {
            console.log('[App] Join Success:', payload);
            const snap = payload?.permissionSnapshot;
            if (snap) {
                useGameStore.getState().setPermission({
                    userId: snap.userId ?? '',
                    role: snap.role ?? 'OB',
                    source: 'JOIN_SUCCESS',
                    controlledEntityIds: snap.controllableEntities ?? snap.controlledEntityIds ?? [],
                    visibleEntityIds: snap.visibleEntities ?? snap.visibleEntityIds ?? [],
                    capabilities: snap.capabilities ?? ['VIEW_ASSETS', 'VIEW_MAP', 'BROWSE_DICTIONARY', 'SEND_INTENT'],
                    snapshotVersion: snap.version ?? snap.snapshotVersion ?? Date.now()
                });
            }
        };

        const handleHookFired = (payload: { hookId: string, source: string }) => {
            console.log('[App] Hook Fired:', payload);
            // 自动清理前端已触发的 hook 预设
            if (payload.source === 'MANUAL') {
                useGameStore.getState().removeHookPresetLocal(payload.hookId);
            }
        };

        const handleHookSync = (payload: { action: string, hook: { id: string, entityId: string, label: string, trigger: any, enabled: boolean } }) => {
            if (payload.action === 'remove') {
                useGameStore.getState().removeHookPresetLocal(payload.hook.id);
            } else {
                useGameStore.getState().upsertHookPreset(payload.hook);
            }
        };

        const handleDecisionAllResolved = (payload: any) => {
            const store = useGameStore.getState();
            // 防御：多标签页场景下，用户已接战时（按过空格），
            // 不应因其他标签页的自动跳过而清除决策窗口
            if (store.tactical.reactionTriggered) {
                console.log('[App] DECISION_ALL_RESOLVED ignored: user is engaged, payload:', payload);
                return;
            }
            console.log('[App] DECISION_ALL_RESOLVED: clearing window, payload:', payload);
            store.clearActiveWindow();
        };

        socketClient.onStateMutated(handleMutation);
        socketClient.onVisualFx(handleVisualFx);
        socketClient.onSceneSync(handleSceneSync);
        socketClient.onActionScheduled(handleActionScheduled);
        socketClient.onDecisionPoll(handleDecisionPoll);
        socketClient.onJoinSuccess(handleJoinSuccess);
        socketClient.onHookSync(handleHookSync);
        socketClient.onHookFired(handleHookFired);
        socketClient.onDecisionAllResolved(handleDecisionAllResolved);

        return () => {
            socketClient.offStateMutated(handleMutation);
            socketClient.offVisualFx(handleVisualFx);
            socketClient.offSceneSync(handleSceneSync);
            socketClient.offActionScheduled(handleActionScheduled);
            socketClient.offDecisionPoll(handleDecisionPoll);
            socketClient.offJoinSuccess(handleJoinSuccess);
            socketClient.offHookFired(handleHookFired);
            socketClient.offHookSync(handleHookSync);
            socketClient.offDecisionAllResolved(handleDecisionAllResolved);
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
