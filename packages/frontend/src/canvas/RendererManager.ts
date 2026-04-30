import { Application, Container, Graphics, Sprite, Text, TextStyle } from 'pixi.js';
import { assetManager } from '../assets';
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
    private entitySprites: Map<string, Graphics | Sprite> = new Map();
    private activeFloatingTexts: FloatingTextAnim[] = [];
    private phantomHero: Graphics | null = null;

    private readonly DISPLAY_SCALE = 50;
    private readonly GRID_SPACING = 50;

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
            resizeTo: window
        });
        // Add layers
        this.app.stage.addChild(this.mapLayer);
        this.app.stage.addChild(this.entityLayer);
        this.app.stage.addChild(this.previewLayer);
        this.app.stage.addChild(this.fxLayer);

        this.mapLayer.eventMode = 'static';
        this.mapLayer.on('pointerdown', (e) => {
            const state = useGameStore.getState();

            if (state.uiState.mode === 'SELECT_MOVE_TARGET') {
                const targetPos = this.mapLayer.toLocal(e.global);
                state.setPendingMoveCoords({ 
                    x: Math.round(targetPos.x / this.DISPLAY_SCALE), 
                    y: Math.round(targetPos.y / this.DISPLAY_SCALE), 
                    z: 0 
                });
            } else {
                state.setSelectedEntityId(null);
            }
        });

        this.phantomHero = new Graphics();
        this.phantomHero.circle(0, 0, 20);
        this.phantomHero.stroke({ width: 2, color: 0x3498db });
        this.phantomHero.moveTo(0, 0);
        this.phantomHero.lineTo(20, 0);
        this.phantomHero.alpha = 0.5;
        this.phantomHero.visible = false;
        this.previewLayer.addChild(this.phantomHero);

        this.drawGrid();
        this.subscribeToStore();

        this.app.ticker.add(() => {
            this.update(this.app!.ticker.deltaTime);
        });
    }

    private drawGrid() {
        // Hit area (transparent, just for click detection)
        const hitArea = new Graphics();
        hitArea.rect(0, 0, 10000, 10000);
        hitArea.fill({ color: 0x000000, alpha: 0 });
        this.mapLayer.addChild(hitArea);

        // Grid lines (separate graphics to avoid fill/stroke conflict)
        const gridLines = new Graphics();
        for (let i = 0; i <= 5000; i += this.GRID_SPACING) {
            gridLines.moveTo(i, 0).lineTo(i, 5000);
            gridLines.moveTo(0, i).lineTo(5000, i);
        }
        gridLines.stroke({ width: 1, color: 0x2a2a2a });
        this.mapLayer.addChild(gridLines);
    }

    private subscribeToStore() {
        if (this.unsubscribeStore) this.unsubscribeStore();

        const syncFromState = (state: ReturnType<typeof useGameStore.getState>) => {
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
                const isSelected = state.selectedEntityId === id;

                if (!sprite) {
                    sprite = this.createEntityDisplay(entity.type, entity.templateId, id, isSelected);
                    sprite.x = entity.transform.coords.x * this.DISPLAY_SCALE;
                    sprite.y = entity.transform.coords.y * this.DISPLAY_SCALE;
                    sprite.angle = entity.transform.facing;
                    
                    this.entitySprites.set(id, sprite);
                    this.entityLayer.addChild(sprite);
                }

                this.syncEntityDisplay(sprite, entity.type, entity.templateId, isSelected);
            }

            // Sync UiState for Ghost Phantom
            const uiState = state.uiState;
            if (this.phantomHero) {
                if (uiState.mode === 'SELECT_MOVE_TARGET' && uiState.pendingMoveCoords) {
                    this.phantomHero.visible = true;
                    this.phantomHero.x = uiState.pendingMoveCoords.x * this.DISPLAY_SCALE;
                    this.phantomHero.y = uiState.pendingMoveCoords.y * this.DISPLAY_SCALE;
                } else {
                    this.phantomHero.visible = false;
                }
            }
        };

        this.unsubscribeStore = useGameStore.subscribe(syncFromState);

        // Immediately sync entities that were loaded before subscription
        syncFromState(useGameStore.getState());
    }

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
            sprite.eventMode = 'static';
            sprite.cursor = 'pointer';
            sprite.on('pointerdown', (e) => {
                e.stopPropagation();
                useGameStore.getState().setSelectedEntityId(id);
            });
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
        });

    }

    private update(dt: number) {
        const state = useGameStore.getState();
        const entities = state.entities;
        const movementTargets = state.movementTargets;
        
        const LERP_FACTOR = 0.2; 
        const adjustedLerp = 1 - Math.pow(1 - LERP_FACTOR, dt);
        
        // 容差阈值：超过此值则权威纠偏 (scaled to display)
        const TOLERANCE = this.DISPLAY_SCALE * 0.3;

        for (const [id, sprite] of this.entitySprites) {
            const entity = entities[id];
            if (!entity) continue;

            const serverX = entity.transform.coords.x * this.DISPLAY_SCALE;
            const serverY = entity.transform.coords.y * this.DISPLAY_SCALE;
            const localTarget = movementTargets[id];

            if (localTarget) {
                const targetX = localTarget.x * this.DISPLAY_SCALE;
                const targetY = localTarget.y * this.DISPLAY_SCALE;
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
            const fxVisual = assetManager.resolveVisualFx(evt.fxTemplateId);

            if (evt.eventType === 'MUTUAL_KILL') {
                // 相杀特效：在两个实体位置之间产生武器碰撞效果
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
                // 打断特效：紫色漂浮文字，屏幕边缘闪光
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
                    0xcc44ff  // 紫色
                );

                // 边缘震动闪光
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
                        startY = ts.y - 20; // 偏上一点
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
