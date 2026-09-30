// packages/backend/src/db/maps/test_arena.ts
// Phase 4.1c: 测试用种子地图 — 小型竞技场 10x8 六边形网格

import type { MapData } from '@hard-vtt/shared';

/**
 * 测试竞技场地图：10x8 六边形网格
 *
 * 布局示意（q, r 轴向坐标）：
 *   GROUND: 大部分区域为可行走地面
 *   WALL:   地图外围边界 + 中央障碍
 *   WATER:  左下水池装饰
 *   OBSTACLE: 散布的障碍物
 *   DOOR:   入口（右上）
 *
 * 生成点：
 *   player_start: (0, 0)
 *   enemy_start:  (7, 5)
 */
export const testArenaMap: MapData = {
  id: 'test_arena',
  name: '测试竞技场',
  width: 10,
  height: 8,
  spawnPoints: {
    player_start: { x: 0, y: 0, z: 0 },
    enemy_start: { x: 7, y: 5, z: 0 },
    center: { x: 4, y: 3, z: 0 },
  },
  tiles: generateArenaTiles(),
  metadata: {
    description: 'Phase 4.1c 测试用竞技场地图',
    recommendedPlayers: '1v1',
  },
};

/**
 * 生成竞技场瓦片数据
 */
function generateArenaTiles(): MapData['tiles'] {
  const tiles: MapData['tiles'] = [];
  const mapWidth = 10;
  const mapHeight = 8;

  for (let r = 0; r < mapHeight; r++) {
    for (let q = 0; q < mapWidth; q++) {
      const hex = { q, r };
      // 外围边界为墙壁
      if (q === 0 || q === mapWidth - 1 || r === 0 || r === mapHeight - 1) {
        tiles.push({ hex, terrain: 'WALL', height: 3, movementCost: -1 });
        continue;
      }

      // 入口（右上角，可通过的 DOOR）
      if ((q === 8 && r === 1) || (q === 9 && r === 1)) {
        tiles.push({ hex, terrain: 'DOOR', height: 0, movementCost: 3 });
        continue;
      }

      // 左下角水池
      if ((q === 1 && r === 6) || (q === 1 && r === 7) || (q === 2 && r === 6)) {
        tiles.push({ hex, terrain: 'WATER', height: 0, movementCost: -1 });
        continue;
      }

      // 中央障碍物
      if ((q === 4 && r === 3) || (q === 5 && r === 3) || (q === 4 && r === 4)) {
        tiles.push({ hex, terrain: 'OBSTACLE', height: 1, movementCost: -1 });
        continue;
      }

      // 散布障碍
      if ((q === 2 && r === 2) || (q === 7 && r === 5)) {
        tiles.push({ hex, terrain: 'OBSTACLE', height: 1, movementCost: -1 });
        continue;
      }

      // 默认地面
      tiles.push({ hex, terrain: 'GROUND', height: 0 });
    }
  }

  return tiles;
}
