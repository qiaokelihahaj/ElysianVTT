import { Entity, StateMutationPayload, VisualEventPayload, type ActionScheduledPayload, type DecisionPollPayload, type LogPayload, LogVisibility, type HexCoord, type EntityId } from '@hard-vtt/shared';
import type { PermissionSubject } from '../permissions/PermissionService.js';
import { Logger } from '../utils/Logger.js';
import type { FogOfWar } from '../core/systems/FogOfWar.js';
import { VectorMath } from '../utils/VectorMath.js';

const logger = Logger.create('Network:VisibilityFilter');

export class VisibilityFilter {
    /** Public scene entities remain visible; hidden actors require control. */
    static forScene(viewer: PermissionSubject, entities: Entity[]): PermissionSubject {
        if (viewer.role === 'GM') return viewer;
        const controlled = new Set(viewer.controlledEntityIds);
        const entityById = new Map(entities.map(entity => [entity.id, entity]));
        const hidden = (entity: Entity): boolean => entity.tags?.includes('HIDDEN') === true
            || entity.tags?.includes('INVISIBLE') === true || (entity as Entity & { visibility?: string }).visibility === 'GM';
        return { ...viewer, visibleEntityIds: entities.filter(entity => {
            if (controlled.has(entity.id)) return true;
            if (hidden(entity)) return false;
            const sourceId = entity.type === 'PROJECTILE' && 'sourceEntityId' in entity && typeof entity.sourceEntityId === 'string'
                ? entity.sourceEntityId : undefined;
            const source = sourceId ? entityById.get(sourceId) : undefined;
            return !source || !hidden(source) || controlled.has(source.id);
        }).map(entity => entity.id) };
    }

    static filterAction(payload: ActionScheduledPayload, viewer: PermissionSubject): ActionScheduledPayload | null {
        if (!this.isEntityVisibleTo(payload.entityId, viewer)) return null;
        if (viewer.role === 'GM') return payload;
        const targetIds = payload.targetIds?.filter(id => this.isEntityVisibleTo(id, viewer));
        const filtered = { ...payload, ...(targetIds ? { targetIds } : {}) };
        if (targetIds?.length !== payload.targetIds?.length) delete filtered.targetCoords;
        return filtered;
    }

    static filterDecisionPoll(payload: DecisionPollPayload, viewer: PermissionSubject): DecisionPollPayload | null {
        if (viewer.role === 'GM') return payload;
        if (!viewer.controlledEntityIds.includes(payload.actorId)) return null;
        if (payload.sourceAction && payload.sourceAction.actorId !== 'SYSTEM' && !this.isEntityVisibleTo(payload.sourceAction.actorId, viewer)) {
            const filtered = { ...payload };
            delete filtered.sourceAction;
            delete filtered.sourceActionId;
            delete filtered.causationId;
            return filtered;
        }
        return payload;
    }

    static filterStateMutation(
        sceneId: string,
        payload: StateMutationPayload,
        viewer?: PermissionSubject | string
    ): StateMutationPayload | null {
        if (!payload || !payload.mutations) return null;
        // The engine also publishes Tick advances with no entity changes.
        if (payload.mutations.length === 0 && !payload.actionPatches?.length) return payload;

        // 向后兼容：支持仅传 viewerEntityId 字符串
        const viewerEntityId = typeof viewer === 'string' ? viewer : viewer?.userId;

        if (!viewerEntityId) {
            return payload;
        }

        // 如果是权限主体对象，使用其可见实体列表
        if (typeof viewer === 'object' && (viewer.role === 'PL' || viewer.role === 'OB')) {
            // 对于 PL 和 OB，过滤只显示可见的实体变化
            const filtered: StateMutationPayload = {
                ...payload,
                mutations: payload.mutations.filter(m => 
                    viewer.visibleEntityIds?.includes(m.entityId) || m.entityId === viewerEntityId
                ).map(mutation => ({ ...mutation, changes: this.filterReferences(mutation.changes, viewer) })),
                ...(payload.actionPatches ? { actionPatches: payload.actionPatches.filter(patch => this.isEntityVisibleTo(patch.entityId, viewer)) } : {}),
            };
            // Tick is public even when this recipient cannot see any change.
            return filtered;
        }

        // GM 可见全部
        return payload;
    }

    static filterVisualFx(
        sceneId: string,
        payload: VisualEventPayload,
        viewer?: PermissionSubject | string
    ): VisualEventPayload | null {
        if (!payload || !payload.events || payload.events.length === 0) return null;

        const viewerEntityId = typeof viewer === 'string' ? viewer : viewer?.userId;

        if (!viewerEntityId) {
            return payload;
        }

        // 对于 PL 和 OB，过滤视觉效果
        if (typeof viewer === 'object' && (viewer.role === 'PL' || viewer.role === 'OB')) {
            const filtered: VisualEventPayload = {
                ...payload,
                events: payload.events.filter(e => {
                    // 显示与自己相关或可见的实体的视觉效果
                    const sourceVisible = !e.sourceId || 
                        viewer.visibleEntityIds?.includes(e.sourceId) || 
                        e.sourceId === viewerEntityId;
                    
                    const targetVisible = !e.targetId || 
                        viewer.visibleEntityIds?.includes(e.targetId) || 
                        e.targetId === viewerEntityId;
                    
                    return sourceVisible && targetVisible;
                })
            };
            return filtered.events.length > 0 ? filtered : null;
        }

        // GM 可见全部
        return payload;
    }

    static getVisibleEntities(
        entities: Entity[],
        viewer: PermissionSubject | string
    ): Entity[] {
        const viewerEntityId = typeof viewer === 'string' ? viewer : viewer?.userId;

        if (!viewerEntityId) {
            return entities;
        }

        // GM 看全部
        if (typeof viewer === 'object' && viewer.role === 'GM') {
            return entities;
        }

        // PL 和 OB 只看可见实体列表中的
        if (typeof viewer === 'object') {
            return entities.filter(e => 
                viewer.visibleEntityIds?.includes(e.id) || e.id === viewerEntityId
            ).map(entity => this.filterReferences(entity, viewer));
        }

        // 向后兼容：仅有 entityId 的情况
        return entities.filter(e => e.id === viewerEntityId);
    }

    /** Full snapshots and mutations carry the same nested entity references. */
    private static filterReferences<T extends object>(value: T, viewer: PermissionSubject): T {
        const filtered = structuredClone(value);
        const state = filtered as Record<string, unknown>;
        if (state.type === 'PROJECTILE') {
            const publicFields = new Set(['id', 'templateId', 'type', 'transform', 'physics', 'resources', 'activeEffects']);
            for (const key of Object.keys(state)) if (!publicFields.has(key)) delete state[key];
            state.templateId = 'projectile';
            state.activeEffects = [];
            return filtered;
        }
        const context = state.currentActionContext;
        if (context && typeof context === 'object' && !Array.isArray(context)) {
            const action = context as Record<string, unknown>;
            for (const key of ['activeTargetIds', 'activeHitTargetIds']) {
                if (Array.isArray(action[key])) action[key] = action[key].filter(id => typeof id === 'string' && this.isEntityVisibleTo(id, viewer));
            }
        }
        if (Array.isArray(state.activeEffects)) {
            state.activeEffects = state.activeEffects.filter(effect => effect && typeof effect === 'object'
                && typeof effect.sourceEntityId === 'string' && this.isEntityVisibleTo(effect.sourceEntityId, viewer));
        }
        const formation = state.formationContext;
        if (formation && typeof formation === 'object' && !Array.isArray(formation)) {
            const context = formation as Record<string, unknown>;
            if (Array.isArray(context.blockZones)) context.blockZones = context.blockZones.filter(zone => zone && typeof zone === 'object'
                && typeof zone.ownerId === 'string' && this.isEntityVisibleTo(zone.ownerId, viewer));
        }
        return filtered;
    }

    static isEntityVisibleTo(
        targetEntityId: string,
        viewer: PermissionSubject | string
    ): boolean {
        const viewerEntityId = typeof viewer === 'string' ? viewer : viewer?.userId;

        if (!viewerEntityId) {
            return false;
        }

        // 自己总是可见的
        if (targetEntityId === viewerEntityId) {
            return true;
        }

        // GM 看全部
        if (typeof viewer === 'object' && viewer.role === 'GM') {
            return true;
        }

        // PL 和 OB 根据可见实体列表
        if (typeof viewer === 'object') {
            return viewer.visibleEntityIds?.includes(targetEntityId) || false;
        }

        return false;
    }

    /**
     * 根据权限主体判断是否可见日志
     */
    static canViewLog(viewer: PermissionSubject, log: LogPayload): boolean {
        // GM 可见所有日志
        if ((viewer.role as string) === 'GM') {
            return true;
        }

        // 根据日志的可见性等级决定
        switch (log.visibility) {
            case LogVisibility.DEV:
                // 仅 GM（开发者）可见
                return (viewer.role as string) === 'GM';

            case LogVisibility.GM:
                // 仅 GM 可见
                return (viewer.role as string) === 'GM';

            case LogVisibility.PLAYER:
                // 所有人可见
                return true;

            default:
                // 未知的可见性等级，保守起见只给 GM
                return (viewer.role as string) === 'GM';
        }
    }

    /**
     * 根据权限主体过滤日志数组
     */
    static filterLogs(viewer: PermissionSubject, logs: LogPayload[]): LogPayload[] {
        return logs.filter(log => this.canViewLog(viewer, log));
    }

    /**
     * 预分组：根据权限级别分组所有观看者
     * 用于优化广播（先按组再分发，而不是逐个过滤）
     */
    static groupViewersByRole(viewers: PermissionSubject[]): {
        gm: PermissionSubject[];
        pl: PermissionSubject[];
        ob: PermissionSubject[];
    } {
        const groups = {
            gm: [] as PermissionSubject[],
            pl: [] as PermissionSubject[],
            ob: [] as PermissionSubject[]
        };

        for (const viewer of viewers) {
            if (viewer.role === 'GM') {
                groups.gm.push(viewer);
            } else if (viewer.role === 'PL') {
                groups.pl.push(viewer);
            } else if (viewer.role === 'OB') {
                groups.ob.push(viewer);
            }
        }

        return groups;
    }

    /**
     * 根据日志的可见性级别确定应该广播给哪些角色
     */
    static getVisibleRoles(visibility: LogVisibility): ('GM' | 'PL' | 'OB')[] {
        switch (visibility) {
            case LogVisibility.DEV:
                // 仅 GM（开发者）可见
                return ['GM'];

            case LogVisibility.GM:
                // GM 可见
                return ['GM'];

            case LogVisibility.PLAYER:
                // 所有人可见
                return ['GM', 'PL', 'OB'];

            default:
                return ['GM'];
        }
    }

    // ============================================================
    //  Phase 4.2: FOV-based 可见性过滤 (Fog of War)
    // ============================================================

    /**
     * 根据 FOV 过滤实体列表 — 仅返回观察者当前能看到的实体。
     *
     * 与 getVisibleEntities (基于权限) 互补：
     * - 权限过滤决定"谁有权看到哪些实体"
     * - FOV 过滤决定"谁实际能看到哪些实体"（视线范围内）
     *
     * 二者结合使用：先权限过滤，再 FOV 过滤。
     */
    static filterByFOV(
        viewerId: EntityId,
        entities: Entity[],
        fogOfWar: FogOfWar,
        coordToHex: (coords: import('@hard-vtt/shared').Vector3D) => import('@hard-vtt/shared').HexCoord = VectorMath.vector3DToHex.bind(VectorMath),
    ): Entity[] {
        return entities.filter(target => {
            if (target.id === viewerId) return true;
            if (target.tags?.includes('INVISIBLE') || target.tags?.includes('HIDDEN')) return false;

            const targetHex = coordToHex(target.transform.coords);
            return fogOfWar.isHexVisibleTo(viewerId, targetHex);
        });
    }

    /**
     * 根据 FOV 过滤实体列表，但已探索区域的实体以灰色显示
     * （需要前端配合渲染）
     */
    static filterByFOVWithExplored(
        viewerId: EntityId,
        entities: Entity[],
        fogOfWar: FogOfWar,
        coordToHex: (coords: import('@hard-vtt/shared').Vector3D) => import('@hard-vtt/shared').HexCoord = VectorMath.vector3DToHex.bind(VectorMath),
    ): { visible: Entity[]; explored: Entity[] } {
        const visible: Entity[] = [];
        const explored: Entity[] = [];

        for (const target of entities) {
            if (target.id === viewerId) {
                visible.push(target);
                continue;
            }
            if (target.tags?.includes('INVISIBLE') || target.tags?.includes('HIDDEN')) {
                continue;
            }

            const targetHex = coordToHex(target.transform.coords);
            if (fogOfWar.isHexVisibleTo(viewerId, targetHex)) {
                visible.push(target);
            } else if (fogOfWar.isHexExplored(targetHex)) {
                explored.push(target);
            }
        }

        return { visible, explored };
    }

    /**
     * 检查实体是否对观察者 FOV 可见
     */
    static isEntityFovVisible(
        viewerId: EntityId,
        target: Entity,
        fogOfWar: FogOfWar,
        coordToHex: (coords: import('@hard-vtt/shared').Vector3D) => import('@hard-vtt/shared').HexCoord = VectorMath.vector3DToHex.bind(VectorMath),
    ): boolean {
        if (target.id === viewerId) return true;
        if (target.tags?.includes('INVISIBLE') || target.tags?.includes('HIDDEN')) return false;

        const targetHex = coordToHex(target.transform.coords);
        return fogOfWar.isHexVisibleTo(viewerId, targetHex);
    }

    /**
     * 根据 FOV 过滤 StateMutation — 隐藏不可见实体的状态变更
     */
    static filterStateMutationByFOV(
        viewerId: EntityId,
        payload: StateMutationPayload,
        entities: Map<EntityId, Entity>,
        fogOfWar: FogOfWar,
        coordToHex: (coords: import('@hard-vtt/shared').Vector3D) => import('@hard-vtt/shared').HexCoord = VectorMath.vector3DToHex.bind(VectorMath),
    ): StateMutationPayload | null {
        if (!payload || !payload.mutations || payload.mutations.length === 0) return null;

        const filtered = {
            ...payload,
            mutations: payload.mutations.filter(m => {
                if (m.entityId === viewerId) return true;
                const entity = entities.get(m.entityId);
                if (!entity) return false;
                return this.isEntityFovVisible(viewerId, entity, fogOfWar, coordToHex);
            }),
        };

        return filtered.mutations.length > 0 ? filtered : null;
    }
}
