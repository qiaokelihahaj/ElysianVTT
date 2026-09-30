import type { ActionTemplate, Entity, EntityId, MapData, Tick, Vector3D } from '@hard-vtt/shared';
import { LogVisibility, getEntityFaction } from '@hard-vtt/shared';
import { Logger } from '../../utils/Logger.js';
import { VectorMath } from '../../utils/VectorMath.js';
import { SpatialSystem } from './SpatialSystem.js';

const logger = Logger.create('System:SpatialAction');
type Mutations = Map<EntityId, Record<string, unknown>>;

/** Rule-defined tactical state changes use the same ACTIVE commit as effects. */
export class SpatialActionSystem {
    public static applyAction(template: ActionTemplate, actor: Entity, tick: Tick, targetCoords?: Vector3D): Mutations {
        const changes: Record<string, unknown> = {};
        const config = template.spatial;
        if (!config) return new Map();
        if (config.stance !== undefined) {
            actor.currentStance = config.stance;
            changes.currentStance = config.stance;
            logger.game(`🔄 [Stance] ${actor.id} → ${config.stance}`, { actorId: actor.id }, LogVisibility.PLAYER, { tick });
        }
        if (config.rotationDelta !== undefined) {
            actor.transform.facing = ((actor.transform.facing + config.rotationDelta) % 360 + 360) % 360;
            changes['transform.facing'] = actor.transform.facing;
            logger.game(`↪️ [Facing] ${actor.id} 转向 ${actor.transform.facing}°`, { actorId: actor.id }, LogVisibility.PLAYER, { tick });
        }
        if (config.weaponOperation) {
            if (config.weaponOperation.type === 'EQUIP' && config.weaponOperation.weaponId) {
                actor.equippedWeaponId = config.weaponOperation.weaponId;
                changes.equippedWeaponId = actor.equippedWeaponId;
            } else if (config.weaponOperation.type === 'DROP' && actor.equippedWeaponId) {
                actor.droppedWeaponIds = [...new Set([...(actor.droppedWeaponIds ?? []), actor.equippedWeaponId])];
                actor.equippedWeaponId = undefined;
                changes.equippedWeaponId = null;
                changes.droppedWeaponIds = [...actor.droppedWeaponIds];
            }
            logger.game(`⚔️ [Weapon] ${actor.id} ${config.weaponOperation.type === 'DROP' ? '丢弃武器' : `切换至 ${actor.equippedWeaponId}`}`,
                { actorId: actor.id }, LogVisibility.PLAYER, { tick });
        }
        if (config.guard) {
            actor.bodyBlocking = config.guard.bodyBlocking;
            actor.formationContext = {
                ...actor.formationContext,
                interceptConfig: config.guard.interceptConfig ? structuredClone(config.guard.interceptConfig) : undefined,
            };
            changes.bodyBlocking = actor.bodyBlocking ?? false;
            changes.formationContext = structuredClone(actor.formationContext);
            logger.game(`🛡️ [Formation] ${actor.id} ${config.guard.interceptConfig ? '建立护卫阵型' : '解除护卫阵型'}`,
                { actorId: actor.id }, LogVisibility.PLAYER, { tick });
        }
        if (config.blockZone) {
            const existing = actor.formationContext?.blockZones ?? [];
            actor.formationContext = { ...actor.formationContext, blockZones: [...existing, {
                ...config.blockZone,
                id: `${actor.id}:${template.id}:${tick}:${existing.length}`,
                center: { ...(targetCoords ?? actor.transform.coords) },
                ownerId: actor.id,
            }] };
            changes.formationContext = structuredClone(actor.formationContext);
            logger.game(`🚧 [Blockade] ${actor.id} 建立封锁区，持续 ${config.blockZone.durationTicks} Tick`,
                { actorId: actor.id }, LogVisibility.PLAYER, { tick });
        }
        return changes && Object.keys(changes).length ? new Map([[actor.id, changes]]) : new Map();
    }

    public static onMovement(mover: Entity, from: Vector3D, entities: Map<EntityId, Entity>, tick: Tick): Mutations {
        let damage = 0;
        for (const owner of entities.values()) {
            if (owner.id === mover.id || (owner.resources.current.hp ?? 1) <= 0) continue;
            const ownerFaction = getEntityFaction(owner);
            if (ownerFaction && ownerFaction === getEntityFaction(mover)) continue;
            for (const zone of owner.formationContext?.blockZones ?? []) {
                if (!SpatialSystem.checkZoneEntry(zone, mover.transform.coords, from)) continue;
                damage += zone.triggerDamage;
                logger.game(`🚧 [Blockade] ${mover.id} 进入 ${owner.id} 的封锁区，受到 ${zone.triggerDamage} 点伤害`,
                    { actorId: mover.id, zoneId: zone.id }, LogVisibility.PLAYER, { tick });
            }
        }
        if (damage <= 0) return new Map();
        mover.resources.current.hp = Math.max(0, (mover.resources.current.hp ?? 0) - damage);
        return new Map([[mover.id, { 'resources.current.hp': mover.resources.current.hp }]]);
    }

    /** Shared runtime/admission predicate for long-weapon blind spots. */
    public static inReach(template: ActionTemplate, actor: Entity, target: Entity, maxReach: number): boolean {
        return SpatialSystem.isInReach(VectorMath.distance(actor.transform.coords, target.transform.coords), maxReach,
            template.spatial?.reach?.minReach ?? template.launchProjectile?.minRange ?? 0);
    }

    public static refreshCover(actor: Entity, entities: Map<EntityId, Entity>): Mutations {
        if (actor.type !== 'ACTOR') return new Map();
        const props = [...entities.values()].filter(entity => entity.type === 'PROP' && entity.coverState);
        // Explicit legacy cover fixtures are preserved. Inferred prop cover is
        // positional and disappears when the actor leaves that prop.
        if (actor.coverState && !props.some(prop => prop.coverState?.coverDefId === actor.coverState?.coverDefId)) return new Map();
        const nearest = props.filter(prop => (prop.resources.current.hp ?? 1) > 0
            && prop.transform.planeId === actor.transform.planeId
            && VectorMath.distance(prop.transform.coords, actor.transform.coords) <= 1.5)
            .sort((a, b) => VectorMath.distance(actor.transform.coords, a.transform.coords)
                - VectorMath.distance(actor.transform.coords, b.transform.coords))[0];
        const next = nearest?.coverState ? {
            ...nearest.coverState,
            facing: VectorMath.directionAngleFromOffset(actor.transform.coords.x, actor.transform.coords.y,
                nearest.transform.coords.x, nearest.transform.coords.y),
        } : undefined;
        if (JSON.stringify(next) === JSON.stringify(actor.coverState)) return new Map();
        actor.coverState = next;
        return new Map([[actor.id, { coverState: next ?? null }]]);
    }

    public static movementCost(map: MapData | undefined, position: Vector3D): number {
        if (!map) return 1;
        const hex = VectorMath.offsetToAxial(Math.round(position.x), Math.round(position.y));
        const tile = map.tiles.find(candidate => candidate.hex.q === hex.q && candidate.hex.r === hex.r);
        return Math.max(1, tile?.movementCost ?? 1);
    }

    /** Match the live blockers and collision clearance used by movement pulses. */
    public static isOccupiedDestination(target: Vector3D, entities: Iterable<Entity>, mover?: Entity): boolean {
        for (const entity of entities) {
            if (entity.id === mover?.id || (entity.type !== 'ACTOR' && entity.type !== 'PROP')
                || !entity.bodyBlocking || (entity.resources.current.hp ?? 1) <= 0
                || (mover && entity.transform.planeId !== mover.transform.planeId)) continue;
            if (VectorMath.distance(target, entity.transform.coords) <= (entity.physics.collisionRadius ?? 0.5) + 0.3) return true;
        }
        return false;
    }

    public static mapObstacles(map: MapData | undefined): Vector3D[] {
        return (map?.tiles ?? []).filter(tile => tile.terrain === 'WALL' || tile.terrain === 'OBSTACLE').map(tile => {
            const { col, row } = VectorMath.axialToOffset(tile.hex);
            return { x: col, y: row, z: tile.height ?? 2 };
        });
    }

    public static clipMovement(from: Vector3D, to: Vector3D, map: MapData | undefined): Vector3D {
        const obstacles = this.mapObstacles(map);
        if (obstacles.length === 0) return to;
        const distance = VectorMath.distance(from, to);
        const steps = Math.max(1, Math.ceil(distance / 0.25));
        let previous = from;
        for (let step = 1; step <= steps; step++) {
            const progress = step / steps;
            const current = { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress, z: from.z };
            if (obstacles.some(obstacle => Math.hypot(obstacle.x - current.x, obstacle.y - current.y) < 0.7)) return previous;
            previous = current;
        }
        return to;
    }
}
