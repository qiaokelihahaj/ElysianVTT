/**
 * SkillCheckPanel — 技能检定结果展示面板
 *
 * d20 掷骰可视化 + 成功/失败展示。
 * 从 exploreStore.skillCheckResult 读取数据。
 *
 * 显示内容：
 *   - 技能名称与 DC
 *   - d20 骰面动画（数值 + 自然 20/1 高亮）
 *   - 检定总值 vs DC
 *   - 成功 / 失败判定（含大成功/大失败标签）
 *
 * 使用方式：
 *   <SkillCheckPanel />
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useExploreStore, type SkillCheckResult } from '../../store/exploreStore';

// ============================================================
//  Sub-components
// ============================================================

interface DiceFaceProps {
  value: number;
  critical: boolean;
  fumble: boolean;
  revealed: boolean;
}

const DiceFace: React.FC<DiceFaceProps> = ({ value, critical, fumble, revealed }) => {
  // d20 骰面颜色
  const faceColor = fumble
    ? 'bg-red-900/80 border-red-500/60 text-red-300'
    : critical
      ? 'bg-amber-900/80 border-amber-400/60 text-amber-300'
      : 'bg-zinc-800/80 border-zinc-600/60 text-zinc-200';

  const badge = fumble ? '💀' : critical ? '⭐' : '';

  return (
    <div
      className={`
        relative flex flex-col items-center justify-center w-16 h-16
        rounded-xl border-2 transition-all duration-300
        ${faceColor}
        ${revealed ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}
      `}
    >
      <span className="text-2xl font-bold font-mono leading-none">
        {revealed ? value : '?'}
      </span>
      {revealed && badge && (
        <span className="absolute -top-2 -right-2 text-sm">{badge}</span>
      )}
    </div>
  );
};

interface ResultBadgeProps {
  success: boolean;
  critical: boolean;
  fumble: boolean;
}

const ResultBadge: React.FC<ResultBadgeProps> = ({ success, critical, fumble }) => {
  if (fumble) {
    return (
      <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-red-900/50 border border-red-500/50 text-red-300">
        💀 大失败
      </span>
    );
  }
  if (critical) {
    return (
      <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-amber-900/50 border border-amber-400/50 text-amber-300">
        ⭐ 大成功
      </span>
    );
  }
  if (success) {
    return (
      <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-green-900/50 border border-green-500/50 text-green-300">
        ✓ 成功
      </span>
    );
  }
  return (
    <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-red-900/40 border border-red-500/40 text-red-400">
      ✗ 失败
    </span>
  );
};

// ============================================================
//  Progress bar component
// ============================================================

interface ProgressBarProps {
  current: number;
  max: number;
  label: string;
  color: string;
}

const ProgressBar: React.FC<ProgressBarProps> = ({ current, max, label, color }) => {
  const pct = max > 0 ? Math.min(100, Math.max(0, (current / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-zinc-500 w-10 text-right font-mono">{label}</span>
      <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-[10px] text-zinc-400 font-mono w-12 text-left">
        {current}/{max}
      </span>
    </div>
  );
};

// ============================================================
//  Main component
// ============================================================

const DISMISS_MS = 8000; // 自动关闭时间

export const SkillCheckPanel: React.FC = () => {
  const skillCheckResult = useExploreStore((s) => s.skillCheckResult);
  const setSkillCheckResult = useExploreStore((s) => s.setSkillCheckResult);

  // 以结果对象身份关联 UI 状态，新的结果自然从未揭示/未关闭开始。
  const [revealedResult, setRevealedResult] = useState<SkillCheckResult | null>(null);
  const [dismissedResult, setDismissedResult] = useState<SkillCheckResult | null>(null);
  const clearResultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 重置动画状态，每次新结果触发揭示动画
  useEffect(() => {
    if (skillCheckResult) {
      const result = skillCheckResult;

      // 短延迟后揭示骰面（模拟滚动动画）
      const revealTimer = setTimeout(() => setRevealedResult(result), 400);

      // 自动关闭
      const dismissTimer = setTimeout(() => {
        setDismissedResult(result);
        // 延迟清除 store 中的数据以允许淡出动画
        clearResultTimer.current = setTimeout(() => {
          if (useExploreStore.getState().skillCheckResult === result) setSkillCheckResult(null);
          clearResultTimer.current = null;
        }, 300);
      }, DISMISS_MS);

      return () => {
        clearTimeout(revealTimer);
        clearTimeout(dismissTimer);
        if (clearResultTimer.current !== null) clearTimeout(clearResultTimer.current);
        clearResultTimer.current = null;
      };
    }
  }, [skillCheckResult, setSkillCheckResult]);

  const handleDismiss = useCallback(() => {
    if (!skillCheckResult) return;
    setDismissedResult(skillCheckResult);
    if (clearResultTimer.current !== null) clearTimeout(clearResultTimer.current);
    clearResultTimer.current = setTimeout(() => {
      if (useExploreStore.getState().skillCheckResult === skillCheckResult) setSkillCheckResult(null);
      clearResultTimer.current = null;
    }, 200);
  }, [skillCheckResult, setSkillCheckResult]);

  if (!skillCheckResult) return null;

  const revealed = revealedResult === skillCheckResult;
  const dismissed = dismissedResult === skillCheckResult;

  const { roll, total, skill, dc, success, critical, fumble } = skillCheckResult;

  return (
    <div
      className={`
        pointer-events-auto transition-all duration-300
        ${dismissed ? 'opacity-0 translate-y-2' : 'opacity-100 translate-y-0'}
      `}
    >
      <div className="bg-zinc-900/95 border border-zinc-700/80 rounded-xl backdrop-blur-md shadow-2xl overflow-hidden w-72">
        {/* Header — skill name */}
        <div className="flex items-center justify-between px-4 py-2 bg-zinc-800/60 border-b border-zinc-700/60">
          <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-200">
            {skill.replace(/_/g, ' ')}
          </h3>
          <button
            onClick={handleDismiss}
            className="text-zinc-600 hover:text-zinc-400 text-xs px-1.5 py-0.5 rounded hover:bg-zinc-700/50 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Dice area */}
        <div className="flex items-center justify-center gap-4 px-4 py-4">
          <DiceFace
            value={roll}
            critical={critical}
            fumble={fumble}
            revealed={revealed}
          />

          {/* VS indicator */}
          <div className="flex flex-col items-center">
            <span className="text-[10px] text-zinc-500 font-mono mb-1">DC</span>
            <span className="text-xl font-bold text-zinc-400 font-mono">{dc}</span>
          </div>

          {/* Result badge */}
          <div className="flex flex-col items-center gap-1 min-w-[80px]">
            <ResultBadge success={success} critical={critical} fumble={fumble} />
            {revealed && (
              <span className="text-[10px] text-zinc-500 font-mono">
                {roll} vs DC{dc}
              </span>
            )}
          </div>
        </div>

        {/* Progress visualization */}
        {revealed && (
          <div className="px-4 pb-3 space-y-1">
            <ProgressBar
              current={total}
              max={Math.max(dc + 5, total)}
              label="Roll"
              color={success ? '#22c55e' : '#ef4444'}
            />
            <ProgressBar
              current={dc}
              max={Math.max(dc + 5, total)}
              label="DC"
              color="#a1a1aa"
            />
          </div>
        )}

        {/* Dismiss hint */}
        <div className="px-4 pb-2 text-center">
          <span className="text-[9px] text-zinc-600">Click or wait to dismiss</span>
        </div>
      </div>
    </div>
  );
};
