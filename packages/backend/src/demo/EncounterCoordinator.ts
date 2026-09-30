import { createDemoContent, createDemoRoster } from './DemoContent.js';
import {
  EncounterCoordinator as FormalEncounterCoordinator,
  type EncounterCoordinatorOptions as FormalEncounterCoordinatorOptions,
} from '../encounters/EncounterCoordinator.js';
import type { EncounterEntity, EncounterRulePack } from '@hard-vtt/shared';

export interface EncounterCoordinatorOptions
  extends Omit<FormalEncounterCoordinatorOptions, 'content' | 'rulePack' | 'entities'> {
  content?: EncounterRulePack;
  /** Alias retained for older HTTP/demo callers. */
  rulePack?: EncounterRulePack;
  entities?: EncounterEntity[];
}

/** Demo composition wrapper. The authoritative implementation lives in encounters/. */
export class EncounterCoordinator extends FormalEncounterCoordinator {
  public constructor(options: EncounterCoordinatorOptions = {}) {
    super({
      ...options,
      content: options.content ?? options.rulePack ?? createDemoContent(),
      entities: options.entities ?? options.initialSnapshot?.entities ?? createDemoRoster(),
    });
  }

  /** Compatibility factory retained for existing demo callers and tests. */
  public static createDemo(
    options: Omit<EncounterCoordinatorOptions, 'content' | 'rulePack' | 'entities'> = {},
  ): EncounterCoordinator {
    return new EncounterCoordinator({
      ...options,
      content: createDemoContent(),
      entities: createDemoRoster(),
    });
  }
}

export default EncounterCoordinator;
