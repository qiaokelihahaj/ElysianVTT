// 通过公开 intent / event API 锁定拆分前后的弹道与时间线行为。
import assert from 'node:assert/strict';
import { CombatEngine } from '../packages/backend/src/campaigns/engines/CombatEngine.js';
import { Dictionary } from '../packages/backend/src/db/Dictionary.js';
import type { ActionTemplate, Entity, StateMutationPayload, VisualEventPayload } from '../packages/shared/src/index.js';

function actor(id: string, x = 0): Entity {
    return {
        id, templateId: 'test', type: 'ACTOR',
        transform: { coords: { x, y: 0, z: 0 }, planeId: 'test', facing: 0 },
        physics: { scaleClass: 1, collisionRadius: 0.1, mass: 1, movementModes: ['WALK'] },
        resources: { current: { hp: 100, poise: 100 }, max: { hp: 100, poise: 100 } },
        activeEffects: []
    };
}

const shot: ActionTemplate = {
    id: 'extraction-shot', tags: [], resourceCost: {}, effects: [],
    timeCost: { startupTicks: 3, recoveryTicks: 2 },
    range: { type: 'RANGED', distanceExpr: '10' },
    launchProjectile: { trajectoryType: 'LINEAR', speed: 1, ticksPerStep: 1, dieThreshold: 1 }
};
const channel: ActionTemplate = {
    ...shot, id: 'extraction-channel', launchProjectile: undefined,
    channelOptions: { maxPulses: 3, intervalTicks: 4 }
};
const originalLookup = Dictionary.getAction;
const originalRandom = Math.random;
const templates = new Map([shot, channel].map(template => [template.id, template]));
Dictionary.getAction = id => templates.get(id) ?? originalLookup.call(Dictionary, id);
Math.random = () => 0.5;

function setup(name: string) {
    const engine = new CombatEngine(name);
    engine.setPlayerControlledEntities([]);
    const caster = actor('caster');
    engine.mountEntities([caster]);
    const visuals: VisualEventPayload[] = [];
    const states: StateMutationPayload[] = [];
    engine.on('VISUAL_FX', (payload: VisualEventPayload) => visuals.push(structuredClone(payload)));
    engine.on('STATE_MUTATED', (payload: StateMutationPayload) => states.push(structuredClone(payload)));
    return { engine, caster, visuals, states };
}

try {
    // 无目标按朝向发射，创建事件发出时实体已注册，飞行结束后被移除。
    {
        const { engine, caster, visuals } = setup('flight');
        engine.on('VISUAL_FX', (payload: VisualEventPayload) => {
            const spawn = payload.events.find(event => event.fxTemplateId === 'projectile-default');
            if (spawn) assert.ok(engine.getAllEntities().some(entity => entity.id === spawn.targetId));
        });
        engine.receiveIntent({ actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0,
            payload: { actionTemplateId: shot.id } });
        const spawn = visuals.find(payload => payload.events[0]?.fxTemplateId === 'projectile-default');
        assert.equal(spawn?.tick, 3);
        assert.deepEqual(visuals.at(-1)?.events[0].targetCoords, { x: 5, y: 0, z: 0 });
        assert.equal(visuals.at(-1)?.tick, 8);
        assert.deepEqual(engine.getAllEntities().map(entity => entity.id), [caster.id]);
        assert.equal(caster.currentActionContext, undefined);
    }
    // 障碍碰撞后剩余已排队的弹道事件不得重复产生视觉事件。
    {
        const { engine, caster, visuals } = setup('obstacle');
        engine.setObstacles([{ x: 1, y: 0, z: 2 }]);
        engine.receiveIntent({ actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0,
            payload: { actionTemplateId: shot.id } });
        assert.equal(visuals.filter(payload => payload.events.some(event => event.eventType === 'COLLISION')).length, 1);
        assert.equal(visuals.at(-1)?.tick, 4);
        assert.equal(visuals.length, 2);
        assert.equal(engine.getAllEntities().length, 1);
    }
    // 命中伤害进入主引擎的 STATE_MUTATED；固定随机源，避免概率性失败。
    {
        const hit: ActionTemplate = { ...shot, id: 'extraction-hit', effects: [
            { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '7', amount: 7 } }
        ] };
        templates.set(hit.id, hit);
        const { engine, caster, states, visuals } = setup('hit');
        const target = actor('target', 4);
        engine.mountEntities([target]);
        engine.receiveIntent({ actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0,
            payload: { actionTemplateId: hit.id, targetIds: [target.id] } });
        assert.equal(target.resources.current.hp, 93);
        assert.ok(states.some(payload => payload.tick === 7 && payload.mutations.some(
            mutation => mutation.entityId === target.id && mutation.changes['resources.current.hp'] === 93)));
        assert.ok(visuals.some(payload => payload.events.some(event => event.eventType === 'COLLISION' && event.targetId === target.id)));
        assert.equal(engine.getAllEntities().length, 2);
    }
    // 时间线预测随每个脉冲广播，最终收招与预测一致。
    {
        const { engine, caster, states } = setup('channel');
        engine.receiveIntent({ actorId: caster.id, intentType: 'CAST_ACTION', clientTick: 0,
            payload: { actionTemplateId: channel.id } });
        const patches = states.flatMap(payload => payload.actionPatches ?? []);
        assert.equal(patches.length, 3);
        for (const patch of patches) {
            assert.deepEqual(patch.timeline, { start: 0, startupEnd: 3, recoveryStart: 12, end: 14, pulseTicks: [3, 7, 11] });
        }
        assert.equal(engine.currentTick, 14);
        assert.equal(caster.currentActionContext, undefined);
    }
    {
        const { engine, caster, states } = setup('movement');
        engine.receiveIntent({ actorId: caster.id, intentType: 'MOVE', clientTick: 0,
            payload: { targetCoords: { x: 3, y: 0, z: 0 } } });
        const patches = states.flatMap(payload => payload.actionPatches ?? []);
        assert.equal(patches.length, 3);
        assert.equal(caster.transform.coords.x, 3);
        assert.equal(patches.at(-1)?.timeline.end, engine.currentTick);
        assert.equal(patches.at(-1)?.timeline.pulseTicks.length, 3);
    }
    console.log('combat-extraction: 5 public-API characterization scenarios passed');
} finally {
    Dictionary.getAction = originalLookup;
    Math.random = originalRandom;
}
