import assert from 'node:assert/strict';
import type { ActionTemplate, Entity, ProjectileAdvanceEvent, StateMutationPayload, TacticalStance, Vector3D, VisualEventPayload } from '../packages/shared/src/index.js';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { CombatProjectileRuntime } from '../packages/backend/src/campaigns/engines/CombatProjectileRuntime.js';
import { InMemoryActionCatalog } from '../packages/backend/src/rules/ActionCatalog.js';
import { Projectile } from '../packages/backend/src/core/entities/Projectile.js';
import { ProjectileSystem } from '../packages/backend/src/core/systems/ProjectileSystem.js';
import { Logger } from '../packages/backend/src/utils/Logger.js';

function actor(id: string, x: number, y = 0): Entity {
    return {
        id, templateId: 'spatial-test', type: 'ACTOR',
        transform: { coords: { x, y, z: 0 }, planeId: 'test', facing: 0 },
        physics: { scaleClass: 1, collisionRadius: 0.1, mass: 1, movementModes: ['WALK'] },
        resources: { current: { hp: 100, poise: 100, power: 12 }, max: { hp: 100, poise: 100, power: 12 } },
        activeEffects: [],
    };
}

function shot(id: string): ActionTemplate {
    return {
        id, tags: [], resourceCost: {},
        timeCost: { startupTicks: 2, recoveryTicks: 1 },
        range: { type: 'RANGED', distanceExpr: '20' },
        launchProjectile: { trajectoryType: 'LINEAR', speed: 1, ticksPerStep: 1, dieThreshold: 1 },
        effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: 'actor.power + 1d6' } }],
    };
}

function makeProjectile(id: string, template: ActionTemplate): Projectile {
    return new Projectile({
        id, templateId: id, sourceEntityId: 'caster', sourceActionTemplateId: template.id,
        transform: { coords: { x: 0, y: 0, z: 0 }, planeId: 'test', facing: 0 },
        physics: { scaleClass: 0, collisionRadius: 0.3, mass: 0.1, movementModes: ['PROJECTILE'] },
        resources: { current: {}, max: {} }, dieThreshold: 1,
        trajectoryType: template.launchProjectile?.trajectoryType,
        speed: template.launchProjectile?.speed,
        maxHeight: template.launchProjectile?.maxHeight,
    });
}

function runFlight(projectile: Projectile, template: ActionTemplate, to: Vector3D, entities: Map<string, Entity>, obstacles: Vector3D[]) {
    const catalog = new InMemoryActionCatalog([template]);
    const events = ProjectileSystem.scheduleProjectile(projectile, { x: 0, y: 0, z: 0 }, to, 0);
    return events.map(event => ProjectileSystem.resolveAdvance(projectile, event, entities, obstacles, catalog));
}

const originalRandom = Math.random;
Math.random = () => 0.5;
try {
    // 真实引擎必须在命中时求值一次，发射不应提前造成伤害。
    {
        const template = shot('production-shot');
        const engine = new CombatEngine('spatial-projectile-impact', new InMemoryActionCatalog([template]));
        engine.setPlayerControlledEntities([]);
        engine.setAutoProcess(false);
        const caster = actor('caster', 0);
        const target = actor('target', 4);
        target.resources.current.armor = 2;
        engine.mountEntities([caster, target]);
        const states: StateMutationPayload[] = [];
        engine.on('STATE_MUTATED', (payload: StateMutationPayload) => states.push(structuredClone(payload)));
        engine.receiveIntent({ actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0,
            payload: { actionTemplateId: template.id, targetIds: [target.id] } });
        engine.processPending(1);
        assert.equal(engine.currentTick, 2);
        assert.equal(target.resources.current.hp, 100, 'launch must not apply projectile damage');
        caster.resources.current.power = 20;
        engine.processPending();
        assert.equal(target.resources.current.hp, 78, 'impact evaluates source actor stats, fixed d6=4, and armor exactly once');
        assert.equal(states.flatMap(state => state.mutations).filter(change =>
            change.entityId === target.id && change.changes['resources.current.hp'] === 78).length, 1);
        assert.equal(engine.getAllEntities().filter(entity => entity.type === 'PROJECTILE').length, 0);
    }
    // 空格投掷以落点为爆心；友军受伤，免疫实体与发射者不受伤。
    {
        const template: ActionTemplate = {
            ...shot('production-cell-blast'),
            launchProjectile: { trajectoryType: 'PARABOLIC', speed: 1, ticksPerStep: 1, maxHeight: 4, dieThreshold: 1 },
            effects: [{ type: 'DAMAGE', targetSelector: 'ALL_IN_AOE', parameters: {
                resource: 'hp', amountExpr: 'actor.power', aoeShape: 'CIRCULAR', aoeRadius: 2,
            } }],
        };
        const caster = actor('caster', 0);
        const enemy = actor('enemy', 6, 1);
        const ally = actor('ally', 7, 1);
        const immune = actor('immune', 6, -1);
        caster.tags = ['FACTION_ALLY'];
        ally.tags = ['FACTION_ALLY'];
        enemy.tags = ['FACTION_ENEMY'];
        immune.tags = ['AOE_IMMUNE'];
        const outside = actor('outside', 3, 2);
        const engine = new CombatEngine('spatial-cell-blast', new InMemoryActionCatalog([template]));
        engine.setPlayerControlledEntities([]);
        engine.mountEntities([caster, enemy, ally, immune, outside]);
        engine.receiveIntent({ actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0,
            payload: { actionTemplateId: template.id, targetCoords: { x: 6, y: 0, z: 0 } } });
        assert.equal(enemy.resources.current.hp, 88);
        assert.equal(ally.resources.current.hp, 88);
        assert.equal(immune.resources.current.hp, 100);
        assert.equal(outside.resources.current.hp, 100);
        assert.equal(caster.resources.current.hp, 100);
    }
    // 高速弹道使用扫掠检测；目标迭代顺序不能让远端抢先承受伤害。
    {
        const template = shot('production-swept-shot');
        template.launchProjectile!.speed = 6;
        const caster = actor('caster', 0);
        const far = actor('far', 5);
        const near = actor('near', 2);
        const entities = new Map([caster, far, near].map(entity => [entity.id, entity]));
        const projectile = makeProjectile('swept', template);
        const results = runFlight(projectile, template, { x: 6, y: 0, z: 0 }, entities, []);
        assert.equal(near.resources.current.hp, 84);
        assert.equal(far.resources.current.hp, 100);
        assert.equal(results[0].collisionResult?.targetId, near.id);
        const duplicate: ProjectileAdvanceEvent = {
            eventId: 'duplicate', eventType: 'PROJECTILE_ADVANCE', targetTick: 2, status: 'PENDING',
            projectileId: projectile.id, waypointIndex: 0, fromCoords: { x: 0, y: 0, z: 0 },
            toCoords: { x: 6, y: 0, z: 0 }, isLastStep: true,
        };
        assert.equal(ProjectileSystem.resolveAdvance(projectile, duplicate, entities, [], new InMemoryActionCatalog([template])).damageMutations.size, 0);
        assert.equal(near.resources.current.hp, 84);
    }
    // 同一生产路径：直射被矮墙挡住，抛物线越过矮墙但不能穿过高墙。
    {
        function hits(trajectoryType: 'LINEAR' | 'PARABOLIC', wallHeight: number) {
            const template = shot(`wall-${trajectoryType}-${wallHeight}`);
            template.launchProjectile = { trajectoryType, speed: 1, ticksPerStep: 1, maxHeight: 4, dieThreshold: 1 };
            const caster = actor('caster', 0);
            const target = actor('target', 6);
            const projectile = makeProjectile(template.id, template);
            runFlight(projectile, template, target.transform.coords,
                new Map([caster, target].map(entity => [entity.id, entity])), [{ x: 3, y: 0, z: wallHeight }]);
            return target.resources.current.hp;
        }
        assert.equal(hits('LINEAR', 1), 100);
        assert.equal(hits('PARABOLIC', 1), 84);
        assert.equal(hits('PARABOLIC', 8), 100);
    }
    // 正式效果系统仍消费 guard 并执行部位伤害；投射物不复制一套简化伤害公式。
    {
        const template = shot('production-guard-shot');
        const caster = actor('caster', 0);
        const guarded = actor('guarded', 4);
        guarded.resources.current.armor = 2;
        guarded.activeEffects = [{ instanceId: 'guard', templateId: 'guard', sourceEntityId: guarded.id,
            remainingTicks: 10, stacks: 1, metadata: { damageMultiplier: 0.5 } }];
        runFlight(makeProjectile('guard-flight', template), template, guarded.transform.coords,
            new Map([caster, guarded].map(entity => [entity.id, entity])), []);
        assert.equal(guarded.resources.current.hp, 94);
        assert.equal(guarded.activeEffects.length, 0);

        const precision: ActionTemplate = {
            ...shot('production-precision-shot'),
            effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: {
                resource: 'hp', amountExpr: 'actor.power + 1d6', route: 'PRECISION',
                hitTable: [{ part: 'HEAD', weight: 100, damageCap: 8 }],
            } }],
        };
        const target = actor('precision-target', 4);
        target.bodyParts = { HEAD: { currentHp: 30, maxHp: 30, destroyed: false } };
        const results = runFlight(makeProjectile('precision-flight', precision), precision, target.transform.coords,
            new Map([caster, target].map(entity => [entity.id, entity])), []);
        assert.equal(target.resources.current.hp, 92);
        assert.equal(target.bodyParts.HEAD.currentHp, 22);
        assert.ok(results.some(result => result.damageMutations.get(target.id)?.['bodyParts.HEAD']));
    }
    // 配置开火高度越过半掩体，但仍能命中地面角色且会被全掩体阻挡。
    {
        function elevatedShot(coverHeight: number, destroyed = false) {
            const template = shot(`production-elevated-${coverHeight}`);
            template.launchProjectile!.launchHeight = 1.5;
            const caster = actor('caster', 0);
            const target = actor('target', 4);
            const cover = actor('wall', 2);
            cover.type = 'PROP';
            if (destroyed) cover.resources.current.hp = 0;
            cover.coverState = { coverDefId: 'test-wall', coverType: coverHeight <= 1 ? 'HALF' : 'FULL',
                coverDr: 0, coverThreshold: 10, facing: 180, height: coverHeight };
            const engine = new CombatEngine(template.id, new InMemoryActionCatalog([template]));
            engine.setPlayerControlledEntities([]);
            engine.mountEntities([caster, target, cover]);
            engine.receiveIntent({ actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0,
                payload: { actionTemplateId: template.id, targetIds: [target.id] } });
            return { targetHp: target.resources.current.hp, coverHp: cover.resources.current.hp };
        }
        assert.deepEqual(elevatedShot(1), { targetHp: 84, coverHp: 100 });
        assert.deepEqual(elevatedShot(2.5), { targetHp: 100, coverHp: 84 });
        assert.deepEqual(elevatedShot(2.5, true), { targetHp: 84, coverHp: 0 });
    }
    // 发射者飞行期间离开射程不会撤销已经到达的弹道；SELF 不在落点重复执行。
    {
        const template = shot('production-moving-source');
        template.effects.push({ type: 'HEAL', targetSelector: 'SELF', parameters: { resource: 'hp', amountExpr: '10' } });
        const caster = actor('caster', 100);
        caster.resources.current.hp = 50;
        const target = actor('target', 4);
        runFlight(makeProjectile('moving-source-flight', template), template, target.transform.coords,
            new Map([caster, target].map(entity => [entity.id, entity])), []);
        assert.equal(target.resources.current.hp, 84);
        assert.equal(caster.resources.current.hp, 50);
    }
    // 实际发射应用姿态精度和撩枪偏移；固定 d20=11，ADS 能把原本未命中的射击变成命中。
    {
        function stanceShot(stance: TacticalStance, dieThreshold: number, largeTarget = false) {
            const template = shot(`production-stance-${stance}-${dieThreshold}`);
            template.launchProjectile!.dieThreshold = dieThreshold;
            const caster = actor('caster', 0);
            caster.currentStance = stance;
            const target = actor('target', 4);
            if (largeTarget) target.physics.collisionRadius = 2;
            const engine = new CombatEngine(template.id, new InMemoryActionCatalog([template]));
            engine.setPlayerControlledEntities([]);
            engine.setAutoProcess(false);
            engine.mountEntities([caster, target]);
            engine.receiveIntent({ actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0,
                payload: { actionTemplateId: template.id, targetIds: [target.id] } });
            engine.processPending(1);
            const projectile = engine.getAllEntities().find(entity => entity.type === 'PROJECTILE');
            assert.ok(projectile instanceof Projectile);
            const destination = { ...projectile.targetCoords! };
            const threshold = projectile.dieThreshold;
            engine.processPending();
            return { destination, threshold, targetHp: target.resources.current.hp };
        }
        assert.equal(stanceShot('NONE', 12).targetHp, 100);
        assert.equal(stanceShot('ADS', 12).targetHp, 84);
        assert.equal(stanceShot('NONE', 10, true).targetHp, 84);
        const blind = stanceShot('BLIND_FIRE', 10, true);
        assert.equal(blind.threshold, 14);
        assert.equal(blind.destination.x, 2.5);
        assert.ok(Math.abs(blind.destination.y) < 0.0001);
        assert.equal(blind.targetHp, 100);

        const cellTemplate = shot('production-blind-cell');
        const cellCaster = actor('caster', 0);
        cellCaster.currentStance = 'BLIND_FIRE';
        const cellEngine = new CombatEngine(cellTemplate.id, new InMemoryActionCatalog([cellTemplate]));
        cellEngine.setPlayerControlledEntities([]);
        cellEngine.setAutoProcess(false);
        cellEngine.mountEntities([cellCaster]);
        cellEngine.receiveIntent({ actorId: cellCaster.id, intentType: 'CAST_ACTION', clientTick: 0,
            payload: { actionTemplateId: cellTemplate.id, targetCoords: { x: 6, y: 0, z: 0 } } });
        cellEngine.processPending(1);
        const cellProjectile = cellEngine.getAllEntities().find(entity => entity.type === 'PROJECTILE');
        assert.ok(cellProjectile instanceof Projectile);
        assert.equal(cellProjectile.targetCoords?.x, 4.5, 'blind-fire deviation also changes explicit cell destinations');
        cellEngine.processPending();
    }
    // 最小射程导致空弹道时不注册无法清理的投射物，也不排队或发出发射特效。
    {
        const template = shot('production-empty-path');
        template.launchProjectile!.minRange = 3;
        const caster = actor('caster', 0);
        const entities = new Map([[caster.id, caster]]);
        const scheduled: ProjectileAdvanceEvent[] = [];
        const visuals: VisualEventPayload[] = [];
        const runtime = new CombatProjectileRuntime({
            entities, currentTick: () => 0, schedule: event => scheduled.push(event), recordMutation: () => {},
            emitVisual: payload => visuals.push(payload), logger: Logger.create('Test:Projectile'),
            logContext: () => ({ tick: 0, sceneId: 'empty-path', entities }),
            getActionCatalog: () => new InMemoryActionCatalog([template]),
        });
        runtime.launch(caster, { eventId: 'empty-launch', eventType: 'ACTION_PHASE', phase: 'ACTIVE',
            actorId: caster.id, actionTemplateId: template.id, targetTick: 0, status: 'PENDING',
            targetCoords: { x: 1, y: 0, z: 0 } }, template);
        assert.equal(entities.size, 1);
        assert.equal(scheduled.length, 0);
        assert.ok(visuals.every(payload => payload.events.every(event => event.fxTemplateId !== 'projectile-default')));
    }
    // 投射物朝向来自实际射线，而不是发射者的旧朝向。
    {
        const template = shot('production-projectile-bearing');
        const caster = actor('caster', 0);
        caster.transform.facing = 90;
        const entities = new Map([[caster.id, caster]]);
        const runtime = new CombatProjectileRuntime({
            entities, currentTick: () => 0, schedule: () => {}, recordMutation: () => {}, emitVisual: () => {},
            logger: Logger.create('Test:Projectile'), logContext: () => ({ tick: 0, sceneId: 'bearing', entities }),
            getActionCatalog: () => new InMemoryActionCatalog([template]),
        });
        runtime.launch(caster, { eventId: 'bearing-launch', eventType: 'ACTION_PHASE', phase: 'ACTIVE',
            actorId: caster.id, actionTemplateId: template.id, targetTick: 0, status: 'PENDING',
            targetCoords: { x: -4, y: 0, z: 0 } }, template);
        const projectile = [...entities.values()].find(entity => entity.type === 'PROJECTILE');
        assert.equal(projectile?.transform.facing, 180);
        assert.equal(caster.transform.facing, 90);
        runtime.reset();
    }
    // 规则明确 includeSelf 时，施法者在爆心附近也受到伤害；旧模板保留自身豁免。
    {
        function selfBlast(includeSelf: boolean) {
            const template: ActionTemplate = {
                ...shot(`production-self-blast-${includeSelf}`),
                launchProjectile: { trajectoryType: 'PARABOLIC', speed: 1, ticksPerStep: 1, maxHeight: 4, dieThreshold: 1 },
                effects: [{ type: 'DAMAGE', targetSelector: 'ALL_IN_AOE', parameters: {
                    resource: 'hp', amountExpr: 'actor.power', aoeShape: 'CIRCULAR', aoeRadius: 3, includeSelf,
                } }],
            };
            const caster = actor('caster', 0);
            const engine = new CombatEngine(template.id, new InMemoryActionCatalog([template]));
            engine.setPlayerControlledEntities([]);
            engine.mountEntities([caster]);
            engine.receiveIntent({ actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0,
                payload: { actionTemplateId: template.id, targetCoords: { x: 2, y: 0, z: 0 } } });
            return caster.resources.current.hp;
        }
        assert.equal(selfBlast(false), 100);
        assert.equal(selfBlast(true), 88);
    }
    console.log('spatial-projectile-production: 11 production scenarios passed');
} finally {
    Math.random = originalRandom;
}
