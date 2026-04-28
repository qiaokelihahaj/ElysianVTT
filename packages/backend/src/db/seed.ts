// 文件位置: packages/backend/src/db/seed.ts
import { prisma } from './prisma.js';

async function main() {
    console.log('🌱 开始播种基础数据...');

    // 1. 播种技能模板
    await prisma.actionTemplate.upsert({
        where: { id: 'HEAVY_STRIKE' },
        update: {},
        create: {
            id: 'HEAVY_STRIKE',
            name: '重击',
            startupTicks: 10,
            recoveryTicks: 5,
            effectsJson: JSON.stringify([
                { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: 'actor.str + 2d6' } },
                { type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'poise', amountExpr: '5' } }
            ]),
            // 👈 播种新增的字段
            tagsJson: JSON.stringify(['ATTACK', 'MELEE', 'HEAVY']),
            resourceCostJson: JSON.stringify({ mp: '0' }), // 假设重击不消耗MP
            rangeJson: JSON.stringify({ type: 'MELEE', distanceExpr: '1' })
        }
    });

    // 2. 播种角色数据
    await prisma.characterSheet.upsert({
        where: { id: 'actor_warrior' },
        update: {},
        create: {
            id: 'actor_warrior',
            name: '人类战士',
            type: 'ACTOR',
            currentSceneId: 'room_1', // 👈 丢进 room_1
            resourcesJson: JSON.stringify({
                current: { hp: 100, poise: 50, str: 15 },
                max: { hp: 100, poise: 50, str: 15 }
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
        update: {},
        create: {
            id: 'target_goblin',
            name: '哥布林',
            type: 'ACTOR',
            currentSceneId: 'room_1', // 👈 同样丢进 room_1
            resourcesJson: JSON.stringify({
                current: { hp: 30, poise: 10 },
                max: { hp: 30, poise: 10 }
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


    console.log('✅ 数据播种完成！');
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect());