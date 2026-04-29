import { Application, Container, Sprite, Graphics } from 'pixi.js';
import { useGameStore } from '../store/gameStore';

export class RendererManager {
    private static instance: RendererManager;
    private app: Application | null = null;
    
    // Layers
    public mapLayer = new Container();
    public entityLayer = new Container();
    public fxLayer = new Container();

    // References to sprites
    private entitySprites: Map<string, Graphics | Sprite> = new Map();

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
        this.app.stage.addChild(this.fxLayer);

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
        
        for (let i = 0; i < 2000; i += 50) {
            graphics.moveTo(i, 0).lineTo(i, 2000);
            graphics.moveTo(0, i).lineTo(2000, i);
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
                    sprite = this.createPlaceholderEntity(entity.type);
                    // Initial snap for new entities
                    sprite.x = entity.transform.coords.x;
                    sprite.y = entity.transform.coords.y;
                    sprite.angle = entity.transform.facing;
                    
                    this.entitySprites.set(id, sprite);
                    this.entityLayer.addChild(sprite);
                }
            }
        });
    }

    private createPlaceholderEntity(type: string): Graphics {
        const g = new Graphics();
        if (type === 'ACTOR') {
            g.circle(0, 0, 20);
            g.fill(0x3498db); // Blue actor
            // facing indicator
            g.moveTo(0, 0);
            g.lineTo(20, 0);
            g.stroke({ width: 2, color: 0xffffff });
        } else if (type === 'PROP') {
            g.rect(-15, -15, 30, 30);
            g.fill(0x95a5a6); // Gray prop
        } else {
            g.circle(0, 0, 5);
            g.fill(0xe74c3c); // Red projectile
        }
        return g;
    }

    private update(dt: number) {
        const state = useGameStore.getState();
        const entities = state.entities;
        
        // 设定的平滑系数，值越近平滑程度越低 (1 = 瞬间到达, 0.1 = 平滑补间)
        // 结合 deltaTime (dt) 使补间在不同帧率下尽可能一致
        const LERP_FACTOR = 0.2; 
        const adjustedLerp = 1 - Math.pow(1 - LERP_FACTOR, dt);
        
        for (const [id, sprite] of this.entitySprites) {
            const entity = entities[id];
            if (entity) {
                // 1. 位置线性插值 (Linear Interpolation)
                const targetX = entity.transform.coords.x;
                const targetY = entity.transform.coords.y;
                
                sprite.x += (targetX - sprite.x) * adjustedLerp;
                sprite.y += (targetY - sprite.y) * adjustedLerp;
                
                // 2. 角度朝向插值 (Shortest path rotation in degrees)
                const targetFacing = entity.transform.facing;
                let diff = targetFacing - sprite.angle;
                
                // 归一化差值到 [-180, 180] 之间，确保走最短弧线
                while (diff < -180) diff += 360;
                while (diff > 180) diff -= 360;
                
                sprite.angle += diff * adjustedLerp;
            }
        }
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
