import { socketClient } from './socketClient';
import { useGameStore } from '../store/gameStore';
import type { EntityId, Vector3D, ClientIntent, HookPreset, PlayerPriorityToggle } from '@hard-vtt/shared';

export class IntentDispatcher {
    /**
     * 生成基础的 Intent Wrapper
     */
    private static createBaseIntent(actorId: EntityId, intentType: ClientIntent['intentType']): ClientIntent {
        const tick = useGameStore.getState().tick;
        return {
            actorId,
            intentType,
            clientTick: tick,
            payload: {}
        };
    }

    /**
     * 分移移动指令
     */
    public static dispatchMove(actorId: EntityId, targetCoords: Vector3D) {
        const intent: ClientIntent = {
            ...this.createBaseIntent(actorId, 'MOVE'),
            payload: { targetCoords }
        };
        socketClient.sendIntent(intent);
        console.log('[IntentDispatcher] 发送转移意图 (MOVE):', intent);
    }

    /**
     * 分发施放技能指令
     */
    public static dispatchCastAction(
        actorId: EntityId, 
        actionTemplateId: string, 
        targetIds?: EntityId[], 
        targetCoords?: Vector3D
    ) {
        const intent: ClientIntent = {
            ...this.createBaseIntent(actorId, 'CAST_ACTION'),
            payload: { actionTemplateId, targetIds, targetCoords }
        };
        socketClient.sendIntent(intent);
        console.log('[IntentDispatcher] 发送施法意图 (CAST_ACTION):', intent);
    }

    /**
     * 分发交互物品指令
     */
    public static dispatchInteract(actorId: EntityId, targetId: EntityId) {
        const intent: ClientIntent = {
            ...this.createBaseIntent(actorId, 'INTERACT'),
            payload: { targetIds: [targetId] }
        };
        socketClient.sendIntent(intent);
        console.log('[IntentDispatcher] 发送交互意图 (INTERACT):', intent);
    }

    /**
     * 分发批量施法指令（同步测试用：所有角色同时施法）
     */
    public static dispatchBatchCast(
        batchIntents: Array<{ actorId: EntityId; actionTemplateId: string; targetIds?: EntityId[] }>
    ) {
        const tick = useGameStore.getState().tick;
        const intent: ClientIntent = {
            actorId: '__batch__',
            intentType: 'BATCH_CAST',
            clientTick: tick,
            payload: { batchIntents }
        };
        socketClient.sendIntent(intent);
        console.log('[IntentDispatcher] 发送批量施法 (BATCH_CAST):', batchIntents);
    }
    public static dispatchCancelAction(actorId: EntityId) {
        const intent: ClientIntent = {
            ...this.createBaseIntent(actorId, 'CANCEL_ACTION'),
            payload: {}
        };
        socketClient.sendIntent(intent);
        console.log('[IntentDispatcher] 发送取消意图 (CANCEL_ACTION):', intent);
    }

    /**
     * 分发 Hook 预设指令（添加/更新）
     */
    public static dispatchHookPreset(actorId: EntityId, preset: HookPreset) {
        const intent: ClientIntent = {
            ...this.createBaseIntent(actorId, 'HOOK_PRESET'),
            payload: { hookPreset: preset }
        };
        socketClient.sendIntent(intent);
        console.log('[IntentDispatcher] 发送 Hook 预设 (HOOK_PRESET):', intent);
    }

    /**
     * 分发优先级切换指令
     */
    public static dispatchPriorityToggle(actorId: EntityId, mode: PlayerPriorityToggle) {
        const intent: ClientIntent = {
            ...this.createBaseIntent(actorId, 'PRIORITY_TOGGLE'),
            payload: { toggleMode: mode }
        };
        socketClient.sendIntent(intent);
        console.log('[IntentDispatcher] 发送优先级切换 (PRIORITY_TOGGLE):', intent);
    }
}
