/**
 * EntityRenderStore — 高性能实体渲染缓存
 *
 * 职责：
 *  - 缓存实体插值位置/旋转，不触发 React 重渲染
 *  - 提供无状态查询接口，供 RendererManager 每帧读取
 *  - 独立于 Zustand store，可接入 combat / explore 两种数据源
 *
 * 使用方式：
 *   RendererManager 每帧调用 interpolateAll() 批量更新，
 *   然后遍历 entitySprites 时通过 getRenderState() 读取位置。
 */

import type { Entity, Vector3D } from '@hard-vtt/shared';

// ============================================================
//  Interfaces
// ============================================================

export interface EntityRenderState {
  /** 像素 X 坐标（插值后） */
  x: number;
  /** 像素 Y 坐标（插值后） */
  y: number;
  /** 朝向角度（插值后，单位度） */
  angle: number;
  /** 透明度 */
  alpha: number;
  /** 是否可见 */
  visible: boolean;
  /** 缩放比例 */
  scale: number;
}

export type HexToPixelFn = (x: number, y: number) => { x: number; y: number };

// ============================================================
//  EntityRenderStore
// ============================================================

const DEFAULT_LERP_FACTOR = 0.2;
const MOVEMENT_TOLERANCE_PX = 50 * 0.3; // DISPLAY_SCALE * 0.3

export class EntityRenderStore {
  private states = new Map<string, EntityRenderState>();
  private lerpFactor: number;

  constructor(lerpFactor = DEFAULT_LERP_FACTOR) {
    this.lerpFactor = lerpFactor;
  }

  // ============================================================
  //  Lifecycle
  // ============================================================

  /** 注册一个新实体（通常在 sprite 创建时调用） */
  public registerEntity(
    id: string,
    x: number,
    y: number,
    angle: number,
  ): void {
    this.states.set(id, {
      x,
      y,
      angle,
      alpha: 1,
      visible: true,
      scale: 1,
    });
  }

  /** 注销一个实体（sprite 销毁时调用） */
  public unregisterEntity(id: string): void {
    this.states.delete(id);
  }

  /** 查询实体是否存在 */
  public hasEntity(id: string): boolean {
    return this.states.has(id);
  }

  /** 获取当前渲染状态（只读快照） */
  public getRenderState(id: string): Readonly<EntityRenderState> | undefined {
    return this.states.get(id);
  }

  /** 获取所有渲染状态 */
  public getAllStates(): Map<string, EntityRenderState> {
    return this.states;
  }

  /** 清空所有状态 */
  public clear(): void {
    this.states.clear();
  }

  /** 返回实体数量 */
  public get size(): number {
    return this.states.size;
  }

  // ============================================================
  //  Data Feed — 从权威 Store 批量插值
  // ============================================================

  /**
   * 每帧调用：从 authoritative entities + movementTargets 批量插值
   *
   * @param entities       Zustand store 中的 entities 快照
   * @param movementTargets 本地预测的移动目标
   * @param dt             PixiJS ticker deltaTime
   * @param hexToPixel     六边形→像素转换函数
   */
  public interpolateAll(
    entities: Record<string, Entity>,
    movementTargets: Record<string, Vector3D>,
    dt: number,
    hexToPixel: HexToPixelFn,
  ): void {
    const adjustedLerp = 1 - Math.pow(1 - this.lerpFactor, dt);

    for (const [id, state] of this.states) {
      const entity = entities[id];
      if (!entity) continue;

      // 权威坐标 → 像素
      const serverPixel = hexToPixel(
        entity.transform.coords.x,
        entity.transform.coords.y,
      );
      const target = movementTargets[id];

      if (target) {
        // 有本地预测目标 → 向目标插值，同时检查是否偏离权威太远
        const targetPixel = hexToPixel(target.x, target.y);
        const dx = targetPixel.x - state.x;
        const dy = targetPixel.y - state.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 1) {
          // 已到达
          state.x = targetPixel.x;
          state.y = targetPixel.y;
        } else {
          state.x += dx * adjustedLerp;
          state.y += dy * adjustedLerp;

          // 如果偏离权威坐标太远 → 强制回正
          const snapDx = serverPixel.x - state.x;
          const snapDy = serverPixel.y - state.y;
          if (Math.sqrt(snapDx * snapDx + snapDy * snapDy) > MOVEMENT_TOLERANCE_PX) {
            state.x = serverPixel.x;
            state.y = serverPixel.y;
          }
        }
      } else {
        // 无预测 → 向权威坐标插值
        state.x += (serverPixel.x - state.x) * adjustedLerp;
        state.y += (serverPixel.y - state.y) * adjustedLerp;
      }

      // 朝向插值（处理 0/360 跨越）
      const targetFacing = entity.transform.facing;
      let diff = targetFacing - state.angle;
      while (diff < -180) diff += 360;
      while (diff > 180) diff -= 360;
      state.angle += diff * adjustedLerp;
    }
  }

  // ============================================================
  //  Manual Updates
  // ============================================================

  /** 外部直接设置位置（用于初始同步或跳转） */
  public setPosition(
    id: string,
    x: number,
    y: number,
    angle?: number,
  ): void {
    const state = this.states.get(id);
    if (state) {
      state.x = x;
      state.y = y;
      if (angle !== undefined) state.angle = angle;
    }
  }

  /** 批量设置可见性 */
  public setVisibility(id: string, visible: boolean): void {
    const state = this.states.get(id);
    if (state) {
      state.visible = visible;
    }
  }

  /** 批量设置透明度 */
  public setAlpha(id: string, alpha: number): void {
    const state = this.states.get(id);
    if (state) {
      state.alpha = Math.max(0, Math.min(1, alpha));
    }
  }

  /** 批量设置缩放 */
  public setScale(id: string, scale: number): void {
    const state = this.states.get(id);
    if (state) {
      state.scale = scale;
    }
  }
}

/** 全局单例（与 RendererManager 生命周期绑定） */
export const entityRenderStore = new EntityRenderStore();
