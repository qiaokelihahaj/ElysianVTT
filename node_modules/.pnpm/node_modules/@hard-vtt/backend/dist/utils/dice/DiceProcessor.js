"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiceProcessor = void 0;
const DiceGenerator_js_1 = require("./DiceGenerator.js");
function evaluateCondition(condition, faceValue, sides) {
    const resolved = condition.replace(/\bsides\b/g, sides.toString());
    const match = resolved.match(/^\s*faceValue\s*(==|!=|>=|<=|>|<)\s*(\d+)\s*$/);
    if (!match)
        return false;
    const [, op, valStr] = match;
    const val = Number(valStr);
    switch (op) {
        case '==': return faceValue === val;
        case '!=': return faceValue !== val;
        case '>=': return faceValue >= val;
        case '<=': return faceValue <= val;
        case '>': return faceValue > val;
        case '<': return faceValue < val;
    }
    return false;
}
class DiceProcessor {
    static process(rawDice, rules, overrides) {
        const processedDice = [];
        const queue = [...rawDice];
        while (queue.length > 0) {
            const raw = queue.shift();
            if (overrides && overrides[raw.id] !== undefined) {
                raw.faceValue = overrides[raw.id];
            }
            const tags = [];
            let exploded = false;
            let rerolled = false;
            for (const rule of rules) {
                if (evaluateCondition(rule.condition, raw.faceValue, raw.sides)) {
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
            const processed = {
                ...raw,
                finalValue: rerolled ? 0 : raw.faceValue,
                tags,
                isOverridden: overrides ? overrides[raw.id] !== undefined : false
            };
            processedDice.push(processed);
            if (exploded) {
                const newDie = DiceGenerator_js_1.DiceGenerator.generateOne(raw.sides);
                queue.push(newDie);
            }
            if (rerolled) {
                const newDie = DiceGenerator_js_1.DiceGenerator.generateOne(raw.sides);
                queue.push(newDie);
            }
        }
        const total = processedDice.reduce((sum, d) => sum + d.finalValue, 0);
        const poolTags = [];
        const seen = new Set();
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
exports.DiceProcessor = DiceProcessor;
//# sourceMappingURL=DiceProcessor.js.map