// packages/backend/src/core/systems/ZoneTrigger.ts
// Phase 4.3: 区域触发系统 — 管理地图上的触发区域（遭遇战、对话、陷阱）

import type {
  ZoneTriggerDef, ZoneTriggerType, Entity, EntityId, Vector3D, Tick
} from '@hard-vtt/shared';
import { VectorMath } from '../../utils/VectorMath.js';
import { generateId } from '../../utils/IdGenerator.js';

export type TriggerEventType = 'COMBAT_START' | 'DIALOG_ACTIVATE' | 'TRAP_TRIGGERED';

export interface TriggerEvent {
  eventId: string;
  triggerId: string;
  eventType: TriggerEventType;
  triggeredBy: EntityId;
  tick: Tick;
  position: Vector3D;
  payload?: Record<string, any>;
}

/**
 * 区域触发系统
 * 管理所有 ZoneTrigger 的注册、检测和触发生命周期
 */
export class ZoneTriggerSystem {
  private triggers: Map<string, ZoneTriggerDef> = new Map();
  /** 仅 inOneShot 且已触发的触发器列表（用于快速排除） */
  private firedOneShots: Set<string> = new Set();

  /**
   * 注册一个区域触发器
   * @returns 注册的触发器（含自动生成的 id）
   */
  public register(def: Omit<ZoneTriggerDef, 'id'> & { id?: string }): ZoneTriggerDef {
    const trigger: ZoneTriggerDef = {
      ...def,
      id: def.id ?? generateId(),
      active: def.active ?? true,
      lastTriggeredTick: undefined,
    };
    this.triggers.set(trigger.id, trigger);
    this.firedOneShots.delete(trigger.id);
    return trigger;
  }

  /**
   * 批量注册触发器
   */
  public registerMany(defs: Array<Omit<ZoneTriggerDef, 'id'> & { id?: string }>): ZoneTriggerDef[] {
    return defs.map(d => this.register(d));
  }

  /**
   * 注销触发器
   */
  public unregister(triggerId: string): boolean {
    const existed = this.triggers.delete(triggerId);
    this.firedOneShots.delete(triggerId);
    return existed;
  }

  /**
   * 获取指定触发器
   */
  public get(triggerId: string): ZoneTriggerDef | undefined {
    return this.triggers.get(triggerId);
  }

  /**
   * 获取所有触发器
   */
  public getAll(): ZoneTriggerDef[] {
    return Array.from(this.triggers.values());
  }

  /**
   * 获取指定类型的触发器
   */
  public getByType(triggerType: ZoneTriggerType): ZoneTriggerDef[] {
    return Array.from(this.triggers.values())
      .filter(t => t.triggerType === triggerType);
  }

  /**
   * 激活/禁用触发器
   */
  public setActive(triggerId: string, active: boolean): boolean {
    const trigger = this.triggers.get(triggerId);
    if (!trigger) return false;
    trigger.active = active;
    return true;
  }

  /**
   * 评估所有实体的位置，检测是否有实体进入触发区域
   *
   * @param entities 所有实体（位置用于检测区域进入）
   * @param tick 当前引擎 Tick
   * @param previousPositions 上一 Tick 各实体的位置（用于跨边界检测）
   * @returns 本次评估中触发的所有事件
   */
  public evaluate(
    entities: Map<EntityId, Entity>,
    tick: Tick,
    previousPositions?: Map<EntityId, Vector3D>
  ): TriggerEvent[] {
    const events: TriggerEvent[] = [];

    for (const [, trigger] of this.triggers) {
      if (!trigger.active) continue;
      if (trigger.oneShot && this.firedOneShots.has(trigger.id)) continue;

      // 检查冷却
      if (trigger.lastTriggeredTick !== undefined && trigger.cooldownTicks > 0) {
        if (tick - trigger.lastTriggeredTick < trigger.cooldownTicks) continue;
      }

      for (const [entityId, entity] of entities) {
        const currentPos = entity.transform.coords;
        const prevPos = previousPositions?.get(entityId);
        const entered = this.checkEntry(trigger, currentPos, prevPos);
        if (!entered) continue;

        // 触发
        const event = this.fireTrigger(trigger, entityId, tick);
        events.push(event);

        // 单次触发器标记已触发
        if (trigger.oneShot) {
          this.firedOneShots.add(trigger.id);
        }
        break; // 每 Tick 每个触发器只触发一次（首个进入的实体）
      }
    }

    return events;
  }

  /**
   * 检查实体是否进入触发区域
   * 若提供了上一 Tick 位置，则检测跨边界进入；否则仅检测当前位置
   */
  private checkEntry(
    trigger: ZoneTriggerDef,
    currentPos: Vector3D,
    previousPos: Vector3D | undefined
  ): boolean {
    const nowIn = VectorMath.distance(trigger.center, currentPos) <= trigger.radius;
    if (!nowIn) return false;
    if (previousPos) {
      const wasIn = VectorMath.distance(trigger.center, previousPos) <= trigger.radius;
      if (wasIn) return false; // 上一 Tick 已在区域内，不重复触发
    }
    return true;
  }

  /**
   * 触发区域事件并生成 TriggerEvent
   */
  private fireTrigger(
    trigger: ZoneTriggerDef,
    triggeredBy: EntityId,
    tick: Tick
  ): TriggerEvent {
    trigger.lastTriggeredTick = tick;

    let eventType: TriggerEventType;
    switch (trigger.triggerType) {
      case 'COMBAT':
        eventType = 'COMBAT_START';
        break;
      case 'DIALOG':
        eventType = 'DIALOG_ACTIVATE';
        break;
      case 'TRAP':
        eventType = 'TRAP_TRIGGERED';
        break;
      default:
        eventType = 'COMBAT_START';
    }

    return {
      eventId: generateId(),
      triggerId: trigger.id,
      eventType,
      triggeredBy,
      tick,
      position: { ...trigger.center },
      payload: trigger.payload ? { ...trigger.payload } : undefined,
    };
  }

  /**
   * Tick 更新（重置触发器状态等）
   * 目前用于移除长时间冷却后的一 shots 标记清理（预留扩展）
   */
  public tickUpdate(_tick: Tick): void {
    // 预留：可在此处实现冷却恢复逻辑
  }

  /**
   * 清除所有触发器状态
   */
  public reset(): void {
    this.triggers.clear();
    this.firedOneShots.clear();
  }
}
