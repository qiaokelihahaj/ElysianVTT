import { EventEmitter } from 'events';
import {
    HookPreset, UnifiedHook, HookSource, Tick, EntityId, Entity
} from '@hard-vtt/shared';
import { generateId } from '../../utils/IdGenerator.js';
import { VectorMath } from '../../utils/VectorMath.js';
import { Logger } from '../../utils/Logger.js';

export class HookRegistry extends EventEmitter {
    private hooks: Map<EntityId, UnifiedHook[]> = new Map();
    private logger: Logger;

    constructor() {
        super();
        this.logger = Logger.create('Engine:HookRegistry');
    }

    /**
     * Register a hook from a HookPreset + source metadata.
     * Returns the created UnifiedHook.
     */
    register(
        entityId: EntityId,
        preset: HookPreset,
        source: HookSource,
        currentTick: Tick,
        ttl: number = 0
    ): UnifiedHook {
        const hook: UnifiedHook = {
            ...preset,
            source,
            createdAtTick: currentTick,
            ttl,
            fired: false
        };

        const existing = this.hooks.get(entityId) ?? [];
        existing.push(hook);
        this.hooks.set(entityId, existing);

        this.logger.debug(
            `Hook '${hook.label}' (${hook.id}) registered for ${entityId}, source=${source}, ttl=${ttl}`,
            { entityId, hookId: hook.id, source, ttl }
        );

        this.emit('hook_registered', hook);
        return hook;
    }

    /**
     * Unregister a hook by ID. Returns true if found and removed.
     */
    unregister(hookId: string): boolean {
        for (const [entityId, entityHooks] of this.hooks) {
            const idx = entityHooks.findIndex(h => h.id === hookId);
            if (idx >= 0) {
                const removed = entityHooks.splice(idx, 1)[0];
                if (entityHooks.length === 0) {
                    this.hooks.delete(entityId);
                } else {
                    this.hooks.set(entityId, entityHooks);
                }
                this.logger.info(`Hook '${hookId}' unregistered from ${entityId}`);
                this.emit('hook_unregistered', removed);
                return true;
            }
        }
        return false;
    }

    /**
     * Get all hooks for a specific entity.
     */
    getHooksForEntity(entityId: EntityId): UnifiedHook[] {
        return this.hooks.get(entityId) ?? [];
    }

    /**
     * Get all active (enabled, not fired) hooks across all entities.
     */
    getActiveHooks(): UnifiedHook[] {
        const active: UnifiedHook[] = [];
        for (const entityHooks of this.hooks.values()) {
            for (const hook of entityHooks) {
                if (hook.enabled && !hook.fired) {
                    active.push(hook);
                }
            }
        }
        return active;
    }

    /**
     * Find the earliest TICK_REACHED targetTick in the range (fromTick, toTick).
     * Used by CombatEngine to inject breakpoints so hooks fire at the correct tick.
     * Returns null if no active TICK_REACHED hook targets a tick in this range.
     */
    findEarliestTargetTickInRange(fromTick: Tick, toTick: Tick): Tick | null {
        let earliest: Tick | null = null;
        for (const entityHooks of this.hooks.values()) {
            for (const hook of entityHooks) {
                if (!hook.enabled || hook.fired) continue;
                if (hook.trigger.type !== 'TICK_REACHED') continue;
                const target = hook.trigger.targetTick;
                if (target > fromTick && target < toTick) {
                    if (earliest === null || target < earliest) {
                        earliest = target;
                    }
                }
            }
        }
        return earliest;
    }

    /**
     * Evaluate all active hooks against current game state.
     * Returns array of hooks that fired during this evaluation.
     *
     * Supported trigger types:
     * - TICK_REACHED: tick >= trigger.targetTick
     * - ENEMY_ENTERS_RANGE: any ACTOR entity within trigger.range of origin
     * - ENTITY_MOVES_TO: entity position close to trigger.targetHex
     */
    evaluate(tick: Tick, entities: Map<EntityId, Entity>): UnifiedHook[] {
        const fired: UnifiedHook[] = [];

        for (const [entityId, entityHooks] of this.hooks) {
            const entity = entities.get(entityId);
            if (!entity) continue;

            for (const hook of entityHooks) {
                if (!hook.enabled || hook.fired) continue;

                let matched = false;
                const trigger = hook.trigger;

                switch (trigger.type) {
                    case 'TICK_REACHED':
                        // 仅在钩子创建时 targetTick 未过期且 tick 已到达时触发
                        // 防止注册时 targetTick 已过期仍在下一次 evaluate 触发
                        matched = tick >= trigger.targetTick && hook.createdAtTick <= trigger.targetTick;
                        break;

                    case 'ENEMY_ENTERS_RANGE': {
                        const origin = trigger.originEntityId
                            ? entities.get(trigger.originEntityId)
                            : entity;
                        if (!origin) break;
                        for (const other of entities.values()) {
                            if (other.id === origin.id) continue;
                            if (other.type !== 'ACTOR') continue;
                            const dist = VectorMath.distance(origin.transform.coords, other.transform.coords);
                            if (dist <= trigger.range) {
                                matched = true;
                                break;
                            }
                        }
                        break;
                    }

                    case 'ENTITY_MOVES_TO': {
                        const { q, r } = trigger.targetHex;
                        const ex = entity.transform.coords.x;
                        const ey = entity.transform.coords.y;
                        const hexDist = Math.sqrt((ex - q) ** 2 + (ey - r) ** 2);
                        matched = hexDist < 1.5;
                        break;
                    }

                    default:
                        // Other trigger types not yet implemented
                        break;
                }

                if (!matched) continue;

                hook.fired = true;
                fired.push(hook);
                this.logger.info(
                    `Hook '${hook.label}' (${hook.id}) fired at tick ${tick}`,
                    { hookId: hook.id, entityId, tick }
                );
                this.emit('hook_fired', hook);
            }
        }

        return fired;
    }

    /**
     * Mark a hook as fired by ID.
     */
    markFired(hookId: string): void {
        for (const entityHooks of this.hooks.values()) {
            for (const hook of entityHooks) {
                if (hook.id === hookId) {
                    hook.fired = true;
                    return;
                }
            }
        }
    }

    /**
     * Clean up expired hooks:
     * - System hooks that have fired are removed
     * - Hooks with ttl > 0 that have exceeded their lifetime are removed
     * - Manual hooks persist until explicitly unregistered
     */
    cleanup(tick: Tick): void {
        for (const [entityId, entityHooks] of this.hooks) {
            const remaining = entityHooks.filter(hook => {
                // Remove fired system hooks (manual hooks persist until explicit unregister)
                if (hook.fired && hook.source === 'SYSTEM') return false;
                // Remove expired hooks (ttl exceeded)
                if (hook.ttl > 0 && (tick - hook.createdAtTick) >= hook.ttl) return false;
                return true;
            });

            if (remaining.length === 0) {
                this.hooks.delete(entityId);
            } else if (remaining.length !== entityHooks.length) {
                this.hooks.set(entityId, remaining);
            }
        }
    }

    /**
     * Get all hooks across all entities.
     */
    getAll(): UnifiedHook[] {
        const all: UnifiedHook[] = [];
        for (const entityHooks of this.hooks.values()) {
            all.push(...entityHooks);
        }
        return all;
    }
}
