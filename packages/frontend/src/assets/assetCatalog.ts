import type { Entity } from '@hard-vtt/shared';

export type EntityType = Entity['type'];

export type EntityVisualShape = 'circle' | 'rect' | 'diamond';

export interface EntityVisualDefinition {
    id: string;
    entityTypes: EntityType[];
    templateIds?: string[];
    imageUrl?: string;
    geometry: {
        shape: EntityVisualShape;
        size: number;
        fill: number;
        stroke: number;
        selectedFill: number;
        selectedStroke: number;
        strokeWidth: number;
        selectedStrokeWidth: number;
    };
}

export interface VisualFxDefinition {
    id: string;
    templateIds: string[];
    imageUrl?: string;
    floatingTextColor: number;
    flashColor: number;
}

export const ENTITY_VISUAL_DEFINITIONS: EntityVisualDefinition[] = [
    {
        id: 'actor-default',
        entityTypes: ['ACTOR'],
        imageUrl: '/assets/entities/actor.svg',
        geometry: {
            shape: 'circle',
            size: 40,
            fill: 0x3498db,
            stroke: 0xffffff,
            selectedFill: 0xf4c542,
            selectedStroke: 0xfff2b3,
            strokeWidth: 2,
            selectedStrokeWidth: 4,
        },
    },
    {
        id: 'prop-default',
        entityTypes: ['PROP'],
        imageUrl: '/assets/entities/prop.svg',
        geometry: {
            shape: 'rect',
            size: 30,
            fill: 0x95a5a6,
            stroke: 0xffffff,
            selectedFill: 0xf4c542,
            selectedStroke: 0xfff2b3,
            strokeWidth: 2,
            selectedStrokeWidth: 4,
        },
    },
    {
        id: 'projectile-default',
        entityTypes: ['PROJECTILE'],
        imageUrl: '/assets/entities/projectile.svg',
        geometry: {
            shape: 'diamond',
            size: 20,
            fill: 0xe74c3c,
            stroke: 0xffffff,
            selectedFill: 0xf4c542,
            selectedStroke: 0xfff2b3,
            strokeWidth: 2,
            selectedStrokeWidth: 4,
        },
    },
];

export const VISUAL_FX_DEFINITIONS: VisualFxDefinition[] = [
    {
        id: 'info',
        templateIds: ['info', 'INFO'],
        imageUrl: '/assets/fx/info.svg',
        floatingTextColor: 0x7ecbff,
        flashColor: 0x4aa3ff,
    },
    {
        id: 'interrupted',
        templateIds: ['interrupted', 'INTERRUPTED'],
        imageUrl: '/assets/fx/interrupted.svg',
        floatingTextColor: 0xcc44ff,
        flashColor: 0xcc33ff,
    },
    {
        id: 'mutual_kill',
        templateIds: ['mutual_kill', 'MUTUAL_KILL', 'clash'],
        imageUrl: '/assets/fx/mutual-kill.svg',
        floatingTextColor: 0xff8c00,
        flashColor: 0xff3300,
    },
    {
        id: 'heal',
        templateIds: ['heal', 'HEAL'],
        imageUrl: '/assets/fx/heal.svg',
        floatingTextColor: 0x44ff44,
        flashColor: 0x22cc66,
    },
    {
        id: 'damage',
        templateIds: ['damage', 'DAMAGE'],
        imageUrl: '/assets/fx/damage.svg',
        floatingTextColor: 0xff4444,
        flashColor: 0xff3300,
    },
];

const DEFAULT_ENTITY_VISUAL = ENTITY_VISUAL_DEFINITIONS[0];
const DEFAULT_FX_VISUAL = VISUAL_FX_DEFINITIONS[0];

export function getEntityVisualDefinition(entityType: EntityType, templateId?: string): EntityVisualDefinition {
    const templateMatch = ENTITY_VISUAL_DEFINITIONS.find((definition) => {
        return definition.entityTypes.includes(entityType) && Boolean(templateId && definition.templateIds?.includes(templateId));
    });

    if (templateMatch) {
        return templateMatch;
    }

    return ENTITY_VISUAL_DEFINITIONS.find((definition) => definition.entityTypes.includes(entityType)) ?? DEFAULT_ENTITY_VISUAL;
}

export function getVisualFxDefinition(templateId?: string): VisualFxDefinition {
    if (!templateId) {
        return DEFAULT_FX_VISUAL;
    }

    return VISUAL_FX_DEFINITIONS.find((definition) => definition.templateIds.includes(templateId)) ?? DEFAULT_FX_VISUAL;
}