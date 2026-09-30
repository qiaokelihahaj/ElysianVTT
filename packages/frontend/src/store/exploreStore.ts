/**
 * exploreStore — 探索模式 Zustand Store
 *
 * 职责：
 *  - 独立于 gameStore，管理探索模式专有状态
 *  - 地图数据、可见实体、战争迷雾状态
 *  - 交互动作列表与技能检定结果
 *  - 区域触发感知
 *
 * 与 gameStore 的关系：
 *  - gameStore 管理战斗状态，exploreStore 管理探索状态
 *  - 两者可以共存，通过 exploreMode 标志切换
 *  - RendererManager 根据 exploreMode 选择数据源
 */

import { create } from 'zustand';
import type {
  MapData,
  Entity,
  ZoneTriggerDef,
} from '@hard-vtt/shared';

// ============================================================
//  Exploration-specific types
// ============================================================

/** 地图上可供玩家交互的对象 */
export interface InteractionDef {
  id: string;
  label: string;
  description: string;
  icon?: string;
  /** 是否在范围内（距离检查） */
  inRange: boolean;
  /** 关联的技能检定（可选） */
  skillCheck?: SkillCheckTemplate;
  /** 使用冷却（Tick） */
  cooldownTicks?: number;
}

/** 技能检定模板 */
export interface SkillCheckTemplate {
  skill: string;
  dc: number;
  advantage: 'NONE' | 'ADVANTAGE' | 'DISADVANTAGE';
}

/** 技能检定结果 */
export interface SkillCheckResult {
  /** 原始 d20 掷骰结果 */
  roll: number;
  /** 加上调整值后的总值 */
  total: number;
  /** 检定技能名称 */
  skill: string;
  /** 难度等级 */
  dc: number;
  /** 是否成功 */
  success: boolean;
  /** 是否大成功（自然 20） */
  critical: boolean;
  /** 是否大失败（自然 1） */
  fumble: boolean;
  /** 时间戳 */
  timestamp: number;
}

/** 实体可见性信息 */
export interface EntityVisibility {
  entityId: string;
  /** 是否在当前视野内 */
  inView: boolean;
  /** 是否曾被探索到（阴影状态） */
  discovered: boolean;
  /** 最后可见 Tick */
  lastSeenTick: number;
}

/** 战争迷雾 Hex 状态 */
export interface HexVisibility {
  /** 是否已探索（曾进入视野） */
  explored: boolean;
  /** 当前是否在视野内 */
  visible: boolean;
}

// ============================================================
//  Store interface
// ============================================================

interface ExploreState {
  // --- Mode ---
  /** 是否处于探索模式（而非战斗） */
  exploreMode: boolean;

  // --- Map ---
  /** 当前地图 ID */
  currentMapId: string | null;
  /** 当前完整地图数据 */
  mapData: MapData | null;

  // --- Entities ---
  /** 全量实体表（探索状态下独立于 gameStore 维护） */
  exploreEntities: Record<string, Entity>;
  /** 当前可见的实体 ID 列表（基于视线/FOW 过滤） */
  visibleEntityIds: string[];
  /** 实体可见性详情 */
  entityVisibility: Record<string, EntityVisibility>;

  // --- Fog of War ---
  /** Hex 级别的迷雾状态，key = "q,r"（全局混合，保留向后兼容） */
  hexVisibility: Record<string, HexVisibility>;
  /** 每个实体的可见 hex key 集合：entityId → Set<"q,r"> */
  entityHexVisibility: Record<string, string[]>;
  /** 当前视角实体 ID（以哪个实体的视野渲染迷雾） */
  viewingEntityId: string | null;

  // --- Interaction ---
  /** 当前选中实体的 ID */
  selectedEntityId: string | null;
  /** 当前可用的交互动作列表 */
  availableInteractions: InteractionDef[];
  /** 正在进行的交互 ID */
  activeInteractionId: string | null;

  // --- Skill Check ---
  /** 最近的技能检定结果（用于 UI 展示） */
  skillCheckResult: SkillCheckResult | null;

  // --- Zone Triggers ---
  /** 当前激活的区域触发器 */
  activeZoneTriggers: ZoneTriggerDef[];

  // ============================================================
  //  Actions
  // ============================================================

  // Mode
  setExploreMode: (enabled: boolean) => void;

  // Map
  setMapData: (mapData: MapData) => void;
  clearMapData: () => void;

  // Entities
  setExploreEntities: (entities: Entity[]) => void;
  addExploreEntity: (entity: Entity) => void;
  removeExploreEntity: (entityId: string) => void;
  updateExploreEntity: (entityId: string, changes: Partial<Entity>) => void;
  setVisibleEntityIds: (ids: string[]) => void;

  // FOW
  setHexExplored: (q: number, r: number) => void;
  setHexVisible: (q: number, r: number, visible: boolean) => void;
  setHexVisibilityBatch: (entries: Array<{ q: number; r: number; explored: boolean; visible: boolean }>) => void;
  /** 设置每个实体的可见 hex 集合 */
  setEntityHexVisibility: (entityId: string, hexKeys: string[]) => void;
  /** 批量设置所有实体的可见 hex（来自 SCENE_SYNC） */
  setAllEntityHexVisibility: (data: Record<string, string[]>) => void;
  /** 设置当前视角实体 */
  setViewingEntityId: (entityId: string | null) => void;
  clearFow: () => void;

  // Interaction
  setSelectedEntityId: (id: string | null) => void;
  setAvailableInteractions: (interactions: InteractionDef[]) => void;
  setActiveInteraction: (id: string | null) => void;

  // Skill Check
  setSkillCheckResult: (result: SkillCheckResult | null) => void;

  // Zone Triggers
  setActiveZoneTriggers: (triggers: ZoneTriggerDef[]) => void;

  // Reset
  resetExplore: () => void;
}

// ============================================================
//  Initial state
// ============================================================

const INITIAL_STATE = {
  exploreMode: false,
  currentMapId: null as string | null,
  mapData: null as MapData | null,
  exploreEntities: {} as Record<string, Entity>,
  visibleEntityIds: [] as string[],
  entityVisibility: {} as Record<string, EntityVisibility>,
  hexVisibility: {} as Record<string, HexVisibility>,
  entityHexVisibility: {} as Record<string, string[]>,
  viewingEntityId: null as string | null,
  selectedEntityId: null as string | null,
  availableInteractions: [] as InteractionDef[],
  activeInteractionId: null as string | null,
  skillCheckResult: null as SkillCheckResult | null,
  activeZoneTriggers: [] as ZoneTriggerDef[],
};

// ============================================================
//  Store
// ============================================================

export const useExploreStore = create<ExploreState>()((set) => ({
  ...INITIAL_STATE,

  // --- Mode ---
  setExploreMode: (enabled) => set({ exploreMode: enabled }),

  // --- Map ---
  setMapData: (mapData) =>
    set({
      mapData,
      currentMapId: mapData.id,
    }),

  clearMapData: () =>
    set({
      mapData: null,
      currentMapId: null,
    }),

  // --- Entities ---
  setExploreEntities: (entities) =>
    set(() => {
      const map: Record<string, Entity> = {};
      for (const entity of entities) {
        map[entity.id] = entity;
      }
      return { exploreEntities: map };
    }),

  addExploreEntity: (entity) =>
    set((state) => ({
      exploreEntities: {
        ...state.exploreEntities,
        [entity.id]: entity,
      },
    })),

  removeExploreEntity: (entityId) =>
    set((state) => {
      const rest = { ...state.exploreEntities };
      delete rest[entityId];
      return { exploreEntities: rest };
    }),

  updateExploreEntity: (entityId, changes) =>
    set((state) => {
      const existing = state.exploreEntities[entityId];
      if (!existing) return state;
      return {
        exploreEntities: {
          ...state.exploreEntities,
          [entityId]: { ...existing, ...changes },
        },
      };
    }),

  setVisibleEntityIds: (ids) =>
    set((state) => {
      const now = Date.now();
      const visibility: Record<string, EntityVisibility> = {};
      for (const id of ids) {
        const prev = state.entityVisibility[id];
        visibility[id] = {
          entityId: id,
          inView: true,
          discovered: prev?.discovered ?? true,
          lastSeenTick: now,
        };
      }
      // 不在当前视野的标记为 inView=false 但保留 discovered
      for (const id of Object.keys(state.exploreEntities)) {
        if (!ids.includes(id)) {
          visibility[id] = {
            entityId: id,
            inView: false,
            discovered: state.entityVisibility[id]?.discovered ?? false,
            lastSeenTick: state.entityVisibility[id]?.lastSeenTick ?? 0,
          };
        }
      }
      return {
        visibleEntityIds: ids,
        entityVisibility: visibility,
      };
    }),

  // --- FOW ---
  setHexExplored: (q, r) =>
    set((state) => {
      const key = `${q},${r}`;
      const prev = state.hexVisibility[key];
      return {
        hexVisibility: {
          ...state.hexVisibility,
          [key]: {
            explored: true,
            visible: prev?.visible ?? false,
          },
        },
      };
    }),

  setHexVisible: (q, r, visible) =>
    set((state) => {
      const key = `${q},${r}`;
      const prev = state.hexVisibility[key];
      return {
        hexVisibility: {
          ...state.hexVisibility,
          [key]: {
            explored: prev?.explored ?? false,
            visible,
          },
        },
      };
    }),

  setHexVisibilityBatch: (entries) =>
    set((state) => {
      const updated = { ...state.hexVisibility };
      for (const entry of entries) {
        const key = `${entry.q},${entry.r}`;
        updated[key] = {
          explored: entry.explored,
          visible: entry.visible,
        };
      }
      return { hexVisibility: updated };
    }),

  setEntityHexVisibility: (entityId, hexKeys) =>
    set((state) => ({
      entityHexVisibility: {
        ...state.entityHexVisibility,
        [entityId]: hexKeys,
      },
    })),

  setAllEntityHexVisibility: (data) =>
    set({ entityHexVisibility: data }),

  setViewingEntityId: (entityId) => set({ viewingEntityId: entityId }),

  clearFow: () => set({ hexVisibility: {}, entityHexVisibility: {} }),

  // --- Interaction ---
  setSelectedEntityId: (id) => set({ selectedEntityId: id }),

  setAvailableInteractions: (interactions) =>
    set({ availableInteractions: interactions }),

  setActiveInteraction: (id) => set({ activeInteractionId: id }),

  // --- Skill Check ---
  setSkillCheckResult: (result) => set({ skillCheckResult: result }),

  // --- Zone Triggers ---
  setActiveZoneTriggers: (triggers) => set({ activeZoneTriggers: triggers }),

  // --- Reset ---
  resetExplore: () => set({ ...INITIAL_STATE }),
}));
