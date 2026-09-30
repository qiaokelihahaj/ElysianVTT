import { hexOffsetToAxial } from '@hard-vtt/shared';
import type {
    ActionTemplate,
    EncounterEntity,
    EncounterFaction,
    EncounterRulePack,
    EntityId,
    MapData,
    Vector3D,
} from '@hard-vtt/shared';
import { Dictionary } from '../db/Dictionary.js';

export const DEMO_RULE_PACK_ID = 'elysian-lan-demo-v1';

export const DEMO_ACTION_IDS = {
    MELEE: 'DEMO_MELEE_STRIKE',
    RANGED: 'DEMO_RANGED_SHOT',
    CHANNEL: 'DEMO_GUIDED_PULSE',
    MOVE: 'DEMO_MOVE',
    HEAL: 'DEMO_RECOVER_WOUND',
    RECOVER: 'DEMO_RECOVER_FOCUS',
    PARRY: 'PARRY',
    DODGE: 'DODGE',
    INTERRUPT: 'INTERRUPT',
} as const;

function damageAction(
    id: string,
    damage: number,
    startupTicks: number,
    recoveryTicks: number,
    range: number,
    priorityExpr: string,
    resourceCost: Record<string, string> = {},
    poiseDamage = 0,
): ActionTemplate {
    return {
        id,
        tags: ['ATTACK'],
        activeWindowTicks: 1,
        resourceCost,
        timeCost: { startupTicks, recoveryTicks },
        range: { type: range <= 2 ? 'MELEE' : 'RANGED', distanceExpr: String(range) },
        priorityExpr,
        effects: [
            {
                type: 'DAMAGE',
                targetSelector: 'PRIMARY',
                parameters: { resource: 'hp', amountExpr: String(damage) },
            },
            ...(poiseDamage > 0 ? [{
                type: 'DAMAGE' as const,
                targetSelector: 'PRIMARY' as const,
                parameters: { resource: 'poise', amountExpr: String(poiseDamage) },
            }] : []),
        ],
        rulePackId: DEMO_RULE_PACK_ID,
    };
}

export const DEMO_ACTION_TEMPLATES: ActionTemplate[] = [
    {
        id: DEMO_ACTION_IDS.MOVE,
        tags: ['MOVEMENT'],
        resourceCost: {},
        timeCost: { startupTicks: 10, recoveryTicks: 5 },
        range: { type: 'MOVEMENT', distanceExpr: '10' },
        priorityExpr: 'actor.agi',
        effects: [],
        rulePackId: DEMO_RULE_PACK_ID,
    },
    { ...damageAction(DEMO_ACTION_IDS.MELEE, 18, 2, 2, 1.6, 'actor.agi + 2', {}, 6), activeWindowTicks: 3 },
    damageAction(DEMO_ACTION_IDS.RANGED, 14, 3, 2, 8, 'actor.agi + 1', { focus: '1' }, 3),
    {
        ...damageAction(DEMO_ACTION_IDS.CHANNEL, 8, 2, 3, 7, 'actor.agi', { focus: '1' }, 2),
        tags: ['ATTACK', 'CHANNEL'],
        sustainResources: ['focus'],
        channelOptions: {
            intervalTicks: 2,
            maxPulses: 3,
            pulseResourceCost: { focus: '1' },
        },
    },
    {
        id: DEMO_ACTION_IDS.HEAL,
        activeWindowTicks: 1,
        tags: ['RECOVERY'],
        resourceCost: { focus: '1' },
        timeCost: { startupTicks: 3, recoveryTicks: 2 },
        range: { type: 'MELEE', distanceExpr: '3' },
        priorityExpr: 'actor.agi',
        effects: [{
            type: 'HEAL',
            targetSelector: 'PRIMARY',
            parameters: { resource: 'hp', amountExpr: '12' },
        }],
        rulePackId: DEMO_RULE_PACK_ID,
    },
    {
        id: DEMO_ACTION_IDS.RECOVER,
        tags: ['RECOVERY', 'RESOURCE'],
        resourceCost: {},
        timeCost: { startupTicks: 4, recoveryTicks: 1 },
        range: { type: 'SELF', distanceExpr: '0' },
        priorityExpr: 'actor.agi',
        effects: [{
            type: 'HEAL',
            targetSelector: 'SELF',
            parameters: { resource: 'focus', amountExpr: '3' },
        }, {
            type: 'HEAL',
            targetSelector: 'SELF',
            parameters: { resource: 'poise', amountExpr: '3' },
        }],
        rulePackId: DEMO_RULE_PACK_ID,
    },
    {
        id: DEMO_ACTION_IDS.PARRY,
        tags: ['DEFENSE', 'REACTION'],
        resourceCost: { poise: '1' },
        timeCost: { startupTicks: 1, recoveryTicks: 2 },
        range: { type: 'SELF', distanceExpr: '0' },
        priorityExpr: 'actor.agi + 20',
        effects: [{
            type: 'APPLY_BUFF',
            targetSelector: 'SELF',
            parameters: { buffId: 'DEMO_PARRY_WINDOW', durationTicks: 1, damageMultiplier: 0.5 },
        }],
        rulePackId: DEMO_RULE_PACK_ID,
    },
    {
        id: DEMO_ACTION_IDS.DODGE,
        tags: ['DEFENSE', 'REACTION'],
        resourceCost: { focus: '2' },
        timeCost: { startupTicks: 1, recoveryTicks: 3 },
        range: { type: 'SELF', distanceExpr: '0' },
        priorityExpr: 'actor.agi + 30',
        effects: [{
            type: 'APPLY_BUFF',
            targetSelector: 'SELF',
            parameters: { buffId: 'DEMO_DODGE_WINDOW', durationTicks: 1, negateDamage: true },
        }],
        rulePackId: DEMO_RULE_PACK_ID,
    },
    {
        id: DEMO_ACTION_IDS.INTERRUPT,
        tags: ['REACTION', 'INTERRUPT'],
        resourceCost: { focus: '1' },
        timeCost: { startupTicks: 1, recoveryTicks: 2 },
        range: { type: 'RANGED', distanceExpr: '6' },
        priorityExpr: 'actor.agi + 50',
        effects: [{
            type: 'INTERRUPT',
            targetSelector: 'PRIMARY',
            parameters: {},
        }],
        rulePackId: DEMO_RULE_PACK_ID,
    },
];

const DEMO_TEMPLATES: Record<string, Omit<EncounterEntity, 'id'>> = {
    'player-melee': makeTemplate('先锋', 'demo.player.melee', 'PLAYERS', { hp: 100, poise: 20, focus: 4, agi: 12 }),
    'player-ranged': makeTemplate('游侠', 'demo.player.ranged', 'PLAYERS', { hp: 75, poise: 12, focus: 7, agi: 18 }),
    'player-guide': makeTemplate('引导者', 'demo.player.guide', 'PLAYERS', { hp: 70, poise: 10, focus: 10, agi: 15 }),
    'monster-bruiser': makeTemplate('近战兽', 'demo.monster.bruiser', 'ENEMIES', { hp: 80, poise: 18, focus: 2, agi: 10 }),
    'monster-marksman': makeTemplate('远射手', 'demo.monster.marksman', 'ENEMIES', { hp: 55, poise: 8, focus: 6, agi: 16 }),
    'monster-channeler': makeTemplate('引导怪', 'demo.monster.channeler', 'ENEMIES', { hp: 60, poise: 8, focus: 8, agi: 13 }),
};

function makeTemplate(
    displayName: string,
    templateId: string,
    faction: EncounterFaction,
    current: Record<string, number>,
): Omit<EncounterEntity, 'id'> {
    return {
        templateId,
        encounterTemplateId: templateId,
        displayName,
        visibility: 'PUBLIC',
        type: 'ACTOR',
        transform: { coords: { x: 0, y: 0, z: 0 }, planeId: 'elysian-demo', facing: 0 },
        physics: { scaleClass: 1, collisionRadius: 0.45, mass: 60, movementModes: ['WALK'] },
        resources: { current: { ...current }, max: { ...current } },
        activeEffects: [],
        tags: [faction],
        faction,
    };
}

function cloneEntity(templateKey: string, id: EntityId, position: Vector3D): EncounterEntity {
    const template = DEMO_TEMPLATES[templateKey];
    if (!template) throw new Error(`Unknown demo entity template: ${templateKey}`);
    return {
        ...structuredClone(template),
        id,
        transform: { ...structuredClone(template.transform), coords: { ...position } },
        resources: {
            current: { ...template.resources.current },
            max: { ...template.resources.max },
        },
        activeEffects: [],
    };
}

export const DEMO_ENTITY_TEMPLATES = Object.freeze(Object.keys(DEMO_TEMPLATES));

export function createDemoEntity(
    templateKey: string,
    id = `${templateKey}-${Math.random().toString(36).slice(2, 8)}`,
    position: Vector3D = { x: 0, y: 0, z: 0 },
): EncounterEntity {
    return cloneEntity(templateKey, id, position);
}

export function createDemoRoster(): EncounterEntity[] {
    return [
        cloneEntity('player-melee', 'demo-player-melee', { x: 1, y: 2, z: 0 }),
        cloneEntity('player-ranged', 'demo-player-ranged', { x: 1, y: 3, z: 0 }),
        cloneEntity('player-guide', 'demo-player-guide', { x: 2, y: 2, z: 0 }),
        cloneEntity('monster-bruiser', 'demo-monster-bruiser', { x: 7, y: 2, z: 0 }),
        cloneEntity('monster-marksman', 'demo-monster-marksman', { x: 7, y: 4, z: 0 }),
        cloneEntity('monster-channeler', 'demo-monster-channeler', { x: 6, y: 3, z: 0 }),
    ];
}

function createMap(): MapData {
    const tiles = [];
    for (let q = 0; q < 10; q++) {
        for (let r = 0; r < 6; r++) {
            tiles.push({ hex: hexOffsetToAxial(q, r), terrain: 'GROUND' as const, movementCost: 1 });
        }
    }
    return {
        id: 'elysian-demo-map',
        name: '裂隙庭院',
        tiles,
        width: 10,
        height: 6,
        spawnPoints: {
            players: { x: 1, y: 2, z: 0 },
            enemies: { x: 7, y: 2, z: 0 },
        },
    };
}

/** Build isolated example content without changing the process-wide dictionary. */
export function createDemoContent(): EncounterRulePack {
    return {
        id: DEMO_RULE_PACK_ID,
        name: 'ElysianVTT 首个可玩 Demo',
        actionTemplates: structuredClone(DEMO_ACTION_TEMPLATES),
        actorTemplates: structuredClone(DEMO_TEMPLATES),
        map: createMap(),
        reactionJoinMs: 10_000,
        reactionSelectMs: 60_000,
        priorityTolerance: 0,
    };
}

/** Compatibility helper for legacy standalone engine callers. */
export function installDemoContent(): EncounterRulePack {
    Dictionary.registerActions(DEMO_ACTION_TEMPLATES);
    return createDemoContent();
}

export const DemoContent = {
    install: installDemoContent,
    createEntity: createDemoEntity,
    createRoster: createDemoRoster,
    actionTemplates: DEMO_ACTION_TEMPLATES,
    entityTemplates: DEMO_ENTITY_TEMPLATES,
    rulePackId: DEMO_RULE_PACK_ID,
};
