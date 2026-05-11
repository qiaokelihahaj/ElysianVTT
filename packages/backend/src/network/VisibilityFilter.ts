import { Entity, StateMutationPayload, VisualEventPayload, type LogPayload, LogVisibility, type HexCoord, type EntityId } from '@hard-vtt/shared';
import type { PermissionSubject } from '../permissions/PermissionService.js';
import { Logger } from '../utils/Logger.js';
import type { FogOfWar } from '../core/systems/FogOfWar.js';
import { VectorMath } from '../utils/VectorMath.js';

const logger = Logger.create('Network:VisibilityFilter');

export class VisibilityFilter {
    static filterStateMutation(
        sceneId: string,
        payload: StateMutationPayload,
        viewer?: PermissionSubject | string
    ): StateMutationPayload | null {
        if (!payload || !payload.mutations) return null;
        if (payload.mutations.length === 0) return payload;

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
                )
            };
            return filtered.mutations.length > 0 ? filtered : null;
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
            );
        }

        // 向后兼容：仅有 entityId 的情况
        return entities.filter(e => e.id === viewerEntityId);
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
    ): Entity[] {
        return entities.filter(target => {
            if (target.id === viewerId) return true;
            if (target.tags?.includes('INVISIBLE') || target.tags?.includes('HIDDEN')) return false;

            const targetHex = VectorMath.vector3DToHex(target.transform.coords);
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

            const targetHex = VectorMath.vector3DToHex(target.transform.coords);
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
    ): boolean {
        if (target.id === viewerId) return true;
        if (target.tags?.includes('INVISIBLE') || target.tags?.includes('HIDDEN')) return false;

        const targetHex = VectorMath.vector3DToHex(target.transform.coords);
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
    ): StateMutationPayload | null {
        if (!payload || !payload.mutations || payload.mutations.length === 0) return null;

        const filtered = {
            ...payload,
            mutations: payload.mutations.filter(m => {
                if (m.entityId === viewerId) return true;
                const entity = entities.get(m.entityId);
                if (!entity) return false;
                return this.isEntityFovVisible(viewerId, entity, fogOfWar);
            }),
        };

        return filtered.mutations.length > 0 ? filtered : null;
    }
}
