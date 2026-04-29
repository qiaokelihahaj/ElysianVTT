"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiceGenerator = void 0;
const IdGenerator_js_1 = require("../IdGenerator.js");
class DiceGenerator {
    static generate(count, sides) {
        const dice = [];
        for (let i = 0; i < count; i++) {
            dice.push({
                id: (0, IdGenerator_js_1.generateId)(),
                sides,
                faceValue: Math.floor(Math.random() * sides) + 1
            });
        }
        return dice;
    }
    static generateOne(sides) {
        return {
            id: (0, IdGenerator_js_1.generateId)(),
            sides,
            faceValue: Math.floor(Math.random() * sides) + 1
        };
    }
}
exports.DiceGenerator = DiceGenerator;
//# sourceMappingURL=DiceGenerator.js.map