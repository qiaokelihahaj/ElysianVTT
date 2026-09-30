/** Demo composition root. The production implementation lives outside demo/. */
import {
  EncounterServerImpl,
  type EncounterServerOptions,
} from '../network/EncounterServer.js';
import { DemoPersistence, type DemoPersistenceOptions } from './DemoPersistence.js';
import { createDemoContent, createDemoRoster } from './DemoContent.js';
import { createSpatialTacticsContent, createSpatialTacticsRoster } from './SpatialTacticsContent.js';
import { resolve } from 'node:path';

export {
  filterEncounterSnapshot as filterDemoSnapshot,
  type EncounterCoordinatorPort as DemoCoordinator,
  type EncounterCoordinatorFactoryOptions as DemoCoordinatorFactoryOptions,
  type EncounterServerListenResult as DemoServerListenResult,
  type EncounterServerHandle as DemoServerHandle,
} from '../network/EncounterServer.js';

export interface DemoServerOptions extends Omit<EncounterServerOptions, 'content' | 'entities' | 'persistence'>, DemoPersistenceOptions {
  scenario?: 'classic' | 'tactics';
}

export class DemoServerImpl extends EncounterServerImpl {
  constructor(options: DemoServerOptions = {}) {
    const tactics = options.scenario === 'tactics';
    const persistence = new DemoPersistence({
      ...options,
      ...(tactics && !options.dataDirectory && !options.databasePath ? { dataDirectory: resolve(process.cwd(), '.demo-tactics') } : {}),
    });
    try {
      super({
        ...options,
        encounterId: options.encounterId ?? (tactics ? 'elysian-spatial-tactics' : 'elysian-demo'),
        host: options.host ?? '0.0.0.0',
        content: tactics ? createSpatialTacticsContent() : createDemoContent(),
        entities: tactics ? createSpatialTacticsRoster() : createDemoRoster(),
        persistence,
      });
    } catch (error) {
      persistence.close();
      throw error;
    }
  }
}

export async function createDemoServer(options: DemoServerOptions = {}): Promise<DemoServerImpl> {
  return new DemoServerImpl(options);
}
