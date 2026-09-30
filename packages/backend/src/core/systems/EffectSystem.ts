// packages/backend/src/core/systems/EffectSystem.ts
import { Entity, ActionTemplate, ActionEffectPayload, AppliedEffectMetadata, DiceRule, LogVisibility, HitLocationEntry, CritConfig, AoeConfig, DamageFalloffConfig, Vector3D } from '@hard-vtt/shared';
import { RuleEvaluator } from './RuleEvaluator.js';
import { BodyPartResolver } from './BodyPartResolver.js';
import { AoeResolver } from './AoeResolver.js';
import { FormationService } from './FormationService.js';
import { VectorMath } from '../../utils/VectorMath.js';
import { Logger } from '../../utils/Logger.js';
import { CoverService } from './CoverService.js';
import { SpatialSystem } from './SpatialSystem.js';
import { SpatialActionSystem } from './SpatialActionSystem.js';
import type { ActionCatalog } from '../../rules/ActionCatalog.js';

const logger = Logger.create('System:Effect');

interface EffectContext {
    tick?: number;
    sceneId?: string;
    entities?: Map<string, Entity>;
    originCoords?: Vector3D;
    applySpatial?: boolean;
    /** The engine's legacy direct resolver already rolled directional cover. */
    coverChecked?: boolean;
    actionCatalog?: ActionCatalog;
    skipReachCheck?: boolean;
    allowNegativeResources?: boolean | string[];
}

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
        engineCtx?: EffectContext,
        onInterrupt?: (target: Entity) => void,
        coverDrMap?: Map<string, number>  // Phase 3.3: targetId → 掩体 DR
    ): Map<string, Record<string, any>> {
        const mutations = new Map<string, Record<string, any>>(
            engineCtx?.applySpatial === false ? []
                : SpatialActionSystem.applyAction(template, actor, engineCtx?.tick ?? 0, engineCtx?.originCoords),
        );

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
        engineCtx: EffectContext | undefined,
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

        // Buffs are stateful effects and do not require a resource expression.
        if (effect.type === 'APPLY_BUFF') {
            const buffId = typeof effect.parameters.buffId === 'string' ? effect.parameters.buffId : undefined;
            if (!buffId) {
                logger.warn('跳过 APPLY_BUFF: 缺少 buffId', { effect }, engineCtx);
                return;
            }
            const remainingTicks = typeof effect.parameters.durationTicks === 'number'
                ? effect.parameters.durationTicks
                : -1;
            const instanceId = `${template.id}:${target.id}:${engineCtx?.tick ?? 0}:${target.activeEffects.length}`;
            const metadata: AppliedEffectMetadata = {};
            const damageMultiplier = effect.parameters.damageMultiplier;
            if (typeof damageMultiplier === 'number' && Number.isFinite(damageMultiplier) && damageMultiplier >= 0) {
                metadata.damageMultiplier = damageMultiplier;
            }
            if (effect.parameters.negateDamage === true) metadata.negateDamage = true;
            target.activeEffects.push({
                instanceId,
                templateId: buffId,
                sourceEntityId: actor.id,
                remainingTicks,
                stacks: 1,
                metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
            });
            recordChange(target.id, 'activeEffects', target.activeEffects.map(effect => ({ ...effect })));
            logger.game(
                `✨ [Effect: BUFF] ${target.id} 获得了 Buff: ${buffId}`,
                { actionId: template.id, targetId: target.id, buffId },
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
                const isDirect = effect.targetSelector === 'PRIMARY';
                const maxReach = Math.abs(RuleEvaluator.evaluate(template.range.distanceExpr, { actor }).total);
                if (isDirect && !engineCtx?.skipReachCheck && !SpatialActionSystem.inReach(template, actor, target, maxReach)) break;
                const evadeContext = target.currentActionContext;
                const evadeTick = engineCtx?.tick ?? 0;
                const insideEvadeWindow = evadeContext?.phase === 'ACTIVE'
                    && (evadeContext.activeWindowStart === undefined || evadeTick >= evadeContext.activeWindowStart)
                    && (evadeContext.activeWindowEnd === undefined || evadeTick < evadeContext.activeWindowEnd);
                const evadingAction = insideEvadeWindow && evadeContext.actionTemplateId
                    ? engineCtx?.actionCatalog?.getAction(evadeContext.actionTemplateId)
                    : undefined;
                const evadeTags = { DUCK: 'HIGH', HOP: 'LOW', SLIP: 'LINEAR' } as const;
                if (evadingAction?.spatial?.evade
                    && template.attackTags?.includes(evadeTags[evadingAction.spatial.evade])) {
                    logger.game(`🔄 [MicroEvade] ${target.id} 闪过 ${template.id}`,
                        { actorId: actor.id, targetId: target.id }, LogVisibility.PLAYER, engineCtx);
                    break;
                }
                const directionalCover = isDirect ? CoverService.getCoverBetween(actor.transform.coords, target) : null;
                let directionalCoverDr = coverDrMap?.get(target.id) ?? 0;
                if (directionalCover && !engineCtx?.coverChecked) {
                    if (target.currentStance === 'BLIND_FIRE') break;
                    const d20 = Math.floor(Math.random() * 20) + 1;
                    const adjusted = Math.max(1, Math.min(20, d20 + CoverService.getAccuracyModifier(actor.currentStance ?? 'NONE')));
                    if (!CoverService.checkCoverPenetration(directionalCover, adjusted).penetrates) {
                        logger.game(`🧱 [Cover] ${actor.id} 的攻击被 ${target.id} 的掩体阻挡`,
                            { actorId: actor.id, targetId: target.id }, LogVisibility.PLAYER, engineCtx);
                        break;
                    }
                    directionalCoverDr = directionalCover.coverDr;
                }
                if (isDirect && template.spatial?.backstabMultiplier && SpatialSystem.isBackstab(actor, target)) {
                    effectiveAmount = Math.floor(effectiveAmount * template.spatial.backstabMultiplier);
                    logger.game(`🗡️ [Backstab] ${actor.id} 背刺 ${target.id}，伤害 ×${template.spatial.backstabMultiplier}`,
                        { actorId: actor.id, targetId: target.id }, LogVisibility.PLAYER, engineCtx);
                }
                const deadZoneRatio = template.spatial?.reach?.deadZoneRatio;
                if (isDirect && deadZoneRatio !== undefined && maxReach > 0) {
                    const distance = VectorMath.distance(actor.transform.coords, target.transform.coords);
                    const threshold = maxReach * deadZoneRatio;
                    if (distance > threshold && threshold < maxReach) {
                        effectiveAmount = Math.max(0, effectiveAmount - Math.round((distance - threshold) / (maxReach - threshold) * 4));
                    }
                }

                // Defensive behavior is carried by rule-defined effect
                // metadata, so this system stays independent from any demo
                // template ids.  Each guard is consumed by the next hit.
                const defenseIndex = target.activeEffects.findIndex(active =>
                    active.metadata?.negateDamage === true
                    || (typeof active.metadata?.damageMultiplier === 'number' && active.metadata.damageMultiplier >= 0)
                );
                if (defenseIndex >= 0) {
                    const defense = target.activeEffects[defenseIndex];
                    if (defense.metadata?.negateDamage === true) {
                        effectiveAmount = 0;
                        logger.game(`💨 [Guard] ${target.id} 闪避了 ${template.id}`, { targetId: target.id, actionId: template.id }, LogVisibility.PLAYER, engineCtx);
                    } else if (typeof defense.metadata?.damageMultiplier === 'number') {
                        effectiveAmount = Math.floor(effectiveAmount * defense.metadata.damageMultiplier);
                        logger.game(`🛡️ [Guard] ${target.id} 将 ${template.id} 伤害调整为 ${effectiveAmount}`, { targetId: target.id, actionId: template.id, damageMultiplier: defense.metadata.damageMultiplier }, LogVisibility.PLAYER, engineCtx);
                    }
                    target.activeEffects.splice(defenseIndex, 1);
                    recordChange(target.id, 'activeEffects', target.activeEffects.map(active => ({ ...active })));
                }

                // ── Phase 3.5: 阵型主动拦截 ──
                if (isDirect && engineCtx?.entities && engineCtx.entities.size > 0) {
                    const interception = FormationService.checkAttackIntercepted(
                        actor, [target], engineCtx.entities, amount, effectiveAmount, engineCtx
                    );
                    if (interception.intercepted && interception.result) {
                        effectiveAmount = interception.adjustedDamage;
                        if (!interception.result.success) {
                            // 拦截失败：护卫被击退 + 韧性损失
                            const guardian = engineCtx.entities.get(interception.result.interceptorId);
                            if (guardian) {
                                const penalty = FormationService.applyFailurePenalty(guardian);
                                recordChange(guardian.id, 'transform.coords', guardian.transform.coords);
                                recordChange(guardian.id, 'resources.current.poise', guardian.resources.current['poise']);
                            }
                        }
                    }
                }

                // ── 要害优先路线：部位判定 + 暴击 + 截断 ──
                const route: string | undefined = effect.parameters.route;
                if (route === 'PRECISION' && effect.parameters.hitTable && target.bodyParts) {
                    const declaredTable = effect.parameters.hitTable as HitLocationEntry[];
                    const hitTable = directionalCover
                        ? CoverService.filterHitTableByStance(declaredTable, target.currentStance ?? 'NONE')
                        : declaredTable;
                    if (hitTable.length === 0) break;
                    const critConfig: CritConfig = {
                        range: effect.parameters.critRange ?? 20,
                        defaultMultiplier: effect.parameters.critMultiplier ?? 2.0
                    };
                    const d100 = BodyPartResolver.rollD100();
                    const d20 = BodyPartResolver.rollD20();

                    const hitResult = BodyPartResolver.resolveHit(
                        effectiveAmount, hitTable, d100, d20, critConfig, target.bodyParts, poolTags
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
                if (directionalCoverDr > 0) {
                    const coverDr = directionalCoverDr;
                    if (coverDr > 0) {
                        const beforeCover = effectiveAmount;
                        effectiveAmount = Math.max(0, effectiveAmount - coverDr);
                        if (effectiveAmount !== beforeCover) {
                            logger.game(`🧱 [Cover DR] ${target.id} 的掩体减免了 ${beforeCover - effectiveAmount} 点伤害 (Cover DR=${coverDr})`, null, LogVisibility.PLAYER, engineCtx);
                        }
                    }
                }
                const currentVal = target.resources.current[resKey] || 0;
                const allowNegative = engineCtx?.allowNegativeResources === true
                    || (Array.isArray(engineCtx?.allowNegativeResources)
                        && engineCtx.allowNegativeResources.includes(resKey));
                // HP is always clamped.  RulePack-defined sustain resources can
                // remain negative until the startup interruption check runs.
                const newVal = resKey === 'hp' || !allowNegative
                    ? Math.max(0, currentVal - effectiveAmount)
                    : currentVal - effectiveAmount;
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
                const maxVal = target.resources.max[resKey] ?? 999;
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
        engineCtx?: EffectContext
    ): Entity[] {
        if (!engineCtx?.entities) {
            logger.warn('ALL_IN_AOE 需要 entities 上下文，返回空列表', null, engineCtx);
            return [];
        }

        const allEntities = Array.from(engineCtx.entities.values()).filter(entity => entity.type !== 'PROJECTILE'
            && (entity.resources.current.hp ?? 1) > 0);
        const aoeShape = effect.parameters.aoeShape as string;
        const aoeRadius = effect.parameters.aoeRadius as number;

        if (!aoeShape || !aoeRadius) {
            logger.warn('ALL_IN_AOE 缺少 aoeShape/aoeRadius 参数', null, engineCtx);
            return [];
        }

        const origin = { ...(engineCtx.originCoords ?? actor.transform.coords) };
        const config: AoeConfig = {
            shape: aoeShape as any,
            origin,
            facing: actor.transform.facing,
            radius: aoeRadius,
            angle: (effect.parameters.aoeAngle as number) ?? 90,
            width: (effect.parameters.aoeWidth as number) ?? 1
        };

        const inArea = AoeResolver.resolveTargets(allEntities, config)
            .filter(e => e.id !== actor.id || effect.parameters.includeSelf === true);

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
        engineCtx?: EffectContext
    ): number {
        if (effect.targetSelector !== 'ALL_IN_AOE') return effectiveAmount;

        let modified = effectiveAmount;
        const origin = { ...(engineCtx?.originCoords ?? actor.transform.coords) };
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
            if ((ent.resources.current.hp ?? 1) <= 0 || !ent.coverState) continue;
            const coverDist = VectorMath.distance(blastCenter, ent.transform.coords);
            if (coverDist < targetDist) covers.push(ent);
        }
        return covers;
    }
}
