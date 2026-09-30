import { useMemo, useState } from 'react';
import type {
  EncounterEntity,
  EncounterCommandType,
  EncounterRelation,
  EncounterSide,
  EncounterSnapshot,
  EncounterVictoryCondition,
} from '@hard-vtt/shared';
import {
  getEntityFaction,
  getEncounterRelation,
  getEncounterSide,
  isEncounterFaction,
} from '@hard-vtt/shared';
import type { DemoCatalog, DemoSelectedCell } from './types';
import { entityLabel, factionLabel } from './format';

export type FactionCommandSender = (type: EncounterCommandType, payload: Record<string, unknown>) => void;

export interface FactionControlsProps {
  snapshot: EncounterSnapshot;
  catalog: DemoCatalog | null;
  selectedEntityId: string | null;
  selectedCell?: DemoSelectedCell | null;
  onCommand: FactionCommandSender;
}

const INDEPENDENT_VALUE = '';

function sideKey(side: EncounterSide): string {
  return JSON.stringify(side);
}

function sideLabel(side: EncounterSide, entities: Map<string, EncounterEntity>): string {
  if (side.kind === 'FACTION') return factionLabel(side.id);
  const entity = entities.get(side.id);
  return `${entity ? entityLabel(entity) : side.id}（独立）`;
}

// Reset a draft only when its source changes, not on unrelated snapshot updates.
function useSourceDraft<T>(source: string, initialValue: T): [T, (value: T) => void] {
  const [draft, setDraft] = useState({ source, value: initialValue });
  if (draft.source !== source) setDraft({ source, value: initialValue });
  return [draft.source === source ? draft.value : initialValue, (value) => setDraft({ source, value })];
}

function relationLabel(relation: EncounterRelation | 'UNKNOWN'): string {
  switch (relation) {
    case 'ALLY': return '同盟';
    case 'NEUTRAL': return '中立';
    case 'HOSTILE': return '敌对';
    default: return '未设置';
  }
}

function factionOptions(snapshot: EncounterSnapshot): string[] {
  const values = new Set<string>(['PLAYERS', 'ENEMIES']);
  for (const entity of snapshot.entities) {
    const faction = getEntityFaction(entity);
    if (faction) values.add(faction);
  }
  return [...values];
}

function relationSides(snapshot: EncounterSnapshot): EncounterSide[] {
  const seen = new Set<string>();
  const sides: EncounterSide[] = [];
  for (const entity of snapshot.entities) {
    if (entity.type !== 'ACTOR') continue;
    const side = getEncounterSide(entity);
    const key = sideKey(side);
    if (seen.has(key)) continue;
    seen.add(key);
    sides.push(side);
  }
  return sides;
}

export function FactionControls({ snapshot, catalog, selectedEntityId, selectedCell, onCommand }: FactionControlsProps) {
  const entities = useMemo(() => new Map(snapshot.entities.map((entity) => [entity.id, entity])), [snapshot.entities]);
  const factions = useMemo(() => factionOptions(snapshot), [snapshot]);
  const sides = useMemo(() => relationSides(snapshot), [snapshot]);
  const selected = selectedEntityId ? entities.get(selectedEntityId) : undefined;
  const selectedFaction = selected ? getEntityFaction(selected) : null;
  const factionSource = JSON.stringify([selectedEntityId, selectedFaction]);
  const [factionName, setFactionName] = useSourceDraft(factionSource, selectedFaction ?? '');
  const [spawnTemplateChoice, setSpawnTemplate] = useState('');
  const spawnTemplate = catalog?.entries.some(entry => entry.templateId === spawnTemplateChoice)
    ? spawnTemplateChoice : catalog?.entries[0]?.templateId ?? '';
  const [spawnFaction, setSpawnFaction] = useSourceDraft(factionSource, selected ? selectedFaction ?? '' : factions[0] ?? '');
  const [spawnFactionName, setSpawnFactionName] = useState('');
  const [sideBChoice, setSideBValue] = useState('');
  const authoritativeVictory = snapshot.victoryCondition ?? 'LAST_SIDE';
  const [victoryCondition, setVictoryCondition] = useSourceDraft<EncounterVictoryCondition>(authoritativeVictory, authoritativeVictory);
  const [validationError, setValidationError] = useState('');
  const sideMap = useMemo(() => new Map(sides.map((side) => [sideKey(side), side])), [sides]);
  const sideAValue = selected?.type === 'ACTOR' ? sideKey(getEncounterSide(selected)) : '';
  const otherSides = sides.filter(side => sideKey(side) !== sideAValue);
  const sideBValue = sideBChoice !== sideAValue && sideMap.has(sideBChoice)
    ? sideBChoice : otherSides[0] ? sideKey(otherSides[0]) : '';
  const sideA = sideMap.get(sideAValue);
  const sideB = sideMap.get(sideBValue);
  const currentRelation = sideA && sideB ? getEncounterRelation(sideA, sideB, snapshot.relations ?? []) : 'UNKNOWN';
  const [relation, setRelation] = useSourceDraft<EncounterRelation | ''>(
    JSON.stringify([sideAValue, sideBValue, currentRelation]), currentRelation === 'UNKNOWN' ? '' : currentRelation,
  );

  const trimmedFaction = factionName.trim();
  const validFaction = trimmedFaction.length > 0 && isEncounterFaction(trimmedFaction);
  const trimmedSpawnFaction = spawnFactionName.trim();
  const spawnFactionValue = trimmedSpawnFaction.length > 0
    ? (isEncounterFaction(trimmedSpawnFaction) ? trimmedSpawnFaction : null)
    : spawnFaction === INDEPENDENT_VALUE || spawnFaction === '' ? null : spawnFaction;
  const spawnReady = Boolean(spawnTemplate && catalog?.entries.some(entry => entry.templateId === spawnTemplate)
    && (trimmedSpawnFaction.length === 0 || isEncounterFaction(trimmedSpawnFaction))
    && (spawnFactionValue === null || isEncounterFaction(spawnFactionValue)));

  const validateFaction = (value: string): boolean => {
    if (value.length === 0 || isEncounterFaction(value)) {
      setValidationError('');
      return true;
    }
    setValidationError('阵营名称需为 1–64 个字符，不能包含控制字符。');
    return false;
  };

  const submitFaction = (): void => {
    if (!selectedEntityId || !validateFaction(trimmedFaction)) return;
    onCommand('GM_SET_FACTION', { entityId: selectedEntityId, faction: trimmedFaction });
  };

  const submitSpawn = (): void => {
    if (!spawnTemplate || !spawnReady) return;
    if (trimmedSpawnFaction.length > 0 && !isEncounterFaction(trimmedSpawnFaction)) {
      setValidationError('刷出阵营名称需为 1–64 个字符，不能包含控制字符。');
      return;
    }
    onCommand('GM_SPAWN', {
      templateId: spawnTemplate,
      faction: spawnFactionValue,
      ...(selectedCell ? { position: { x: selectedCell.x, y: selectedCell.y, z: 0 } } : {}),
    });
  };

  return <div className="demo-faction-controls" aria-label="阵营与关系控制">
    <div className="demo-faction-controls-section">
      <h3>阵营</h3>
      <div className="demo-inline-controls">
        <input className="demo-input" value={factionName} maxLength={64} disabled={!selectedEntityId} aria-label="阵营名称" placeholder="自定义阵营名称" onChange={(event) => { setFactionName(event.target.value); if (validationError) validateFaction(event.target.value.trim()); }} />
        <select className="demo-select" value={factions.includes(factionName) ? factionName : ''} disabled={!selectedEntityId} aria-label="选择已有阵营" onChange={(event) => { setFactionName(event.target.value); setValidationError(''); }}>
          <option value="">选择已有阵营</option>
          {factions.map((faction) => <option value={faction} key={faction}>{factionLabel(faction)}</option>)}
        </select>
        <button className="demo-button ghost" type="button" disabled={!selectedEntityId || !validFaction} aria-label="应用阵营" onClick={submitFaction}>应用阵营</button>
        <button className="demo-button ghost" type="button" disabled={!selectedEntityId} aria-label="设为独立" onClick={() => onCommand('GM_SET_FACTION', { entityId: selectedEntityId, faction: null })}>设为独立</button>
      </div>
      {validationError && <small className="demo-form-error" role="alert">{validationError}</small>}
    </div>
    <div className="demo-faction-controls-section">
      <h3>刷出实体</h3>
      <div className="demo-inline-controls">
        <select className="demo-select" value={spawnTemplate} aria-label="刷出模板" disabled={!catalog?.entries.length} onChange={(event) => setSpawnTemplate(event.target.value)}>
          <option value="">选择模板</option>
          {(catalog?.entries ?? []).map((entry) => <option value={entry.templateId} key={entry.templateId}>{entry.label}</option>)}
        </select>
        <select className="demo-select" value={spawnFaction} aria-label="刷出阵营" onChange={(event) => setSpawnFaction(event.target.value)}>
          <option value={INDEPENDENT_VALUE}>独立</option>
          {factions.map((faction) => <option value={faction} key={faction}>{factionLabel(faction)}</option>)}
        </select>
        <input className="demo-input" value={spawnFactionName} maxLength={64} aria-label="刷出阵营名称" placeholder="或输入新阵营" onChange={(event) => setSpawnFactionName(event.target.value)} />
        <button className="demo-button primary" type="button" disabled={!spawnReady} onClick={submitSpawn}>在选中格刷出</button>
      </div>
    </div>
    <div className="demo-faction-controls-section">
      <h3>关系</h3>
      <div className="demo-inline-controls">
        <span className="demo-muted">{sideA ? sideLabel(sideA, entities) : '请选择角色'} →</span>
        <select className="demo-select" value={sideBValue} aria-label="关系另一方" disabled={!sideA || sides.length < 2} onChange={(event) => setSideBValue(event.target.value)}>
          <option value="">选择另一方</option>
          {otherSides.map((side) => <option key={sideKey(side)} value={sideKey(side)}>{sideLabel(side, entities)}</option>)}
        </select>
        <select className="demo-select" value={relation} aria-label="双方关系" disabled={!sideA || !sideB} onChange={(event) => setRelation(event.target.value as EncounterRelation | '')}>
          <option value="">未设置</option>
          <option value="ALLY">同盟</option>
          <option value="NEUTRAL">中立</option>
          <option value="HOSTILE">敌对</option>
        </select>
        <button className="demo-button ghost" type="button" disabled={!sideA || !sideB} aria-label="应用关系" onClick={() => onCommand('GM_SET_RELATION', { a: sideA, b: sideB, relation: relation || null })}>应用关系</button>
        <span className="demo-muted" title={relationLabel(currentRelation)}>当前：{relationLabel(currentRelation)}</span>
      </div>
    </div>
    <div className="demo-faction-controls-section">
      <h3>胜负</h3>
      <div className="demo-inline-controls">
        <select className="demo-select" value={victoryCondition} aria-label="胜负条件" onChange={(event) => setVictoryCondition(event.target.value as EncounterVictoryCondition)}>
          <option value="LAST_SIDE">仅剩一方或同盟胜出</option>
          <option value="MANUAL">GM 手动裁定</option>
        </select>
        <button className="demo-button ghost" type="button" onClick={() => onCommand('GM_SET_VICTORY_CONDITION', { condition: victoryCondition })}>应用胜负条件</button>
      </div>
    </div>
  </div>;
}
