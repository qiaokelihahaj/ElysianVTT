// packages/backend/src/core/systems/MapLoader.ts
// Phase 4.1c: 地图加载与瓦片系统 — 支持六边形网格地图的解析、查询和路径计算

import type { HexCoord, TileDef, TerrainType, MapData, Vector3D } from '@hard-vtt/shared';
import { SpatialSystem } from './SpatialSystem.js';
import { VectorMath } from '../../utils/VectorMath.js';

export class MapLoader {
  private tiles: Map<string, TileDef> = new Map();
  private mapData: MapData;

  constructor(mapData: MapData) {
    this.mapData = mapData;
    for (const tile of mapData.tiles) {
      const key = hexKey(tile.hex);
      this.tiles.set(key, tile);
    }
  }

  /** 获取原始 MapData */
  public getMapData(): MapData {
    return this.mapData;
  }

  /** 通过 HexCoord 获取瓦片定义 */
  public getTile(hex: HexCoord): TileDef | undefined {
    return this.tiles.get(hexKey(hex));
  }

  /** 通过 HexCoord 获取瓦片地形类型 */
  public getTerrain(hex: HexCoord): TerrainType | undefined {
    return this.tiles.get(hexKey(hex))?.terrain;
  }

  /** 检查六边形是否在地图范围内 */
  public hasTile(hex: HexCoord): boolean {
    return this.tiles.has(hexKey(hex));
  }

  /** 获取所有瓦片 */
  public getAllTiles(): TileDef[] {
    return Array.from(this.tiles.values());
  }

  /** 检查瓦片是否可行走 */
  public isWalkable(hex: HexCoord): boolean {
    const tile = this.getTile(hex);
    if (!tile) return false;
    return tile.terrain === 'GROUND' || tile.terrain === 'DOOR';
  }

  /** 检查瓦片是否可通行（含 DOOR 特殊处理） */
  public isPassable(hex: HexCoord, ignoreDoors: boolean = false): boolean {
    const tile = this.getTile(hex);
    if (!tile) return false;
    if (tile.terrain === 'DOOR' && !ignoreDoors) return false;
    return tile.terrain === 'GROUND' || tile.terrain === 'DOOR';
  }

  /**
   * 获取六边形的邻居瓦片（仅返回存在且通过的瓦片）
   * @param hex 目标六边形
   * @param includeBlocked 是否包含不可通行的瓦片
   */
  public getNeighbors(hex: HexCoord, includeBlocked: boolean = false): TileDef[] {
    const neighbors = SpatialSystem.hexNeighbors(hex);
    return neighbors
      .map(n => this.getTile(n))
      .filter((t): t is TileDef => {
        if (!t) return false;
        if (includeBlocked) return true;
        return this.isWalkable(t.hex);
      });
  }

  /**
   * 获取移动到目标六边形的移动消耗
   * @param hex 目标六边形
   * @param baseCost 基础移动消耗（默认 1）
   * @returns -1 表示不可通行
   */
  public getMovementCost(hex: HexCoord, baseCost: number = 1): number {
    const tile = this.getTile(hex);
    if (!tile) return -1;
    if (!this.isWalkable(hex)) return -1;
    if (tile.movementCost !== undefined) return tile.movementCost;
    switch (tile.terrain) {
      case 'GROUND': return baseCost;
      case 'DOOR': return baseCost + 1;
      default: return -1;
    }
  }

  /**
   * 获取指定范围内所有瓦片
   */
  public getTilesInRadius(center: HexCoord, radius: number): TileDef[] {
    const result: TileDef[] = [];
    for (const tile of this.tiles.values()) {
      const dist = SpatialSystem.hexDistance(center, tile.hex);
      if (dist <= radius) {
        result.push(tile);
      }
    }
    return result;
  }

  /**
   * 获取指定地形类型的所有瓦片
   */
  public getTilesOfType(terrain: TerrainType): TileDef[] {
    const result: TileDef[] = [];
    for (const tile of this.tiles.values()) {
      if (tile.terrain === terrain) {
        result.push(tile);
      }
    }
    return result;
  }

  /**
   * 获取所有可通行的瓦片
   */
  public getWalkableTiles(): TileDef[] {
    return this.getTilesOfType('GROUND');
  }

  /**
   * 将 Vector3D 世界坐标转换到 HexCoord
   */
  public vectorToHex(v3: Vector3D): HexCoord {
    return VectorMath.vector3DToHex(v3);
  }

  /**
   * 将 HexCoord 转换到 Vector3D 世界坐标
   */
  public hexToVector(hex: HexCoord, zOffset?: number): Vector3D {
    return VectorMath.hexToVector3D(hex, zOffset);
  }

  /**
   * A* 寻路：从 from 到 to 的最短路径
   * 使用六边形距离作为启发函数
   * @returns HexCoord[] 路径（含起点和终点），无法到达时返回空数组
   */
  public findPath(from: HexCoord, to: HexCoord): HexCoord[] {
    if (!this.hasTile(from) || !this.hasTile(to)) return [];
    if (!this.isWalkable(to)) return [];

    const fromKey = hexKey(from);
    const toKey = hexKey(to);

    const openSet = new Set<string>([fromKey]);
    // cameFrom: childKey -> parentKey
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>();
    const fScore = new Map<string, number>();

    gScore.set(fromKey, 0);
    fScore.set(fromKey, SpatialSystem.hexDistance(from, to));

    while (openSet.size > 0) {
      // 找 fScore 最小的节点
      let currentKey = '';
      let currentF = Infinity;
      for (const key of openSet) {
        const score = fScore.get(key) ?? Infinity;
        if (score < currentF) {
          currentF = score;
          currentKey = key;
        }
      }

      if (currentKey === toKey) {
        return reconstructPath(cameFrom, currentKey);
      }

      openSet.delete(currentKey);
      const currentHex = parseHexKey(currentKey);

      const neighbors = SpatialSystem.hexNeighbors(currentHex);
      for (const neighbor of neighbors) {
        const nKey = hexKey(neighbor);
        if (!this.isWalkable(neighbor)) continue;

        const moveCost = this.getMovementCost(neighbor);
        if (moveCost < 0) continue;

        const tentativeG = (gScore.get(currentKey) ?? Infinity) + moveCost;

        if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
          cameFrom.set(nKey, currentKey);
          gScore.set(nKey, tentativeG);
          fScore.set(nKey, tentativeG + SpatialSystem.hexDistance(neighbor, to));
          openSet.add(nKey);
        }
      }
    }

    return [];
  }

  /**
   * 获取指定位置的生成点坐标
   */
  public getSpawnPoint(name: string): Vector3D | undefined {
    return this.mapData.spawnPoints[name];
  }

  /**
   * 获取所有生成点
   */
  public getAllSpawnPoints(): Record<string, Vector3D> {
    return { ...this.mapData.spawnPoints };
  }

  /**
   * 获取地图尺寸信息
   */
  public getSize(): { width: number; height: number } {
    return { width: this.mapData.width, height: this.mapData.height };
  }
}

// ==========================================
// 辅助函数
// ==========================================

/** 将 HexCoord 序列化为字符串键 */
export function hexKey(hex: HexCoord): string {
  return `${hex.q},${hex.r}`;
}

/** 将字符串键解析回 HexCoord */
export function parseHexKey(key: string): HexCoord {
  const [q, r] = key.split(',').map(Number);
  return { q, r };
}

/**
 * 从 cameFrom 地图重建 A* 路径
 * cameFrom: childKey -> parentKey
 * currentKey 初始为 toKey，反向追溯到 fromKey
 */
function reconstructPath(
  cameFrom: Map<string, string>,
  currentKey: string
): HexCoord[] {
  const path: HexCoord[] = [];
  let key: string | undefined = currentKey;
  while (key) {
    path.unshift(parseHexKey(key));
    key = cameFrom.get(key);
  }
  return path;
}
