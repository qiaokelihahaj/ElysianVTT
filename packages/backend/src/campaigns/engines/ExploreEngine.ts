// packages/backend/src/campaigns/engines/ExploreEngine.ts
import { EventEmitter } from 'events';
import {
  IEngineInstance, Tick, ClientIntent, Entity, EntityId, Vector3D, HexCoord,
  ExploreEntity, MovementResult, ExploreIntent, SkillCheckResult,
  StateMutationPayload, VisualEventPayload,
  MapData, ZoneTriggerDef, FogUpdatePayload,
  LogVisibility, HookTrigger,
} from '@hard-vtt/shared';
import { SpatialSystem } from '../../core/systems/SpatialSystem.js';
import { VectorMath } from '../../utils/VectorMath.js';
import { generateId } from '../../utils/IdGenerator.js';
import { Logger } from '../../utils/Logger.js';
import { HookRegistry } from './HookRegistry.js';

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
  /** 待发送的状态变更累积 */
  private pendingMutations: StateMutationPayload = { tick: 0, mutations: [] };
  /** 最新的迷雾更新（供每步移动后广播） */
  private latestFogUpdate: FogUpdatePayload | null = null;

  constructor(engineId: string) {
    super();
    this.engineId = engineId;
    this.logger = Logger.create('Engine:Explore');
    this.hookRegistry = new HookRegistry();
    this.logger.info(`ExploreEngine created`, null, { sceneId: this.engineId });
  }

  // ============================================================
  //  地图 & 区域管理
  // ============================================================

  /** 加载地图数据 */
  loadMap(mapData: MapData): void {
    this.mapData = mapData;
    this.logger.info(
      `Map '${mapData.name}' loaded: ${mapData.tiles.length} tiles`,
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
    for (const entity of entities) {
      const exploreEntity = this.toExploreEntity(entity);
      this.entities.set(entity.id, exploreEntity);
    }
    this.logger.info(
      `Mounted ${entities.length} entities`,
      { entityIds: entities.map(e => e.id) },
      { sceneId: this.engineId }
    );
  }

  unmountEntities(entityIds: EntityId[]): Entity[] {
    const removed: Entity[] = [];
    for (const id of entityIds) {
      const ent = this.entities.get(id);
      if (ent) {
        removed.push(ent);
        this.entities.delete(id);
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

    const fromHex = VectorMath.vector3DToHex(actor.transform.coords);
    const toHex = VectorMath.vector3DToHex(targetCoords);

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

    // 逐 hex 执行移动
    const triggeredHooks: string[] = [];
    const zoneEntries: string[] = [];
    const previousCoords = { ...actor.transform.coords };

    for (const hex of path) {
      const newCoords = VectorMath.hexToVector3D(hex, actor.transform.coords.z ?? 0);

      // 更新实体坐标
      actor.transform = {
        ...actor.transform,
        coords: newCoords,
      };

      // 检查 ENTITY_MOVES_TO 钩子
      const firedHooks = this.checkEntityMovesHooks(actor, hex);
      for (const h of firedHooks) {
        triggeredHooks.push(h.id);
      }

      // 检查 ENTITY_ENTERS_AREA 钩子
      const enteredZones = this.checkZoneEntries(actor, previousCoords, newCoords);
      for (const zId of enteredZones) {
        zoneEntries.push(zId);
      }
    }

    // 更新移动点
    actor.movementPoints -= moveCost;

    // 记录状态变更
    const finalCoords = VectorMath.hexToVector3D(path[path.length - 1], actor.transform.coords.z ?? 0);
    this.recordMutation(actor.id, {
      'transform.coords.x': finalCoords.x,
      'transform.coords.y': finalCoords.y,
      'transform.coords.z': finalCoords.z,
      'movementPoints': actor.movementPoints,
    });

    // 广播移动结果
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

    // 检查区域触发器
    this.checkAndFireZoneTriggers(actor, toHex);

    // 广播状态变更
    this.flushMutations();

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

    // 检查距离
    const dist = VectorMath.distance(actor.transform.coords, target.transform.coords);
    const interactRange = 1.5;
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
   * 处理检查意图（EXAMINE）：对目标进行更详细的鉴定
   */
  handleExamineIntent(actor: ExploreEntity, targetId: EntityId): void {
    const target = this.entities.get(targetId);
    if (!target) {
      this.logger.warn(`Examine target ${targetId} not found`, null, { sceneId: this.engineId });
      return;
    }

    const dist = VectorMath.distance(actor.transform.coords, target.transform.coords);
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
   * 检查 ENTITY_MOVES_TO 钩子
   * 委托给 HookRegistry 评估，检测实体是否移动到目标 hex
   */
  private checkEntityMovesHooks(actor: ExploreEntity, currentHex: HexCoord): ReturnType<HookRegistry['evaluate']> {
    // 临时将实体位置映射到 hex 空间以便 HookRegistry 检查
    // HookRegistry.evaluate 中 ENTITY_MOVES_TO 检查距离 < 1.5
    // 由于我们已经将实体坐标更新为 hex 的 Vector3D 坐标，直接评估即可
    return this.hookRegistry.evaluate(this._currentTick, this.entityMap());
  }

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
      }
    }

    return entered;
  }

  /**
   * 检查区域触发器（基于 hex 位置）
   */
  private checkAndFireZoneTriggers(actor: ExploreEntity, hex: HexCoord): void {
    const coords = VectorMath.hexToVector3D(hex);
    for (const trigger of this.zoneTriggers) {
      if (!trigger.active) continue;
      if (trigger.oneShot && trigger.lastTriggeredTick !== undefined) continue;

      const dist = VectorMath.distance(trigger.center, coords);
      if (dist <= trigger.radius) {
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
    return tile?.movementCost ?? 1;
  }

  /**
   * 检查 hex 是否可通行
   */
  isHexPassable(hex: HexCoord): boolean {
    if (!this.mapData) return true;

    const tile = this.mapData.tiles.find(
      t => t.hex.q === hex.q && t.hex.r === hex.r
    );
    if (!tile) return true;

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

  /** 获取单个探索实体 */
  getEntity(id: EntityId): ExploreEntity | undefined {
    return this.entities.get(id);
  }

  /** 获取指定 hex 上的所有实体 */
  getEntitiesAtHex(hex: HexCoord): ExploreEntity[] {
    return Array.from(this.entities.values()).filter(e => {
      const entityHex = VectorMath.vector3DToHex(e.transform.coords);
      return entityHex.q === hex.q && entityHex.r === hex.r;
    });
  }

  /** 获取指定范围内的所有实体 */
  getEntitiesInRange(center: HexCoord, range: number): ExploreEntity[] {
    return Array.from(this.entities.values()).filter(e => {
      const entityHex = VectorMath.vector3DToHex(e.transform.coords);
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

  private entityMap(): Map<EntityId, Entity> {
    // HookRegistry expects Map<EntityId, Entity> but we have ExploreEntity
    // ExploreEntity extends Entity so this is safe
    return this.entities as Map<EntityId, Entity>;
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
