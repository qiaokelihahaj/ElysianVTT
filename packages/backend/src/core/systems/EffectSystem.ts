// packages/backend/src/core/systems/EffectSystem.ts
import { Entity, ActionTemplate, ActionEffectPayload, DiceRule, LogVisibility } from '@hard-vtt/shared';
import { RuleEvaluator } from './RuleEvaluator.js'; // 记得 .js 后缀
import { Logger } from '../../utils/Logger.js';

const logger = Logger.create('System:Effect');

export class EffectSystem {
    /**
     * 执行技能效果，并返回所有发生变更的实体状态差分
     */
    public static applyAction(
        template: ActionTemplate, 
        actor: Entity, 
        targets: Entity[],
        engineCtx?: { tick?: number; sceneId?: string }
    ): Map<string, Record<string, any>> {
        // 记录状态变更，Map<EntityId, Changes>
        const mutations = new Map<string, Record<string, any>>();

        const recordChange = (entityId: string, path: string, value: any) => {
            if (!mutations.has(entityId)) mutations.set(entityId, {});
            mutations.get(entityId)![path] = value;
        };

        // 遍历所有效果 (Data-Driven 解析核心)
        for (const effect of template.effects) {
            
            // 确定当前效果的承受者
            let resolvedTargets: Entity[] = [];
            if (effect.targetSelector === 'SELF') {
                resolvedTargets = [actor];
            } else if (effect.targetSelector === 'PRIMARY') {
                resolvedTargets = targets;
            }

            for (const target of resolvedTargets) {
                this.executeEffect(effect, actor, target, template, engineCtx, recordChange);
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
        recordChange: (id: string, path: string, value: any) => void
    ) {
        const resKey = effect.parameters.resource;
        const expr = effect.parameters.amountExpr;

        if (!resKey || !expr) return;

        // 计算公式值
        const { total: amount } = RuleEvaluator.evaluate(expr, { actor, target, diceRules: template.diceRules });

        switch (effect.type) {
            case 'DAMAGE': {
                // 读取当前资源值
                const currentVal = target.resources.current[resKey] || 0;
                // 扣除伤害 (不低于0)
                const newVal = Math.max(0, currentVal - amount);
                target.resources.current[resKey] = newVal;
                
                // 记录状态变化 (用于推给前端)
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
                // 恢复生命 (不超过上限)
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
                // MVP: 仅记录日志，暂不实现完整的 Buff 挂载逻辑
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