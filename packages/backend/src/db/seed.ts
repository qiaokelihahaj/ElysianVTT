// 文件位置: packages/backend/src/db/seed.ts
import { prisma } from './prisma.js';

async function main() {
    console.log('🌱 开始播种基础数据...');

    // 0. 播种默认规则包 (Elysian 规则)
    await prisma.rulePack.upsert({
        where: { id: 'elysian' },
        update: {},
        create: {
            id: 'elysian',
            name: 'Elysian 规则',
            description: 'ElysianVTT 默认规则系统 — 硬核战术动作类 TRPG',
            attributeDefsJson: JSON.stringify([
                { key: 'str', label: '力量', default: 10 },
                { key: 'agi', label: '敏捷', default: 10 },
                { key: 'dex', label: '灵巧', default: 10 },
                { key: 'focus', label: '专注', default: 10 },
            ]),
            resourceDefsJson: JSON.stringify([
                { key: 'hp', label: '生命', default: 100, min: 0 },
                { key: 'poise', label: '韧性', default: 50, min: 0, sustain: true },
                { key: 'focus', label: '专注', default: 20, min: 0, sustain: true },
            ]),
            phaseDefsJson: JSON.stringify([
                { key: 'DELAY', label: '预备', canInterrupt: true, canReact: true },
                { key: 'STARTUP', label: '前摇', canInterrupt: true, canReact: true },
                { key: 'ACTIVE', label: '发生', canInterrupt: false, canReact: false },
                { key: 'RECOVERY', label: '收招', canInterrupt: false, canReact: true },
            ]),
            defenseModelJson: JSON.stringify({
                drFormula: 'max(0, armor - penetration)',
                parryFormula: 'agi * 2 + 10',
                dodgeFormula: 'agi * 1.5 + 5',
            }),
        }
    });

    // 1. 播种技能模板
    await prisma.actionTemplate.upsert({
        where: { id: 'HEAVY_STRIKE' },
        update: {},
        create: {
            id: 'HEAVY_STRIKE',
            name: '重击',
            rulePackId: 'elysian',
            startupTicks: 10,
            recoveryTicks: 5,
            effectsJson: JSON.stringify([
                { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: 'actor.str + 2d6' } },
                { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'poise', amountExpr: '5' } }
            ]),
            tagsJson: JSON.stringify(['ATTACK', 'MELEE', 'HEAVY']),
            resourceCostJson: JSON.stringify({ poise: '3', focus: '0' }),
            rangeJson: JSON.stringify({ type: 'MELEE', distanceExpr: '1' }),
            priorityExpr: 'actor.str + 10',
            sustainResourcesJson: JSON.stringify(['poise'])
        }
    });

    // 持续施法：火焰风暴 (3 段 AOE)
    await prisma.actionTemplate.upsert({
        where: { id: 'FIRE_STORM' },
        update: {},
        create: {
            id: 'FIRE_STORM',
            name: '火焰风暴',
            rulePackId: 'elysian',
            startupTicks: 15,
            recoveryTicks: 10,
            effectsJson: JSON.stringify([
                { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '10 + 2d6' } }
            ]),
            tagsJson: JSON.stringify(['SPELL', 'AOE', 'CHANNEL']),
            resourceCostJson: JSON.stringify({ poise: '0', focus: '10' }),
            rangeJson: JSON.stringify({ type: 'RANGED', distanceExpr: '8' }),
            priorityExpr: 'actor.agi + 5',
            sustainResourcesJson: JSON.stringify(['concentration', 'poise']),
            channelOptionsJson: JSON.stringify({
                intervalTicks: 8,
                maxPulses: 3
            })
        }
    });

    // 同步测试技能：所有实体同时释放 (同 Tick ClashPool 测试)
    await prisma.actionTemplate.upsert({
        where: { id: 'SYNC_TEST' },
        update: {},
        create: {
            id: 'SYNC_TEST',
            name: '同步测试',
            rulePackId: 'elysian',
            startupTicks: 10,
            recoveryTicks: 5,
            effectsJson: JSON.stringify([
                { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '25' } },
                { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'poise', amountExpr: '10' } }
            ]),
            tagsJson: JSON.stringify(['TEST', 'SYNC']),
            resourceCostJson: JSON.stringify({ mp: '0' }),
            rangeJson: JSON.stringify({ type: 'MELEE', distanceExpr: '5' }),
            sustainResourcesJson: JSON.stringify([]),
            priorityExpr: 'actor.str * 0.5 + 10'
        }
    });

    // PARRY: 招架 (防御技)
    await prisma.actionTemplate.upsert({
        where: { id: 'PARRY' },
        update: {},
        create: {
            id: 'PARRY',
            name: '招架',
            rulePackId: 'elysian',
            startupTicks: 3,
            recoveryTicks: 6,
            effectsJson: JSON.stringify([]),
            tagsJson: JSON.stringify(['DEFENSE', 'MELEE']),
            resourceCostJson: JSON.stringify({ poise: '5', focus: '0' }),
            rangeJson: JSON.stringify({ type: 'SELF', distanceExpr: '0' }),
            priorityExpr: 'actor.agi + 10',
            sustainResourcesJson: JSON.stringify([])
        }
    });

    // DODGE: 闪避 (防御技)
    await prisma.actionTemplate.upsert({
        where: { id: 'DODGE' },
        update: {},
        create: {
            id: 'DODGE',
            name: '闪避',
            rulePackId: 'elysian',
            startupTicks: 2,
            recoveryTicks: 8,
            effectsJson: JSON.stringify([]),
            tagsJson: JSON.stringify(['MOBILITY', 'DEFENSE']),
            resourceCostJson: JSON.stringify({ poise: '0', focus: '8' }),
            rangeJson: JSON.stringify({ type: 'SELF', distanceExpr: '0' }),
            priorityExpr: 'actor.agi + 15',
            sustainResourcesJson: JSON.stringify([])
        }
    });

    // HIGH_SLASH: 上段斩 (高段攻击)
    await prisma.actionTemplate.upsert({
        where: { id: 'HIGH_SLASH' },
        update: {},
        create: {
            id: 'HIGH_SLASH',
            name: '上段斩',
            rulePackId: 'elysian',
            startupTicks: 8,
            recoveryTicks: 4,
            effectsJson: JSON.stringify([
                { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '15' } }
            ]),
            tagsJson: JSON.stringify(['ATTACK', 'MELEE', 'HIGH']),
            resourceCostJson: JSON.stringify({ poise: '2', focus: '0' }),
            rangeJson: JSON.stringify({ type: 'MELEE', distanceExpr: '1.5' }),
            priorityExpr: 'actor.str + 5',
            sustainResourcesJson: JSON.stringify([])
        }
    });

    // LOW_SWEEP: 下段扫 (低段攻击)
    await prisma.actionTemplate.upsert({
        where: { id: 'LOW_SWEEP' },
        update: {},
        create: {
            id: 'LOW_SWEEP',
            name: '下段扫',
            rulePackId: 'elysian',
            startupTicks: 10,
            recoveryTicks: 5,
            effectsJson: JSON.stringify([
                { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '12' } }
            ]),
            tagsJson: JSON.stringify(['ATTACK', 'MELEE', 'LOW']),
            resourceCostJson: JSON.stringify({ poise: '3', focus: '0' }),
            rangeJson: JSON.stringify({ type: 'MELEE', distanceExpr: '1.5' }),
            priorityExpr: 'actor.str + 3',
            sustainResourcesJson: JSON.stringify([])
        }
    });

    // THRUST: 突刺 (线性攻击)
    await prisma.actionTemplate.upsert({
        where: { id: 'THRUST' },
        update: {},
        create: {
            id: 'THRUST',
            name: '突刺',
            rulePackId: 'elysian',
            startupTicks: 6,
            recoveryTicks: 3,
            effectsJson: JSON.stringify([
                { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: '18' } }
            ]),
            tagsJson: JSON.stringify(['ATTACK', 'MELEE', 'LINEAR']),
            resourceCostJson: JSON.stringify({ poise: '4', focus: '0' }),
            rangeJson: JSON.stringify({ type: 'MELEE', distanceExpr: '2.5' }),
            priorityExpr: 'actor.dex + 8',
            sustainResourcesJson: JSON.stringify([])
        }
    });

    // 2. 播种角色数据
    await prisma.characterSheet.upsert({
        where: { id: 'actor_warrior' },
        update: { currentSceneId: 'room_1' },
        create: {
            id: 'actor_warrior',
            name: '人类战士',
            type: 'ACTOR',
            currentSceneId: 'room_1', // 👈 丢进 room_1
            resourcesJson: JSON.stringify({
                current: { hp: 100, poise: 50, str: 15, focus: 20 },
                max: { hp: 100, poise: 50, str: 15, focus: 20 }
            }),
            transformJson: JSON.stringify({
                coords: { x: 0, y: 0, z: 0 },
                planeId: 'room_1',
                facing: 0
            }),
            physicsJson: JSON.stringify({
                scaleClass: 1, collisionRadius: 0.5, mass: 70, movementModes: ['WALK']
            })
        }
    });

    // 3. 播种哥布林 (位于正前方 2 格)
    await prisma.characterSheet.upsert({
        where: { id: 'target_goblin' },
        update: { currentSceneId: 'room_1' },
        create: {
            id: 'target_goblin',
            name: '哥布林',
            type: 'ACTOR',
            currentSceneId: 'room_1', // 👈 同样丢进 room_1
            resourcesJson: JSON.stringify({
                current: { hp: 30, poise: 10, focus: 15 },
                max: { hp: 30, poise: 10, focus: 15 }
            }),
            transformJson: JSON.stringify({
                coords: { x: 0, y: 2, z: 0 }, // 👈 放在了距离为 2 的位置
                planeId: 'room_1',
                facing: 180
            }),
            physicsJson: JSON.stringify({
                scaleClass: 1, collisionRadius: 0.5, mass: 30, movementModes: ['WALK']
            })
        }
    });

    // 4. 播种骑士 (高护甲坦克)
    await prisma.characterSheet.upsert({
        where: { id: 'actor_knight' },
        update: { currentSceneId: 'room_1' },
        create: {
            id: 'actor_knight',
            name: '骑士',
            type: 'ACTOR',
            currentSceneId: 'room_1',
            resourcesJson: JSON.stringify({
                current: { hp: 150, poise: 80, str: 18, focus: 10, armor: 5 },
                max: { hp: 150, poise: 80, str: 18, focus: 10, armor: 5 }
            }),
            transformJson: JSON.stringify({
                coords: { x: 3, y: 0, z: 0 },
                planeId: 'room_1',
                facing: 0
            }),
            physicsJson: JSON.stringify({
                scaleClass: 1, collisionRadius: 0.8, mass: 90, movementModes: ['WALK']
            })
        }
    });

    // 5. 播种盗贼 (高闪避敏捷型)
    await prisma.characterSheet.upsert({
        where: { id: 'actor_rogue' },
        update: { currentSceneId: 'room_1' },
        create: {
            id: 'actor_rogue',
            name: '盗贼',
            type: 'ACTOR',
            currentSceneId: 'room_1',
            resourcesJson: JSON.stringify({
                current: { hp: 70, poise: 30, str: 10, focus: 30, agi: 25 },
                max: { hp: 70, poise: 30, str: 10, focus: 30, agi: 25 }
            }),
            transformJson: JSON.stringify({
                coords: { x: -3, y: 0, z: 0 },
                planeId: 'room_1',
                facing: 0
            }),
            physicsJson: JSON.stringify({
                scaleClass: 1, collisionRadius: 0.4, mass: 50, movementModes: ['WALK']
            })
        }
    });

    console.log('✅ 数据播种完成！');
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect());