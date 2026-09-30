import type { ActionTemplate } from '@hard-vtt/shared';

/** Instance-owned action template lookup used by a combat engine. */
export interface ActionCatalog {
    getAction(id: string): ActionTemplate | undefined;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

/**
 * Reusable validation for trusted action templates.
 *
 * This keeps the existing Dictionary.registerAction boundary and the
 * instance-owned catalog on the same validation path.
 */
export function validateActionTemplate(template: ActionTemplate): void {
    if (!template || !template.id || !template.timeCost || !template.range || !Array.isArray(template.effects)) {
        throw new Error('Invalid action template');
    }

    if (!isNonNegativeInteger(template.timeCost.startupTicks)
        || !isNonNegativeInteger(template.timeCost.recoveryTicks)) {
        throw new Error(`Invalid action timing for ${template.id}`);
    }
    if (template.activeWindowTicks !== undefined && !isPositiveInteger(template.activeWindowTicks)) {
        throw new Error(`Invalid activeWindowTicks for ${template.id}`);
    }
    if (template.strikeSequence) {
        if (!isPositiveInteger(template.strikeSequence.count)
            || !isNonNegativeInteger(template.strikeSequence.startupTicks)) {
            throw new Error(`Invalid strikeSequence timing for ${template.id}`);
        }
        if (template.strikeSequence.activeWindowTicks !== undefined
            && !isPositiveInteger(template.strikeSequence.activeWindowTicks)) {
            throw new Error(`Invalid strikeSequence activeWindowTicks for ${template.id}`);
        }
    }
    if (template.channelOptions) {
        if (!isPositiveInteger(template.channelOptions.intervalTicks)) {
            throw new Error(`Invalid channel intervalTicks for ${template.id}`);
        }
        if (template.channelOptions.maxPulses !== undefined
            && !isPositiveInteger(template.channelOptions.maxPulses)) {
            throw new Error(`Invalid channel maxPulses for ${template.id}`);
        }
    }
    if (template.targetKind !== undefined && !['entity', 'cell', 'none'].includes(template.targetKind)) {
        throw new Error(`Invalid targetKind for ${template.id}`);
    }
    const spatial = template.spatial;
    if (spatial) {
        if (spatial.stance !== undefined && !['ADS', 'BLIND_FIRE', 'NONE'].includes(spatial.stance)) {
            throw new Error(`Invalid stance for ${template.id}`);
        }
        const nonNegative = (value: number | undefined) => value === undefined || (Number.isFinite(value) && value >= 0);
        if ((spatial.rotationDelta !== undefined && !Number.isFinite(spatial.rotationDelta))
            || !nonNegative(spatial.reach?.minReach) || !nonNegative(spatial.backstabMultiplier)
            || (spatial.reach?.deadZoneRatio !== undefined && (!nonNegative(spatial.reach.deadZoneRatio) || spatial.reach.deadZoneRatio > 1))) {
            throw new Error(`Invalid spatial reach/facing for ${template.id}`);
        }
        if (spatial.weaponOperation && (!['EQUIP', 'DROP'].includes(spatial.weaponOperation.type)
            || (spatial.weaponOperation.type === 'EQUIP' && !spatial.weaponOperation.weaponId))) {
            throw new Error(`Invalid weaponOperation for ${template.id}`);
        }
        if (spatial.blockZone && (!isPositiveInteger(spatial.blockZone.durationTicks)
            || !Number.isFinite(spatial.blockZone.radius) || spatial.blockZone.radius <= 0
            || !nonNegative(spatial.blockZone.triggerDamage))) {
            throw new Error(`Invalid blockZone for ${template.id}`);
        }
        const intercept = spatial.guard?.interceptConfig;
        if (intercept && (!nonNegative(intercept.interceptRange) || !nonNegative(intercept.interceptionRating)
            || !nonNegative(intercept.interceptDamageReduction) || intercept.interceptDamageReduction > 1
            || !nonNegative(intercept.failurePenaltyPoise) || !nonNegative(intercept.failureKnockback)
            || !nonNegative(intercept.coopBonusPerAlly) || !nonNegative(intercept.maxCoopBonus))) {
            throw new Error(`Invalid interceptConfig for ${template.id}`);
        }
        if (spatial.evade !== undefined && !['DUCK', 'HOP', 'SLIP'].includes(spatial.evade)) {
            throw new Error(`Invalid evade for ${template.id}`);
        }
    }
    if (template.launchProjectile && (!Number.isFinite(template.launchProjectile.speed) || template.launchProjectile.speed <= 0
        || !isPositiveInteger(template.launchProjectile.ticksPerStep)
        || (template.launchProjectile.launchHeight !== undefined
            && (!Number.isFinite(template.launchProjectile.launchHeight) || template.launchProjectile.launchHeight < 0)))) {
        throw new Error(`Invalid projectile timing for ${template.id}`);
    }
}

/** Simple per-engine action catalog backed by an in-memory map. */
export class InMemoryActionCatalog implements ActionCatalog {
    private readonly actions = new Map<string, ActionTemplate>();

    constructor(templates: Iterable<ActionTemplate> = []) {
        this.registerActions(templates);
    }

    public getAction(id: string): ActionTemplate | undefined {
        const template = this.actions.get(id);
        return template ? structuredClone(template) : undefined;
    }

    public registerAction(template: ActionTemplate): void {
        validateActionTemplate(template);
        this.actions.set(template.id, structuredClone(template));
    }

    public registerActions(templates: Iterable<ActionTemplate>): void {
        for (const template of templates) this.registerAction(template);
    }

    /** Return independent snapshots for composing or atomically publishing a catalog. */
    public getAllActions(): ActionTemplate[] {
        return Array.from(this.actions.values(), template => structuredClone(template));
    }

    public unregisterAction(id: string): void {
        this.actions.delete(id);
    }

    public clear(): void {
        this.actions.clear();
    }
}
