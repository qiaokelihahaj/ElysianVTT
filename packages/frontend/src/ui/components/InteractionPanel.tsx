/**
 * InteractionPanel — 探索模式交互动作面板
 *
 * 展示当前实体可用的交互动作列表（搜索、撬锁、调查等）。
 * 点击触发后，委托 IntentDispatcher 发出交互意图，
 * 或直接通过 exploreStore 触发本地技能检定动画。
 *
 * 使用方式：
 *   <InteractionPanel />
 *
 * 依赖：
 *   - exploreStore（availableInteractions、activeInteractionId）
 *   - IntentDispatcher（dispatchInteraction）
 */

import React, { useCallback } from 'react';
import { useExploreStore, type InteractionDef } from '../../store/exploreStore';

// ============================================================
//  Interaction icons map
// ============================================================

const INTERACTION_ICONS: Record<string, string> = {
  search: '🔍',
  lockpick: '🔓',
  investigate: '📋',
  examine: '👁',
  talk: '💬',
  push: '🖐',
  pull: '🖐',
  open: '🚪',
  close: '🚪',
  use: '⚙',
  take: '✋',
  read: '📄',
  pry: '🔧',
  disable: '⛔',
};

const DEFAULT_ICON = '⚡';

// ============================================================
//  Sub-components
// ============================================================

interface InteractionButtonProps {
  interaction: InteractionDef;
  isActive: boolean;
  onClick: (interaction: InteractionDef) => void;
}

const InteractionButton: React.FC<InteractionButtonProps> = ({
  interaction,
  isActive,
  onClick,
}) => {
  const icon = INTERACTION_ICONS[interaction.id] ?? DEFAULT_ICON;

  return (
    <button
      onClick={() => onClick(interaction)}
      disabled={!interaction.inRange}
      className={`
        flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-left text-xs
        transition-all duration-150 border
        ${
          isActive
            ? 'bg-sky-600/30 border-sky-500/50 text-sky-200'
            : interaction.inRange
              ? 'bg-zinc-800/80 border-zinc-700/60 text-zinc-300 hover:bg-zinc-700/80 hover:border-zinc-600 hover:text-zinc-100'
              : 'bg-zinc-900/60 border-zinc-800/40 text-zinc-600 cursor-not-allowed'
        }
      `}
      title={interaction.description}
    >
      <span className="text-base flex-none w-5 text-center">{icon}</span>
      <div className="flex flex-col flex-1 min-w-0">
        <span className="font-semibold truncate">{interaction.label}</span>
        {(interaction.skillCheck || interaction.cooldownTicks) && (
          <span className="text-[10px] text-zinc-500 font-mono">
            {interaction.skillCheck
              ? `${interaction.skillCheck.skill} DC${interaction.skillCheck.dc}`
              : null}
            {interaction.skillCheck && interaction.cooldownTicks ? ' · ' : null}
            {interaction.cooldownTicks
              ? `CD ${interaction.cooldownTicks}t`
              : null}
          </span>
        )}
      </div>
      {interaction.skillCheck && (
        <span
          className={`text-[11px] font-mono font-bold px-1.5 py-0.5 rounded ${
            interaction.skillCheck.dc <= 10
              ? 'text-green-400 bg-green-500/10'
              : interaction.skillCheck.dc <= 15
                ? 'text-amber-400 bg-amber-500/10'
                : 'text-red-400 bg-red-500/10'
          }`}
        >
          D20
        </span>
      )}
    </button>
  );
};

// ============================================================
//  Main component
// ============================================================

interface InteractionPanelProps {
  /** 可选：面板标题 */
  title?: string;
}

export const InteractionPanel: React.FC<InteractionPanelProps> = ({
  title = 'Interactions',
}) => {
  const exploreMode = useExploreStore((s) => s.exploreMode);
  const availableInteractions = useExploreStore((s) => s.availableInteractions);
  const activeInteractionId = useExploreStore((s) => s.activeInteractionId);
  const selectedEntityId = useExploreStore((s) => s.selectedEntityId);
  const setActiveInteraction = useExploreStore((s) => s.setActiveInteraction);
  const clearInteractions = () =>
    useExploreStore.getState().setAvailableInteractions([]);

  const handleInteraction = useCallback(
    (interaction: InteractionDef) => {
      if (!interaction.inRange) return;

      if (activeInteractionId === interaction.id) {
        // 再次点击取消
        setActiveInteraction(null);
        return;
      }

      setActiveInteraction(interaction.id);

      // 如果定义了技能检定 → 更新 store（后续由 SkillCheckPanel 或后端触发结果）
      // 实际使用时，交互逻辑应由 IntentDispatcher 或后端响应驱动
      if (interaction.skillCheck) {
        // 模拟自动检定（生产环境中由后端返回结果）
        const roll = Math.floor(Math.random() * 20) + 1;
        const total = roll; // 生产环境需加上属性/熟练加值
        useExploreStore.getState().setSkillCheckResult({
          roll,
          total,
          skill: interaction.skillCheck.skill,
          dc: interaction.skillCheck.dc,
          success: total >= interaction.skillCheck.dc,
          critical: roll === 20,
          fumble: roll === 1,
          timestamp: Date.now(),
        });
      }
    },
    [activeInteractionId, setActiveInteraction],
  );

  // 非探索模式或不处于探索场景时隐藏
  if (!exploreMode) return null;

  return (
    <div className="pointer-events-auto w-64 max-h-80">
      <div className="bg-zinc-900/90 border border-zinc-700/80 rounded-xl backdrop-blur-md overflow-hidden shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 bg-zinc-800/60 border-b border-zinc-700/60">
          <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-300">
            {title}
          </h3>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-500 font-mono">
              {availableInteractions.length}
            </span>
            {availableInteractions.length > 0 && (
              <button
                onClick={clearInteractions}
                className="text-zinc-600 hover:text-zinc-400 text-[10px] px-1.5 py-0.5 rounded hover:bg-zinc-700/50 transition-colors"
                title="Clear"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="overflow-y-auto max-h-60 p-2 space-y-1">
          {availableInteractions.length === 0 ? (
            <div className="text-center py-4">
              <p className="text-xs text-zinc-500">
                {selectedEntityId
                  ? 'No interactions available'
                  : 'Select an entity to interact'}
              </p>
            </div>
          ) : (
            availableInteractions.map((interaction) => (
              <InteractionButton
                key={interaction.id}
                interaction={interaction}
                isActive={activeInteractionId === interaction.id}
                onClick={handleInteraction}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
};
