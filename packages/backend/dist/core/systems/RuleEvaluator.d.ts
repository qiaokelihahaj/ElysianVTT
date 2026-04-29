import { Entity, DiceRule, DicePoolResult } from '@hard-vtt/shared';
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
export declare class RuleEvaluator {
    static evaluate(expression: string, context: EvaluationContext): EvaluationResult;
    private static buildScope;
}
//# sourceMappingURL=RuleEvaluator.d.ts.map