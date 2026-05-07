import { Application, Container, Graphics, Rectangle, Sprite, Text, TextStyle } from 'pixi.js';
import { assetManager } from '../assets';
import { useGameStore } from '../store/gameStore';
import type { VisualEventPayload } from '@hard-vtt/shared';

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
    const x = size * 1.5 * col;
    // Type 1 偏移半个六边形高度
    const yOffset = (col & 1) * (size * Math.sqrt(3) * 0.5);
    const y = size * Math.sqrt(3) * row + yOffset;
    return { x, y };
}

/** 像素 → 分数轴向坐标（cube round 前） */
function pixelToFractionalAxial(px: number, py: number, size = HEX_SIZE): { q: number; r: number; s: number } {
    const q = (2 / 3 * px) / size;
    const r = (-1 / 3 * px + Math.sqrt(3) / 3 * py) / size;
    return { q, r, s: -q - r };
}

/** Cube round：分数 cube → 最近整数 cube */
function cubeRound(q: number, r: number, s: number): { q: number; r: number; s: number } {
    let rq = Math.round(q);
    let rr = Math.round(r);
    let rs = Math.round(s);
    const dq = Math.abs(rq - q);
    const dr = Math.abs(rr - r);
    const ds = Math.abs(rs - s);
    if (dq > dr && dq > ds) rq = -rr - rs;
    else if (dr > ds) rr = -rq - rs;
    else rs = -rq - rr;
    return { q: rq, r: rr, s: rs };
}

/** 像素 → 最近六边形偏移坐标 (col, row) */
function pixelToHex(px: number, py: number, size = HEX_SIZE): { col: number; row: number } {
    const frac = pixelToFractionalAxial(px, py, size);
    const rounded = cubeRound(frac.q, frac.r, frac.s);
    // 轴向 (q, r) → 偏移 (col, row)：
    // 偏移系统对奇数列有垂直偏移（Type 1），所以 row 需要修正
    // 公式：col = q, row = r + floor(q / 2)
    return { col: rounded.q, row: rounded.r + Math.floor(rounded.q / 2) };
}

/** 获取 flat-top 六边形 6 个角相对中心的偏移（角度步长 60°） */
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

    private entitySprites: Map<string, Graphics | Sprite> = new Map();
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

    private readonly DISPLAY_SCALE = HEX_SIZE;

    private unsubscribeStore: (() => void) | null = null;

    private constructor() {}

    public static getInstance() {
        if (!RendererManager.instance) {
            RendererManager.instance = new RendererManager();
        }
        return RendererManager.instance;
    }

    public async initialize(viewConfig: { canvas: HTMLCanvasElement; width: number; height: number }) {
        if (this.app) return;

        await assetManager.preload();

        this.app = new Application();
        await this.app.init({
            canvas: viewConfig.canvas,
            width: viewConfig.width,
            height: viewConfig.height,
            backgroundColor: 0x1a1a1a,
            resolution: window.devicePixelRatio || 1,
            autoDensity: true,
            resizeTo: window,
        });
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
            } else {
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

        this.app.ticker.add(() => {
            this.update(this.app!.ticker.deltaTime);
        });
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
    //  Entity synchronisation
    // ============================================================

    private subscribeToStore() {
        if (this.unsubscribeStore) this.unsubscribeStore();

        const syncFromState = (state: ReturnType<typeof useGameStore.getState>) => {
            const currentEntities = state.entities;

            // Sync entity removal
            for (const [id, sprite] of this.entitySprites) {
                if (!currentEntities[id]) {
                    this.tokenLayer.removeChild(sprite);
                    sprite.destroy();
                    this.entitySprites.delete(id);
                }
            }

            // Sync entity creation and updates
            for (const [id, entity] of Object.entries(currentEntities)) {
                let sprite = this.entitySprites.get(id);
                const isSelected = state.selectedEntityId === id;

                if (!sprite) {
                    sprite = this.createEntityDisplay(entity.type, entity.templateId, id, isSelected);
                    const pos = hexToPixel(entity.transform.coords.x, entity.transform.coords.y);
                    sprite.x = pos.x;
                    sprite.y = pos.y;
                    sprite.angle = entity.transform.facing;

                    this.entitySprites.set(id, sprite);
                    this.tokenLayer.addChild(sprite);
                }

                this.syncEntityDisplay(sprite, entity.type, entity.templateId, isSelected);
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
    // ============================================================

    private redrawEntitySprite(graphics: Graphics, type: string, templateId: string, isSelected: boolean) {
        const visual = assetManager.resolveEntityVisual(type as 'ACTOR' | 'PROP' | 'PROJECTILE', templateId);
        graphics.clear();

        const fillColor = isSelected ? visual.geometry.selectedFill : visual.geometry.fill;
        const strokeColor = isSelected ? visual.geometry.selectedStroke : visual.geometry.stroke;
        const strokeWidth = isSelected ? visual.geometry.selectedStrokeWidth : visual.geometry.strokeWidth;

        if (visual.geometry.shape === 'circle') {
            graphics.circle(0, 0, visual.geometry.size / 2);
            graphics.fill(fillColor);
            graphics.moveTo(0, 0);
            graphics.lineTo(visual.geometry.size / 2, 0);
            graphics.stroke({ width: strokeWidth, color: strokeColor });
        } else if (visual.geometry.shape === 'rect') {
            graphics.rect(-visual.geometry.size / 2, -visual.geometry.size / 2, visual.geometry.size, visual.geometry.size);
            graphics.fill(fillColor);
            graphics.stroke({ width: strokeWidth, color: strokeColor });
        } else {
            const halfSize = visual.geometry.size / 2;
            graphics.poly([0, -halfSize, halfSize, 0, 0, halfSize, -halfSize, 0]);
            graphics.fill(fillColor);
            graphics.stroke({ width: strokeWidth, color: strokeColor });
        }
    }

    private createEntityDisplay(type: string, templateId: string, id: string, isSelected: boolean): Graphics | Sprite {
        const visual = assetManager.resolveEntityVisual(type as 'ACTOR' | 'PROP' | 'PROJECTILE', templateId);

        if (visual.imageUrl) {
            const sprite = Sprite.from(visual.imageUrl);
            sprite.anchor.set(0.5);
            this.attachEntityInteraction(sprite, id);
            this.syncEntitySpriteAppearance(sprite, visual, isSelected);
            return sprite;
        }

        const graphics = new Graphics();
        this.redrawEntitySprite(graphics, type, templateId, isSelected);
        this.attachEntityInteraction(graphics, id);
        return graphics;
    }

    private syncEntityDisplay(sprite: Graphics | Sprite, type: string, templateId: string, isSelected: boolean) {
        if (sprite instanceof Sprite) {
            const visual = assetManager.resolveEntityVisual(type as 'ACTOR' | 'PROP' | 'PROJECTILE', templateId);
            this.syncEntitySpriteAppearance(sprite, visual, isSelected);
            return;
        }
        this.redrawEntitySprite(sprite, type, templateId, isSelected);
    }

    private syncEntitySpriteAppearance(
        sprite: Sprite,
        visual: ReturnType<typeof assetManager.resolveEntityVisual>,
        isSelected: boolean
    ) {
        sprite.tint = isSelected ? visual.geometry.selectedFill : visual.geometry.fill;
        sprite.width = visual.geometry.size;
        sprite.height = visual.geometry.size;
        sprite.scale.set(isSelected ? 1.08 : 1);
    }

    private attachEntityInteraction(target: Graphics | Sprite, id: string) {
        target.eventMode = 'static';
        target.cursor = 'pointer';
        target.on('pointerdown', (e) => {
            e.stopPropagation();
            useGameStore.getState().setSelectedEntityId(id);
            if (useGameStore.getState().centerOnEntity) {
                this.centerOnEntity(id);
            }
        });
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

        const LERP_FACTOR = 0.2;
        const adjustedLerp = 1 - Math.pow(1 - LERP_FACTOR, dt);
        const TOLERANCE = this.DISPLAY_SCALE * 0.3;

        for (const [id, sprite] of this.entitySprites) {
            const entity = entities[id];
            if (!entity) continue;

            // Convert authoritative hex coords to pixel position
            const serverPos = hexToPixel(entity.transform.coords.x, entity.transform.coords.y);
            const serverX = serverPos.x;
            const serverY = serverPos.y;
            const localTarget = movementTargets[id];

            if (localTarget) {
                const targetPos = hexToPixel(localTarget.x, localTarget.y);
                const targetX = targetPos.x;
                const targetY = targetPos.y;
                const dx = targetX - sprite.x;
                const dy = targetY - sprite.y;
                const localDist = Math.sqrt(dx * dx + dy * dy);

                if (localDist < 1) {
                    sprite.x = targetX;
                    sprite.y = targetY;
                    state.clearMovementTarget(id);
                } else {
                    sprite.x += dx * adjustedLerp;
                    sprite.y += dy * adjustedLerp;

                    const serverDist = Math.sqrt(
                        (serverX - sprite.x) ** 2 + (serverY - sprite.y) ** 2
                    );

                    if (serverDist > TOLERANCE) {
                        sprite.x = serverX;
                        sprite.y = serverY;
                        state.clearMovementTarget(id);
                    }
                }
            } else {
                sprite.x += (serverX - sprite.x) * adjustedLerp;
                sprite.y += (serverY - sprite.y) * adjustedLerp;
            }

            const targetFacing = entity.transform.facing;
            let diff = targetFacing - sprite.angle;
            while (diff < -180) diff += 360;
            while (diff > 180) diff -= 360;
            sprite.angle += diff * adjustedLerp;
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
                const flash = new Graphics();
                flash.rect(0, 0, window.innerWidth, window.innerHeight);
                flash.fill({ color: fxVisual.flashColor, alpha: 0.1 });
                this.fxLayer.addChild(flash);
                setTimeout(() => {
                    this.fxLayer.removeChild(flash);
                    flash.destroy();
                }, 200);
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
                const flash = new Graphics();
                flash.rect(0, 0, window.innerWidth, window.innerHeight);
                flash.fill({ color: 0xcc33ff, alpha: 0.08 });
                this.fxLayer.addChild(flash);
                setTimeout(() => {
                    this.fxLayer.removeChild(flash);
                    flash.destroy();
                }, 150);
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
        if (this.domAbort) {
            this.domAbort.abort();
            this.domAbort = null;
        }
        if (this.unsubscribeStore) {
            this.unsubscribeStore();
            this.unsubscribeStore = null;
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
        for (const layer of [
            this.groundLayer, this.gridLayer, this.objectLayer,
            this.tokenLayer, this.gmLayer, this.fowLayer, this.previewLayer,
            this.fxLayer, this.lightingLayer,
        ]) {
            layer.removeChildren();
        }
    }
}
