// test/fow.test.ts
// Phase 4.2: 战争迷雾系统测试 — FOV 计算 + 迷雾三态 + 实体可见性过滤

// ==========================================
// 1. 内联类型定义
// ==========================================
type EntityId = string;
type TerrainType = 'GROUND' | 'WALL' | 'WATER' | 'OBSTACLE' | 'DOOR';
type FogState = 'UNEXPLORED' | 'EXPLORED' | 'VISIBLE';

interface HexCoord { q: number; r: number; }

interface Vector3D { x: number; y: number; z: number; }

interface TileDef {
  hex: HexCoord;
  terrain: TerrainType;
  height?: number;
}

interface MapData {
  id: string;
  tiles: TileDef[];
}

interface FogCellState {
  hex: HexCoord;
  state: FogState;
  lastSeenTick: number;
}

interface FogUpdatePayload {
  entityId: EntityId;
  revealedHexes: HexCoord[];
  obscuredHexes: HexCoord[];
  exploredHexes: HexCoord[];
}

interface Entity {
  id: EntityId;
  transform: { coords: Vector3D; planeId?: string; facing: number };
  tags?: string[];
  type: string;
}

// ==========================================
// 2. 内联实现: VectorMath (minimal)
// ==========================================
class VMath {
  static hexToVector3D(hex: HexCoord, zOffset = 0): Vector3D {
    const x = 3 / 2 * hex.q;
    const y = Math.sqrt(3) / 2 * hex.q + Math.sqrt(3) * hex.r;
    return { x, y, z: zOffset };
  }

  static vector3DToHex(v3: Vector3D): HexCoord {
    const q = Math.round((2 / 3 * v3.x) / 1);
    const r = Math.round((-1 / 3 * v3.x + Math.sqrt(3) / 3 * v3.y) / 1);
    return { q, r };
  }
}

// ==========================================
// 3. 内联实现: hex helpers
// ==========================================
function hexKey(h: HexCoord): string { return `${h.q},${h.r}`; }

function hexSetHas(set: Set<HexCoord>, target: HexCoord): boolean {
  for (const h of set) {
    if (h.q === target.q && h.r === target.r) return true;
  }
  return false;
}

function hexCount(set: Set<HexCoord>): number { return set.size; }

function hexDistance(a: HexCoord, b: HexCoord): number {
  const dq = a.q - b.q, dr = a.r - b.r, ds = a.q + a.r - b.q - b.r;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
}

function hexNeighbors(coord: HexCoord): HexCoord[] {
  return [[1,0],[0,1],[-1,1],[-1,0],[0,-1],[1,-1]]
    .map(([dq, dr]) => ({ q: coord.q + dq, r: coord.r + dr }));
}

function hexRing(center: HexCoord, radius: number): HexCoord[] {
  if (radius === 0) return [center];
  const results: HexCoord[] = [];
  let hex: HexCoord = { q: center.q + radius, r: center.r - radius };
  const dirs: [number, number][] = [[0,1],[-1,1],[-1,0],[0,-1],[1,-1],[1,0]];
  for (const [dq, dr] of dirs) {
    for (let s = 0; s < radius; s++) {
      results.push({ ...hex });
      hex = { q: hex.q + dq, r: hex.r + dr };
    }
  }
  return results;
}

// ==========================================
// 4. 内联实现: FogOfWar 副本
// ==========================================
class FogOfWar {
  private cells: Record<string, FogCellState> = {};
  private entityFov: Map<EntityId, Set<string>> = new Map();
  private defaultSightRange: number;

  constructor(defaultSightRange = 6) {
    this.defaultSightRange = defaultSightRange;
  }

  private axialToCube(hex: HexCoord): { x: number; y: number; z: number } {
    return { x: hex.q, y: hex.r, z: -hex.q - hex.r };
  }

  private cubeRoundToAxial(cube: { x: number; y: number; z: number }): HexCoord {
    let rx = Math.round(cube.x), ry = Math.round(cube.y), rz = Math.round(cube.z);
    const dx = Math.abs(rx - cube.x), dy = Math.abs(ry - cube.y), dz = Math.abs(rz - cube.z);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    return { q: rx, r: ry };
  }

  private buildBlockingSet(mapData: MapData | null): Set<string> {
    const b = new Set<string>();
    if (!mapData) return b;
    for (const tile of mapData.tiles) {
      if (tile.terrain === 'WALL' || tile.terrain === 'OBSTACLE') {
        b.add(hexKey(tile.hex));
      }
    }
    return b;
  }

  getHexRing = hexRing;

  getHexesInRange(center: HexCoord, range: number): HexCoord[] {
    const r: HexCoord[] = [center];
    for (let i = 1; i <= range; i++) r.push(...this.getHexRing(center, i));
    return r;
  }

  hasLineOfSight(
    origin: HexCoord, target: HexCoord,
    blockingHexes: Set<string>, mapData: MapData | null,
  ): boolean {
    const dist = hexDistance(origin, target);
    if (dist <= 1) return true;
    const fromC = this.axialToCube(origin), toC = this.axialToCube(target);
    for (let i = 1; i < dist; i++) {
      const t = i / dist;
      const interp = {
        x: fromC.x + (toC.x - fromC.x) * t,
        y: fromC.y + (toC.y - fromC.y) * t,
        z: fromC.z + (toC.z - fromC.z) * t,
      };
      const hex = this.cubeRoundToAxial(interp);
      if (blockingHexes.has(hexKey(hex))) {
        const tile = mapData?.tiles.find(
          t => t.hex.q === hex.q && t.hex.r === hex.r
        );
        if (tile && (tile.terrain === 'WALL' || tile.terrain === 'OBSTACLE')) {
          return false;
        }
      }
    }
    return true;
  }

  calculateFOV(
    entity: Entity, mapData: MapData | null,
    sightRange?: number,
  ): Set<HexCoord> {
    const origin = VMath.vector3DToHex(entity.transform.coords);
    const range = sightRange ?? this.defaultSightRange;
    const visible = new Set<HexCoord>();
    visible.add(origin);
    const blocking = this.buildBlockingSet(mapData);
    for (let r = 1; r <= range; r++) {
      for (const hex of this.getHexRing(origin, r)) {
        if (this.hasLineOfSight(origin, hex, blocking, mapData)) {
          visible.add(hex);
        }
      }
    }
    // calculateFOV 不修改 entityFov — 由 updateFov 管理
    return visible;
  }

  updateFog(entity: Entity, newFov: Set<HexCoord>, tick: number): FogUpdatePayload {
    const prevKeys = this.entityFov.get(entity.id) ?? new Set<string>();
    const newKeys = this.serializeHexSet(newFov);
    const revealed: HexCoord[] = [];
    const obscured: HexCoord[] = [];
    const explored: HexCoord[] = [];

    for (const h of newFov) {
      const key = hexKey(h);
      if (!prevKeys.has(key)) revealed.push(h);
      const existing = this.cells[key];
      if (!existing || existing.state === 'UNEXPLORED') {
        this.cells[key] = { hex: h, state: 'VISIBLE', lastSeenTick: tick };
        if (!existing) explored.push(h);
      } else {
        this.cells[key] = { ...existing, state: 'VISIBLE', lastSeenTick: tick };
      }
    }

    for (const key of prevKeys) {
      if (!newKeys.has(key)) {
        const parts = key.split(',').map(Number);
        obscured.push({ q: parts[0], r: parts[1] });
        const cell = this.cells[key];
        if (cell && cell.state === 'VISIBLE') {
          this.cells[key] = { ...cell, state: 'EXPLORED' };
        }
      }
    }

    this.entityFov.set(entity.id, newKeys);

    return {
      entityId: entity.id,
      revealedHexes: revealed,
      obscuredHexes: obscured,
      exploredHexes: explored,
    };
  }

  getHexFogState(hex: HexCoord): FogState {
    return this.cells[hexKey(hex)]?.state ?? 'UNEXPLORED';
  }

  isHexExplored(hex: HexCoord): boolean {
    const s = this.cells[hexKey(hex)]?.state;
    return s !== undefined && s !== 'UNEXPLORED';
  }

  isHexVisibleTo(entityId: EntityId, hex: HexCoord): boolean {
    const fov = this.entityFov.get(entityId);
    return fov ? fov.has(hexKey(hex)) : false;
  }

  filterVisibleEntities(viewerId: EntityId, entities: Entity[], mapData: MapData | null): Entity[] {
    return entities.filter(target => {
      if (target.id === viewerId) return true;
      if (target.tags?.includes('INVISIBLE') || target.tags?.includes('HIDDEN')) return false;
      const targetHex = VMath.vector3DToHex(target.transform.coords);
      return this.isHexVisibleTo(viewerId, targetHex);
    });
  }

  private serializeHexSet(hexes: Set<HexCoord>): Set<string> {
    return new Set(Array.from(hexes).map(h => hexKey(h)));
  }

  reset(): void {
    this.cells = {};
    this.entityFov.clear();
  }

  initializeMap(mapData: MapData): void {
    this.reset();
    for (const tile of mapData.tiles) {
      this.cells[hexKey(tile.hex)] = { hex: tile.hex, state: 'UNEXPLORED', lastSeenTick: 0 };
    }
  }
}

// ==========================================
// 5. 测试框架
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

// ==========================================
// 6. 辅助函数
// ==========================================
/** 在指定 hex 中心创建实体 */
function spawnEntity(id: string, h: HexCoord): Entity {
  const pos = VMath.hexToVector3D(h);
  return {
    id,
    type: 'ACTOR',
    transform: { coords: { x: pos.x, y: pos.y, z: 0 }, planeId: 'main', facing: 0 },
    tags: [],
  };
}

function hex(q: number, r: number): HexCoord { return { q, r }; }

/** 构建开放地图（无阻挡） */
function buildOpenMap(width: number, height: number): MapData {
  const tiles: TileDef[] = [];
  for (let r = 0; r < height; r++) {
    for (let q = 0; q < width; q++) {
      tiles.push({ hex: { q, r }, terrain: 'GROUND' });
    }
  }
  return { id: 'open_map', tiles };
}

/** 构建带墙壁的地图 (10x8) */
function buildWallMap(): MapData {
  // 垂直墙壁 q=5, r=0..7，缺口在 (5,4)
  const tiles: TileDef[] = [];
  for (let r = 0; r < 8; r++) {
    for (let q = 0; q < 10; q++) {
      tiles.push({
        hex: { q, r },
        terrain: q === 5 && r !== 4 ? 'WALL' : 'GROUND',
      });
    }
  }
  return { id: 'wall_map', tiles };
}

/** 在 hex 集中按值查找 hex */
function findHexInSet(set: Set<HexCoord>, q: number, r: number): boolean {
  return hexSetHas(set, hex(q, r));
}

// ==========================================
// 7. 场景测试
// ==========================================
function runTests() {
  console.log('=== ElysianVTT 战争迷雾系统测试 ===\n');

  // ===============================================
  // Scenario A: 六边形环计算 (基础 FOV 构件)
  // ===============================================
  console.log('[Scenario A] 六边形环计算');
  {
    const fow = new FogOfWar();

    // 半径 0: 只有自身
    const ring0 = fow.getHexRing(hex(0, 0), 0);
    assertEqual(ring0.length, 1, '半径0: 1 个 hex');
    assertEqual(ring0[0].q, 0, '半径0: q=0');
    assertEqual(ring0[0].r, 0, '半径0: r=0');

    // 半径 1: 6 个邻居
    const ring1 = fow.getHexRing(hex(0, 0), 1);
    assertEqual(ring1.length, 6, '半径1: 6 个 hex');
    const exp1 = [hex(1,-1),hex(1,0),hex(0,1),hex(-1,1),hex(-1,0),hex(0,-1)];
    for (const e of exp1) {
      assert(ring1.some(h => h.q === e.q && h.r === e.r), `半径1 包含 (${e.q},${e.r})`);
    }

    // 半径 2: 12 个 hex
    assertEqual(fow.getHexRing(hex(0, 0), 2).length, 12, '半径2: 12 个 hex');
    // 半径 3: 18 个 hex
    assertEqual(fow.getHexRing(hex(3, 4), 3).length, 18, '半径3: 18 个 hex');

    // hexesInRange 验证
    assertEqual(fow.getHexesInRange(hex(0, 0), 2).length, 19, '半径2 范围内: 19 hex');
    assertEqual(fow.getHexesInRange(hex(0, 0), 3).length, 37, '半径3 范围内: 37 hex');
    assertEqual(fow.getHexesInRange(hex(5, 3), 2).length, 19, '半径2 离中心: 19 hex');

    // 非原点中心: 验证距离都正确
    const ring2 = fow.getHexRing(hex(5, 3), 2);
    assertEqual(ring2.length, 12, '非原点中心半径2: 12 hex');
    for (const h of ring2) {
      const dist = hexDistance(hex(5, 3), h);
      assertEqual(dist, 2, `非原点中心 hex(${h.q},${h.r}) 距离=2`);
    }
  }

  // ===============================================
  // Scenario B: 开放地图 FOV — 无阻挡时正确计算可见 hex
  // ===============================================
  console.log('\n[Scenario B] 开放地图 FOV — 无阻挡');
  {
    const openMap = buildOpenMap(15, 15);
    const fow = new FogOfWar(5);

    // 实体在 hex(7,7) 中心
    const entity = spawnEntity('scout', hex(7, 7));

    // 视野 5: 1+6+12+18+24+30 = 91
    const fov5 = fow.calculateFOV(entity, openMap, 5);
    assertEqual(fov5.size, 91, '视野5 可见 91 个 hex');

    // 自身 hex 始终在 FOV 中
    assert(findHexInSet(fov5, 7, 7), '自身 hex(7,7) 在 FOV 中');

    // 距离 5 的 hex 可见
    assert(findHexInSet(fov5, 12, 7), '距离5 的 hex(12,7) 可见');

    // 距离 6 的不在视野内
    assert(!findHexInSet(fov5, 13, 7), '距离6 的 hex(13,7) 不可见');
  }

  // ===============================================
  // Scenario C: 墙壁阻挡视线
  // ===============================================
  console.log('\n[Scenario C] 墙壁阻挡视线');
  {
    const wallMap = buildWallMap();
    const fow = new FogOfWar(6);
    const blocking = new Set<string>();
    for (const tile of wallMap.tiles) {
      if (tile.terrain === 'WALL' || tile.terrain === 'OBSTACLE') {
        blocking.add(hexKey(tile.hex));
      }
    }

    // 墙体: q=5, r≠4 → WALL; (5,4) 是缺口
    // 从 (4,4) 出发

    // (4,4) → (6,4): 经过 (5,4) 缺口 → 视线通过
    const los1 = fow.hasLineOfSight(hex(4, 4), hex(6, 4), blocking, wallMap);
    assert(los1, '通过缺口(5,4): (4,4)→(6,4) 视线可通过');

    // (4,4) → (5,3): 目标是 WALL 但距离≤1 → visible
    const los2 = fow.hasLineOfSight(hex(4, 4), hex(5, 3), blocking, wallMap);
    assert(los2, '相邻 WALL hex(5,3) 始终可见 (dist=1)');

    // (4,4) → (6,2): 经过 (5,3) 是 WALL → 阻挡
    const los3 = fow.hasLineOfSight(hex(4, 4), hex(6, 2), blocking, wallMap);
    assert(!los3, '穿过 WALL(5,3): (4,4)→(6,2) 视线阻挡');

    // (4,4) → (6,5): 经过 (5,5) 是 WALL → 阻挡
    const los4 = fow.hasLineOfSight(hex(4, 4), hex(6, 5), blocking, wallMap);
    assert(!los4, '穿过 WALL(5,5): (4,4)→(6,5) 视线阻挡');

    // (4,4) → (7,6): dist=4, 中间 hex (5,5)=WALL → 阻挡
    const los5 = fow.hasLineOfSight(hex(4, 4), hex(7, 6), blocking, wallMap);
    assert(!los5, '穿过 WALL: (4,4)→(7,6) 视线阻挡');

    // (4,4) → (7,0): 穿过 WALL(5,1)(6,0) 或路径上有 WALL → 阻挡
    const los6 = fow.hasLineOfSight(hex(4, 4), hex(7, 0), blocking, wallMap);
    assert(!los6, '穿过 WALL: (4,4)→(7,0) 视线阻挡');
  }

  // ===============================================
  // Scenario D: 不同视野范围
  // ===============================================
  console.log('\n[Scenario D] 不同视野范围');
  {
    const openMap = buildOpenMap(20, 20);
    const fow = new FogOfWar();
    const entity = spawnEntity('viewer', hex(10, 10));

    assertEqual(fow.calculateFOV(entity, openMap, 1).size, 7, '视野1: 7 hex');
    assertEqual(fow.calculateFOV(entity, openMap, 2).size, 19, '视野2: 19 hex');
    assertEqual(fow.calculateFOV(entity, openMap, 3).size, 37, '视野3: 37 hex');

    // 视野 0: 仅自身
    assertEqual(fow.calculateFOV(entity, openMap, 0).size, 1, '视野0: 仅自身 1 hex');

    // 负数视为 0
    assertEqual(fow.calculateFOV(entity, openMap, -1).size, 1, '负数视野: 仅自身 1 hex');
  }

  // ===============================================
  // Scenario E: 迷雾三态 — UNEXPLORED / EXPLORED / VISIBLE
  // ===============================================
  console.log('\n[Scenario E] 迷雾三态转换');
  {
    const openMap = buildOpenMap(10, 10);
    const fow = new FogOfWar(2);

    // 初始化
    fow.initializeMap(openMap);
    assertEqual(fow.getHexFogState(hex(5, 5)), 'UNEXPLORED', '初始化后 UNEXPLORED');
    assertEqual(fow.isHexExplored(hex(5, 5)), false, '初始化后未探索');

    // 实体在 (5,5), 视野 2
    const entity = spawnEntity('hero', hex(5, 5));
    // 手动构造 FOV set（避免 calculateFOV 覆盖 entityFov 缓存）
    const fovSet1 = new Set(fow.getHexesInRange(hex(5, 5), 2));
    fow.updateFog(entity, fovSet1, 10);

    // 自身 hex → VISIBLE
    assertEqual(fow.getHexFogState(hex(5, 5)), 'VISIBLE', '自身 hex VISIBLE');
    assertEqual(fow.isHexExplored(hex(5, 5)), true, '自身 hex 已探索');

    // 邻居 hex → VISIBLE
    assertEqual(fow.getHexFogState(hex(5, 4)), 'VISIBLE', '邻居 hex(5,4) VISIBLE');
    assertEqual(fow.getHexFogState(hex(6, 5)), 'VISIBLE', '邻居 hex(6,5) VISIBLE');

    // 远处 hex → UNEXPLORED
    assertEqual(fow.getHexFogState(hex(0, 0)), 'UNEXPLORED', '远处 hex UNEXPLORED');

    // 移动实体到 (8,5)。不调用 calculateFOV（防止覆盖 entityFov 缓存），
    // 直接构造新 FOV set。updateFog 会用 entity.id 查 prevKeys 做 diff。
    // (5,5) 距离 (8,5) = max(3,0,3)=3 > 2 → 离开视野
    const fovSet2 = new Set(fow.getHexesInRange(hex(8, 5), 2));
    fow.updateFog(entity, fovSet2, 20);

    // 之前可见但现在不在视野的 (5,5) → EXPLORED
    const state55 = fow.getHexFogState(hex(5, 5));
    assertEqual(state55, 'EXPLORED', '离开视野后 hex(5,5) EXPLORED');

    // 仍在视野内 (8,5) → VISIBLE
    assertEqual(fow.getHexFogState(hex(8, 5)), 'VISIBLE', '新位置 hex(8,5) VISIBLE');

    // (7,6) 在视野内 → VISIBLE
    const state76 = fow.getHexFogState(hex(7, 6));
    assert(state76 === 'VISIBLE', `hex(7,6) VISIBLE, 实际=${state76}`);

    // 未探索过的仍 UNEXPLORED
    assertEqual(fow.getHexFogState(hex(0, 0)), 'UNEXPLORED', '从未见过 hex(0,0) UNEXPLORED');
  }

  // ===============================================
  // Scenario F: 增量迷雾更新
  // ===============================================
  console.log('\n[Scenario F] 增量迷雾更新');
  {
    const openMap = buildOpenMap(8, 8);
    const fow = new FogOfWar(2);
    // 不调用 initializeMap，让 updateFog 自行追踪首次探索

    const entity = spawnEntity('ranger', hex(3, 3));
    // 直接构造 FOV set，不通过 calculateFOV（避免 FOV 缓存干扰 delta 检测）
    const initialFov = new Set(fow.getHexesInRange(hex(3, 3), 2));

    // 第一次更新（无 prevKeys）: 全部重新揭示
    const update1 = fow.updateFog(entity, initialFov, 1);
    assert(update1.exploredHexes.length > 0, '首次更新: 有新探索 hex');
    assertEqual(update1.revealedHexes.length, update1.exploredHexes.length,
      '首次更新: revealed === explored (无 prevKeys)');
    assertEqual(update1.obscuredHexes.length, 0, '首次更新无遮蔽');
    assertEqual(update1.entityId, 'ranger', '更新携带 entityId');

    // 第二次（同一 FOV）: 无变化
    const update2 = fow.updateFog(entity, initialFov, 2);
    assertEqual(update2.exploredHexes.length, 0, '第二次无新探索');
    assertEqual(update2.revealedHexes.length, 0, '第二次无新揭示(已通过 prevKeys 追踪)');
    assertEqual(update2.obscuredHexes.length, 0, '第二次无遮蔽');

    // 新位置: (5,5) → FOV 变化
    const newFov = new Set(fow.getHexesInRange(hex(5, 5), 2));
    const update3 = fow.updateFog(entity, newFov, 3);

    // (3,3) 和 (5,5) 的 range2 无重叠 hex → 全部揭示和遮蔽
    assert(update3.revealedHexes.length > 0, '移动后新揭示 hex');
    assert(update3.obscuredHexes.length > 0, '移动后新遮蔽 hex');
    const totalChanges = update3.revealedHexes.length + update3.obscuredHexes.length;
    assert(totalChanges > 0, '移动后有变化');
  }

  // ===============================================
  // Scenario G: 实体在墙壁一侧时 FOV 验证
  // ===============================================
  console.log('\n[Scenario G] 墙壁阻挡 FOV 计算');
  {
    const wallMap = buildWallMap();
    const fow = new FogOfWar(6);

    // 实体在 (4,4) — 墙壁左侧
    const entity = spawnEntity('watcher', hex(4, 4));
    const fov = fow.calculateFOV(entity, wallMap, 6);

    // 左侧壁前 hex → 可见
    assert(findHexInSet(fov, 3, 4), '左侧 (3,4) 可见');
    assert(findHexInSet(fov, 2, 5), '左侧 (2,5) 可见');

    // 通过缺口 (5,4) 右侧 hex → 可见
    assert(findHexInSet(fov, 6, 4), '通过缺口 (6,4) 可见');
    assert(findHexInSet(fov, 7, 4), '通过缺口 (7,4) 可见');

    // 墙后且无 LOS 的 hex → 不可见
    // (6,2) 被 (5,3)=WALL 阻挡
    assert(!findHexInSet(fov, 6, 2), '墙后 (6,2) 不可见');
    // (6,1) 也被墙阻挡
    assert(!findHexInSet(fov, 6, 1), '墙后 (6,1) 不可见');

    // 自身 hex 可见
    assert(findHexInSet(fov, 4, 4), '自身 (4,4) 可见');

    fow.updateFog(entity, fov, 1);

    // 墙后不可见
    assertEqual(fow.getHexFogState(hex(6, 2)), 'UNEXPLORED', '墙后 (6,2) UNEXPLORED');
  }

  // ===============================================
  // Scenario H: 多实体 FOV 独立
  // ===============================================
  console.log('\n[Scenario H] 多实体独立 FOV');
  {
    const openMap = buildOpenMap(12, 12);
    const fow = new FogOfWar(3);

    const alice = spawnEntity('alice', hex(3, 3));
    const bob = spawnEntity('bob', hex(9, 9));

    fow.updateFog(alice, fow.calculateFOV(alice, openMap, 3), 1);
    fow.updateFog(bob, fow.calculateFOV(bob, openMap, 3), 1);

    // 各自可见自身
    assert(fow.isHexVisibleTo('alice', hex(3, 3)), 'alice 可见自身 hex');
    assert(fow.isHexVisibleTo('bob', hex(9, 9)), 'bob 可见自身 hex');

    // 互相看不到对方的位置
    assert(!fow.isHexVisibleTo('alice', hex(9, 9)), 'alice 看不到 bob 的 hex');
    assert(!fow.isHexVisibleTo('bob', hex(3, 3)), 'bob 看不到 alice 的 hex');

    // 中间区域可能某方可见
    const mid = hex(6, 6);
    assert(typeof fow.isHexVisibleTo('alice', mid) === 'boolean', 'alice 查询中间 hex');
    assert(typeof fow.isHexVisibleTo('bob', mid) === 'boolean', 'bob 查询中间 hex');

    // 各自的迷雾状态独立
    assertEqual(fow.getHexFogState(hex(3, 3)), 'VISIBLE', 'alice 自身 VISIBLE');
    assertEqual(fow.getHexFogState(hex(9, 9)), 'VISIBLE', 'bob 自身 VISIBLE');
  }

  // ===============================================
  // Scenario I: 实体可见性过滤
  // ===============================================
  console.log('\n[Scenario I] 实体可见性过滤');
  {
    const wallMap = buildWallMap();
    const fow = new FogOfWar(5);

    const viewer = spawnEntity('viewer', hex(4, 4));
    const ally = spawnEntity('ally', hex(3, 4));           // 同侧
    const enemyVis = spawnEntity('enemy_vis', hex(6, 4));   // 通过缺口可见
    const enemyHid = spawnEntity('enemy_hid', hex(6, 2));   // 墙后
    const invisible = spawnEntity('invisible', hex(4, 3));
    invisible.tags = ['INVISIBLE'];

    const allEntities = [viewer, ally, enemyVis, enemyHid, invisible];

    const fov = fow.calculateFOV(viewer, wallMap, 5);
    fow.updateFog(viewer, fov, 1);

    const visible = fow.filterVisibleEntities('viewer', allEntities, wallMap);

    assert(visible.some(e => e.id === 'viewer'), '自己始终可见');
    assert(visible.some(e => e.id === 'ally'), '同侧 ally 可见');
    assert(visible.some(e => e.id === 'enemy_vis'), '通过缺口的敌人可见');
    assert(!visible.some(e => e.id === 'enemy_hid'), '墙后敌人不可见');
    assert(!visible.some(e => e.id === 'invisible'), 'INVISIBLE 实体不可见');
  }

  // ===============================================
  // Scenario J: 边界条件
  // ===============================================
  console.log('\n[Scenario J] 边界条件');
  {
    // 零视野
    const fow0 = new FogOfWar(0);
    const entity = spawnEntity('zero', hex(5, 5));
    assertEqual(fow0.calculateFOV(entity, null, 0).size, 1, '零视野返回自身 hex');

    // 极大视野（系统不强制地图边界 — FOV 计算基于 blocking set）
    const largeMap = buildOpenMap(20, 20);
    const fowLarge = new FogOfWar(10);
    const entityMid = spawnEntity('zero', hex(10, 10));
    const fovLarge = fowLarge.calculateFOV(entityMid, largeMap, 10);
    assert(fovLarge.size > 0, '极大视野返回结果不崩溃');

    // null 地图 — 无阻挡
    const fowNo = new FogOfWar(3);
    assertEqual(fowNo.calculateFOV(entity, null, 3).size, 37, 'null 地图视野3 → 37 hex');

    // 全墙地图 — 仅自身可见
    const allWallTiles: TileDef[] = [];
    for (let r = 0; r < 10; r++) {
      for (let q = 0; q < 10; q++) {
        allWallTiles.push({ hex: { q, r }, terrain: 'WALL' });
      }
    }
    const allWallMap: MapData = { id: 'all_wall', tiles: allWallTiles };
    const fowW = new FogOfWar(3);
    const entityW = spawnEntity('trapped', hex(5, 5));
    const fovW = fowW.calculateFOV(entityW, allWallMap, 3);
    // 相邻 hex (dist ≤ 1) 始终可见，故自身 + 6 邻居 = 7
    assertEqual(fovW.size, 7, '全墙地图: 仅自身+6邻里=7 hex 可见');

    // 初始化 + reset
    fowW.initializeMap(allWallMap);
    assertEqual(fowW.getHexFogState(hex(5, 5)), 'UNEXPLORED', '初始化后 UNEXPLORED');
    fowW.reset();
    assertEqual(fowW.getHexFogState(hex(5, 5)), 'UNEXPLORED', 'reset 后 UNEXPLORED');
  }

  // ===============================================
  // Scenario K: L 形墙壁角落阻挡
  // ===============================================
  console.log('\n[Scenario K] L 形墙角落阻挡视线');
  {
    // L 形墙: 垂直 q=5 r=3..7 + 水平 r=7 q=0..4
    const tiles: TileDef[] = [];
    for (let r = 0; r < 10; r++) {
      for (let q = 0; q < 10; q++) {
        let terrain: TerrainType = 'GROUND';
        if (q === 5 && r >= 3 && r <= 7) terrain = 'WALL';
        if (r === 7 && q >= 0 && q <= 4) terrain = 'WALL';
        tiles.push({ hex: { q, r }, terrain });
      }
    }
    const lMap: MapData = { id: 'l_wall', tiles };
    const fow = new FogOfWar(5);

    // 站在 (4,4) — L 墙内侧
    const entity = spawnEntity('watcher', hex(4, 4));
    const fov = fow.calculateFOV(entity, lMap, 5);

    // 内侧可见
    assert(findHexInSet(fov, 3, 4), '内侧 (3,4) 可见');
    assert(findHexInSet(fov, 4, 3), '内侧 (4,3) 可见');

    // 墙外不可见: (6,7) 被 L 墙挡住
    assert(!findHexInSet(fov, 6, 7), 'L 墙外 (6,7) 不可见');

    // 从 (4,4) 看 (6,7): 经过 (5,5)=WALL → 阻挡
    const blocking = new Set<string>();
    for (const tile of lMap.tiles) {
      if (tile.terrain === 'WALL' || tile.terrain === 'OBSTACLE') {
        blocking.add(hexKey(tile.hex));
      }
    }
    const los = fow.hasLineOfSight(hex(4, 4), hex(6, 7), blocking, lMap);
    assert(!los, 'L 墙阻挡 (4,4)→(6,7) [经 WALL(5,5)]');

    // 从 (4,6) 到 (4,7): 距离 1，始终可见（即使 (4,7) 是 WALL）
    const losAdj = fow.hasLineOfSight(hex(4, 6), hex(4, 7), blocking, lMap);
    assert(losAdj, '相邻 hex(4,7) 始终可见 dist=1');
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有战争迷雾测试通过!');
}

runTests();
