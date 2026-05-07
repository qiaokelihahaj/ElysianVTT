import { create, all } from 'mathjs';
import { Entity, DiceRule, DicePoolResult } from '@hard-vtt/shared';
import { DiceGenerator } from '../../utils/dice/DiceGenerator.js';
import { DiceProcessor } from '../../utils/dice/DiceProcessor.js';

const math = create(all);

math.import({
    import: function () { throw new Error('Function import is disabled'); },
    createUnit: function () { throw new Error('Function createUnit is disabled'); },
    simplify: function () { throw new Error('Function simplify is disabled'); },
    derivative: function () { throw new Error('Function derivative is disabled'); }
}, { override: true });

export interface EvaluationContext {
    actor?: Entity;
    target?: Entity;
    diceRules?: DiceRule[];
    overrides?: Record<string, number>;
    [key: string]: any;
}

export interface EvaluationResult {
    total: number;
    rolls: DicePoolResult;
}

const DICE_REGEX = /(\d+)d(\d+)/g;
DICE_REGEX.lastIndex = 0;

export class RuleEvaluator {
    public static evaluate(expression: string, context: EvaluationContext): EvaluationResult {
        return this.evaluateWithDefs(expression, context, undefined);
    }

    public static evaluateWithDefs(expression: string, context: EvaluationContext, customVarDefs?: Record<string, number>): EvaluationResult {
        const scope = this.buildScope(context, customVarDefs);
        const diceRules = context.diceRules ?? [];
        const overrides = context.overrides;

        const allDice: DicePoolResult['dice'] = [];
        const tagSeen = new Set<string>();
        let diceTotal = 0;

        const parsedExpression = expression.replace(DICE_REGEX, (match, n, m) => {
            const count = Number(n);
            const sides = Number(m);

            const rawDice = DiceGenerator.generate(count, sides);
            const result = DiceProcessor.process(rawDice, diceRules, overrides);

            diceTotal += result.total;

            for (const die of result.dice) {
                allDice.push(die);
            }
            for (const tag of result.poolTags) {
                tagSeen.add(tag);
            }

            return result.total.toString();
        });

        const allTags = [...tagSeen];

        scope.total = diceTotal;
        scope.isCrit = allTags.includes('CRIT_SUCCESS');
        scope.isFumble = allTags.includes('CRIT_FAILURE');
        scope.poolTags = allTags;

        try {
            const result = math.evaluate!(parsedExpression, scope);
            const finalTotal = Number(result);

            const rolls: DicePoolResult = {
                total: finalTotal,
                dice: allDice,
                poolTags: allTags
            };

            return { total: finalTotal, rolls };
        } catch (error) {
            console.error(`[RuleEvaluator] Failed to evaluate: ${expression}`, error);
            const rolls: DicePoolResult = {
                total: 0,
                dice: allDice,
                poolTags: allTags
            };
            return { total: 0, rolls };
        }
    }

    private static buildScope(context: EvaluationContext, customVarDefs?: Record<string, number>): Record<string, any> {
        const scope: Record<string, any> = { actor: {}, target: {} };

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

        // Custom variable definitions from RulePack
        if (customVarDefs) {
            Object.entries(customVarDefs).forEach(([key, val]) => {
                scope[key] = val;
            });
        }

        return scope;
    }
}
