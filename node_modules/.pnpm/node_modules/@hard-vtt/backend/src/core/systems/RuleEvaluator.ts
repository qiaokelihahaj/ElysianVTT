import { create, all } from 'mathjs';
import { Entity } from '@hard-vtt/shared';

// 1. 创建受限的 mathjs 实例
const math = create(all);


math.import({
    import: function () { throw new Error('Function import is disabled'); },
    createUnit: function () { throw new Error('Function createUnit is disabled'); },
    simplify: function () { throw new Error('Function simplify is disabled'); },
    derivative: function () { throw new Error('Function derivative is disabled'); }
}, { override: true });

export class RuleEvaluator {
    /**
     * 安全计算表达式，例如: "actor.str + 3d6"
     */
    public static evaluate(
        expression: string, 
        context: { actor?: Entity; target?: Entity; [key: string]: any }
    ): number {
        try {
            // 1. 构建嵌套作用域字典
            const scope = this.buildScope(context);
            
            // 2. 拦截 "3d6" 等掷骰宏，替换为确定的常数
            const parsedExpression = this.preprocessDiceRolls(expression);

            // 3. 安全解析计算
            const result = math.evaluate!(parsedExpression, scope);
            return Number(result);
        } catch (error) {
            console.error(`[RuleEvaluator] Failed to evaluate: ${expression}`, error);
            return 0; // 出错时返回 0 防止引擎崩溃
        }
    }

    private static buildScope(context: any): Record<string, any> {
        const scope: Record<string, any> = { actor: {}, target: {} };
        
        if (context.actor?.resources?.current) {
            Object.entries(context.actor.resources.current).forEach(([key, val]) => {
                scope.actor[key] = val;
            });
            // 预留：未来可以在这里注入 actor.attributes (力量、敏捷等)
        }
        
        if (context.target?.resources?.current) {
            Object.entries(context.target.resources.current).forEach(([key, val]) => {
                scope.target[key] = val;
            });
        }
        
        return scope;
    }

    private static preprocessDiceRolls(expr: string): string {
        // MVP 阶段：正则匹配 NdM (例如 2d6) 并替换为随机值
        // 未来：这里应接入外部的 /utils/DiceRoller.ts 处理优势/劣势(Advantage/Disadvantage)
        return expr.replace(/(\d+)d(\d+)/g, (match, n, m) => {
            let total = 0;
            for(let i = 0; i < Number(n); i++) {
                total += Math.floor(Math.random() * Number(m)) + 1;
            }
            return total.toString();
        });
    }
}