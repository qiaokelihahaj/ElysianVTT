import { Assets } from 'pixi.js';
import {
    ENTITY_VISUAL_DEFINITIONS,
    getEntityVisualDefinition,
    getVisualFxDefinition,
    VISUAL_FX_DEFINITIONS,
    type EntityVisualDefinition,
    type VisualFxDefinition,
} from './assetCatalog';

class AssetManager {
    private preloadTask: Promise<void> | null = null;

    public async preload() {
        if (!this.preloadTask) {
            this.preloadTask = this.loadInitialAssets();
        }

        return this.preloadTask;
    }

    public resolveEntityVisual(entityType: EntityVisualDefinition['entityTypes'][number], templateId?: string) {
        return getEntityVisualDefinition(entityType, templateId);
    }

    public resolveVisualFx(templateId?: string): VisualFxDefinition {
        return getVisualFxDefinition(templateId);
    }

    private async loadInitialAssets() {
        const assetUrls = [
            ...ENTITY_VISUAL_DEFINITIONS.map((definition) => definition.imageUrl),
            ...VISUAL_FX_DEFINITIONS.map((definition) => definition.imageUrl),
        ].filter((url): url is string => Boolean(url));

        if (assetUrls.length === 0) {
            return;
        }

        await Assets.load(assetUrls);
    }
}

export const assetManager = new AssetManager();