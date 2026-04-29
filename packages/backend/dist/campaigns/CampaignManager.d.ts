import { Server } from 'socket.io';
import { CombatEngine } from './engines/CombatEngine.js';
export declare class CampaignManager {
    private engines;
    private io;
    constructor(io: Server);
    /**
     * 获取或创建一个场景的战斗引擎
     */
    getOrCreateEngine(sceneId: string): Promise<CombatEngine>;
    private createEngine;
    getEngine(sceneId: string): Promise<CombatEngine | undefined>;
}
//# sourceMappingURL=CampaignManager.d.ts.map