// packages/backend/src/core/systems/FogOfWar.ts
import type {
  Entity, EntityId, HexCoord, Vector3D,
  FogState, FogCellState, FogOfWarState, FogUpdatePayload,
  TerrainVisibility, MapData, TileDef,
} from '@hard-vtt/shared';
import { SpatialSystem } from './SpatialSystem.js';
import { VectorMath } from '../../utils/VectorMath.js';
import { Logger } from '../../utils/Logger.js';

/**
 * 六边形战争迷雾系统
 *
 * 设计理念：
 * - 三态迷雾：UNEXPLORED（从未见过）/ EXPLORED（曾经见过但当前不在视野中）/ VISIBLE（当前可见）
 * - FOV 基于六边形视线距离 + 地形阻挡
 * - 增量广播：只发送视野变化的 hex，而非完整迷雾状态
 *
 * 类比：像打开手电筒探索黑暗房间 — 走过的地方会记住布局（EXPLORED），
 * 当前照亮的区域能看清所有细节（VISIBLE），没去过的地方完全未知（UNEXPLORED）。
 */
export class FogOfWar {
  private state: FogOfWarState;
  private entityFov: Map<EntityId, Set<string>> = new Map();
  private logger: Logger;
  /** 默认 FOV 范围（hex 数） */
  private defaultSightRange: number;

  constructor(defaultSightRange: number = 6) {
    this.state = { cells: {}, visibleHexes: [] };
    this.defaultSightRange = defaultSightRange;
    this.logger = Logger.create('System:FogOfWar');
  }

  // ============================================================
  //  FOV 计算核心
  // ============================================================

  /**
   * 计算实体的当前视野（返回可见 hex 集合）
   *
   * 使用六边形射线投射算法：
   * 1. 从实体 hex 出发，向所有方向发射射线
   * 2. 沿射线逐步检查 hex 是否被地形阻挡
   * 3. 遇到阻挡 hex 后停止该射线
   * 4. 返回所有可见 hex
   *
   * @param entity      观察者实体
   * @param mapData     地图数据（含地形信息）
   * @param allEntities 所有实体（用于实体阻挡判定）
   * @param sightRange  视线距离（hex 数），默认取实体 sightRange
   * @returns           当前可见的 hex 坐标集合
   */
  calculateFOV(
    entity: Entity,
    mapData: MapData | null,
    allEntities: Entity[],
    sightRange?: number,
  ): Set<HexCoord> {
    const originHex = VectorMath.vector3DToHex(entity.transform.coords);
    const range = sightRange ?? this.defaultSightRange;
    const visible = new Set<HexCoord>();
    visible.add(originHex); // 自身所在 hex 始终可见

    // 构建阻挡 hex 集合（WALL / OBSTACLE 地形）
    const blockingHexes = this.buildBlockingSet(mapData);

    // 六边形环扩展 + 视线检查
    for (let r = 1; r <= range; r++) {
      const ring = this.getHexRing(originHex, r);
      for (const hex of ring) {
        if (this.hasLineOfSight(originHex, hex, blockingHexes, mapData)) {
          visible.add(hex);
        }
      }
    }

    // calculateFOV 是纯计算函数，不修改内部状态
    // entityFov 缓存由 updateFog 管理，以保证前后 FOV 差分计算正确
    return visible;
  }

  /**
   * 检查从 origin 到 target 是否有视线（射线检测）
   *
   * 算法：沿六边形直线逐步推进，检查途中每个 hex 是否阻挡视线
   */
  hasLineOfSight(
    origin: HexCoord,
    target: HexCoord,
    blockingHexes: Set<string>,
    mapData: MapData | null,
  ): boolean {
    const dist = SpatialSystem.hexDistance(origin, target);
    if (dist <= 1) return true;

    // 六边形直线插值
    const fromCube = this.axialToCube(origin);
    const toCube = this.axialToCube(target);
    const steps = dist;

    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const cubeInterp = {
        x: fromCube.x + (toCube.x - fromCube.x) * t,
        y: fromCube.y + (toCube.y - fromCube.y) * t,
        z: fromCube.z + (toCube.z - fromCube.z) * t,
      };
      const hex = this.cubeRoundToAxial(cubeInterp);

      if (blockingHexes.has(this.hexKey(hex))) {
        // 检查该 tile 的高度是否完全阻挡视线
        const tile = this.getTile(hex, mapData);
        if (tile && this.isVisionBlocking(tile)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * 获取六边形环上所有 hex（距离中心 r 步的所有 hex）
   */
  getHexRing(center: HexCoord, radius: number): HexCoord[] {
    if (radius === 0) return [center];

    const results: HexCoord[] = [];
    // 从 center 向一个方向走 r 步，然后绕圈走 r 步
    let hex: HexCoord = { q: center.q + radius, r: center.r - radius };

    // 六个方向的增量（轴向坐标）
    const directions: [number, number][] = [
      [0, 1], [-1, 1], [-1, 0],
      [0, -1], [1, -1], [1, 0],
    ];

    for (let dir = 0; dir < 6; dir++) {
      const [dq, dr] = directions[dir];
      for (let step = 0; step < radius; step++) {
        results.push({ ...hex });
        hex = { q: hex.q + dq, r: hex.r + dr };
      }
    }

    return results;
  }

  /**
   * 获取指定范围内的所有 hex（完整填充，非仅环）
   */
  getHexesInRange(center: HexCoord, range: number): HexCoord[] {
    const results: HexCoord[] = [center];
    for (let r = 1; r <= range; r++) {
      results.push(...this.getHexRing(center, r));
    }
    return results;
  }

  // ============================================================
  //  迷雾状态管理
  // ============================================================

  /**
   * 更新实体的迷雾状态 — 将新 FOV 与当前状态比较，生成增量更新
   *
   * @param entity       观察者实体
   * @param newFov       当前计算的可见 hex 集合
   * @param currentTick  当前 tick（用于 lastSeenTick）
   * @returns            增量迷雾更新（新增可见、新探索、新遮蔽）
   */
  updateFog(
    entity: Entity,
    newFov: Set<HexCoord>,
    currentTick: number,
  ): FogUpdatePayload {
    const previousVisible = this.getEntityVisibleHexes(entity.id);
    const previousVisibleSet = new Set(previousVisible.map(h => this.hexKey(h)));

    const newFovKeySet = new Set<string>();
    for (const h of newFov) {
      newFovKeySet.add(this.hexKey(h));
    }

    // 新增可见：之前不可见，现在可见
    const revealedHexes: HexCoord[] = [];
    for (const h of newFov) {
      const key = this.hexKey(h);
      if (!previousVisibleSet.has(key)) {
        revealedHexes.push(h);
      }
    }

    // 新遮蔽：之前可见，现在不可见
    const obscuredHexes: HexCoord[] = [];
    for (const prev of previousVisible) {
      if (!newFovKeySet.has(this.hexKey(prev))) {
        obscuredHexes.push(prev);
      }
    }

    // 新探索：UNEXPLORED → EXPLORED（首次发现）
    const exploredHexes: HexCoord[] = [];
    for (const h of newFov) {
      const key = this.hexKey(h);
      const existing = this.state.cells[key];
      if (!existing || existing.state === 'UNEXPLORED') {
        const fogCell: FogCellState = {
          hex: h,
          state: 'VISIBLE',
          lastSeenTick: currentTick,
        };
        this.state.cells[key] = fogCell;

        if (!existing) {
          exploredHexes.push(h);
        }
      } else {
        // 更新为 VISIBLE
        this.state.cells[key] = {
          ...existing,
          state: 'VISIBLE',
          lastSeenTick: currentTick,
        };
      }
    }

    // 将遮蔽的 hex 标记为 EXPLORED
    for (const h of obscuredHexes) {
      const key = this.hexKey(h);
      const existing = this.state.cells[key];
      if (existing && existing.state === 'VISIBLE') {
        this.state.cells[key] = {
          ...existing,
          state: 'EXPLORED',
        };
      }
    }

    // 更新可见 hex 列表
    this.state.visibleHexes = Array.from(newFov);

    const payload: FogUpdatePayload = {
      entityId: entity.id,
      revealedHexes,
      obscuredHexes,
      exploredHexes,
    };

    this.logger.debug(
      `Fog update for ${entity.id}: +${revealedHexes.length} revealed, -${obscuredHexes.length} obscured, +${exploredHexes.length} explored`,
      { entityId: entity.id, revealed: revealedHexes.length, obscured: obscuredHexes.length, explored: exploredHexes.length },
    );

    return payload;
  }

  /**
   * 为多个实体批量更新迷雾
   * @returns 每个实体的增量迷雾更新
   */
  updateFogForAll(
    entities: Entity[],
    mapData: MapData | null,
    currentTick: number,
  ): FogUpdatePayload[] {
    const updates: FogUpdatePayload[] = [];
    // 收集所有实体用于相互可见性判定
    const allEntities = Array.from(entities);

    for (const entity of entities) {
      const sightRange = (entity as any).sightRange ?? this.defaultSightRange;
      const fov = this.calculateFOV(entity, mapData, allEntities, sightRange);
      const update = this.updateFog(entity, fov, currentTick);
      updates.push(update);
    }

    return updates;
  }

  /**
   * 获取实体的当前可见 hex 列表
   */
  getEntityVisibleHexes(entityId: EntityId): HexCoord[] {
    const keys = this.entityFov.get(entityId);
    if (!keys) return [];

    return this.deserializeHexSet(keys);
  }

  /**
   * 检查指定 hex 对实体是否可见
   */
  isHexVisibleTo(entityId: EntityId, hex: HexCoord): boolean {
    const key = this.hexKey(hex);
    const cell = this.state.cells[key];
    if (!cell) return false;

    // 检查该实体当前 FOV 中是否包含此 hex
    const fovKeys = this.entityFov.get(entityId);
    if (!fovKeys) return false;
    return fovKeys.has(key);
  }

  /**
   * 检查指定 hex 是否被任何实体探索过
   */
  isHexExplored(hex: HexCoord): boolean {
    const key = this.hexKey(hex);
    const cell = this.state.cells[key];
    return cell !== undefined && cell.state !== 'UNEXPLORED';
  }

  /**
   * 获取 hex 的迷雾状态
   */
  getHexFogState(hex: HexCoord): FogState {
    const key = this.hexKey(hex);
    const cell = this.state.cells[key];
    return cell?.state ?? 'UNEXPLORED';
  }

  /**
   * 获取所有已探索 hex 的地图
   */
  getExploredMap(): Record<string, FogCellState> {
    return { ...this.state.cells };
  }

  // ============================================================
  //  实体可见性过滤
  // ============================================================

  /**
   * 根据 FOV 过滤可见实体列表
   *
   * 实体在 hex 上可见的条件：
   * 1. 该 hex 对观察者当前可见（VISIBLE）
   * 2. 目标实体非隐藏/非隐身
   *
   * @param viewerId   观察者 ID
   * @param entities   所有实体列表
   * @param mapData    地图数据
   * @returns          观察者可见的实体列表
   */
  filterVisibleEntities(
    viewerId: EntityId,
    entities: Entity[],
    mapData: MapData | null,
  ): Entity[] {
    return entities.filter(target => {
      // 自己始终可见
      if (target.id === viewerId) return true;

      // 检查隐身标签
      if (target.tags?.includes('INVISIBLE') || target.tags?.includes('HIDDEN')) {
        return false;
      }

      // 检查目标所在 hex 是否对观察者可见
      const targetHex = VectorMath.vector3DToHex(target.transform.coords);
      return this.isHexVisibleTo(viewerId, targetHex);
    });
  }

  /**
   * 检查实体 A 是否能看到实体 B
   */
  canSeeEntity(viewerId: EntityId, target: Entity): boolean {
    if (viewerId === target.id) return true;
    if (target.tags?.includes('INVISIBLE') || target.tags?.includes('HIDDEN')) {
      return false;
    }
    const targetHex = VectorMath.vector3DToHex(target.transform.coords);
    return this.isHexVisibleTo(viewerId, targetHex);
  }

  // ============================================================
  //  重置 & 序列化
  // ============================================================

  /**
   * 完全重置迷雾（新地图加载时调用）
   */
  reset(mapData?: MapData): void {
    this.state = { cells: {}, visibleHexes: [] };
    this.entityFov.clear();
    this.logger.info('Fog of war reset', mapData ? { mapId: mapData.id } : undefined);
  }

  /**
   * 初始化地图 — 将所有非阻挡 hex 标记为已探索
   * （用于已知区域初始加载）
   */
  initializeMap(mapData: MapData, currentTick: number): void {
    this.reset(mapData);

    for (const tile of mapData.tiles) {
      this.state.cells[this.hexKey(tile.hex)] = {
        hex: tile.hex,
        state: 'UNEXPLORED',
        lastSeenTick: 0,
      };
    }

    this.logger.info(
      `Fog map initialized: ${mapData.tiles.length} tiles`,
      { mapId: mapData.id, tileCount: mapData.tiles.length },
    );
  }

  /**
   * 序列化当前迷雾状态（用于持久化或网络传输）
   */
  serialize(): FogOfWarState {
    return {
      cells: { ...this.state.cells },
      visibleHexes: [...this.state.visibleHexes],
    };
  }

  /**
   * 从序列化数据恢复迷雾状态
   */
  deserialize(saved: FogOfWarState): void {
    this.state = {
      cells: { ...saved.cells },
      visibleHexes: [...saved.visibleHexes],
    };
  }

  // ============================================================
  //  辅助方法
  // ============================================================

  /**
   * 构建阻挡视线 hex 集合
   */
  private buildBlockingSet(mapData: MapData | null): Set<string> {
    const blocking = new Set<string>();
    if (!mapData) return blocking;

    for (const tile of mapData.tiles) {
      if (this.isVisionBlocking(tile)) {
        blocking.add(this.hexKey(tile.hex));
      }
    }
    return blocking;
  }

  /**
   * 判断 tile 是否阻挡视线
   */
  private isVisionBlocking(tile: TileDef): boolean {
    return tile.terrain === 'WALL' || tile.terrain === 'OBSTACLE';
  }

  /**
   * 获取指定 hex 的 tile
   */
  private getTile(hex: HexCoord, mapData: MapData | null): TileDef | undefined {
    if (!mapData) return undefined;
    return mapData.tiles.find(t => t.hex.q === hex.q && t.hex.r === hex.r);
  }

  /**
   * hex 序列化为字符串 "q,r"
   */
  hexKey(hex: HexCoord): string {
    return `${hex.q},${hex.r}`;
  }

  /**
   * 从字符串 "q,r" 反序列化 hex
   */
  parseHexKey(key: string): HexCoord {
    const [q, r] = key.split(',').map(Number);
    return { q, r };
  }

  /**
   * 序列化 HexCoord 集合为字符串集合
   */
  private serializeHexSet(hexes: Set<HexCoord>): Set<string> {
    const result = new Set<string>();
    for (const h of hexes) {
      result.add(this.hexKey(h));
    }
    return result;
  }

  /**
   * 从字符串集合反序列化 HexCoord 数组
   */
  private deserializeHexSet(keys: Set<string>): HexCoord[] {
    return Array.from(keys).map(k => this.parseHexKey(k));
  }

  /**
   * 轴向坐标 → 立方坐标
   */
  private axialToCube(hex: HexCoord): { x: number; y: number; z: number } {
    return { x: hex.q, y: hex.r, z: -hex.q - hex.r };
  }

  /**
   * 立方坐标取整 → 轴向坐标
   */
  private cubeRoundToAxial(cube: { x: number; y: number; z: number }): HexCoord {
    let rx = Math.round(cube.x);
    let ry = Math.round(cube.y);
    let rz = Math.round(cube.z);

    const dx = Math.abs(rx - cube.x);
    const dy = Math.abs(ry - cube.y);
    const dz = Math.abs(rz - cube.z);

    if (dx > dy && dx > dz) {
      rx = -ry - rz;
    } else if (dy > dz) {
      ry = -rx - rz;
    }

    return { q: rx, r: ry };
  }
}
