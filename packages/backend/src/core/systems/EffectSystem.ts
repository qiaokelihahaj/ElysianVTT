// packages/backend/src/core/systems/EffectSystem.ts
import { Entity, ActionTemplate, ActionEffectPayload, DiceRule, LogVisibility, HitLocationEntry, CritConfig, AoeConfig, DamageFalloffConfig } from '@hard-vtt/shared';
import { RuleEvaluator } from './RuleEvaluator.js';
import { BodyPartResolver } from './BodyPartResolver.js';
import { AoeResolver } from './AoeResolver.js';
import { VectorMath } from '../../utils/VectorMath.js';
import { Logger } from '../../utils/Logger.js';

const logger = Logger.create('System:Effect');

export class EffectSystem {
    /**
     * 执行技能效果，并返回所有发生变更的实体状态差分
     * 
     * @param onInterrupt - 可选回调，当效果类型为 INTERRUPT 时触发，用于取消目标当前动作
     */
    public static applyAction(
        template: ActionTemplate,
        actor: Entity,
        targets: Entity[],
        engineCtx?: { tick?: number; sceneId?: string; entities?: Map<string, Entity> },
        onInterrupt?: (target: Entity) => void,
        coverDrMap?: Map<string, number>  // Phase 3.3: targetId → 掩体 DR
    ): Map<string, Record<string, any>> {
        const mutations = new Map<string, Record<string, any>>();

        const recordChange = (entityId: string, path: string, value: any) => {
            if (!mutations.has(entityId)) mutations.set(entityId, {});
            mutations.get(entityId)![path] = value;
        };

        for (const effect of template.effects) {
            let resolvedTargets: Entity[] = [];
            if (effect.targetSelector === 'SELF') {
                resolvedTargets = [actor];
            } else if (effect.targetSelector === 'PRIMARY') {
                resolvedTargets = targets;
            } else if (effect.targetSelector === 'ALL_IN_AOE') {
                resolvedTargets = this.resolveAoeTargets(effect, actor, targets, engineCtx);
            }

            for (const target of resolvedTargets) {
                this.executeEffect(effect, actor, target, template, engineCtx, recordChange, onInterrupt, coverDrMap);
            }
        }

        return mutations;
    }

    private static executeEffect(
        effect: ActionEffectPayload,
        actor: Entity,
        target: Entity,
        template: ActionTemplate,
        engineCtx: { tick?: number; sceneId?: string } | undefined,
        recordChange: (id: string, path: string, value: any) => void,
        onInterrupt?: (target: Entity) => void,
        coverDrMap?: Map<string, number>
    ) {
        // INTERRUPT 效果特殊处理：不需要表达式求值，直接取消目标当前动作
        if (effect.type === 'INTERRUPT') {
            if (onInterrupt) {
                onInterrupt(target);
            }
            logger.game(
                `💥 [Effect: INTERRUPT] ${target.id} 的当前动作被 ${actor.id} 打断!`,
                { actionId: template.id, targetId: target.id },
                LogVisibility.PLAYER,
                engineCtx
            );
            return;
        }

        const resKey = effect.parameters.resource;
        const expr = effect.parameters.amountExpr;

        if (!resKey || !expr) {
            logger.warn(`跳过效果 [${effect.type}]: 缺少 resource 或 amountExpr`, { effect }, engineCtx);
            return;
        }

        const { total: amount, rolls } = RuleEvaluator.evaluate(expr, { actor, target, diceRules: template.diceRules });

        switch (effect.type) {
            case 'DAMAGE': {
                let effectiveAmount = amount;
                const poolTags: string[] = rolls?.poolTags ?? [];

                // ── 要害优先路线：部位判定 + 暴击 + 截断 ──
                const route: string | undefined = effect.parameters.route;
                if (route === 'PRECISION' && effect.parameters.hitTable && target.bodyParts) {
                    const hitTable = effect.parameters.hitTable as HitLocationEntry[];
                    const critConfig: CritConfig = {
                        range: effect.parameters.critRange ?? 20,
                        defaultMultiplier: effect.parameters.critMultiplier ?? 2.0
                    };
                    const d100 = BodyPartResolver.rollD100();
                    const d20 = BodyPartResolver.rollD20();

                    const hitResult = BodyPartResolver.resolveHit(
                        amount, hitTable, d100, d20, critConfig, target.bodyParts, poolTags
                    );

                    effectiveAmount = hitResult.cappedDamage;

                    if (hitResult.partDestroyed) {
                        logger.game(
                            `🎯 [Precision] ${target.id} 的 [${hitResult.part}] 已破坏 → 打空!`,
                            { actionId: template.id, targetId: target.id, part: hitResult.part },
                            LogVisibility.PLAYER, engineCtx
                        );
                        break; // 无伤害，跳过后续
                    }

                    if (hitResult.isCrit) {
                        logger.game(
                            `💥 [Crit!] ${actor.id} 暴击命中 ${target.id} 的 [${hitResult.part}]! 倍率 x${hitResult.critMultiplier} (${amount}→${hitResult.rawDamage})`,
                            { actionId: template.id, targetId: target.id, part: hitResult.part, critMultiplier: hitResult.critMultiplier },
                            LogVisibility.PLAYER, engineCtx
                        );
                    }

                    if (hitResult.overflowDamage > 0) {
                        logger.game(
                            `🛡️ [Cap] 部位 [${hitResult.part}] 伤害截断: ${hitResult.rawDamage} → ${hitResult.cappedDamage} (溢出 ${hitResult.overflowDamage})`,
                            { actionId: template.id, targetId: target.id, part: hitResult.part },
                            LogVisibility.PLAYER, engineCtx
                        );
                    }

                    // 更新部位 HP 状态
                    if (effectiveAmount > 0) {
                        const partResult = BodyPartResolver.applyPartDamage(
                            target.bodyParts!, hitResult.part, hitResult.cappedDamage
                        );
                        if (partResult.destroyed) {
                            logger.game(
                                `💀 [Break!] ${target.id} 的 [${hitResult.part}] 被破坏!`,
                                { targetId: target.id, part: hitResult.part },
                                LogVisibility.PLAYER, engineCtx
                            );
                        }
                        // 记录部位状态变更
                        const partState = target.bodyParts![hitResult.part];
                        recordChange(target.id, `bodyParts.${hitResult.part}`, {
                            currentHp: partState.currentHp,
                            maxHp: partState.maxHp,
                            destroyed: partState.destroyed
                        });
                    }

                    logger.game(
                        `🎯 [Precision] ${actor.id} 命中 ${target.id} 的 [${hitResult.part}] (d100=${d100}, d20=${d20}), 有效伤害=${effectiveAmount}`,
                        { actionId: template.id, targetId: target.id, part: hitResult.part, d100, d20 },
                        LogVisibility.PLAYER, engineCtx
                    );
                }

                // ── AOE 衰减与爆风阴影 (Phase 3.6) ──
                if (effect.targetSelector === 'ALL_IN_AOE') {
                    effectiveAmount = EffectSystem.applyAoeModifiers(
                        effectiveAmount, effect, actor, target, engineCtx
                    );
                }

                const ignoreDr = effect.parameters.ignoreDr === true;
                if (!ignoreDr) {
                    const dr = target.resources.current.armor ?? target.resources.current.dr ?? 0;
                    if (dr > 0) {
                        const beforeDR = effectiveAmount;
                        effectiveAmount = Math.max(0, effectiveAmount - dr);
                        if (effectiveAmount !== beforeDR) {
                            logger.game(`🛡️ [DR] ${target.id} 的护甲减免了 ${beforeDR - effectiveAmount} 点伤害 (DR=${dr})`, null, LogVisibility.PLAYER, engineCtx);
                        }
                    }
                }
                // Phase 3.3: 应用掩体 DR（在护甲 DR 后、最终结算前）
                if (coverDrMap && coverDrMap.has(target.id)) {
                    const coverDr = coverDrMap.get(target.id)!;
                    if (coverDr > 0) {
                        const beforeCover = effectiveAmount;
                        effectiveAmount = Math.max(0, effectiveAmount - coverDr);
                        if (effectiveAmount !== beforeCover) {
                            logger.game(`🧱 [Cover DR] ${target.id} 的掩体减免了 ${beforeCover - effectiveAmount} 点伤害 (Cover DR=${coverDr})`, null, LogVisibility.PLAYER, engineCtx);
                        }
                    }
                }
                const currentVal = target.resources.current[resKey] || 0;
                const newVal = Math.max(0, currentVal - effectiveAmount);
                target.resources.current[resKey] = newVal;

                recordChange(target.id, `resources.current.${resKey}`, newVal);

                logger.game(
                    `[${actor.id}] 施放了 [${template.id}] 造成 ${effectiveAmount} 点伤害`,
                    { actionId: template.id, targetId: target.id, damage: effectiveAmount },
                    LogVisibility.PLAYER,
                    engineCtx
                );
                break;
            }
            case 'HEAL': {
                const currentVal = target.resources.current[resKey] || 0;
                const maxVal = target.resources.max[resKey] || 999;
                const newVal = Math.min(maxVal, currentVal + amount);
                target.resources.current[resKey] = newVal;
                
                recordChange(target.id, `resources.current.${resKey}`, newVal);
                logger.game(
                    `[${actor.id}] 施放了 [${template.id}] 恢复 ${amount} 点 ${resKey}`,
                    { actionId: template.id, targetId: target.id, heal: amount },
                    LogVisibility.PLAYER,
                    engineCtx
                );
                break;
            }
            case 'APPLY_BUFF': {
                logger.game(
                    `✨ [Effect: BUFF] ${target.id} 获得了 Buff: ${effect.parameters.buffId}`,
                    { actionId: template.id, targetId: target.id, buffId: effect.parameters.buffId },
                    LogVisibility.PLAYER,
                    engineCtx
                );
                break;
            }
            default:
                logger.warn(`未知的效果类型: ${effect.type}`, null, engineCtx);
        }
    }

    // ==========================================================
    //  AOE 目标解析与伤害修正 (Phase 3.6)
    // ==========================================================

    /**
     * 解析 ALL_IN_AOE 目标列表
     * 使用 engineCtx 中的 entities 地图查找所有在 AOE 范围内的实体
     */
    private static resolveAoeTargets(
        effect: ActionEffectPayload,
        actor: Entity,
        _primaryTargets: Entity[],
        engineCtx?: { tick?: number; sceneId?: string; entities?: Map<string, Entity> }
    ): Entity[] {
        if (!engineCtx?.entities) {
            logger.warn('ALL_IN_AOE 需要 entities 上下文，返回空列表', null, engineCtx);
            return [];
        }

        const allEntities = Array.from(engineCtx.entities.values());
        const aoeShape = effect.parameters.aoeShape as string;
        const aoeRadius = effect.parameters.aoeRadius as number;

        if (!aoeShape || !aoeRadius) {
            logger.warn('ALL_IN_AOE 缺少 aoeShape/aoeRadius 参数', null, engineCtx);
            return [];
        }

        const origin = { ...actor.transform.coords };
        const config: AoeConfig = {
            shape: aoeShape as any,
            origin,
            facing: actor.transform.facing,
            radius: aoeRadius,
            angle: (effect.parameters.aoeAngle as number) ?? 90,
            width: (effect.parameters.aoeWidth as number) ?? 1
        };

        const inArea = AoeResolver.resolveTargets(allEntities, config)
            .filter(e => e.id !== actor.id); // 排除施法者自身

        // 过滤掉带有 AOE_IMMUNE 标签的实体
        return inArea.filter(e => AoeResolver.isFriendlyFireAffected(e, ''));
    }

    /**
     * 对 AOE 伤害应用衰减和爆风阴影修正
     * 在 executeEffect DAMAGE 分支中调用
     */
    public static applyAoeModifiers(
        effectiveAmount: number,
        effect: ActionEffectPayload,
        actor: Entity,
        target: Entity,
        engineCtx?: { tick?: number; sceneId?: string; entities?: Map<string, Entity> }
    ): number {
        if (effect.targetSelector !== 'ALL_IN_AOE') return effectiveAmount;

        let modified = effectiveAmount;
        const origin = { ...actor.transform.coords };
        const dist = VectorMath.distance(origin, target.transform.coords);

        // 1. 范围衰减
        const ffRadius = effect.parameters.falloffFullRadius as number | undefined;
        const feRadius = effect.parameters.falloffEndRadius as number | undefined;
        const minPct = effect.parameters.falloffMinPercent as number | undefined;

        if (ffRadius !== undefined && feRadius !== undefined && minPct !== undefined) {
            const falloffConfig: DamageFalloffConfig = {
                fullDamageRadius: ffRadius,
                falloffStart: feRadius,
                minDamagePercent: minPct
            };
            // applyFalloffDamage 不包括 DR（DR 在 executeEffect 中统一处理）
            const percent = AoeResolver.calculateFalloff(dist, falloffConfig);
            modified = Math.floor(effectiveAmount * percent);
        }

        // 2. 爆风阴影
        const covers = this.findBlastCovers(engineCtx, origin, target);
        if (covers.length > 0) {
            const shadow = AoeResolver.isInBlastShadow(origin, target, covers);
            if (shadow.inShadow) {
                modified = Math.floor(modified * 0.3);
                logger.game(
                    `🌫️ [BlastShadow] ${target.id} 被掩体遮挡，伤害降为 ${modified}`,
                    null, LogVisibility.PLAYER, engineCtx
                );
            }
        }

        return modified;
    }

    /**
     * 查找爆炸中心与目标之间的掩体（PROP 类型实体）
     */
    private static findBlastCovers(
        engineCtx: { tick?: number; sceneId?: string; entities?: Map<string, Entity> } | undefined,
        blastCenter: { x: number; y: number; z: number },
        target: Entity
    ): Entity[] {
        if (!engineCtx?.entities) return [];
        const covers: Entity[] = [];
        const targetDist = VectorMath.distance(blastCenter, target.transform.coords);
        for (const [, ent] of engineCtx.entities) {
            if (ent.type !== 'PROP') continue;
            const coverDist = VectorMath.distance(blastCenter, ent.transform.coords);
            if (coverDist < targetDist) covers.push(ent);
        }
        return covers;
    }
}
