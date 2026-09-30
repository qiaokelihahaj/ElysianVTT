import { hexOffsetToAxial } from '@hard-vtt/shared';
import type { ActionTemplate, BodyPart, EncounterEntity, EncounterRulePack, MapData, Vector3D } from '@hard-vtt/shared';
import { createDemoContent, createDemoEntity } from './DemoContent.js';

export const SPATIAL_TACTICS_RULE_PACK_ID = 'elysian-spatial-tactics-v1';
export const TACTIC_ACTION_IDS = {
    MOVE: 'TACTIC_SPRINT', SPEAR: 'TACTIC_SPEAR', PRECISION: 'TACTIC_PRECISION',
    SHOT: 'TACTIC_LINEAR_SHOT', LOB: 'TACTIC_LOB', CONE: 'TACTIC_CONE', LINE: 'TACTIC_LINE',
    BACKSTAB: 'TACTIC_BACKSTAB', ADS: 'TACTIC_ADS', BLIND: 'TACTIC_BLIND_FIRE',
    TURN_LEFT: 'TACTIC_TURN_LEFT', TURN_RIGHT: 'TACTIC_TURN_RIGHT', GUARD: 'TACTIC_GUARD',
    UNGUARD: 'TACTIC_UNGUARD', ZONE: 'TACTIC_BLOCK_ZONE', DROP: 'TACTIC_DROP_WEAPON',
    EQUIP_SPEAR: 'TACTIC_EQUIP_SPEAR', EQUIP_SIDEARM: 'TACTIC_EQUIP_SIDEARM',
    EQUIP_RIFLE: 'TACTIC_EQUIP_RIFLE', SIDEARM: 'TACTIC_SIDEARM', DODGE: 'TACTIC_DODGE',
    DUCK: 'TACTIC_DUCK', HOP: 'TACTIC_HOP', SLIP: 'TACTIC_SLIP',
} as const;

function action(id: string, label: string, description: string, overrides: Partial<ActionTemplate> = {}): ActionTemplate {
    return {
        id, label, description, tags: ['TACTICAL'], targetKind: 'none',
        timeCost: { startupTicks: 2, recoveryTicks: 1 }, resourceCost: {},
        range: { type: 'SELF', distanceExpr: '0' }, priorityExpr: 'actor.agi', effects: [],
        rulePackId: SPATIAL_TACTICS_RULE_PACK_ID, ...overrides,
    };
}

function hit(damage: number): ActionTemplate['effects'] {
    return [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: { resource: 'hp', amountExpr: String(damage) } }];
}

const partTable = (['HEAD', 'TORSO', 'LEFT_ARM', 'RIGHT_ARM', 'LEFT_LEG', 'RIGHT_LEG'] as BodyPart[])
    .map((part, index) => ({ part, weight: index === 1 ? 30 : 14, damageCap: part === 'TORSO' ? 24 : 16 }));

export const TACTIC_ACTION_TEMPLATES: ActionTemplate[] = [
    action(TACTIC_ACTION_IDS.MOVE, '冲刺移动', '选择空地，沿事件路径逐步接近；连续步进加速，实体与墙体会阻挡路径。', {
        tags: ['MOVEMENT'], targetKind: 'cell', timeCost: { startupTicks: 4, recoveryTicks: 2 },
        range: { type: 'MOVEMENT', distanceExpr: '12' },
    }),
    action(TACTIC_ACTION_IDS.SPEAR, '长枪突刺', '有效触及 1–3；贴身死角会挥空，极限距离有伤害惩罚。先装备长枪。', {
        tags: ['ATTACK'], targetKind: 'entity', timeCost: { startupTicks: 3, recoveryTicks: 3 },
        range: { type: 'MELEE', distanceExpr: '3' }, spatial: { requiredWeaponId: 'spear', reach: { minReach: 1, deadZoneRatio: 0.7 } },
        activeWindowTicks: 2, attackTags: ['LINEAR'], effects: hit(24),
    }),
    action(TACTIC_ACTION_IDS.PRECISION, '要害重击', '要害路线：随机部位、重击与伤害上限；破坏部位后再次命中会打空。', {
        tags: ['ATTACK'], targetKind: 'entity', range: { type: 'MELEE', distanceExpr: '2' },
        timeCost: { startupTicks: 3, recoveryTicks: 3 }, activeWindowTicks: 2,
        attackTags: ['HIGH'],
        effects: [{ type: 'DAMAGE', targetSelector: 'PRIMARY', parameters: {
            resource: 'hp', amountExpr: '20', route: 'PRECISION', hitTable: partTable, critRange: 18, critMultiplier: 2,
        } }],
    }),
    action(TACTIC_ACTION_IDS.SHOT, '直射弹道', '真实投射物逐事件飞行；途中实体可能截获，高墙柱会阻挡，枪口高于低沙袋时可以越过。先装备步枪。', {
        tags: ['ATTACK', 'PROJECTILE'], targetKind: 'entity', resourceCost: { focus: '1' },
        range: { type: 'RANGED', distanceExpr: '12' }, spatial: { requiredWeaponId: 'rifle' },
        launchProjectile: { trajectoryType: 'LINEAR', speed: 1, launchHeight: 1.5, ticksPerStep: 1, dieThreshold: 8 }, effects: hit(20),
    }),
    action(TACTIC_ACTION_IDS.LOB, '抛射爆弹', '选择落点，抛物线越过低掩体；落地爆炸半径 2.8，含友伤、衰减与爆风阴影。近于 2 的落点属于盲区。', {
        tags: ['ATTACK', 'PROJECTILE', 'AOE'], targetKind: 'cell', resourceCost: { focus: '2' },
        timeCost: { startupTicks: 4, recoveryTicks: 3 }, range: { type: 'RANGED', distanceExpr: '12', radiusExpr: '2.8' },
        launchProjectile: { trajectoryType: 'PARABOLIC', speed: 1, maxHeight: 4, minRange: 2, ticksPerStep: 1 },
        effects: [{ type: 'DAMAGE', targetSelector: 'ALL_IN_AOE', parameters: {
            resource: 'hp', amountExpr: '30', aoeShape: 'CIRCULAR', aoeRadius: 2.8,
            includeSelf: true,
            falloffFullRadius: 0.8, falloffEndRadius: 2.8, falloffMinPercent: 0.25,
        } }],
    }),
    ...(['CONE', 'LINE'] as const).map(shape => action(
        shape === 'CONE' ? TACTIC_ACTION_IDS.CONE : TACTIC_ACTION_IDS.LINE,
        shape === 'CONE' ? '扇形扫荡' : '线形贯穿',
        shape === 'CONE' ? '沿当前朝向展开 90°、长 4 的扇形，伤害所有范围内角色，包括友军。' : '沿当前朝向打出长 6、半宽 0.6 的线形攻击，包括友军。先转身调整方向。',
        { tags: ['ATTACK', 'AOE'], ...(shape === 'CONE' ? { attackTags: ['LOW' as const] } : {}), resourceCost: { focus: '2' }, timeCost: { startupTicks: 3, recoveryTicks: 3 },
            effects: [{ type: 'DAMAGE', targetSelector: 'ALL_IN_AOE', parameters: {
                resource: 'hp', amountExpr: '18', aoeShape: shape === 'CONE' ? 'CONICAL' : 'LINEAR',
                aoeRadius: shape === 'CONE' ? 4 : 6, aoeAngle: 90, aoeWidth: 0.6,
            } }],
        },
    )),
    action(TACTIC_ACTION_IDS.BACKSTAB, '侧翼背刺', '绕到目标朝向的背面造成 1.5 倍伤害；正面命中为普通伤害。', {
        tags: ['ATTACK'], targetKind: 'entity', range: { type: 'MELEE', distanceExpr: '1.8' },
        activeWindowTicks: 2, spatial: { backstabMultiplier: 1.5 }, effects: hit(22),
    }),
    action(TACTIC_ACTION_IDS.ADS, '架枪姿态', '花费 5 Tick 架枪；提高射击精度，同时暴露头部和双臂。', {
        timeCost: { startupTicks: 5, recoveryTicks: 1 }, spatial: { stance: 'ADS' },
    }),
    action(TACTIC_ACTION_IDS.BLIND, '撩枪姿态', '花费 3 Tick 切换撩枪，减少暴露但投射物有落点偏移。', {
        timeCost: { startupTicks: 3, recoveryTicks: 1 }, spatial: { stance: 'BLIND_FIRE' },
    }),
    action(TACTIC_ACTION_IDS.TURN_LEFT, '左转 60°', '消耗行动时间改变朝向；影响背刺、扇形和线形覆盖。', { spatial: { rotationDelta: -60 } }),
    action(TACTIC_ACTION_IDS.TURN_RIGHT, '右转 60°', '消耗行动时间改变朝向；影响背刺、扇形和线形覆盖。', { spatial: { rotationDelta: 60 } }),
    action(TACTIC_ACTION_IDS.GUARD, '护卫阵型', '部署邻近同阵营主动护卫，成功拦截减伤 50%；多个护卫提供协作加成。', {
        resourceCost: { poise: '1' }, spatial: { guard: { bodyBlocking: true, interceptConfig: {
            interceptRange: 2, interceptionRating: 24, coopBonusPerAlly: 2, maxCoopBonus: 6,
            interceptDamageReduction: 0.5, failurePenaltyPoise: 2, failureKnockback: 1,
        } } },
    }),
    action(TACTIC_ACTION_IDS.UNGUARD, '解除护卫', '撤除主动护卫，保留实体占位。', { spatial: { guard: { bodyBlocking: true } } }),
    action(TACTIC_ACTION_IDS.ZONE, '封锁通道', '选择 4 格内落点，建立半径 1.2 的封锁区，持续 18 Tick；敌人进入受到 8 伤害。', {
        targetKind: 'cell', range: { type: 'RANGED', distanceExpr: '4' }, resourceCost: { poise: '2' },
        spatial: { blockZone: { radius: 1.2, durationTicks: 18, triggerDamage: 8 } },
    }),
    action(TACTIC_ACTION_IDS.DROP, '弃武器', '放弃当前武器，相关武器攻击暂时不可用；可以接着换用副武器。', {
        timeCost: { startupTicks: 1, recoveryTicks: 1 }, spatial: { weaponOperation: { type: 'DROP' } },
    }),
    ...(['spear', 'sidearm', 'rifle'] as const).map(weaponId => action(
        { spear: TACTIC_ACTION_IDS.EQUIP_SPEAR, sidearm: TACTIC_ACTION_IDS.EQUIP_SIDEARM, rifle: TACTIC_ACTION_IDS.EQUIP_RIFLE }[weaponId],
        { spear: '装备长枪', sidearm: '切换副武器', rifle: '装备步枪' }[weaponId],
        '耗时切换装备，随后才能使用对应武器攻击。', { spatial: { weaponOperation: { type: 'EQUIP', weaponId } } },
    )),
    action(TACTIC_ACTION_IDS.SIDEARM, '副武器速击', '弃长武器后可切副武器进行贴身攻击，没有长枪的最短距离限制。', {
        tags: ['ATTACK'], targetKind: 'entity', range: { type: 'MELEE', distanceExpr: '1.5' },
        spatial: { requiredWeaponId: 'sidearm' }, activeWindowTicks: 2, effects: hit(14),
    }),
    action(TACTIC_ACTION_IDS.DODGE, '位移闪避', '选择附近空地，真实位移躲开生效窗口；没有无敌帧，范围攻击仍会命中。', {
        tags: ['MOVEMENT', 'DEFENSE'], targetKind: 'cell', resourceCost: { focus: '1' },
        timeCost: { startupTicks: 1, recoveryTicks: 3 }, range: { type: 'MOVEMENT', distanceExpr: '2' },
    }),
    ...(['DUCK', 'HOP', 'SLIP'] as const).map(evade => action(
        TACTIC_ACTION_IDS[evade], { DUCK: '下潜微避', HOP: '小跳微避', SLIP: '侧闪微避' }[evade],
        `原地保持 3 Tick 微避窗口，只规避${{ DUCK: '上段 HIGH', HOP: '下段 LOW', SLIP: '指向 LINEAR' }[evade]}攻击；其他标签和无标签爆炸仍然命中。`,
        { tags: ['DEFENSE'], resourceCost: { focus: '1' }, activeWindowTicks: 3,
            timeCost: { startupTicks: 1, recoveryTicks: 2 }, spatial: { evade } },
    )),
];

const bodyParts = (): EncounterEntity['bodyParts'] => Object.fromEntries(partTable.map(({ part }) => [part, {
    currentHp: part === 'TORSO' ? 40 : 24, maxHp: part === 'TORSO' ? 40 : 24, destroyed: false,
}]));

function actor(key: string, id: string, displayName: string, coords: Vector3D, equippedWeaponId: string): EncounterEntity {
    const entity = createDemoEntity(key, id, coords);
    entity.displayName = displayName;
    entity.transform.planeId = SPATIAL_TACTICS_RULE_PACK_ID;
    entity.transform.facing = key.startsWith('player') ? 0 : 180;
    entity.bodyParts = bodyParts();
    entity.bodyBlocking = true;
    entity.equippedWeaponId = equippedWeaponId;
    entity.currentStance = 'NONE';
    entity.resources.current.focus = 16;
    entity.resources.max.focus = 16;
    entity.resources.current.hp = Math.max(90, entity.resources.current.hp ?? 0);
    entity.resources.max.hp = entity.resources.current.hp;
    entity.resources.current.armor = 2;
    entity.resources.max.armor = 2;
    return entity;
}

function cover(id: string, name: string, x: number, y: number, full: boolean): EncounterEntity {
    return {
        id, templateId: id, encounterTemplateId: id, displayName: name, visibility: 'PUBLIC', type: 'PROP', faction: null,
        transform: { coords: { x, y, z: 0 }, planeId: SPATIAL_TACTICS_RULE_PACK_ID, facing: 0 },
        physics: { scaleClass: 1, collisionRadius: 0.48, mass: 500, movementModes: [] },
        resources: { current: { hp: full ? 120 : 60 }, max: { hp: full ? 120 : 60 } }, activeEffects: [],
        tags: ['COVER'], bodyBlocking: true,
        coverState: { coverDefId: id, coverType: full ? 'FULL' : 'HALF', coverDr: full ? 8 : 4, coverThreshold: full ? 16 : 10, facing: 0, height: full ? 2.5 : 1 },
    };
}

export function createSpatialTacticsRoster(): EncounterEntity[] {
    return [
        actor('player-melee', 'tactics-vanguard', '先锋 · 长枪护卫', { x: 2, y: 3, z: 0 }, 'spear'),
        actor('player-ranged', 'tactics-ranger', '游侠 · 弹道侧翼', { x: 2, y: 5, z: 0 }, 'rifle'),
        actor('player-guide', 'tactics-engineer', '术师 · 范围压制', { x: 3, y: 6, z: 0 }, 'sidearm'),
        actor('monster-bruiser', 'tactics-sentinel', '堡垒守卫', { x: 10, y: 3, z: 0 }, 'spear'),
        actor('monster-marksman', 'tactics-sniper', '掩体射手', { x: 11, y: 4, z: 0 }, 'rifle'),
        actor('monster-channeler', 'tactics-bombardier', '爆弹术师', { x: 10, y: 6, z: 0 }, 'sidearm'),
        cover('tactics-sandbags-west', '西侧沙袋 · 半掩体', 3, 5, false),
        cover('tactics-sandbags-east', '东侧沙袋 · 半掩体', 10, 4, false),
        cover('tactics-pillar-north', '北断柱 · 全掩体', 6, 2, true),
        cover('tactics-pillar-south', '南断柱 · 全掩体', 6, 6, true),
    ];
}

function createTacticsMap(): MapData {
    const tiles: MapData['tiles'] = [];
    for (let x = 0; x < 14; x++) for (let y = 0; y < 9; y++) {
        const wall = x === 6 && [1, 7].includes(y);
        const water = x === 7 && [0, 1, 7, 8].includes(y);
        tiles.push({ hex: hexOffsetToAxial(x, y), terrain: wall ? 'WALL' : water ? 'WATER' : 'GROUND',
            height: wall ? 2.5 : 0, movementCost: water ? 3 : 1 });
    }
    return { id: 'spatial-tactics-fortress', name: '断桥堡垒', width: 14, height: 9, tiles,
        spawnPoints: { players: { x: 2, y: 4, z: 0 }, enemies: { x: 10, y: 4, z: 0 } } };
}

/** A single connected encounter using the production spatial and timing systems. */
export function createSpatialTacticsContent(): EncounterRulePack {
    const legacy = createDemoContent();
    const roster = createSpatialTacticsRoster();
    return {
        ...legacy, id: SPATIAL_TACTICS_RULE_PACK_ID, name: '断桥堡垒 · 空间战术演练', map: createTacticsMap(),
        actionTemplates: [...structuredClone(TACTIC_ACTION_TEMPLATES), ...legacy.actionTemplates.filter(template =>
            !template.tags.includes('MOVEMENT') && !template.launchProjectile)].map(template => ({ ...template, rulePackId: SPATIAL_TACTICS_RULE_PACK_ID })),
        actorTemplates: Object.fromEntries(roster.filter(entity => entity.type === 'ACTOR').map(entity => {
            const { id: _id, ...template } = entity;
            void _id;
            return [entity.encounterTemplateId ?? entity.templateId, template];
        })),
        scenario: {
            id: 'spatial-tactics', title: '断桥堡垒 · 空间战术演练',
            summary: '三人突击组穿越断桥夺取堡垒。GM 操作三名守军；所有战术都在同一地图、同一时间轴与真实结算中发生。也可由一名 GM 控制双方演练。',
            objectives: [
                { id: 'approach', title: '1 · 掩体接敌与冲刺', description: '沿中央通道推进，观察冲刺加速和实体占位。游侠利用西侧沙袋，比较架枪和撩枪；墙柱会拦住直射，抛射可以越过。', actionIds: [TACTIC_ACTION_IDS.MOVE, TACTIC_ACTION_IDS.ADS, TACTIC_ACTION_IDS.BLIND, TACTIC_ACTION_IDS.SHOT] },
                { id: 'control', title: '2 · 护卫协作与通道封锁', description: '先锋靠近队友后部署护卫，GM 用守军射击队友观察拦截。两名队友同时护卫可协同。封锁中央通道，再让敌人进入触发区域伤害。', actionIds: [TACTIC_ACTION_IDS.GUARD, TACTIC_ACTION_IDS.ZONE, TACTIC_ACTION_IDS.UNGUARD] },
                { id: 'flank', title: '3 · 触及死角与侧翼背刺', description: '长枪在 1–3 距离有效，极限距离会减伤；贴身时弃枪换副武器。绕到守卫背面背刺，并让守卫转身比较效果。位移闪避要抢在生效窗口前到达；下潜、小跳、侧闪分别规避 HIGH、LOW、LINEAR 标签。', actionIds: [TACTIC_ACTION_IDS.SPEAR, TACTIC_ACTION_IDS.DROP, TACTIC_ACTION_IDS.EQUIP_SIDEARM, TACTIC_ACTION_IDS.SIDEARM, TACTIC_ACTION_IDS.BACKSTAB, TACTIC_ACTION_IDS.TURN_RIGHT, TACTIC_ACTION_IDS.DODGE, TACTIC_ACTION_IDS.DUCK, TACTIC_ACTION_IDS.HOP, TACTIC_ACTION_IDS.SLIP] },
                { id: 'blast', title: '4 · 爆炸、范围形状与友伤', description: '抛射爆弹落在堡垒守军附近，比较近爆心、边缘和柱后伤害。队友也会受伤。转向后比较扇形与线形覆盖；近距离投弹属于最小射程盲区。', actionIds: [TACTIC_ACTION_IDS.LOB, TACTIC_ACTION_IDS.CONE, TACTIC_ACTION_IDS.LINE, TACTIC_ACTION_IDS.TURN_LEFT] },
                { id: 'finish', title: '5 · 部位破坏与终局', description: '近身施放要害重击，观察随机部位、暴击、伤害截断与部位破坏；损伤路线攻击直接扣生命。击倒全部守军后等待在途事件完成、保存结算，再重开复演。', actionIds: [TACTIC_ACTION_IDS.PRECISION, TACTIC_ACTION_IDS.BACKSTAB] },
            ],
        },
    };
}
