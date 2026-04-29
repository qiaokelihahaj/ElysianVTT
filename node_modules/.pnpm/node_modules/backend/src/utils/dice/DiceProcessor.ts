import { RawDie, DiceRule, ProcessedDie, DicePoolResult } from '@hard-vtt/shared';
import { DiceGenerator } from './DiceGenerator.js';

function compileCondition(condition: string): (faceValue: number, sides: number) => boolean {
    const match = condition.trim().match(/^faceValue\s*(==|!=|>=|<=|>|<)\s*(sides|\d+)$/);
    if (!match) return () => false;
    
    const [, op, rightSide] = match;
    const isSides = rightSide === 'sides';
    const literalVal = isSides ? 0 : Number(rightSide);
    
    return (faceValue: number, sides: number) => {
        const val = isSides ? sides : literalVal;
        switch (op) {
            case '==': return faceValue === val;
            case '!=': return faceValue !== val;
            case '>=': return faceValue >= val;
            case '<=': return faceValue <= val;
            case '>': return faceValue > val;
            case '<': return faceValue < val;
        }
        return false;
    };
}

export class DiceProcessor {
    public static process(
        rawDice: RawDie[],
        rules: DiceRule[],
        overrides?: Record<string, number>
    ): DicePoolResult {
        const compiledRules = rules.map(rule => ({
            ...rule,
            evaluator: compileCondition(rule.condition)
        }));
        
        const processedDice: ProcessedDie[] = [];
        const queue: RawDie[] = [...rawDice];

        while (queue.length > 0) {
            const raw = queue.shift()!;

            if (overrides && overrides[raw.id] !== undefined) {
                raw.faceValue = overrides[raw.id];
            }

            const tags: string[] = [];
            let exploded = false;
            let rerolled = false;

            for (const rule of compiledRules) {
                if (rule.evaluator(raw.faceValue, raw.sides)) {
                    switch (rule.actionType) {
                        case 'ADD_TAG':
                            if (rule.actionPayload) {
                                tags.push(rule.actionPayload);
                            }
                            break;
                        case 'EXPLODE':
                            tags.push('EXPLODED');
                            exploded = true;
                            break;
                        case 'REROLL':
                            rerolled = true;
                            break;
                    }
                }
            }

            const processed: ProcessedDie = {
                ...raw,
                finalValue: rerolled ? 0 : raw.faceValue,
                tags,
                isOverridden: overrides ? overrides[raw.id] !== undefined : false
            };

            processedDice.push(processed);

            if (exploded) {
                const newDie = DiceGenerator.generateOne(raw.sides);
                queue.push(newDie);
            }

            if (rerolled) {
                const newDie = DiceGenerator.generateOne(raw.sides);
                queue.push(newDie);
            }
        }

        const total = processedDice.reduce((sum, d) => sum + d.finalValue, 0);
        const poolTags: string[] = [];
        const seen = new Set<string>();
        for (const d of processedDice) {
            for (const tag of d.tags) {
                if (!seen.has(tag)) {
                    seen.add(tag);
                    poolTags.push(tag);
                }
            }
        }

        return { total, dice: processedDice, poolTags };
    }
}
