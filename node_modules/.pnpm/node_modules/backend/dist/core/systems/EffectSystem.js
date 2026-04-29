"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EffectSystem = void 0;
const RuleEvaluator_js_1 = require("./RuleEvaluator.js"); // 记得 .js 后缀
class EffectSystem {
    /**
     * 执行技能效果，并返回所有发生变更的实体状态差分
     */
    static applyAction(template, actor, targets) {
        // 记录状态变更，Map<EntityId, Changes>
        const mutations = new Map();
        const recordChange = (entityId, path, value) => {
            if (!mutations.has(entityId))
                mutations.set(entityId, {});
            mutations.get(entityId)[path] = value;
        };
        // 遍历所有效果 (Data-Driven 解析核心)
        for (const effect of template.effects) {
            // 确定当前效果的承受者
            let resolvedTargets = [];
            if (effect.targetSelector === 'SELF') {
                resolvedTargets = [actor];
            }
            else if (effect.targetSelector === 'PRIMARY') {
                resolvedTargets = targets;
            }
            for (const target of resolvedTargets) {
                this.executeEffect(effect, actor, target, template.diceRules, recordChange);
            }
        }
        return mutations;
    }
    static executeEffect(effect, actor, target, diceRules, recordChange) {
        const resKey = effect.parameters.resource;
        const expr = effect.parameters.amountExpr;
        if (!resKey || !expr)
            return;
        // 计算公式值
        const { total: amount } = RuleEvaluator_js_1.RuleEvaluator.evaluate(expr, { actor, target, diceRules });
        switch (effect.type) {
            case 'DAMAGE': {
                // 读取当前资源值
                const currentVal = target.resources.current[resKey] || 0;
                // 扣除伤害 (不低于0)
                const newVal = Math.max(0, currentVal - amount);
                target.resources.current[resKey] = newVal;
                // 记录状态变化 (用于推给前端)
                recordChange(target.id, `resources.current.${resKey}`, newVal);
                console.log(`💥 [Effect: DAMAGE] ${target.id} 失去 ${amount} 点 ${resKey}, 剩余: ${newVal}`);
                break;
            }
            case 'HEAL': {
                const currentVal = target.resources.current[resKey] || 0;
                const maxVal = target.resources.max[resKey] || 999;
                // 恢复生命 (不超过上限)
                const newVal = Math.min(maxVal, currentVal + amount);
                target.resources.current[resKey] = newVal;
                recordChange(target.id, `resources.current.${resKey}`, newVal);
                console.log(`💚 [Effect: HEAL] ${target.id} 恢复 ${amount} 点 ${resKey}, 当前: ${newVal}`);
                break;
            }
            case 'APPLY_BUFF': {
                // MVP: 仅记录日志，暂不实现完整的 Buff 挂载逻辑
                console.log(`✨ [Effect: BUFF] ${target.id} 获得了 Buff: ${effect.parameters.buffId}`);
                break;
            }
            default:
                console.warn(`[EffectSystem] 未知的效果类型: ${effect.type}`);
        }
    }
}
exports.EffectSystem = EffectSystem;
//# sourceMappingURL=EffectSystem.js.map