import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { useGameStore } from '../store/gameStore';
import type { VisualEventPayload } from '@hard-vtt/shared';

interface FloatingTextAnim {
    sprite: Text;
    life: number;
    maxLife: number;
    velY: number;
}

export class RendererManager {
    private static instance: RendererManager;
    private app: Application | null = null;
    
    // Layers
    public mapLayer = new Container();
    public entityLayer = new Container();
    public fxLayer = new Container();
    public previewLayer = new Container(); // For phantoms and indicators

    // References to sprites
    private entitySprites: Map<string, Graphics> = new Map();
    private activeFloatingTexts: FloatingTextAnim[] = [];
    private phantomHero: Graphics | null = null;

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

        this.app = new Application();
        await this.app.init({
            canvas: viewConfig.canvas,
            width: viewConfig.width,
            height: viewConfig.height,
            backgroundColor: 0x1a1a1a,
            resolution: window.devicePixelRatio || 1,
            autoDensity: true,
            resizeTo: window
        });

        // Add layers
        this.app.stage.addChild(this.mapLayer);
        this.app.stage.addChild(this.entityLayer);
        this.app.stage.addChild(this.previewLayer);
        this.app.stage.addChild(this.fxLayer);

        // Make map layer interactive for moving
        this.mapLayer.eventMode = 'static';
        this.mapLayer.on('pointerdown', (e) => {
            const state = useGameStore.getState();
            
            if (state.uiState.mode === 'SELECT_MOVE_TARGET') {
                const targetPos = this.mapLayer.toLocal(e.global);
                // Sets pending coordinate when clicking in map rather than dispatching right away
                state.setPendingMoveCoords({ x: targetPos.x, y: targetPos.y, z: 0 });
            } else {
                state.setSelectedEntityId(null);
            }
        });

        // Initialize phantom
        this.phantomHero = new Graphics();
        this.phantomHero.circle(0, 0, 20);
        this.phantomHero.stroke({ width: 2, color: 0x3498db });
        // facing indicator
        this.phantomHero.moveTo(0, 0);
        this.phantomHero.lineTo(20, 0);
        this.phantomHero.alpha = 0.5;
        this.phantomHero.visible = false; // hidden initially
        this.previewLayer.addChild(this.phantomHero);

        // Map layer temp grid
        this.drawGrid();

        this.subscribeToStore();

        // Optional custom ticker to handle interpolation later
        this.app.ticker.add(() => {
            this.update(this.app!.ticker.deltaTime);
        });
    }

    private drawGrid() {
        const graphics = new Graphics();
        
        // 使用一个足够大的尺寸以覆盖高分辨率屏幕，且为未来的相机缩放/平移预留空间
        const gridSize = 10000;
        
        // 也可以画一个半透明的底图充当 hitArea 确保没有线条的地方也能响应 mapLayer pointerdown
        graphics.rect(0, 0, gridSize, gridSize);
        graphics.fill({ color: 0x000000, alpha: 0.001 });

        for (let i = 0; i < gridSize; i += 50) {
            graphics.moveTo(i, 0).lineTo(i, gridSize);
            graphics.moveTo(0, i).lineTo(gridSize, i);
        }
        
        graphics.stroke({ width: 1, color: 0x333333 });
        this.mapLayer.addChild(graphics);
    }

    private subscribeToStore() {
        if (this.unsubscribeStore) this.unsubscribeStore();

        this.unsubscribeStore = useGameStore.subscribe((state) => {
            // Check entities bounds / diffing manually since 
            // Zustand is reactive but Pixi is imperative
            const currentEntities = state.entities;
            
            // Sync entity removal
            for (const [id, sprite] of this.entitySprites) {
                if (!currentEntities[id]) {
                    this.entityLayer.removeChild(sprite);
                    sprite.destroy();
                    this.entitySprites.delete(id);
                }
            }

            // Sync entity creation and updates
            for (const [id, entity] of Object.entries(currentEntities)) {
                let sprite = this.entitySprites.get(id);

                if (!sprite) {
                    sprite = this.createPlaceholderEntity(entity.type, id);
                    // Initial snap for new entities
                    sprite.x = entity.transform.coords.x;
                    sprite.y = entity.transform.coords.y;
                    sprite.angle = entity.transform.facing;
                    
                    this.entitySprites.set(id, sprite);
                    this.entityLayer.addChild(sprite);
                }

                if (sprite instanceof Graphics) {
                    this.redrawEntitySprite(sprite, entity.type, state.selectedEntityId === id);
                }
            }

            // Sync UiState for Ghost Phantom
            const uiState = state.uiState;
            if (this.phantomHero) {
                if (uiState.mode === 'SELECT_MOVE_TARGET' && uiState.pendingMoveCoords) {
                    this.phantomHero.visible = true;
                    this.phantomHero.x = uiState.pendingMoveCoords.x;
                    this.phantomHero.y = uiState.pendingMoveCoords.y;
                } else {
                    this.phantomHero.visible = false;
                }
            }
        });
    }

    private redrawEntitySprite(graphics: Graphics, type: string, isSelected: boolean) {
        graphics.clear();

        if (type === 'ACTOR') {
            graphics.circle(0, 0, 20);
            graphics.fill(isSelected ? 0xf4c542 : 0x3498db);
            graphics.moveTo(0, 0);
            graphics.lineTo(20, 0);
            graphics.stroke({ width: isSelected ? 4 : 2, color: isSelected ? 0xf4c542 : 0xffffff });
        } else if (type === 'PROP') {
            graphics.rect(-15, -15, 30, 30);
            graphics.fill(isSelected ? 0xf4c542 : 0x95a5a6);
            graphics.stroke({ width: isSelected ? 4 : 2, color: isSelected ? 0xf4c542 : 0xffffff });
        } else {
            graphics.circle(0, 0, 5);
            graphics.fill(isSelected ? 0xf4c542 : 0xe74c3c);
        }
    }

    private createPlaceholderEntity(type: string, id: string): Graphics {
        const g = new Graphics();
        this.redrawEntitySprite(g, type, false);

        // Enable interaction with entities
        g.eventMode = 'static';
        g.cursor = 'pointer';
        g.on('pointerdown', (e) => {
            e.stopPropagation(); // 阻止事件冒泡到地图导致错误寻路

            useGameStore.getState().setSelectedEntityId(id);
        });

        return g;
    }

    private update(dt: number) {
        const state = useGameStore.getState();
        const entities = state.entities;
        const movementTargets = state.movementTargets;
        
        const LERP_FACTOR = 0.2; 
        const adjustedLerp = 1 - Math.pow(1 - LERP_FACTOR, dt);
        
        // 容差阈值：超过此值则权威纠偏
        const TOLERANCE = 0.3;

        for (const [id, sprite] of this.entitySprites) {
            const entity = entities[id];
            if (!entity) continue;

            const serverX = entity.transform.coords.x;
            const serverY = entity.transform.coords.y;
            const localTarget = movementTargets[id];

            if (localTarget) {
                // === Dead Reckoning: 本地盲区推测 ===
                // 直接向本地存储的目标点平滑补间（不等服务器）
                const dx = localTarget.x - sprite.x;
                const dy = localTarget.y - sprite.y;
                const localDist = Math.sqrt(dx * dx + dy * dy);

                if (localDist < 0.05) {
                    // 已到达本地目标
                    sprite.x = localTarget.x;
                    sprite.y = localTarget.y;
                    state.clearMovementTarget(id);
                } else {
                    // 平滑动画朝向本地目标
                    sprite.x += dx * adjustedLerp;
                    sprite.y += dy * adjustedLerp;

                    // === 容差纠正 (Tolerance Correction) ===
                    // 计算本地渲染位置与服务器权威位置的偏差
                    const serverDist = Math.sqrt(
                        (serverX - sprite.x) ** 2 + (serverY - sprite.y) ** 2
                    );

                    if (serverDist > TOLERANCE) {
                        // 偏差过大 → 强制纠偏（被击退/打断/定身等）
                        sprite.x = serverX;
                        sprite.y = serverY;
                        state.clearMovementTarget(id);
                    }
                }
            } else {
                // === 无本地目标，跟随服务器坐标 ===
                const targetX = serverX;
                const targetY = serverY;
                
                sprite.x += (targetX - sprite.x) * adjustedLerp;
                sprite.y += (targetY - sprite.y) * adjustedLerp;
            }

            // 角度朝向插值
            const targetFacing = entity.transform.facing;
            let diff = targetFacing - sprite.angle;
            while (diff < -180) diff += 360;
            while (diff > 180) diff -= 360;
            sprite.angle += diff * adjustedLerp;
        }

        // Phantom Pulse effect
        if (this.phantomHero && this.phantomHero.visible) {
            this.phantomHero.alpha = 0.4 + Math.sin(Date.now() / 200) * 0.2;
            this.phantomHero.rotation += 0.05 * dt;
        }

        // 浮动文字特效更新
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

    public handleVisualFx(payload: VisualEventPayload) {
        payload.events.forEach(evt => {
            if (evt.eventType === 'UI_FLOATING_TEXT' && evt.text) {
                let startX = 0;
                let startY = 0;

                if (evt.targetId) {
                    const ts = this.entitySprites.get(evt.targetId);
                    if (ts) {
                        startX = ts.x;
                        startY = ts.y - 20; // 偏上一点
                    }
                } else if (evt.targetCoords) {
                    startX = evt.targetCoords.x;
                    startY = evt.targetCoords.y;
                }

                // If floating text starts with '+' or is 'heal' we color it green, else red
                const isHeal = evt.text.startsWith('+') || evt.fxTemplateId === 'heal';
                const color = isHeal ? 0x44ff44 : 0xff4444;

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
                stroke: { color: 0x000000, width: 4 }
            })
        });

        textSprite.anchor.set(0.5);
        textSprite.position.set(x, y);

        this.fxLayer.addChild(textSprite);

        this.activeFloatingTexts.push({
            sprite: textSprite,
            life: duration,
            maxLife: duration,
            velY: 2 
        });
    }

    public destroy() {
        if (this.unsubscribeStore) {
            this.unsubscribeStore();
            this.unsubscribeStore = null;
        }
        if (this.app) {
            // Fix PixiJS double invocation issues in React StrictMode
            try {
                this.app.destroy({ removeView: true }, true);
            } catch(e) {
                console.warn("[Renderer] Destroy error (often expected in StrictMode):", e);
            }
            this.app = null;
        }
        this.entitySprites.clear();
        this.mapLayer.removeChildren();
        this.entityLayer.removeChildren();
        this.fxLayer.removeChildren();
    }
}
