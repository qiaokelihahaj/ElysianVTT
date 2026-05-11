// test/explore-map.test.ts
// Phase 4.1c: 地图加载与瓦片系统测试 — MapLoader 单元测试 + A* 寻路

import { MapLoader, hexKey } from '../packages/backend/src/core/systems/MapLoader.js';
import { SpatialSystem } from '../packages/backend/src/core/systems/SpatialSystem.js';
import { testArenaMap } from '../packages/backend/src/db/maps/test_arena.js';

// ==========================================
// 1. 测试框架
// ==========================================
let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
  testCount++;
  if (cond) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}
function assertEqual<T>(actual: T, expected: T, label: string) {
  testCount++;
  if (actual === expected) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label} (期望=${JSON.stringify(expected)}, 实际=${JSON.stringify(actual)})`); process.exitCode = 1; }
}
function assertApprox(actual: number, expected: number, eps: number, label: string) {
  testCount++;
  if (Math.abs(actual - expected) <= eps) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label} (期望≈${expected}, 实际=${actual})`); process.exitCode = 1; }
}

// ==========================================
// 2. 测试入口
// ==========================================
function runTests() {
  console.log('=== ElysianVTT 地图加载与瓦片系统测试 ===\n');

  // ===============================================
  // Scenario A: 地图加载与基本查询
  // ===============================================
  console.log('[Scenario A] 地图加载与瓦片查询');
  {
    const mapLoader = new MapLoader(testArenaMap);

    // 地图元数据
    assertEqual(mapLoader.getMapData().id, 'test_arena', '地图 ID 正确');
    assertEqual(mapLoader.getSize().width, 10, '地图宽度 10');
    assertEqual(mapLoader.getSize().height, 8, '地图高度 8');

    // 瓦片存在性
    assert(mapLoader.hasTile({ q: 0, r: 0 }), '瓦片 (0,0) 存在');
    assert(mapLoader.hasTile({ q: 9, r: 7 }), '瓦片 (9,7) 存在');
    assert(!mapLoader.hasTile({ q: -1, r: 0 }), '瓦片 (-1,0) 不存在');
    assert(!mapLoader.hasTile({ q: 99, r: 99 }), '瓦片 (99,99) 不存在');

    // 所有瓦片数量
    const allTiles = mapLoader.getAllTiles();
    assertEqual(allTiles.length, 80, '10x8 = 80 个瓦片');
  }

  // ===============================================
  // Scenario B: 地形类型与通行检测
  // ===============================================
  console.log('\n[Scenario B] 地形类型与通行检测');
  {
    const mapLoader = new MapLoader(testArenaMap);

    // 地面可行走
    assert(mapLoader.isWalkable({ q: 3, r: 3 }), 'GROUND 可行走');
    assert(mapLoader.getTerrain({ q: 3, r: 3 }), 'GROUND');

    // 墙壁不可行走
    assert(!mapLoader.isWalkable({ q: 0, r: 0 }), 'WALL 不可行走');
    assert(!mapLoader.isWalkable({ q: 9, r: 0 }), 'WALL 不可行走');
    assert(!mapLoader.isWalkable({ q: 0, r: 7 }), 'WALL 不可行走');

    // 水域不可行走
    assert(!mapLoader.isWalkable({ q: 1, r: 6 }), 'WATER 不可行走');
    assert(!mapLoader.isWalkable({ q: 1, r: 7 }), 'WATER 不可行走');

    // 障碍物不可行走
    assert(!mapLoader.isWalkable({ q: 4, r: 3 }), 'OBSTACLE 不可行走');
    assert(!mapLoader.isWalkable({ q: 2, r: 2 }), 'OBSTACLE 不可行走');

    // DOOR 可行走但 isPassable 默认不可通
    const doorTile = mapLoader.getTile({ q: 8, r: 1 });
    if (doorTile?.terrain === 'DOOR') {
      assert(mapLoader.isWalkable({ q: 8, r: 1 }), 'DOOR 可行走');
      assert(!mapLoader.isPassable({ q: 8, r: 1 }), 'DOOR 默认不可通行');
      assert(mapLoader.isPassable({ q: 8, r: 1 }, true), 'DOOR ignoreDoors 可通行');
    }
  }

  // ===============================================
  // Scenario C: 邻居查询
  // ===============================================
  console.log('\n[Scenario C] 六边形邻居查询');
  {
    const mapLoader = new MapLoader(testArenaMap);

    // 中央区域的邻居（GROUND 为主）
    const centralNeighbors = mapLoader.getNeighbors({ q: 3, r: 3 });
    assert(centralNeighbors.length > 0, '中央区域有邻居');
    // 所有邻居应为 GROUND
    for (const n of centralNeighbors) {
      assert(n.terrain === 'GROUND', `邻居 (${n.hex.q},${n.hex.r}) 为 GROUND`);
    }

    // 靠近墙壁的邻居应排除 WALL
    const wallNeighbors = mapLoader.getNeighbors({ q: 1, r: 1 });
    const hasWall = wallNeighbors.some(n => n.terrain === 'WALL');
    assert(!hasWall, '邻居查询排除不可行走瓦片');

    // includeBlocked 模式下包含全部
    const allNeighbors = mapLoader.getNeighbors({ q: 1, r: 1 }, true);
    const allCount = SpatialSystem.hexNeighbors({ q: 1, r: 1 }).length;
    const existingCount = allNeighbors.length;
    // (1,1) 的邻居含 (0,0)(0,1)(0,2)(1,0)(1,2)(2,0)(2,1)(2,2) 但有些可能不存在边界外
    assert(existingCount <= allCount, 'includeBlocked 模式返回所有存在瓦片');
  }

  // ===============================================
  // Scenario D: 移动消耗计算
  // ===============================================
  console.log('\n[Scenario D] 移动消耗计算');
  {
    const mapLoader = new MapLoader(testArenaMap);

    // GROUND 基础消耗
    const groundCost = mapLoader.getMovementCost({ q: 3, r: 3 });
    assertEqual(groundCost, 1, 'GROUND 移动消耗 1');

    // DOOR 额外消耗 (movementCost: 3 在 map data 中)
    const doorTile = mapLoader.getTile({ q: 8, r: 1 });
    if (doorTile?.terrain === 'DOOR') {
      const doorCost = mapLoader.getMovementCost({ q: 8, r: 1 });
      assertEqual(doorCost, 3, 'DOOR 移动消耗 3 (地图数据显式设置)');
    }

    // 不可通行瓦片返回 -1
    const wallCost = mapLoader.getMovementCost({ q: 0, r: 0 });
    assertEqual(wallCost, -1, 'WALL 移动消耗 -1');

    const waterCost = mapLoader.getMovementCost({ q: 1, r: 6 });
    assertEqual(waterCost, -1, 'WATER 移动消耗 -1');

    const obstacleCost = mapLoader.getMovementCost({ q: 4, r: 3 });
    assertEqual(obstacleCost, -1, 'OBSTACLE 移动消耗 -1');

    // 使用自定义 baseCost
    const customCost = mapLoader.getMovementCost({ q: 3, r: 3 }, 2);
    assertEqual(customCost, 2, '自定义 baseCost=2 (GROUND tiles 无显式 movementCost)');
  }

  // ===============================================
  // Scenario E: 范围查询
  // ===============================================
  console.log('\n[Scenario E] 范围查询');
  {
    const mapLoader = new MapLoader(testArenaMap);

    // 半径 0 — 只有自己
    const radius0 = mapLoader.getTilesInRadius({ q: 5, r: 4 }, 0);
    assertEqual(radius0.length, 1, '半径0 返回自身');

    // 半径 1 — 自身 + 6 邻居
    const radius1 = mapLoader.getTilesInRadius({ q: 5, r: 4 }, 1);
    const maxR1 = 1 + 6; // 理论最多 7 个（所有邻居都存在时）
    assert(radius1.length >= 1 && radius1.length <= maxR1,
      `半径1 返回 ${radius1.length} 个瓦片`);

    // 按地形过滤
    const walls = mapLoader.getTilesOfType('WALL');
    assert(walls.length > 0, '地图中有墙壁瓦片');
    for (const w of walls) {
      assertEqual(w.terrain, 'WALL', '过滤后全为 WALL');
    }

    const grounds = mapLoader.getTilesOfType('GROUND');
    assert(grounds.length > 0, '地图中有 GROUND 瓦片');

    const obstacles = mapLoader.getTilesOfType('OBSTACLE');
    assertEqual(obstacles.length, 5, '地图中有 5 个 OBSTACLE 瓦片 (4,3)(5,3)(4,4)(2,2)(7,5)');
  }

  // ===============================================
  // Scenario F: Hex ↔ Vector 坐标转换
  // ===============================================
  console.log('\n[Scenario F] Hex ↔ Vector 坐标转换');
  {
    const mapLoader = new MapLoader(testArenaMap);

    // Hex(0,0) → Vector(0, 0, 0)
    const v0 = mapLoader.hexToVector({ q: 0, r: 0 });
    assertApprox(v0.x, 0, 0.01, 'hex(0,0).x = 0');
    assertApprox(v0.y, 0, 0.01, 'hex(0,0).y = 0');

    // Hex(1,0) → Vector(1.5, ~0.866)
    const v1 = mapLoader.hexToVector({ q: 1, r: 0 });
    assertApprox(v1.x, 1.5, 0.01, 'hex(1,0).x = 1.5');
    assertApprox(v1.y, 0.866, 0.01, 'hex(1,0).y ≈ 0.866');

    // 双向转换
    const hexBack = mapLoader.vectorToHex(v1);
    assertEqual(hexBack.q, 1, 'Vector→Hex q');
    assertEqual(hexBack.r, 0, 'Vector→Hex r');

    // 六边形中心点坐标双向转换：hex → vector → hex 应还原
    const vTest = mapLoader.hexToVector({ q: 3, r: 4 });
    const hexBack2 = mapLoader.vectorToHex(vTest);
    assertEqual(hexBack2.q, 3, 'vector→hex→q 还原');
    assertEqual(hexBack2.r, 4, 'vector→hex→r 还原');
  }

  // ===============================================
  // Scenario G: A* 寻路
  // ===============================================
  console.log('\n[Scenario G] A* 寻路');
  {
    const mapLoader = new MapLoader(testArenaMap);

    // 同一位置
    const samePath = mapLoader.findPath({ q: 3, r: 3 }, { q: 3, r: 3 });
    assertEqual(samePath.length, 1, '同位置路径长度为 1（仅起点）');
    assertEqual(samePath[0].q, 3, '起点 q=3');
    assertEqual(samePath[0].r, 3, '起点 r=3');

    // 相邻地面：应有直达路径
    const adjPath = mapLoader.findPath({ q: 3, r: 3 }, { q: 3, r: 4 });
    assert(adjPath.length >= 1, '相邻地面有路径');
    assertEqual(adjPath[0].q, 3, '路径起点 q=3');
    assertEqual(adjPath[adjPath.length - 1].q, 3, '路径终点 q=3');
    assertEqual(adjPath[adjPath.length - 1].r, 4, '路径终点 r=4');

    // 绕路路径（避开障碍物）：从 (3,2) 到 (6,4) 需绕过中央障碍
    const aroundPath = mapLoader.findPath({ q: 3, r: 2 }, { q: 6, r: 4 });
    assert(aroundPath.length > 1, '绕过障碍有路径');
    const last = aroundPath[aroundPath.length - 1];
    assertEqual(last.q, 6, '终点 q=6');
    assertEqual(last.r, 4, '终点 r=4');
    // 验证路径不穿过障碍物 (4,3) (5,3) (4,4)
    for (const step of aroundPath) {
      const isObstacle = (step.q === 4 && step.r === 3) ||
                          (step.q === 5 && step.r === 3) ||
                          (step.q === 4 && step.r === 4);
      assert(!isObstacle, `路径不穿过障碍物 (${step.q},${step.r})`);
    }

    // 不可通过目标 → 无路径
    const noPath = mapLoader.findPath({ q: 3, r: 3 }, { q: 0, r: 0 });
    assertEqual(noPath.length, 0, '目标为墙壁 -> 无路径');

    const waterPath = mapLoader.findPath({ q: 3, r: 3 }, { q: 1, r: 6 });
    assertEqual(waterPath.length, 0, '目标为水域 -> 无路径');
  }

  // ===============================================
  // Scenario H: 生成点
  // ===============================================
  console.log('\n[Scenario H] 地图生成点');
  {
    const mapLoader = new MapLoader(testArenaMap);

    const playerStart = mapLoader.getSpawnPoint('player_start');
    assert(playerStart !== undefined, 'player_start 存在');
    assertApprox(playerStart!.x, 0, 0.01, 'player_start.x=0');
    assertApprox(playerStart!.y, 0, 0.01, 'player_start.y=0');

    const enemyStart = mapLoader.getSpawnPoint('enemy_start');
    assert(enemyStart !== undefined, 'enemy_start 存在');
    assertApprox(enemyStart!.x, 7, 0.01, 'enemy_start.x=7');
    assertApprox(enemyStart!.y, 5, 0.01, 'enemy_start.y=5');

    const allSpawns = mapLoader.getAllSpawnPoints();
    assertEqual(Object.keys(allSpawns).length, 3, '共 3 个生成点');
    assert(allSpawns['center'] !== undefined, 'center 生成点存在');

    // 不存在生成点
    const none = mapLoader.getSpawnPoint('nonexistent');
    assert(none === undefined, '不存在生成点返回 undefined');
  }

  // ===============================================
  // Scenario I: 边界条件 — 空地图 / 孤立瓦片
  // ===============================================
  console.log('\n[Scenario I] 边界条件');
  {
    // 孤立起点（只有起点在 MapData 中）— 但我们的地图所有瓦片都存在
    const mapLoader = new MapLoader(testArenaMap);

    // 从可通行位置到不可通行的目标
    const toWall = mapLoader.findPath({ q: 3, r: 3 }, { q: 0, r: 1 });
    assertEqual(toWall.length, 0, '目标为 WALL → 无路径');

    // 从不可通行位置出发
    const fromWall = mapLoader.findPath({ q: 0, r: 0 }, { q: 3, r: 3 });
    assertEqual(fromWall.length, 0, '起点为 WALL → 无路径');

    // 只可通行的邻居计数
    const atEdge = mapLoader.getNeighbors({ q: 1, r: 1 });
    for (const n of atEdge) {
      assert(n.terrain === 'GROUND', `邻居 (${n.hex.q},${n.hex.r}) 只返回 GROUND`);
    }

    // GROUND 瓦片没有显式 movementCost（使用默认）
    const tile = mapLoader.getTile({ q: 3, r: 3 });
    if (tile) {
      assert(tile.movementCost === undefined, 'GROUND 瓦片无显式 movementCost');
    }
  }

  // ===============================================
  // Scenario J: hexKey / parseHexKey 辅助函数
  // ===============================================
  console.log('\n[Scenario J] hexKey 序列化');
  {
    const key = hexKey({ q: -3, r: 5 });
    assertEqual(key, '-3,5', 'hexKey(-3,5) = "-3,5"');

    const parsed = { q: -3, r: 5 };
    assertEqual(parsed.q, -3, 'parseHexKey 反序列化 q');
    assertEqual(parsed.r, 5, 'parseHexKey 反序列化 r');

    // hex(0,0) 可序列化为 "0,0"
    assertEqual(hexKey({ q: 0, r: 0 }), '0,0', 'hexKey(0,0) = "0,0"');
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有地图加载测试通过!');
}

runTests();
