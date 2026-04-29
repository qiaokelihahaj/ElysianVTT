"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RuleEvaluator = void 0;
const mathjs_1 = require("mathjs");
const DiceGenerator_js_1 = require("../../utils/dice/DiceGenerator.js");
const DiceProcessor_js_1 = require("../../utils/dice/DiceProcessor.js");
const math = (0, mathjs_1.create)(mathjs_1.all);
math.import({
    import: function () { throw new Error('Function import is disabled'); },
    createUnit: function () { throw new Error('Function createUnit is disabled'); },
    simplify: function () { throw new Error('Function simplify is disabled'); },
    derivative: function () { throw new Error('Function derivative is disabled'); }
}, { override: true });
const DICE_REGEX = /(\d+)d(\d+)/g;
class RuleEvaluator {
    static evaluate(expression, context) {
        const scope = this.buildScope(context);
        const diceRules = context.diceRules ?? [];
        const overrides = context.overrides;
        const allDice = [];
        const allPoolTags = [];
        const tagSeen = new Set();
        const parsedExpression = expression.replace(DICE_REGEX, (match, n, m) => {
            const count = Number(n);
            const sides = Number(m);
            const rawDice = DiceGenerator_js_1.DiceGenerator.generate(count, sides);
            const result = DiceProcessor_js_1.DiceProcessor.process(rawDice, diceRules, overrides);
            for (const die of result.dice) {
                allDice.push(die);
            }
            for (const tag of result.poolTags) {
                if (!tagSeen.has(tag)) {
                    tagSeen.add(tag);
                    allPoolTags.push(tag);
                }
            }
            return result.total.toString();
        });
        const allTags = [...tagSeen];
        scope.total = allDice.reduce((sum, d) => sum + d.finalValue, 0);
        scope.isCrit = allTags.includes('CRIT_SUCCESS');
        scope.isFumble = allTags.includes('CRIT_FAILURE');
        scope.poolTags = allTags;
        try {
            const result = math.evaluate(parsedExpression, scope);
            const finalTotal = Number(result);
            const rolls = {
                total: finalTotal,
                dice: allDice,
                poolTags: allTags
            };
            return { total: finalTotal, rolls };
        }
        catch (error) {
            console.error(`[RuleEvaluator] Failed to evaluate: ${expression}`, error);
            const rolls = {
                total: 0,
                dice: allDice,
                poolTags: allTags
            };
            return { total: 0, rolls };
        }
    }
    static buildScope(context) {
        const scope = { actor: {}, target: {} };
        if (context.actor?.resources?.current) {
            Object.entries(context.actor.resources.current).forEach(([key, val]) => {
                scope.actor[key] = val;
            });
        }
        if (context.target?.resources?.current) {
            Object.entries(context.target.resources.current).forEach(([key, val]) => {
                scope.target[key] = val;
            });
        }
        return scope;
    }
}
exports.RuleEvaluator = RuleEvaluator;
//# sourceMappingURL=RuleEvaluator.js.map