import { hexOffsetToPixel, pixelToHexOffset } from '@hard-vtt/shared';
import { Application, Container, Graphics, Rectangle, Sprite, Text, TextStyle } from 'pixi.js';
import { assetManager } from '../assets';
import { IntentDispatcher } from '../network/IntentDispatcher';
import { useGameStore } from '../store/gameStore';
import { entityRenderStore, EntityRenderStore } from './EntityRenderStore';
import { useExploreStore, type HexVisibility } from '../store/exploreStore';
import type { VisualEventPayload, TileDef } from '@hard-vtt/shared';

// ============================================================
//  Flat-top hex math — 双型偏移坐标系统
//  每个六边形按所在列分为 Type 0（偶数列）和 Type 1（奇数列），
//  奇数列整体下移半个六边形高度（√3/2×size），实现密接排列。
//  角度步长 60°（0°/60°/120°/180°/240°/300°）
// ============================================================

const HEX_SIZE = 50;

/** 六边形类型：偶数列 = Type 0，奇数列 = Type 1 */
function hexType(col: number): 0 | 1 {
    return (col & 1) as unknown as 0 | 1;
}

/**
 * 偏移坐标 (col, row) → 像素中心坐标
 * Type 1（奇数 col）在 Type 0 基础上垂直偏移 halfHexH
 */
function hexToPixel(col: number, row: number, size = HEX_SIZE): { x: number; y: number } {
    return hexOffsetToPixel(col, row, size);
}

function pixelToHex(px: number, py: number, size = HEX_SIZE): { col: number; row: number } {
    return pixelToHexOffset(px, py, size);
}

const HEX_CORNERS: { x: number; y: number }[] = (() => {
    const corners: { x: number; y: number }[] = [];
    for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 180) * (60 * i);
        corners.push({ x: HEX_SIZE * Math.cos(angle), y: HEX_SIZE * Math.sin(angle) });
    }
    return corners;
})();

// ============================================================
//  Floating text animation interface
// ============================================================

interface FloatingTextAnim {
    sprite: Text;
    life: number;
    maxLife: number;
    velY: number;
}

/**
 * 渲染图层常量（自底向上），参考 PlanarAlly 的图层模型：
 *   Ground → Grid → Objects → Token → GM → FOW → Preview → FX → Lighting
 */
export const RenderLayer = {
    Ground: 0,
    Grid: 1,
    Objects: 2,
    Token: 3,
    GM: 4,
    FOW: 5,
    Preview: 6,
    FX: 7,
    Lighting: 8,
} as const;
export type RenderLayer = (typeof RenderLayer)[keyof typeof RenderLayer];

export class RendererManager {
    private static instance: RendererManager;
    private app: Application | null = null;
    private initializationId = 0;
    private initializing = false;
    private fxTimers = new Set<ReturnType<typeof setTimeout>>();

    public groundLayer = new Container();
    public gridLayer = new Container();
    public objectLayer = new Container();
    public tokenLayer = new Container();
    public gmLayer = new Container();
    public fowLayer = new Container();
    public previewLayer = new Container();
    public fxLayer = new Container();
    public lightingLayer = new Container();
    /** @deprecated 请直接使用 groundLayer/gridLayer/tokenLayer */
    public mapLayer = this.groundLayer;
    /** @deprecated 请使用 tokenLayer */
    public entityLayer = this.tokenLayer;

    private entitySprites: Map<string, Container> = new Map();
    /** 记录每个实体上次选中状态，避免每帧重绘 */
    private lastSelectedState: Map<string, boolean> = new Map();
    private activeFloatingTexts: FloatingTextAnim[] = [];
    private phantomHero: Graphics | null = null;

    // Camera, drag-to-pan, and zoom state
    private canvas: HTMLCanvasElement | null = null;
    private cameraContainer = new Container();
    private cameraX = 0;
    private cameraY = 0;
    private zoom = 1;
    private isPointerDown = false;
    private dragStartX = 0;
    private dragStartY = 0;
    private camDragStartX = 0;
    private camDragStartY = 0;
    private hasDragged = false;
    private domAbort: AbortController | null = null;

    private unsubscribeStore: (() => void) | null = null;
    private unsubscribeFow: (() => void) | null = null;

    /** 战争迷雾 Graphics（单例，clear+redraw） */
    private fowGraphics: Graphics | null = null;

    /** 实体渲染缓存（可注入，默认使用全局单例） */
    private renderStore: EntityRenderStore;

    private constructor() {
      this.renderStore = entityRenderStore;
    }

    /** 设置自定义 renderStore（用于测试或 explore 模式切换） */
    public setRenderStore(store: EntityRenderStore): void {
      this.renderStore = store;
    }

    public static getInstance() {
        if (!RendererManager.instance) {
            RendererManager.instance = new RendererManager();
        }
        return RendererManager.instance;
    }

    public async initialize(viewConfig: { canvas: HTMLCanvasElement; width: number; height: number }) {
        if (this.app || this.initializing) return;
        const initializationId = ++this.initializationId;
        this.initializing = true;
        try {

        await assetManager.preload();
        if (this.initializationId !== initializationId) return;

        const app = new Application();
        await app.init({
            canvas: viewConfig.canvas,
            width: viewConfig.width,
            height: viewConfig.height,
            backgroundColor: 0x1a1a1a,
            resolution: window.devicePixelRatio || 1,
            autoDensity: true,
            resizeTo: window,
        });
        if (this.initializationId !== initializationId) {
            app.destroy({ removeView: true }, true);
            return;
        }
        this.app = app;
        this.canvas = this.app.canvas as HTMLCanvasElement;

        const orderedLayers = [
            this.groundLayer,
            this.gridLayer,
            this.objectLayer,
            this.tokenLayer,
            this.gmLayer,
            this.fowLayer,
            this.previewLayer,
            this.fxLayer,
            this.lightingLayer,
        ];
        for (const layer of orderedLayers) {
            this.cameraContainer.addChild(layer);
        }
        this.app.stage.addChild(this.cameraContainer);

        // --- Click handling (PixiJS event system, respects entity selection) ---
        this.groundLayer.eventMode = 'static';
        this.groundLayer.hitArea = new Rectangle(-100000, -100000, 200000, 200000);
        this.groundLayer.cursor = 'grab';

        this.groundLayer.on('pointerdown', (e) => {
            const state = useGameStore.getState();
            // 相机模式下地面点击仅用于导航，不处理实体选择
            if (state.cameraMode) return;
            // Manual screen→world conversion using known camera state,
            // avoids potential PixiJS worldTransform staleness issues
            const camScale = this.cameraContainer.scale.x;
            const worldX = (e.global.x - this.cameraX) / camScale;
            const worldY = (e.global.y - this.cameraY) / camScale;
            const hex = pixelToHex(worldX, worldY);

            if (state.uiState.mode === 'SELECT_MOVE_TARGET') {
                state.setPendingMoveCoords({ x: hex.col, y: hex.row, z: 0 });
            } else if (state.uiState.mode === 'IDLE') {
                state.setSelectedEntityId(null);
            }
        });

        // --- Drag-to-pan (DOM events, bypass PixiJS stopPropagation) + zoom ---
        this.domAbort = new AbortController();
        const opts = { signal: this.domAbort.signal };

        viewConfig.canvas.addEventListener('pointerdown', (e) => {
            const state = useGameStore.getState();
            if (!state.cameraMode) return;
            this.isPointerDown = true;
            this.hasDragged = false;
            this.dragStartX = e.clientX;
            this.dragStartY = e.clientY;
            this.camDragStartX = this.cameraX;
            this.camDragStartY = this.cameraY;
        }, opts);

        document.addEventListener('pointermove', (e) => {
            if (!this.isPointerDown) return;
            const dx = e.clientX - this.dragStartX;
            const dy = e.clientY - this.dragStartY;
            if (!this.hasDragged && dx * dx + dy * dy > 9) {
                this.hasDragged = true;
                viewConfig.canvas.style.cursor = 'grabbing';
            }
            if (this.hasDragged) {
                this.cameraX = this.camDragStartX + dx;
                this.cameraY = this.camDragStartY + dy;
                this.cameraContainer.x = this.cameraX;
                this.cameraContainer.y = this.cameraY;
            }
        }, opts);

        document.addEventListener('pointerup', () => {
            this.isPointerDown = false;
            const camMode = useGameStore.getState().cameraMode;
            viewConfig.canvas.style.cursor = camMode ? 'grab' : 'default';
        }, opts);

        // Zoom toward mouse cursor
        viewConfig.canvas.addEventListener('wheel', (e: WheelEvent) => {
            const state = useGameStore.getState();
            if (!state.cameraMode) return;
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.08 : 0.08;
            this.zoom = Math.max(0.35, Math.min(3, this.zoom + delta));

            const rect = viewConfig.canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;

            const oldScale = this.cameraContainer.scale.x;
            const worldX = (mx - this.cameraX) / oldScale;
            const worldY = (my - this.cameraY) / oldScale;

            this.cameraContainer.scale.set(this.zoom);
            this.cameraX = mx - worldX * this.zoom;
            this.cameraY = my - worldY * this.zoom;
            this.cameraContainer.x = this.cameraX;
            this.cameraContainer.y = this.cameraY;
        }, { ...opts, passive: false });

        this.phantomHero = new Graphics();
        this.phantomHero.circle(0, 0, 20);
        this.phantomHero.fill({ color: 0x3498db, alpha: 0.15 });
        // fill() consumes the path - must rebuild for stroke()
        this.phantomHero.circle(0, 0, 20);
        this.phantomHero.stroke({ width: 2, color: 0x3498db });
        this.phantomHero.alpha = 0.7;
        this.phantomHero.visible = false;
        this.previewLayer.addChild(this.phantomHero);

        this.drawGrid();
        this.subscribeToStore();

        // 初始化战争迷雾（空 Graphics，数据由 exploreStore 驱动）
        this.fowGraphics = new Graphics();
        this.fowLayer.addChild(this.fowGraphics);
        this.subscribeToFow();

        app.ticker.add((ticker) => {
            this.update(ticker.deltaTime);
        });
        } finally {
            if (this.initializationId === initializationId) this.initializing = false;
        }
    }

    // ============================================================
    //  Hex Grid Rendering
    // ============================================================

    private drawGrid() {
        // Draw hex grid lines
        const gridLines = new Graphics();
        this.drawHexGrid(gridLines);
        this.gridLayer.addChild(gridLines);
    }

    /** 绘制密接六边形网格，每列按类型交替偏移 */
    private drawHexGrid(g: Graphics) {
        // Extend far beyond screen to support drag-to-pan and zoom-out
        const pad = 6000;
        const screenW = window.innerWidth + pad * 2;
        const screenH = window.innerHeight + pad * 2;

        // 屏幕矩形在偏移坐标下的行列范围
        const hexW = 1.5 * HEX_SIZE;
        const hexH = Math.sqrt(3) * HEX_SIZE;
        const halfCols = Math.ceil(screenW / hexW / 2) + 2;
        const halfScreenH = screenH / 2;

        for (let col = -halfCols; col <= halfCols; col++) {
            const type = hexType(col); // 0 或 1
            // Type 1 （奇数列）整列垂直偏移 halfHexH
            const yOffset = type * (HEX_SIZE * Math.sqrt(3) * 0.5);

            // 计算本列哪些行在屏幕范围内
            // pixel_y = hexH * row + yOffset → row = (pixel_y - yOffset) / hexH
            const rowStart = Math.floor((-halfScreenH - yOffset) / hexH) - 1;
            const rowEnd = Math.ceil((halfScreenH - yOffset) / hexH) + 1;

            for (let row = rowStart; row <= rowEnd; row++) {
                const cx = hexW * col;
                const cy = hexH * row + yOffset;
                this.drawHexOutline(g, cx, cy);
            }
        }

        g.stroke({ width: 1, color: 0x2a2a2a });
    }

    /** 在 (cx, cy) 处绘制单个六边形轮廓 */
    private drawHexOutline(g: Graphics, cx: number, cy: number) {
        g.moveTo(cx + HEX_CORNERS[0].x, cy + HEX_CORNERS[0].y);
        for (let i = 1; i <= 6; i++) {
            g.lineTo(cx + HEX_CORNERS[i % 6].x, cy + HEX_CORNERS[i % 6].y);
        }
    }

    // ============================================================
    //  Fog of War (FOW) — 战争迷雾渲染
    //  exploreStore.hexVisibility 驱动，仅在变化时重绘
    //  轴向坐标 (q, r) → 偏移坐标 (col = q, row = r + floor(q/2))
    // ============================================================

    /** 轴向坐标 (q, r) → 偏移坐标 (col, row) */
    private axialToOffset(q: number, r: number): { col: number; row: number } {
        return { col: q, row: r + Math.floor(q / 2) };
    }

    /** 在 (cx, cy) 处绘制填充六边形路径以供 fill/stroke */
    private drawFowHexPath(g: Graphics, cx: number, cy: number) {
        g.moveTo(cx + HEX_CORNERS[0].x, cy + HEX_CORNERS[0].y);
        for (let i = 1; i <= 6; i++) {
            g.lineTo(cx + HEX_CORNERS[i % 6].x, cy + HEX_CORNERS[i % 6].y);
        }
        g.closePath();
    }

    /**
     * 订阅 exploreStore 的 hexVisibility / entityHexVisibility / viewingEntityId 变化
     * 仅在地图加载、迷雾状态变化、或切换视角实体时重绘
     */
    private subscribeToFow(): void {
        if (this.unsubscribeFow) this.unsubscribeFow();

        const redraw = () => {
            const exploreState = useExploreStore.getState();
            const isGM = useGameStore.getState().permission.role === 'GM';
            if (!exploreState.exploreMode || !exploreState.mapData) {
                if (this.fowGraphics) this.fowGraphics.clear();
                return;
            }
            this.updateFow(
                exploreState.hexVisibility,
                exploreState.entityHexVisibility,
                exploreState.viewingEntityId,
                exploreState.mapData.tiles,
                isGM,
            );
        };

        // 首次渲染
        redraw();

        // 监听相关字段变化
        this.unsubscribeFow = useExploreStore.subscribe((state) => {
            const isGM = useGameStore.getState().permission.role === 'GM';
            if (state.exploreMode && state.mapData) {
                this.updateFow(
                    state.hexVisibility,
                    state.entityHexVisibility,
                    state.viewingEntityId,
                    state.mapData.tiles,
                    isGM,
                );
            } else if (this.fowGraphics) {
                this.fowGraphics.clear();
            }
        });
    }

    /**
     * 更新战争迷雾渲染
     *
     * 优先使用 viewingEntityId 对应实体的视野；
     * 若未设置视角实体，退回使用全局 hexVisibility。
     *
     * @param hexVisibility        全局迷雾状态（key = "q,r"）
     * @param entityHexVisibility 每个实体的可见 hex key 集合
     * @param viewingEntityId     当前视角实体 ID
     * @param tiles               地图瓦片列表
     */
    private updateFow(
        hexVisibility: Record<string, HexVisibility>,
        entityHexVisibility: Record<string, string[]>,
        viewingEntityId: string | null,
        tiles: TileDef[],
        isGM: boolean = false,
    ): void {
        const g = this.fowGraphics;
        if (!g) return;

        g.clear();

        // GM 未选中角色 → 不显示迷雾（全图可见）
        if (isGM && !viewingEntityId) {
            return;
        }

        // GM 选中角色 → 更轻的迷雾覆盖（仅示意），PL/OB → 正常迷雾
        const unexploredAlpha = isGM ? 0.2 : 0.95;
        const exploredAlpha = isGM ? 0.08 : 0.55;

        // 确定当前视角的可见 hex 集合
        const visibleHexKeys: Set<string> | null = viewingEntityId
            ? new Set(entityHexVisibility[viewingEntityId] ?? [])
            : null;

        for (const tile of tiles) {
            const { q, r } = tile.hex;
            const key = `${q},${r}`;

            // 转换为偏移坐标 → 像素
            const offset = this.axialToOffset(q, r);
            const pos = hexToPixel(offset.col, offset.row);

            // 判断该 hex 对当前视角的可见性
            const isCurrentlyVisible = visibleHexKeys
                ? visibleHexKeys.has(key)
                : (hexVisibility[key]?.visible ?? false);

            const isExplored = hexVisibility[key]?.explored ?? false;

            if (!isExplored && !isCurrentlyVisible) {
                // 从未探索
                this.drawFowHexPath(g, pos.x, pos.y);
                g.fill({ color: 0x000000, alpha: unexploredAlpha });
                continue;
            }

            if (isCurrentlyVisible) {
                // 当前可见 → 不绘制迷雾覆盖
                continue;
            }

            // 已探索但当前不可见
            this.drawFowHexPath(g, pos.x, pos.y);
            g.fill({ color: 0x0a0a0a, alpha: exploredAlpha });
        }
    }

    // ============================================================
    //  Entity synchronisation
    // ============================================================

    private subscribeToStore() {
        if (this.unsubscribeStore) this.unsubscribeStore();

        const syncFromState = (state: ReturnType<typeof useGameStore.getState>) => {
            const currentEntities = state.entities;

            // Sync entity removal
            for (const [id, container] of this.entitySprites) {
                if (!currentEntities[id]) {
                    this.tokenLayer.removeChild(container);
                    container.destroy({ children: true });
                    this.entitySprites.delete(id);
                    this.lastSelectedState.delete(id);
                    this.renderStore.unregisterEntity(id);
                }
            }

            // Sync entity creation and updates
            for (const [id, entity] of Object.entries(currentEntities)) {
                let container = this.entitySprites.get(id);
                const isSelected = state.selectedEntityId === id;
                const prevSelected = this.lastSelectedState.get(id);

                if (!container) {
                    container = this.createEntityDisplay(entity.type, entity.templateId, id, isSelected);
                    const pos = hexToPixel(entity.transform.coords.x, entity.transform.coords.y);
                    container.x = pos.x;
                    container.y = pos.y;
                    container.angle = entity.transform.facing ?? 0;

                    this.entitySprites.set(id, container);
                    this.lastSelectedState.set(id, isSelected);
                    this.tokenLayer.addChild(container);

                    this.renderStore.registerEntity(id, pos.x, pos.y, entity.transform.facing ?? 0);
                } else if (prevSelected !== isSelected) {
                    // 仅在选中状态变化时重绘（避免每帧清除 Graphics）
                    this.syncEntityDisplay(container, entity.type, entity.templateId, isSelected);
                    this.lastSelectedState.set(id, isSelected);
                }
            }

            // Sync ground cursor with camera mode
            // 相机模式下显示拖拽光标，非相机模式下显示箭头光标
            this.groundLayer.cursor = state.cameraMode ? 'grab' : 'default';
            if (this.canvas) {
                this.canvas.style.cursor = state.cameraMode ? 'grab' : 'default';
            }

            // Sync UiState for Ghost Phantom
            const uiState = state.uiState;
            if (this.phantomHero) {
                if (uiState.mode === 'SELECT_MOVE_TARGET' && uiState.pendingMoveCoords) {
                    this.phantomHero.visible = true;
                    const pos = hexToPixel(uiState.pendingMoveCoords.x, uiState.pendingMoveCoords.y);
                    this.phantomHero.x = pos.x;
                    this.phantomHero.y = pos.y;
                } else {
                    this.phantomHero.visible = false;
                }
            }
        };

        this.unsubscribeStore = useGameStore.subscribe(syncFromState);
        syncFromState(useGameStore.getState());
    }

    // ============================================================
    //  Entity display creation / sync
    //  每个实体 = Container(angle=朝向) → [selectionRing, body, dirArrow]
    //  方向箭头随 Container.angle 旋转，不随 body 重绘而丢失
    // ============================================================

    /** 子节点 name 常量，用于查找 */
    private static readonly BODY_NAME = 'body';
    private static readonly ARROW_NAME = 'arrow';
    private static readonly RING_NAME = 'ring';

    /**
     * 重绘 body 图形和方向箭头（仅在选中状态变化时调用）
     * Container.angle 由 update() 维护，此处不修改
     */
    private redrawEntityBody(container: Container, type: string, templateId: string, isSelected: boolean): void {
        const visual = assetManager.resolveEntityVisual(type as 'ACTOR' | 'PROP' | 'PROJECTILE', templateId);
        const halfSize = visual.geometry.size / 2;

        const fillColor = isSelected ? visual.geometry.selectedFill : visual.geometry.fill;
        const strokeColor = isSelected ? visual.geometry.selectedStroke : visual.geometry.stroke;
        const strokeWidth = isSelected ? visual.geometry.selectedStrokeWidth : visual.geometry.strokeWidth;

        // --- body ---
        let body = container.getChildByName(RendererManager.BODY_NAME) as Graphics | Sprite | null;
        if (!body) {
            body = new Graphics();
            body.label = RendererManager.BODY_NAME;
            container.addChild(body);
        }

        if (body instanceof Graphics) {
            body.clear();
            if (visual.geometry.shape === 'circle') {
                body.circle(0, 0, halfSize);
                body.fill(fillColor);
                body.stroke({ width: strokeWidth, color: strokeColor });
            } else if (visual.geometry.shape === 'rect') {
                body.rect(-halfSize, -halfSize, visual.geometry.size, visual.geometry.size);
                body.fill(fillColor);
                body.stroke({ width: strokeWidth, color: strokeColor });
            } else {
                body.poly([0, -halfSize, halfSize, 0, 0, halfSize, -halfSize, 0]);
                body.fill(fillColor);
                body.stroke({ width: strokeWidth, color: strokeColor });
            }
        }

        // --- 方向箭头（独立 Graphics，指向正右方 angle=0） ---
        let arrow = container.getChildByName(RendererManager.ARROW_NAME) as Graphics | null;
        if (!arrow) {
            arrow = new Graphics();
            arrow.label = RendererManager.ARROW_NAME;
            container.addChild(arrow);
        }

        arrow.clear();
        const arrowLen = halfSize * 1.1;
        const arrowW = halfSize * 0.45;
        // 实心三角箭头，从边缘向外突出
        arrow.poly([
            halfSize + 2, 0,                        // 尖端
            halfSize - arrowLen * 0.5, -arrowW,     // 上根
            halfSize - arrowLen * 0.7, 0,            // 内凹
            halfSize - arrowLen * 0.5, arrowW,       // 下根
        ]);
        arrow.fill({ color: 0xffcc00, alpha: 0.95 });
        arrow.stroke({ width: 1, color: 0x000000, alpha: 0.5 });

        // --- 选中环 ---
        let ring = container.getChildByName(RendererManager.RING_NAME) as Graphics | null;
        if (!ring) {
            ring = new Graphics();
            ring.label = RendererManager.RING_NAME;
            container.addChild(ring);
        }
        ring.clear();
        if (isSelected) {
            ring.circle(0, 0, halfSize + 5);
            ring.stroke({ width: 2.5, color: 0xfbbf24, alpha: 0.9 });
        }
    }

    /** 创建实体 Container（仅在实体首次出现时调用） */
    private createEntityDisplay(type: string, templateId: string, id: string, isSelected: boolean): Container {
        const container = new Container();
        container.eventMode = 'static';
        container.cursor = 'pointer';
        container.on('pointerdown', (e) => {
            e.stopPropagation();
            IntentDispatcher.selectEntityOrTarget(id);
            if (useGameStore.getState().centerOnEntity) {
                this.centerOnEntity(id);
            }
        });

        // 点击区域：透明大圆（比实体大，方便点击）
        const hitArea = new Graphics();
        hitArea.circle(0, 0, 30);
        hitArea.fill({ color: 0xffffff, alpha: 0.001 });
        hitArea.label = 'hitarea';
        container.addChild(hitArea);

        this.redrawEntityBody(container, type, templateId, isSelected);
        return container;
    }

    /** 仅在选中状态变化时调用 */
    private syncEntityDisplay(container: Container, type: string, templateId: string, isSelected: boolean): void {
        this.redrawEntityBody(container, type, templateId, isSelected);
    }

    /**
     * 将镜头中心移动到指定实体位置
     * 根据实体的六边形偏移坐标转换为像素坐标，计算使实体位于屏幕中心的 cameraX/Y
     */
    public centerOnEntity(entityId: string) {
        const state = useGameStore.getState();
        const entity = state.entities[entityId];
        if (!entity || !this.app) return;

        const pos = hexToPixel(entity.transform.coords.x, entity.transform.coords.y);
        const screenCenterX = this.app.screen.width / 2;
        const screenCenterY = this.app.screen.height / 2;

        this.cameraX = screenCenterX - pos.x * this.zoom;
        this.cameraY = screenCenterY - pos.y * this.zoom;
        this.cameraContainer.x = this.cameraX;
        this.cameraContainer.y = this.cameraY;
    }

    // ============================================================
    //  Update loop (interpolation)
    // ============================================================

    private update(dt: number) {
        const state = useGameStore.getState();
        const entities = state.entities;
        const movementTargets = state.movementTargets;

        // transform.coords 统一为偏移坐标，直接使用 hexToPixel
        this.renderStore.interpolateAll(entities, movementTargets, dt, hexToPixel);

        // 探索模式：根据当前视角实体的 FOV 过滤实体可见性
        const exploreState = useExploreStore.getState();
        const exploreMode = exploreState.exploreMode;
        const viewingEntityId = exploreState.viewingEntityId;
        const entityHexVis = exploreState.entityHexVisibility;
        const isGM = state.permission.role === 'GM';
        const visibleHexKeys: Set<string> | null = (exploreMode && viewingEntityId)
            ? new Set(entityHexVis[viewingEntityId] ?? [])
            : null;
        // GM 模式下不可见实体的透明度（仍然清晰可见，仅示意）
        const gmLimitedAlpha = 0.55;

        // 从 renderStore 读取插值结果应用到 sprite
        for (const [id, container] of this.entitySprites) {
            const renderState = this.renderStore.getRenderState(id);
            if (!renderState) continue;

            if (!renderState.visible) {
                container.visible = false;
                continue;
            }
            container.visible = true;
            container.x = renderState.x;
            container.y = renderState.y;
            container.angle = renderState.angle;
            container.alpha = renderState.alpha;

            // 探索模式 FOV 实体可见性
            if (visibleHexKeys && id !== viewingEntityId) {
                const entity = entities[id];
                if (entity) {
                    const col = entity.transform.coords.x;
                    const row = entity.transform.coords.y;
                    const q = Math.round(col);
                    const r = Math.round(row - Math.floor(col / 2));
                    const key = `${q},${r}`;
                    if (!visibleHexKeys.has(key)) {
                        container.alpha = isGM ? gmLimitedAlpha : 0.2;
                    }
                }
            }
        }

        // Phantom pulse
        if (this.phantomHero && this.phantomHero.visible) {
            this.phantomHero.alpha = 0.4 + Math.sin(Date.now() / 200) * 0.2;
            this.phantomHero.rotation += 0.05 * dt;
        }

        // Floating text lifecycle
        for (let i = this.activeFloatingTexts.length - 1; i >= 0; i--) {
            const fx = this.activeFloatingTexts[i];
            fx.life -= dt * (1000 / 60);
            fx.sprite.y -= fx.velY * dt;
            fx.sprite.alpha = fx.life / fx.maxLife;

            if (fx.life <= 0) {
                this.fxLayer.removeChild(fx.sprite);
                fx.sprite.destroy();
                this.activeFloatingTexts.splice(i, 1);
            }
        }
    }

    // ============================================================
    //  Visual FX
    // ============================================================

    public handleVisualFx(payload: VisualEventPayload) {
        if (!this.app) return;
        payload.events.forEach(evt => {
            const fxVisual = assetManager.resolveVisualFx(evt.fxTemplateId);

            if (evt.eventType === 'MUTUAL_KILL') {
                let startX = 0;
                let startY = 0;
                if (evt.sourceId) {
                    const sourceSprite = this.entitySprites.get(evt.sourceId);
                    if (sourceSprite) {
                        startX = sourceSprite.x;
                        startY = sourceSprite.y;
                    }
                }
                this.spawnFloatingText(
                    evt.text || '⚔️ Clash!',
                    startX,
                    startY - 30,
                    evt.durationMs || 2000,
                    fxVisual.floatingTextColor
                );
                this.spawnFlash(fxVisual.flashColor, 0.1, 200);
                return;
            }

            if (evt.eventType === 'INTERRUPTED') {
                let startX = 0;
                let startY = 0;
                if (evt.sourceId) {
                    const sourceSprite = this.entitySprites.get(evt.sourceId);
                    if (sourceSprite) {
                        startX = sourceSprite.x;
                        startY = sourceSprite.y;
                    }
                }
                this.spawnFloatingText(
                    evt.text || '💥 INTERRUPTED!',
                    startX,
                    startY - 30,
                    1500,
                    0xcc44ff
                );
                this.spawnFlash(0xcc33ff, 0.08, 150);
                return;
            }

            if (evt.eventType === 'UI_FLOATING_TEXT' && evt.text) {
                let startX = 0;
                let startY = 0;
                if (evt.targetId) {
                    const ts = this.entitySprites.get(evt.targetId);
                    if (ts) {
                        startX = ts.x;
                        startY = ts.y - 20;
                    }
                } else if (evt.targetCoords) {
                    startX = evt.targetCoords.x;
                    startY = evt.targetCoords.y;
                }
                const color = fxVisual.floatingTextColor;
                this.spawnFloatingText(evt.text, startX, startY, evt.durationMs || 1000, color);
            }
        });
    }

    private spawnFlash(color: number, alpha: number, duration: number) {
        const flash = new Graphics();
        flash.rect(0, 0, window.innerWidth, window.innerHeight);
        flash.fill({ color, alpha });
        this.fxLayer.addChild(flash);
        const timer = setTimeout(() => {
            this.fxTimers.delete(timer);
            if (!flash.destroyed) flash.destroy();
        }, duration);
        this.fxTimers.add(timer);
    }

    private spawnFloatingText(text: string, x: number, y: number, duration: number, color: number) {
        const textSprite = new Text({
            text,
            style: new TextStyle({
                fontFamily: 'Arial',
                fontSize: 24,
                fill: color,
                stroke: { color: 0x000000, width: 4 },
            }),
        });
        textSprite.anchor.set(0.5);
        textSprite.position.set(x, y);
        this.fxLayer.addChild(textSprite);
        this.activeFloatingTexts.push({
            sprite: textSprite,
            life: duration,
            maxLife: duration,
            velY: 2,
        });
    }

    public destroy() {
        this.initializationId += 1;
        this.initializing = false;
        for (const timer of this.fxTimers) clearTimeout(timer);
        this.fxTimers.clear();
        if (this.domAbort) {
            this.domAbort.abort();
            this.domAbort = null;
        }
        if (this.unsubscribeStore) {
            this.unsubscribeStore();
            this.unsubscribeStore = null;
        }
        if (this.unsubscribeFow) {
            this.unsubscribeFow();
            this.unsubscribeFow = null;
        }
        if (this.app) {
            try {
                this.app.destroy({ removeView: true }, true);
            } catch (e) {
                console.warn('[Renderer] Destroy error (often expected in StrictMode):', e);
            }
            this.app = null;
        }
        this.entitySprites.clear();
        this.lastSelectedState.clear();
        this.activeFloatingTexts = [];
        this.renderStore.clear();
        this.fowGraphics = null;
        this.phantomHero = null;
        this.canvas = null;
        if (!this.cameraContainer.destroyed) this.cameraContainer.destroy({ children: true });
        this.cameraContainer = new Container();
        this.groundLayer = new Container();
        this.gridLayer = new Container();
        this.objectLayer = new Container();
        this.tokenLayer = new Container();
        this.gmLayer = new Container();
        this.fowLayer = new Container();
        this.previewLayer = new Container();
        this.fxLayer = new Container();
        this.lightingLayer = new Container();
        this.mapLayer = this.groundLayer;
        this.entityLayer = this.tokenLayer;
        this.cameraX = 0;
        this.cameraY = 0;
        this.zoom = 1;
        this.isPointerDown = false;
    }
}
