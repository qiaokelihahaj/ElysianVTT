/**
 * 骰子工具 — 参考 Fari App rollGroups 模式。
 *
 * 纯静态方法，无副作用，用于 GM 面板和前端即时掷骰。
 * 与后端 DiceProcessor 的区别：这是面向人的工具（展示每个骰面），
 * 后端是面向规则的引擎（条件重投/加标签/爆炸骰）。
 */

export interface DieRoll {
  sides: number;
  value: number;
}

export interface RollResult {
  label: string;       // 原始表达式，如 "2d6+3"
  total: number;
  rolls: DieRoll[];
  modifier: number;
}

export interface RollGroupResult {
  results: RollResult[];
  grandTotal: number;
}

// 匹配 "2d6+3"、"d20"、"1d8-2"、"3d6"
const DICE_REGEX = /^(\d*)d(\d+)([+-]\d+)?$/i;

export class DiceRoller {
  /** 掷一个骰子表达式 */
  static roll(expression: string): RollResult {
    expression = expression.trim().replace(/\s/g, '');
    const match = expression.match(DICE_REGEX);

    if (!match) {
      throw new Error(`Invalid dice expression: "${expression}"`);
    }

    const count = Math.max(1, parseInt(match[1] || '1', 10));
    const sides = parseInt(match[2], 10);
    const modifier = parseInt(match[3] || '0', 10);

    if (sides < 2) throw new Error(`Invalid die size: d${sides}`);
    if (count > 100) throw new Error(`Too many dice: ${count}d${sides} (max 100)`);

    const rolls: DieRoll[] = [];
    let subtotal = 0;

    for (let i = 0; i < count; i++) {
      const value = DiceRoller.rollDie(sides);
      rolls.push({ sides, value });
      subtotal += value;
    }

    const total = subtotal + modifier;

    return {
      label: expression,
      total,
      rolls,
      modifier,
    };
  }

  /**
   * rollGroups — 参考 Fari App 的多命令组合。
   * 传入多个骰子表达式，分别计算后返回合计。
   *
   * 示例：rollGroups(["2d6", "1d8+3"]) → { 2d6的总和, 1d8+3的总和, grandTotal }
   */
  static rollGroups(expressions: string[]): RollGroupResult {
    const results = expressions.map(expr => DiceRoller.roll(expr));
    const grandTotal = results.reduce((sum, r) => sum + r.total, 0);
    return { results, grandTotal };
  }

  /** 掷一个单骰 [1, sides] */
  private static rollDie(sides: number): number {
    return Math.floor(Math.random() * sides) + 1;
  }

  /** 格式化结果为可读字符串 */
  static formatResult(result: RollResult): string {
    const details = result.rolls.map(r => r.value).join(' + ');
    let output = `${result.label} = ${details}`;
    if (result.modifier !== 0) {
      const modSign = result.modifier > 0 ? '+' : '';
      output += ` ${modSign}${result.modifier}`;
    }
    output += ` = **${result.total}**`;
    return output;
  }

  /** 格式化 rollGroups 结果 */
  static formatGroupResult(group: RollGroupResult): string {
    return group.results
      .map(r => DiceRoller.formatResult(r))
      .join('\n') + `\n---\n合计: **${group.grandTotal}**`;
  }
}
