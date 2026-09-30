// packages/backend/src/campaigns/engines/ExploreEngine.ts
import { EventEmitter } from 'events';
import {
  IEngineInstance, Tick, ClientIntent, Entity, EntityId, Vector3D, HexCoord,
  ExploreEntity, MovementResult, ExploreIntent, SkillCheckResult,
  StateMutationPayload,
  MapData, ZoneTriggerDef, FogUpdatePayload, FogCellState,
  LogVisibility, HookTrigger,
} from '@hard-vtt/shared';
import { SpatialSystem } from '../../core/systems/SpatialSystem.js';
import { VectorMath } from '../../utils/VectorMath.js';
import { generateId } from '../../utils/IdGenerator.js';
import { Logger } from '../../utils/Logger.js';
import { HookRegistry } from './HookRegistry.js';
import { FogOfWar } from '../../core/systems/FogOfWar.js';

/**
 * ExploreEngine — 探索模式引擎
 *
 * 设计理念：探索模式不使用 Tick 时间轴，所有移动/交互立即结算。
 * 类似 D&D 探索回合 — 玩家在网格上自由移动，遇到触发点（敌人、陷阱、对话）才切换到战斗。
 *
 * 核心职责：
 * 1. 实体挂载/卸载
 * 2. 接收并立即处理 MOVE / INTERACT / EXAMINE / USE_SKILL 意图
 * 3. 移动后触发 ENTITY_MOVES_TO / ENTITY_ENTERS_AREA 钩子检查
 * 4. 引擎事件广播：STATE_MUTATED, ENTITY_MOVED, ZONE_ENTERED
 */
export class ExploreEngine extends EventEmitter implements IEngineInstance {
  public engineId: string;
  public engineType: 'COMBAT' | 'EXPLORE' = 'EXPLORE';
  public get currentTick(): Tick { return this._currentTick; }

  private _currentTick: Tick = 0;
  private entities = new Map<EntityId, ExploreEntity>();
  private mapData: MapData | null = null;
  private zoneTriggers: ZoneTriggerDef[] = [];
  private hookRegistry: HookRegistry;
  private logger: Logger;
  /** 战争迷雾系统 */
  private fogOfWar: FogOfWar;
  /** 待发送的状态变更累积 */
  private pendingMutations: StateMutationPayload = { tick: 0, mutations: [] };
  /** 最新的迷雾更新（供每步移动后广播） */
  private latestFogUpdate: FogUpdatePayload | null = null;

  constructor(engineId: string) {
    super();
    this.engineId = engineId;
    this.logger = Logger.create('Engine:Explore');
    this.hookRegistry = new HookRegistry();
    this.fogOfWar = new FogOfWar(6);
    this.logger.info(`ExploreEngine created`, null, { sceneId: this.engineId });
  }

  // ============================================================
  //  地图 & 区域管理
  // ============================================================

  /** 加载地图数据 */
  loadMap(mapData: MapData): void {
    this.mapData = mapData;
    this.fogOfWar.initializeMap(mapData, this._currentTick);
    this.logger.info(
      `Map '${mapData.name}' loaded: ${mapData.tiles.length} tiles (FOW initialized)`,
      { mapId: mapData.id, tileCount: mapData.tiles.length },
      { sceneId: this.engineId }
    );
  }

  /** 获取当前地图数据 */
  getMapData(): MapData | null {
    return this.mapData;
  }

  /** 设置区域触发器 */
  setZoneTriggers(triggers: ZoneTriggerDef[]): void {
    this.zoneTriggers = triggers;
  }

  /** 获取区域触发器 */
  getZoneTriggers(): ZoneTriggerDef[] {
    return this.zoneTriggers;
  }

  // ============================================================
  //  IEngineInstance 接口
  // ============================================================

  mountEntities(entities: Entity[]): void {
    // 探索模式：将实体放置到地图有效 hex 上（偏移坐标，与战斗模式一致）
    const validHexes = this.getValidSpawnHexes(entities.length);
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const exploreEntity = this.toExploreEntity(entity);
      // 轴向 hex → 偏移坐标 (col, row)，与战斗模式坐标系统一致
      if (validHexes[i]) {
        const offset = VectorMath.axialToOffset(validHexes[i]);
        exploreEntity.transform = {
          ...exploreEntity.transform,
          coords: { x: offset.col, y: offset.row, z: 0 },
        };
      }
      this.entities.set(entity.id, exploreEntity);
    }
    this.logger.info(
      `Mounted ${entities.length} entities (repositioned to valid hexes)`,
      { entityIds: entities.map(e => e.id), hexes: validHexes.slice(0, entities.length) },
      { sceneId: this.engineId }
    );

    // 计算初始视野
    if (this.mapData) {
      this.refreshAllFog();
    }
  }

  unmountEntities(entityIds: EntityId[]): Entity[] {
    const removed: Entity[] = [];
    for (const id of entityIds) {
      const ent = this.entities.get(id);
      if (ent) {
        removed.push(ent);
        this.entities.delete(id);
        for (const hook of [...this.hookRegistry.getHooksForEntity(id)]) this.hookRegistry.unregister(hook.id);
        const update = this.fogOfWar.removeEntity(id);
        if (update.obscuredHexes.length > 0) {
          this.latestFogUpdate = update;
          this.emit('FOG_UPDATED', update);
        }
      }
    }
    return removed;
  }

  receiveIntent(intent: ClientIntent): void {
    const actor = this.entities.get(intent.actorId);
    if (!actor) {
      this.logger.warn(`Intent from unknown entity ${intent.actorId}`, null, { sceneId: this.engineId });
      return;
    }

    switch (intent.intentType) {
      case 'MOVE':
        this.handleExploreMove(actor, intent);
        break;
      case 'INTERACT':
        this.handleExploreInteract(actor, intent);
        break;
      case 'ROTATE':
        this.handleExploreRotate(actor, intent);
        break;
      default:
        this.logger.warn(
          `Unsupported intent type in ExploreEngine: ${intent.intentType}`,
          { actorId: actor.id },
          { sceneId: this.engineId }
        );
    }
  }

  // ============================================================
  //  探索移动 — 即时结算
  // ============================================================

  /**
   * 处理探索模式移动意图
   *
   * 探索移动特点：
   * - 无 Tick 时间轴，立即更新坐标
   * - 路径由前端计算（或使用 hexNeighbors 逐步推进）
   * - 移动消耗基于 hexDistance
   * - 每步触发 ENTITY_MOVES_TO 和 ENTITY_ENTERS_AREA 钩子
   */
  private handleExploreMove(actor: ExploreEntity, intent: ClientIntent): void {
    const targetCoords = intent.payload.targetCoords;
    if (!targetCoords) {
      this.logger.warn(`Move intent without targetCoords from ${actor.id}`, null, { sceneId: this.engineId });
      return;
    }

    // 偏移坐标 → 轴向坐标（与战斗模式一致：coords.x=col, coords.y=row）
    const fromHex = VectorMath.offsetToAxial(actor.transform.coords.x, actor.transform.coords.y);
    const toHex = VectorMath.offsetToAxial(targetCoords.x, targetCoords.y);

    // 计算路径：利用前端传入的路径或自行推算
    const payload = intent.payload as Record<string, any>;
    const path: HexCoord[] = payload.path ?? this.computeHexPath(fromHex, toHex);

    if (path.length === 0) {
      const result: MovementResult = {
        success: false,
        entityId: actor.id,
        fromHex,
        toHex,
        path: [],
        cost: 0,
        remainingMovement: actor.movementPoints,
        triggeredHooks: [],
        zoneEntries: [],
        reason: 'Already at target hex',
      };
      this.emit('ENTITY_MOVED', result);
      return;
    }

    // 计算移动消耗
    const moveCost = this.calculatePathCost(path);
    if (moveCost > actor.movementPoints) {
      const result: MovementResult = {
        success: false,
        entityId: actor.id,
        fromHex,
        toHex,
        path: [],
        cost: moveCost,
        remainingMovement: actor.movementPoints,
        triggeredHooks: [],
        zoneEntries: [],
        reason: `Insufficient movement points: need ${moveCost}, have ${actor.movementPoints}`,
      };
      this.emit('ENTITY_MOVED', result);
      this.logger.game(
        `🚶 [Explore] ${actor.id} 移动不足: 需要 ${moveCost} MP, 剩余 ${actor.movementPoints}`,
        { actorId: actor.id, path },
        LogVisibility.PLAYER,
        { sceneId: this.engineId }
      );
      return;
    }

    // 逐 hex 执行移动（path 中为轴向 hex，转换为偏移坐标存储）
    const triggeredHooks: string[] = [];
    const zoneEntries: string[] = [];
    const previousCoords = { ...actor.transform.coords };

    for (const hex of path) {
      const offset = VectorMath.axialToOffset(hex);
      const worldFrom = VectorMath.hexToVector3D(VectorMath.offsetToAxial(previousCoords.x, previousCoords.y));
      const worldTo = VectorMath.hexToVector3D(hex);

      // 计算朝向：从上一个位置指向新位置
      const newFacing = VectorMath.directionAngleFromOffset(
        previousCoords.x, previousCoords.y,
        offset.col, offset.row,
      );

      // 更新实体坐标（偏移坐标，与战斗模式一致）
      actor.transform = {
        ...actor.transform,
        coords: { x: offset.col, y: offset.row, z: actor.transform.coords.z ?? 0 },
        facing: newFacing,
      };

      // 暂存用于下一步朝向计算
      previousCoords.x = offset.col;
      previousCoords.y = offset.row;

      // 检查 ENTITY_MOVES_TO 钩子
      const firedHooks = this.hookRegistry.evaluate(this._currentTick, this.entities);
      for (const h of firedHooks) {
        triggeredHooks.push(h.id);
      }

      // 检查 ENTITY_ENTERS_AREA 钩子（传入世界坐标用于 SpatialSystem 距离计算）
      const enteredZones = this.checkZoneEntries(actor, worldFrom, worldTo);
      for (const zId of enteredZones) {
        zoneEntries.push(zId);
      }
    }

    // 更新移动点
    actor.movementPoints -= moveCost;

    // 记录状态变更（偏移坐标 + 朝向）
    const finalOffset = VectorMath.axialToOffset(path[path.length - 1]);
    this.recordMutation(actor.id, {
      'transform.coords.x': finalOffset.col,
      'transform.coords.y': finalOffset.row,
      'transform.coords.z': actor.transform.coords.z ?? 0,
      'transform.facing': actor.transform.facing,
      'movementPoints': actor.movementPoints,
    });

    // 广播移动结果（fromHex/toHex 保持轴向，供前端调试）
    const result: MovementResult = {
      success: true,
      entityId: actor.id,
      fromHex,
      toHex: path[path.length - 1],
      path,
      cost: moveCost,
      remainingMovement: actor.movementPoints,
      triggeredHooks,
      zoneEntries,
    };

    this.emit('ENTITY_MOVED', result);

    this.logger.game(
      `🚶 [Explore] ${actor.id} 移动到 ${toHex.q},${toHex.r} (消耗 ${moveCost} MP, 剩余 ${actor.movementPoints})`,
      { actorId: actor.id, fromHex, toHex, path, cost: moveCost },
      LogVisibility.PLAYER,
      { sceneId: this.engineId }
    );

    // 广播状态变更
    this.flushMutations();

    // 刷新战争迷雾
    this.refreshFogAfterMove(actor.id);

    this._currentTick++;
  }

  // ============================================================
  //  探索交互（INTERACT / EXAMINE）
  // ============================================================

  private handleExploreInteract(actor: ExploreEntity, intent: ClientIntent): void {
    const payload = intent.payload as Record<string, any>;
    const targetId = (payload.targetEntityId as string)
      ?? intent.payload.targetIds?.[0];

    const target = targetId ? this.entities.get(targetId) : undefined;
    if (!target) {
      this.logger.warn(
        `Interact from ${actor.id}: target not found`,
        null,
        { sceneId: this.engineId }
      );
      return;
    }

    // 检查距离（偏移坐标 → 轴向 → hexDistance）
    const actorHex = VectorMath.offsetToAxial(actor.transform.coords.x, actor.transform.coords.y);
    const targetHex = VectorMath.offsetToAxial(target.transform.coords.x, target.transform.coords.y);
    const dist = SpatialSystem.hexDistance(actorHex, targetHex);
    const interactRange = 1; // 1 hex 相邻
    if (dist > interactRange) {
      this.logger.game(
        `🔍 [Explore] ${actor.id} 距离 ${target.id} 太远 (${dist.toFixed(1)} > ${interactRange})`,
        { actorId: actor.id, targetId: target.id, distance: dist },
        LogVisibility.PLAYER,
        { sceneId: this.engineId }
      );
      this.emit('INTERACT_FAILED', {
        actorId: actor.id,
        targetId: target.id,
        reason: 'OUT_OF_RANGE',
        distance: dist,
      });
      return;
    }

    this.logger.game(
      `🔍 [Explore] ${actor.id} 与 ${target.id} (${target.templateId}) 交互`,
      { actorId: actor.id, targetId: target.id },
      LogVisibility.PLAYER,
      { sceneId: this.engineId }
    );

    this.emit('INTERACT_TRIGGERED', {
      actorId: actor.id,
      targetId: target.id,
      targetTemplateId: target.templateId,
    });

    this.emit('VISUAL_FX', {
      tick: this._currentTick,
      events: [{
        eventId: generateId(),
        eventType: 'UI_FLOATING_TEXT',
        sourceId: actor.id,
        targetId: target.id,
        fxTemplateId: 'interact',
        durationMs: 800,
        text: 'INTERACT',
      }],
    });
  }

  /**
   * 处理旋转意图（ROTATE）：改变实体朝向
   * 每 60° 消耗 1 移动点（类似移动的耗时动作）
   */
  private handleExploreRotate(actor: ExploreEntity, intent: ClientIntent): void {
    const payload = intent.payload as Record<string, any>;
    const delta = (payload.rotationDelta as number) ?? 60;

    // 计算消耗：每 60° = 1 MP
    const cost = Math.ceil(Math.abs(delta) / 60);
    if (cost > actor.movementPoints) {
      this.logger.game(
        `🔄 [Explore] ${actor.id} 旋转不足: 需要 ${cost} MP, 剩余 ${actor.movementPoints}`,
        { actorId: actor.id, delta, cost },
        LogVisibility.PLAYER,
        { sceneId: this.engineId }
      );
      return;
    }

    const currentFacing = actor.transform.facing ?? 0;
    const newFacing = ((currentFacing + delta) % 360 + 360) % 360;

    actor.transform = {
      ...actor.transform,
      facing: newFacing,
    };
    actor.movementPoints -= cost;

    this.recordMutation(actor.id, {
      'transform.facing': newFacing,
      'movementPoints': actor.movementPoints,
    });

    this.flushMutations();

    this.logger.game(
      `🔄 [Explore] ${actor.id} 旋转 ${delta > 0 ? '+' : ''}${delta}° → ${newFacing.toFixed(0)}° (消耗 ${cost} MP, 剩余 ${actor.movementPoints})`,
      { actorId: actor.id, delta, newFacing, cost },
      LogVisibility.PLAYER,
      { sceneId: this.engineId }
    );

    // 旋转后刷新迷雾
    this.refreshFogAfterMove(actor.id);

    this._currentTick++;
  }

  /**
   * 处理检查意图（EXAMINE）：对目标进行更详细的鉴定
   */
  handleExamineIntent(actor: ExploreEntity, targetId: EntityId): void {
    const target = this.entities.get(targetId);
    if (!target) {
      this.logger.warn(`Examine target ${targetId} not found`, null, { sceneId: this.engineId });
      return;
    }

    const actorHex = VectorMath.offsetToAxial(actor.transform.coords.x, actor.transform.coords.y);
    const targetHex = VectorMath.offsetToAxial(target.transform.coords.x, target.transform.coords.y);
    const dist = SpatialSystem.hexDistance(actorHex, targetHex);
    if (dist > 3) {
      this.emit('EXAMINE_FAILED', {
        actorId: actor.id,
        targetId,
        reason: 'OUT_OF_RANGE',
        distance: dist,
      });
      return;
    }

    this.logger.game(
      `🔎 [Explore] ${actor.id} 检查 ${target.id}`,
      { actorId: actor.id, targetId },
      LogVisibility.PLAYER,
      { sceneId: this.engineId }
    );

    // 构造检查结果：暴露目标的属性/效果信息
    const examineData = {
      entityId: target.id,
      templateId: target.templateId,
      type: target.type,
      resources: Object.entries(target.resources.current).map(([k, v]) => ({
        key: k,
        current: v,
        max: target.resources.max[k] ?? 0,
      })),
      activeEffects: target.activeEffects.map(e => ({
        templateId: e.templateId,
        remainingTicks: e.remainingTicks,
        stacks: e.stacks,
      })),
      transform: { ...target.transform },
    };

    this.emit('EXAMINE_RESULT', examineData);
  }

  /**
   * 处理技能检定意图（USE_SKILL）
   */
  handleSkillCheckIntent(actor: ExploreEntity, skillCheck: ExploreIntent['skillCheck']): SkillCheckResult {
    if (!skillCheck) {
      return {
        success: false,
        criticalSuccess: false,
        criticalFailure: true,
        roll: 0,
        threshold: 999,
        skillName: 'UNKNOWN',
        marginOfSuccess: -999,
      };
    }

    // d20 检定
    const d20 = Math.floor(Math.random() * 20) + 1;
    const attrBonus = skillCheck.attributeKey
      ? (actor.resources.current[skillCheck.attributeKey] ?? 0)
      : 0;
    const profBonus = skillCheck.proficiencyBonus ?? 0;
    const totalRoll = d20 + attrBonus + profBonus;
    const marginOfSuccess = totalRoll - skillCheck.difficulty;

    const result: SkillCheckResult = {
      success: totalRoll >= skillCheck.difficulty,
      criticalSuccess: d20 === 20,
      criticalFailure: d20 === 1,
      roll: totalRoll,
      threshold: skillCheck.difficulty,
      skillName: skillCheck.skillName,
      marginOfSuccess,
    };

    this.logger.game(
      `🎲 [Explore] ${actor.id} 检定 ${skillCheck.skillName}: d20=${d20} + ${attrBonus}(attr) + ${profBonus}(prof) = ${totalRoll} vs DC ${skillCheck.difficulty} → ${result.success ? '成功' : '失败'}${result.criticalSuccess ? ' (暴击!)' : ''}${result.criticalFailure ? ' (大失败!)' : ''}`,
      { actorId: actor.id, roll: d20, total: totalRoll, dc: skillCheck.difficulty },
      LogVisibility.PLAYER,
      { sceneId: this.engineId }
    );

    this.emit('SKILL_CHECK_RESULT', result);
    return result;
  }

  // ============================================================
  //  Hook & Zone 检查
  // ============================================================

  /**
   * 检查实体是否进入了封锁/触发区域
   */
  private checkZoneEntries(
    actor: ExploreEntity,
    previousCoords: Vector3D,
    currentCoords: Vector3D,
  ): string[] {
    const entered: string[] = [];

    for (const trigger of this.zoneTriggers) {
      if (!trigger.active) continue;

      const enteredZone = SpatialSystem.checkZoneEntry(
        { center: trigger.center, radius: trigger.radius },
        currentCoords,
        previousCoords,
      );

      if (enteredZone) {
        entered.push(trigger.id);
        this.logger.game(
          `📍 [Zone] ${actor.id} 进入区域 ${trigger.id} (${trigger.triggerType})`,
          { actorId: actor.id, zoneId: trigger.id, triggerType: trigger.triggerType },
          LogVisibility.PLAYER,
          { sceneId: this.engineId }
        );
        this.emit('ZONE_ENTERED', {
          entityId: actor.id,
          zoneId: trigger.id,
          triggerType: trigger.triggerType,
          payload: trigger.payload,
        });
        if (trigger.oneShot && trigger.lastTriggeredTick !== undefined) continue;
        if (trigger.lastTriggeredTick !== undefined
          && this._currentTick - trigger.lastTriggeredTick < trigger.cooldownTicks) continue;

        trigger.lastTriggeredTick = this._currentTick;
        this.emit('ZONE_TRIGGERED', {
          entityId: actor.id,
          triggerId: trigger.id,
          triggerType: trigger.triggerType,
          payload: trigger.payload,
        });

        this.logger.game(
          `⚡ [ZoneTrigger] ${trigger.triggerType} zone '${trigger.id}' fired for ${actor.id}`,
          { actorId: actor.id, triggerId: trigger.id, triggerType: trigger.triggerType },
          LogVisibility.PLAYER,
          { sceneId: this.engineId }
        );
      }
    }

    return entered;
  }

  // ============================================================
  //  路径计算 & 消耗
  // ============================================================

  /**
   * 计算六边形网格路径（A* 简化版 — 直线 hex 路径）
   * 使用轴向坐标线性插值
   */
  private computeHexPath(from: HexCoord, to: HexCoord): HexCoord[] {
    const dist = SpatialSystem.hexDistance(from, to);
    if (dist === 0) return [];

    const path: HexCoord[] = [];
    for (let i = 1; i <= dist; i++) {
      const t = i / dist;
      // 立方坐标插值 → 轴向坐标
      const fromCube = this.axialToCube(from);
      const toCube = this.axialToCube(to);
      const cubeInterp = {
        x: fromCube.x + (toCube.x - fromCube.x) * t,
        y: fromCube.y + (toCube.y - fromCube.y) * t,
        z: fromCube.z + (toCube.z - fromCube.z) * t,
      };
      const hex = this.cubeRoundToAxial(cubeInterp);
      path.push(hex);
    }

    return path;
  }

  /**
   * 轴向坐标 → 立方坐标
   */
  private axialToCube(hex: HexCoord): { x: number; y: number; z: number } {
    const q = hex.q;
    const r = hex.r;
    return { x: q, y: r, z: -q - r };
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

  /**
   * 计算路径 Hex 移动消耗
   * 每个 hex 基础消耗 1，地形可能增加
   */
  private calculatePathCost(path: HexCoord[]): number {
    let cost = 0;
    for (const hex of path) {
      if (!this.isHexPassable(hex)) return 999;
      const tileCost = this.getTileMovementCost(hex);
      cost += tileCost;
    }
    return cost;
  }

  /**
   * 获取单个 hex 的移动消耗
   */
  private getTileMovementCost(hex: HexCoord): number {
    if (!this.mapData) return 1;

    const tile = this.mapData.tiles.find(
      t => t.hex.q === hex.q && t.hex.r === hex.r
    );
    if (!tile) return 1;
    // movementCost < 0 表示不可通行，返回极大值阻止寻路
    const mc = tile.movementCost ?? 1;
    if (mc < 0) return 999;
    return mc;
  }

  /**
   * 检查 hex 是否可通行
   */
  isHexPassable(hex: HexCoord): boolean {
    if (!this.mapData) return true;

    const tile = this.mapData.tiles.find(
      t => t.hex.q === hex.q && t.hex.r === hex.r
    );
    if (!tile) return false;

    return tile.terrain !== 'WALL' && tile.terrain !== 'OBSTACLE';
  }

  // ============================================================
  //  Hook 管理
  // ============================================================

  /** 注册探索钩子 */
  registerHook(
    entityId: EntityId,
    trigger: HookTrigger,
    source: 'MANUAL' | 'SYSTEM' = 'MANUAL',
    ttl: number = 0,
  ): string {
    const hookId = generateId();
    this.hookRegistry.register(
      entityId,
      {
        id: hookId,
        entityId,
        label: `Explore Hook: ${trigger.type}`,
        trigger,
        enabled: true,
      },
      source,
      this._currentTick,
      ttl,
    );
    return hookId;
  }

  /** 移除钩子 */
  unregisterHook(hookId: string): boolean {
    return this.hookRegistry.unregister(hookId);
  }

  /** 获取活跃钩子 */
  getActiveHooks() {
    return this.hookRegistry.getActiveHooks();
  }

  /** 获取 HookRegistry 实例（供测试用） */
  getHookRegistry(): HookRegistry {
    return this.hookRegistry;
  }

  // ============================================================
  //  工具方法
  // ============================================================

  /** 获取所有探索实体 */
  getAllEntities(): ExploreEntity[] {
    return Array.from(this.entities.values());
  }

  /** 获取已安排动作列表（探索模式无时间轴，始终为空） */
  getScheduledActions(): any[] {
    return [];
  }

  /** 获取活跃钩子预设（供 SCENE_SYNC 同步） */
  getActiveHookPresets(): { id: string; entityId: string; label: string; trigger: any; enabled: boolean }[] {
    return this.hookRegistry.getAll()
      .filter(h => h.enabled && !h.fired)
      .map(h => ({
        id: h.id,
        entityId: h.entityId,
        label: h.label,
        trigger: h.trigger,
        enabled: h.enabled
      }));
  }

  /** 获取活跃决策窗口（探索模式无决策窗口，始终为空） */
  getActiveDecisionPolls(): any[] {
    return [];
  }

  /** 获取待决决策数量（始终为 0） */
  getPendingDecisionCount(): number {
    return 0;
  }

  /** 获取单个探索实体 */
  getEntity(id: EntityId): ExploreEntity | undefined {
    return this.entities.get(id);
  }

  /** 获取指定 hex 上的所有实体 */
  getEntitiesAtHex(hex: HexCoord): ExploreEntity[] {
    return Array.from(this.entities.values()).filter(e => {
      const entityHex = VectorMath.offsetToAxial(e.transform.coords.x, e.transform.coords.y);
      return entityHex.q === hex.q && entityHex.r === hex.r;
    });
  }

  /** 获取指定范围内的所有实体 */
  getEntitiesInRange(center: HexCoord, range: number): ExploreEntity[] {
    return Array.from(this.entities.values()).filter(e => {
      const entityHex = VectorMath.offsetToAxial(e.transform.coords.x, e.transform.coords.y);
      return SpatialSystem.hexDistance(center, entityHex) <= range;
    });
  }

  /** 设置实体移动点（每回合刷新） */
  refreshMovementPoints(entityId: EntityId, points: number): void {
    const entity = this.entities.get(entityId);
    if (entity) {
      entity.movementPoints = points;
      this.recordMutation(entityId, { movementPoints: points });
    }
  }

  /** 获取迷雾更新 */
  getLatestFogUpdate(): FogUpdatePayload | null {
    return this.latestFogUpdate;
  }

  /** 设置迷雾更新 */
  setLatestFogUpdate(update: FogUpdatePayload): void {
    this.latestFogUpdate = update;
  }

  /** 获取完整迷雾状态（供 SCENE_SYNC 同步） */
  getFowState(): Record<string, FogCellState> {
    return this.fogOfWar.getExploredMap();
  }

  /** 获取每个实体的可见 hex 集合（供前端按角色渲染 FOW） */
  getPerEntityFowState(): Record<string, string[]> {
    return this.fogOfWar.getPerEntityFowState();
  }

  /** 获取全局 FOW 状态（hexKey → FogState） */
  getGlobalFowState(): Record<string, string> {
    return this.fogOfWar.getGlobalFowState();
  }

  // ============================================================
  //  FOW 管理
  // ============================================================

  /** 重新计算所有实体的迷雾 */
  private refreshAllFog(): void {
    const entityList = Array.from(this.entities.values());
    const updates = this.fogOfWar.updateFogForAll(
      entityList, this.mapData, this._currentTick,
      (coords) => VectorMath.offsetToAxial(coords.x, coords.y),
    );
    if (updates.length > 0) {
      this.latestFogUpdate = updates[updates.length - 1];
    }
    this.logger.debug(
      `FOW refreshed for ${entityList.length} entities`,
      { updates: updates.map(u => ({ id: u.entityId, revealed: u.revealedHexes.length, explored: u.exploredHexes.length })) },
    );
  }

  /** 执行移动后刷新迷雾并广播 */
  private refreshFogAfterMove(entityId: string): void {
    const entity = this.entities.get(entityId);
    if (!entity || !this.mapData) return;
    if (!entity.revealsFog) return;

    const originHex = VectorMath.offsetToAxial(entity.transform.coords.x, entity.transform.coords.y);
    const sightRange = entity.sightRange ?? 6;
    const fov = this.fogOfWar.calculateFOV(
      originHex, this.mapData, Array.from(this.entities.values()), sightRange,
    );
    const update = this.fogOfWar.updateFog(entity, fov, this._currentTick);
    this.latestFogUpdate = update;

    if (update.revealedHexes.length > 0 || update.exploredHexes.length > 0 || update.obscuredHexes.length > 0) {
      this.emit('FOG_UPDATED', update);
    }
  }

  /**
   * 获取有效生成 hex 列表（GROUND/DOOR 等可行走地形）
   * 按与 spawn point 的距离排序
   */
  private getValidSpawnHexes(count: number): HexCoord[] {
    if (!this.mapData) return [];

    const passable = this.mapData.tiles
      .filter(t => this.isHexPassable(t.hex))
      .map(t => t.hex);

    // 优先选择靠中心的位置
    const centerQ = Math.floor(this.mapData.width / 2);
    const centerR = Math.floor(this.mapData.height / 2);

    passable.sort((a, b) => {
      const da = SpatialSystem.hexDistance({ q: centerQ, r: centerR }, a);
      const db = SpatialSystem.hexDistance({ q: centerQ, r: centerR }, b);
      return da - db;
    });

    // 均匀分布
    const selected: HexCoord[] = [];
    const step = Math.max(1, Math.floor(passable.length / count));
    for (let i = 0; i < count; i++) {
      const idx = Math.min(i * step, passable.length - 1);
      selected.push(passable[idx]);
    }
    return selected;
  }

  // ============================================================
  //  内部辅助
  // ============================================================

  /**
   * 将普通 Entity 转换为 ExploreEntity
   */
  private toExploreEntity(entity: Entity): ExploreEntity {
    const explore = entity as ExploreEntity;
    if (!explore.exploredHexes) {
      explore.exploredHexes = [];
    }
    if (explore.sightRange === undefined) {
      explore.sightRange = 6; // default 6 hex sight range
    }
    if (explore.movementPoints === undefined) {
      explore.movementPoints = 6; // default movement
    }
    if (explore.revealsFog === undefined) {
      explore.revealsFog = entity.type === 'ACTOR';
    }
    return explore;
  }

  private recordMutation(entityId: EntityId, changes: Record<string, any>): void {
    let mutation = this.pendingMutations.mutations.find(m => m.entityId === entityId);
    if (!mutation) {
      mutation = { entityId, changes: {} };
      this.pendingMutations.mutations.push(mutation);
    }
    Object.assign(mutation.changes, changes);
  }

  private flushMutations(): void {
    if (this.pendingMutations.mutations.length > 0) {
      this.pendingMutations.tick = this._currentTick;
      this.emit('STATE_MUTATED', this.pendingMutations);
      this.pendingMutations = { tick: this._currentTick, mutations: [] };
    }
  }
}
