// packages/backend/src/core/systems/EffectSystem.ts
import { Entity, ActionTemplate, ActionEffectPayload, DiceRule, LogVisibility } from '@hard-vtt/shared';
import { RuleEvaluator } from './RuleEvaluator.js';
import { Logger } from '../../utils/Logger.js';

const logger = Logger.create('System:Effect');

export class EffectSystem {
    /**
     * 执行技能效果，并返回所有发生变更的实体状态差分
     * 
     * @param onInterrupt - 可选回调，当效果类型为 INTERRUPT 时触发，用于取消目标当前动作
     */
    public static applyAction(
        template: ActionTemplate, 
        actor: Entity, 
        targets: Entity[],
        engineCtx?: { tick?: number; sceneId?: string },
        onInterrupt?: (target: Entity) => void
    ): Map<string, Record<string, any>> {
        const mutations = new Map<string, Record<string, any>>();

        const recordChange = (entityId: string, path: string, value: any) => {
            if (!mutations.has(entityId)) mutations.set(entityId, {});
            mutations.get(entityId)![path] = value;
        };

        for (const effect of template.effects) {
            let resolvedTargets: Entity[] = [];
            if (effect.targetSelector === 'SELF') {
                resolvedTargets = [actor];
            } else if (effect.targetSelector === 'PRIMARY') {
                resolvedTargets = targets;
            }

            for (const target of resolvedTargets) {
                this.executeEffect(effect, actor, target, template, engineCtx, recordChange, onInterrupt);
            }
        }

        return mutations;
    }

    private static executeEffect(
        effect: ActionEffectPayload, 
        actor: Entity, 
        target: Entity,
        template: ActionTemplate,
        engineCtx: { tick?: number; sceneId?: string } | undefined,
        recordChange: (id: string, path: string, value: any) => void,
        onInterrupt?: (target: Entity) => void
    ) {
        // INTERRUPT 效果特殊处理：不需要表达式求值，直接取消目标当前动作
        if (effect.type === 'INTERRUPT') {
            if (onInterrupt) {
                onInterrupt(target);
            }
            logger.game(
                `💥 [Effect: INTERRUPT] ${target.id} 的当前动作被 ${actor.id} 打断!`,
                { actionId: template.id, targetId: target.id },
                LogVisibility.PLAYER,
                engineCtx
            );
            return;
        }

        const resKey = effect.parameters.resource;
        const expr = effect.parameters.amountExpr;

        if (!resKey || !expr) {
            logger.warn(`跳过效果 [${effect.type}]: 缺少 resource 或 amountExpr`, { effect }, engineCtx);
            return;
        }

        const { total: amount } = RuleEvaluator.evaluate(expr, { actor, target, diceRules: template.diceRules });

        switch (effect.type) {
            case 'DAMAGE': {
                const currentVal = target.resources.current[resKey] || 0;
                const newVal = Math.max(0, currentVal - amount);
                target.resources.current[resKey] = newVal;
                
                recordChange(target.id, `resources.current.${resKey}`, newVal);
                
                logger.game(
                    `[${actor.id}] 施放了 [${template.id}] 造成 ${amount} 点伤害`,
                    { actionId: template.id, targetId: target.id, damage: amount },
                    LogVisibility.PLAYER,
                    engineCtx
                );
                break;
            }
            case 'HEAL': {
                const currentVal = target.resources.current[resKey] || 0;
                const maxVal = target.resources.max[resKey] || 999;
                const newVal = Math.min(maxVal, currentVal + amount);
                target.resources.current[resKey] = newVal;
                
                recordChange(target.id, `resources.current.${resKey}`, newVal);
                logger.game(
                    `[${actor.id}] 施放了 [${template.id}] 恢复 ${amount} 点 ${resKey}`,
                    { actionId: template.id, targetId: target.id, heal: amount },
                    LogVisibility.PLAYER,
                    engineCtx
                );
                break;
            }
            case 'APPLY_BUFF': {
                logger.game(
                    `✨ [Effect: BUFF] ${target.id} 获得了 Buff: ${effect.parameters.buffId}`,
                    { actionId: template.id, targetId: target.id, buffId: effect.parameters.buffId },
                    LogVisibility.PLAYER,
                    engineCtx
                );
                break;
            }
            default:
                logger.warn(`未知的效果类型: ${effect.type}`, null, engineCtx);
        }
    }
}
