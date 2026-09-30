// packages/backend/src/db/RulePackLoader.ts
import type { RulePackDefs, AttributeDef, ResourceDef, PhaseDef, DefenseModel } from '@hard-vtt/shared';
import { prisma } from './prisma.js';
import { safeParseArray, safeParseRecord } from '../utils/SafeJsonParser.js';
import { Logger } from '../utils/Logger.js';

const logger = Logger.create('DB:RulePackLoader');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isAttributeDef(value: unknown): value is AttributeDef {
  return isRecord(value) && typeof value.key === 'string' && value.key.length > 0
    && typeof value.label === 'string' && finite(value.default)
    && (value.min === undefined || finite(value.min)) && (value.max === undefined || finite(value.max));
}

function isResourceDef(value: unknown): value is ResourceDef {
  return isAttributeDef(value) && isRecord(value) && finite(value.min)
    && (value.sustain === undefined || typeof value.sustain === 'boolean');
}

function isPhaseDef(value: unknown): value is PhaseDef {
  return isRecord(value) && typeof value.key === 'string' && ['DELAY', 'STARTUP', 'ACTIVE', 'RECOVERY'].includes(value.key)
    && typeof value.label === 'string' && typeof value.canInterrupt === 'boolean' && typeof value.canReact === 'boolean';
}

function parseDefinitions<T>(json: string, kind: string, rulePackId: string, validate: (value: unknown) => value is T): T[] {
  const values = safeParseArray<unknown>(json, [], `${kind} definitions of ${rulePackId}`);
  if (!values.every(validate)) throw new Error(`Invalid ${kind} definitions for RulePack '${rulePackId}'`);
  return values;
}

export class RulePackLoader {
  private static cache = new Map<string, RulePackDefs>();

  static async load(rulePackId: string): Promise<RulePackDefs | null> {
    // Check cache first
    if (this.cache.has(rulePackId)) {
      return this.cache.get(rulePackId)!;
    }

    // Load from DB
    const record = await prisma.rulePack.findUnique({ where: { id: rulePackId } });
    if (!record) {
      logger.warn(`RulePack '${rulePackId}' not found in DB`);
      return null;
    }

    const defenseModel: DefenseModel = safeParseRecord(record.defenseModelJson, {}, `defenseModel of ${rulePackId}`);
    if ([defenseModel.drFormula, defenseModel.parryFormula, defenseModel.dodgeFormula, defenseModel.interceptFormula]
      .some(formula => formula !== undefined && typeof formula !== 'string')) {
      throw new Error(`Invalid defense model for RulePack '${rulePackId}'`);
    }
    const defs: RulePackDefs = {
      id: record.id,
      name: record.name,
      description: record.description ?? undefined,
      attributeDefs: parseDefinitions(record.attributeDefsJson, 'attribute', rulePackId, isAttributeDef),
      resourceDefs: parseDefinitions(record.resourceDefsJson, 'resource', rulePackId, isResourceDef),
      phaseDefs: parseDefinitions(record.phaseDefsJson, 'phase', rulePackId, isPhaseDef),
      defenseModel,
    };

    this.cache.set(rulePackId, defs);
    logger.info(`RulePack '${rulePackId}' loaded (${defs.attributeDefs.length} attributes, ${defs.resourceDefs.length} resources)`);
    return defs;
  }

  static getCached(rulePackId: string): RulePackDefs | undefined {
    return this.cache.get(rulePackId);
  }

  static clearCache(): void {
    this.cache.clear();
  }

  static getResourceKeys(rulePackId: string): string[] | null {
    const pack = this.cache.get(rulePackId);
    if (!pack) return null;
    return pack.resourceDefs.map(r => r.key);
  }

  static getAttributeKeys(rulePackId: string): string[] | null {
    const pack = this.cache.get(rulePackId);
    if (!pack) return null;
    return pack.attributeDefs.map(a => a.key);
  }
}
