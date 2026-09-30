import React, { useState } from 'react';
import { useGameStore } from '../../store/gameStore';
import type { HookPreset, HookTrigger } from '../../store/gameStore';

const TRIGGER_TYPES: HookTrigger['type'][] = [
    'TICK_REACHED',
    'ENEMY_ENTERS_RANGE',
    'ENTITY_MOVES_TO',
    'ENTITY_ENTERS_AREA',
    'ACTION_PHASE_DELAY',
    'ENEMY_CASTS_SPELL',
];

const TRIGGER_LABELS: Record<HookTrigger['type'], string> = {
    TICK_REACHED: 'Tick 到达',
    ENEMY_ENTERS_RANGE: '敌人进入范围',
    ENTITY_MOVES_TO: '实体移动到',
    ENTITY_ENTERS_AREA: '实体进入区域',
    ACTION_PHASE_DELAY: '动作前摇延迟',
    ENEMY_CASTS_SPELL: '敌人施法',
};

interface Props {
    show: boolean;
    onClose: () => void;
}

let presetCounter = 0;

export const HookEditor: React.FC<Props> = ({ show, onClose }) => {
    const hookPresets = useGameStore(state => state.tactical.hookPresets);
    const selectedEntityId = useGameStore(state => state.selectedEntityId);
    const entities = useGameStore(state => state.entities);
    const permission = useGameStore(state => state.permission);
    const addHookPreset = useGameStore(state => state.addHookPreset);
    const removeHookPreset = useGameStore(state => state.removeHookPreset);

    const isGM = permission.role === 'GM';
    const [triggerType, setTriggerType] = useState<HookTrigger['type']>('TICK_REACHED');
    const [paramValue, setParamValue] = useState('');
    const [targetEntityId, setTargetEntityId] = useState(selectedEntityId ?? '');

    if (!show) return null;

    const allActors = Object.values(entities).filter(e => e.type === 'ACTOR');
    const currentEntityId = isGM ? targetEntityId : selectedEntityId;
    const myPresets = hookPresets.filter(p => {
        if (isGM) return true;
        return p.entityId === selectedEntityId;
    });

    const handleSave = () => {
        const eid = currentEntityId;
        if (!eid) return;
        const trigger = buildTrigger(triggerType, paramValue);
        const preset: HookPreset = {
            id: `hook_${Date.now()}_${++presetCounter}`,
            entityId: eid,
            label: TRIGGER_LABELS[triggerType],
            trigger,
            enabled: true,
        };
        addHookPreset(preset);
        setParamValue('');
    };

    const getParamLabel = (): string => {
        switch (triggerType) {
            case 'TICK_REACHED': return 'Tick 编号';
            case 'ENEMY_ENTERS_RANGE': return '范围 (格)';
            case 'ENTITY_MOVES_TO': return '目标 Hex 坐标 (q,r)';
            case 'ENTITY_ENTERS_AREA': return '区域坐标 (x,y,z)';
            case 'ACTION_PHASE_DELAY': return '源实体 ID';
            case 'ENEMY_CASTS_SPELL': return '技能模板 ID';
            default: return '';
        }
    };

    const getParamPlaceholder = (): string => {
        switch (triggerType) {
            case 'TICK_REACHED': return '例: 200';
            case 'ENEMY_ENTERS_RANGE': return '例: 5';
            case 'ENTITY_MOVES_TO': return '例: 10,15';
            case 'ENTITY_ENTERS_AREA': return '例: 20,30,0';
            case 'ACTION_PHASE_DELAY': return '例: actor_knight';
            case 'ENEMY_CASTS_SPELL': return '例: FIRE_STORM';
            default: return '输入参数...';
        }
    };

    // Group presets by entity for GM display
    const presetsByEntity = new Map<string, HookPreset[]>();
    if (isGM) {
        for (const p of myPresets) {
            const list = presetsByEntity.get(p.entityId) ?? [];
            list.push(p);
            presetsByEntity.set(p.entityId, list);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 pointer-events-auto">
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-5 backdrop-blur-xl max-w-lg w-full shadow-2xl max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-bold text-zinc-200">
                        🪝 事件钩子
                        {isGM && <span className="ml-2 text-[10px] text-amber-400 font-normal">GM 模式</span>}
                    </h3>
                    <button
                        onClick={onClose}
                        className="text-zinc-500 hover:text-zinc-300 text-lg leading-none transition-colors"
                    >
                        ✕
                    </button>
                </div>

                {/* GM: Entity selector */}
                {isGM && (
                    <div className="mb-3">
                        <label className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1 block">目标实体</label>
                        <select
                            value={targetEntityId}
                            onChange={e => setTargetEntityId(e.target.value)}
                            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-amber-500/50"
                        >
                            <option value="" disabled>选择实体...</option>
                            {allActors.map(actor => (
                                <option key={actor.id} value={actor.id}>
                                    {actor.templateId} ({actor.id.slice(0, 6)})
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                {/* Trigger type selector */}
                <div className="mb-3">
                    <label className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1 block">事件类型</label>
                    <select
                        value={triggerType}
                        onChange={e => setTriggerType(e.target.value as HookTrigger['type'])}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-amber-500/50"
                    >
                        {TRIGGER_TYPES.map(tt => (
                            <option key={tt} value={tt}>{TRIGGER_LABELS[tt]}</option>
                        ))}
                    </select>
                </div>

                {/* Parameter input */}
                <div className="mb-4">
                    <label className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1 block">{getParamLabel()}</label>
                    <input
                        type="text"
                        value={paramValue}
                        onChange={e => setParamValue(e.target.value)}
                        placeholder={getParamPlaceholder()}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-amber-500/50 placeholder-zinc-600"
                    />
                </div>

                <button
                    onClick={handleSave}
                    disabled={!paramValue.trim() || !currentEntityId}
                    className="w-full px-4 py-2 bg-amber-600/80 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium transition-colors mb-4"
                >
                    保存预设
                </button>

                {/* Active hooks list */}
                {myPresets.length > 0 && (
                    <div>
                        <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">活跃钩子</div>
                        <div className="space-y-1 max-h-60 overflow-y-auto">
                            {isGM ? (
                                // GM: grouped by entity
                                Array.from(presetsByEntity.entries()).map(([eid, presets]) => (
                                    <div key={eid} className="mb-2">
                                        <div className="text-[9px] text-zinc-600 uppercase tracking-wider mb-1 px-1">
                                            {entities[eid]?.templateId ?? eid.slice(0, 8)}
                                        </div>
                                        {presets.map(preset => (
                                            <PresetRow key={preset.id} preset={preset} onRemove={removeHookPreset} />
                                        ))}
                                    </div>
                                ))
                            ) : (
                                // PL/OB: flat list for selected entity only
                                myPresets.map(preset => (
                                    <PresetRow key={preset.id} preset={preset} onRemove={removeHookPreset} />
                                ))
                            )}
                        </div>
                    </div>
                )}

                {myPresets.length === 0 && (
                    <div className="text-center text-xs text-zinc-600 py-4">
                        暂无钩子预设，在上方创建
                    </div>
                )}
            </div>
        </div>
    );
};

function PresetRow({ preset, onRemove }: { preset: HookPreset; onRemove: (id: string) => void }) {
    return (
        <div className="flex items-center justify-between bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-1.5">
            <div>
                <div className="text-xs text-zinc-300">{preset.label}</div>
                <div className="text-[10px] text-zinc-500">
                    {preset.trigger.type}
                    {triggerParamSummary(preset.trigger)}
                </div>
            </div>
            <button
                onClick={() => onRemove(preset.id)}
                className="text-zinc-600 hover:text-red-400 text-xs transition-colors"
            >
                删除
            </button>
        </div>
    );
}

function triggerParamSummary(trigger: HookTrigger): string {
    switch (trigger.type) {
        case 'TICK_REACHED': return ` @ ${trigger.targetTick}`;
        case 'ENEMY_ENTERS_RANGE': return ` ≤${trigger.range}格`;
        case 'ENTITY_MOVES_TO': return ` (${trigger.targetHex.q},${trigger.targetHex.r})`;
        case 'ENTITY_ENTERS_AREA': return ` (${trigger.center.x},${trigger.center.y})`;
        case 'ACTION_PHASE_DELAY': return ` ${trigger.sourceEntityId}`;
        case 'ENEMY_CASTS_SPELL': return trigger.sourceFilter ? ` ${trigger.sourceFilter}` : '';
        default: return '';
    }
}

function buildTrigger(type: HookTrigger['type'], param: string): HookTrigger {
    switch (type) {
        case 'TICK_REACHED':
            return { type: 'TICK_REACHED', targetTick: Number(param) || 0 };
        case 'ENEMY_ENTERS_RANGE':
            return { type: 'ENEMY_ENTERS_RANGE', range: Number(param) || 1 };
        case 'ENTITY_MOVES_TO': {
            const [q, r] = param.split(',').map(Number);
            return { type: 'ENTITY_MOVES_TO', targetHex: { q: q || 0, r: r || 0 } };
        }
        case 'ENTITY_ENTERS_AREA': {
            const [x, y, z] = param.split(',').map(Number);
            return { type: 'ENTITY_ENTERS_AREA', center: { x: x || 0, y: y || 0, z: z || 0 }, radius: 1 };
        }
        case 'ACTION_PHASE_DELAY':
            return { type: 'ACTION_PHASE_DELAY', sourceEntityId: param, actionTemplateId: '', delayTicks: 1 };
        case 'ENEMY_CASTS_SPELL':
            return { type: 'ENEMY_CASTS_SPELL', sourceFilter: param };
    }
}
