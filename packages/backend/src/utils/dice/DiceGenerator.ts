import { RawDie } from '@hard-vtt/shared';
import { generateId } from '../IdGenerator.js';

export class DiceGenerator {
    public static generate(count: number, sides: number): RawDie[] {
        const dice: RawDie[] = [];
        for (let i = 0; i < count; i++) {
            dice.push({
                id: generateId(),
                sides,
                faceValue: Math.floor(Math.random() * sides) + 1
            });
        }
        return dice;
    }

    public static generateOne(sides: number): RawDie {
        return {
            id: generateId(),
            sides,
            faceValue: Math.floor(Math.random() * sides) + 1
        };
    }
}
