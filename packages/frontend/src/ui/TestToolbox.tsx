import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useGameStore } from '../store/gameStore';
import { useExploreStore } from '../store/exploreStore';
import { socketClient } from '../network/socketClient';
import { IntentDispatcher } from '../network/IntentDispatcher';

type LogEntry = { time: string; text: string; ok?: boolean };

const TARGET_ACTIONS = [
  { id: '快速斩', label: '快速斩', desc: 'startup=5, recovery=3' },
  { id: '火球术', label: '火球术', desc: 'startup=8, recovery=6, 耗FP' },
  { id: '连刺', label: '连刺', desc: 'channel 3 pulses' },
  { id: 'HEAVY_STRIKE', label: '重击', desc: 'startup=10' },
  { id: 'FIRE_STORM', label: '火焰风暴', desc: 'channel AOE' },
  { id: 'PARRY', label: '招架', desc: '防御，耗PP' },
  { id: 'DODGE', label: '闪避', desc: '位移2格，耗FP' },
];

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3000';
const SCENE_ID = 'room_1';

interface IdentityPreset {
  label: string;
  userId: string;
  role: 'GM' | 'PL';
  actorId: string;
  emoji: string;
}

const IDENTITY_PRESETS: IdentityPreset[] = [
  { label: 'GM (管理员)', userId: 'demo_gm', role: 'GM', actorId: '', emoji: '👑' },
  { label: '战士 (PL)', userId: 'player_warrior', role: 'PL', actorId: 'actor_warrior', emoji: '⚔️' },
  { label: '骑士 (PL)', userId: 'player_knight', role: 'PL', actorId: 'actor_knight', emoji: '🛡️' },
  { label: '盗贼 (PL)', userId: 'player_rogue', role: 'PL', actorId: 'actor_rogue', emoji: '🗡️' },
  { label: '哥布林 (PL)', userId: 'player_goblin', role: 'PL', actorId: 'target_goblin', emoji: '👺' },
];

export const TestToolbox: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const entities = useGameStore(s => s.entities);
  const tick = useGameStore(s => s.tick);
  const scheduledActions = useGameStore(s => s.scheduledActions);
  const permission = useGameStore(s => s.permission);

  // 探索模式状态
  const exploreMode = useExploreStore(s => s.exploreMode);
  const mapData = useExploreStore(s => s.mapData);
  const exploreEntities = useExploreStore(s => s.exploreEntities);
  const hexVisibility = useExploreStore(s => s.hexVisibility);
  const viewingEntityId = useExploreStore(s => s.viewingEntityId);
  const entityHexVisibility = useExploreStore(s => s.entityHexVisibility);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [testingPing, setTestingPing] = useState(false);
  const [selectedAction, setSelectedAction] = useState(TARGET_ACTIONS[0].id);
  const [targetEntityId, setTargetEntityId] = useState('');
  const [moveX, setMoveX] = useState('3');
  const [moveY, setMoveY] = useState('0');
  const [expanded, setExpanded] = useState<string | null>('identity');
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const identityRequestRef = useRef(0);
  const identityCleanupRef = useRef<(() => void) | null>(null);

  const actorEntities = Object.values(entities).filter(e => e.type === 'ACTOR');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      identityRequestRef.current += 1;
      identityCleanupRef.current?.();
      socketClient.skipAutoJoin = false;
    };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const addLog = useCallback((text: string, ok?: boolean) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-99), { time, text, ok }]);
  }, []);

  const testPing = useCallback(async () => {
    setTestingPing(true);
    setLatency(null);
    addLog('Ping...');
    const ms = await socketClient.ping();
    setLatency(ms);
    setTestingPing(false);
    if (ms >= 0) {
      addLog(`延迟: ${ms}ms`, true);
    } else {
      addLog('Ping 超时或失败', false);
    }
  }, [addLog]);

  const handleResync = useCallback(() => {
    socketClient.resync();
    addLog('已发送 RESYNC 请求', true);
  }, [addLog]);

  const handleCastAction = useCallback(() => {
    const targetId = targetEntityId || actorEntities.find(e => e.id !== '__batch__')?.id;
    if (!targetId) {
      addLog('错误: 没有可用的目标实体', false);
      return;
    }
    IntentDispatcher.dispatchCastAction(targetId, selectedAction);
    addLog(`发送 ${selectedAction} → ${targetId}`, true);
  }, [selectedAction, targetEntityId, actorEntities, addLog]);

  const handleMove = useCallback(() => {
    const targetId = targetEntityId || actorEntities[0]?.id;
    if (!targetId) {
      addLog('错误: 没有可用的实体', false);
      return;
    }
    const x = parseFloat(moveX);
    const y = parseFloat(moveY);
    if (isNaN(x) || isNaN(y)) {
      addLog('错误: 坐标格式无效', false);
      return;
    }
    IntentDispatcher.dispatchMove(targetId, { x, y, z: 0 });
    addLog(`移动 ${targetId} → (${x}, ${y})`, true);
  }, [moveX, moveY, targetEntityId, actorEntities, addLog]);

  const handleBatchSync = useCallback(() => {
    const allActors = actorEntities;
    if (allActors.length < 2) {
      addLog('错误: 至少需要 2 个 ACTOR', false);
      return;
    }
    const allIds = allActors.map(e => e.id);
    const batchIntents = allActors.map(e => ({
      actorId: e.id,
      actionTemplateId: 'SYNC_TEST',
      targetIds: allIds.filter(id => id !== e.id),
    }));
    IntentDispatcher.dispatchBatchCast(batchIntents);
    addLog(`批量同步: ${allActors.length} 个角色`, true);
  }, [actorEntities, addLog]);

  const handleSwitchIdentity = useCallback(async (preset: IdentityPreset) => {
    const requestId = ++identityRequestRef.current;
    identityCleanupRef.current?.();
    const isCurrent = () => mountedRef.current && requestId === identityRequestRef.current;
    setSwitchingId(preset.userId);
    addLog(`切换身份 → ${preset.label}`);
    try {
      // 1. 登录获取新 token
      const res = await fetch(`${SERVER_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: preset.userId, role: preset.role })
      });
      const json = await res.json();
      if (!isCurrent()) return;
      if (!json?.ok || !json?.data?.accessToken) {
        addLog(`登录失败: ${json?.error || '无 token'}`, false);
        setSwitchingId(null);
        return;
      }

      const token = json.data.accessToken;
      localStorage.setItem('accessToken', token);

      // 2. 阻止 App.tsx 自动 joinScene（它不知道 actorId）
      socketClient.skipAutoJoin = true;

      // 3. 重新认证（等待服务端确认）
      const authResult = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socketClient.offAuthSuccess(onSuccess);
          socketClient.offAuthFailed(onFailure);
          identityCleanupRef.current = null;
          resolve(ok);
        };
        const onSuccess = () => finish(true);
        const onFailure = () => finish(false);
        const timer = setTimeout(() => finish(false), 5000);
        identityCleanupRef.current = () => finish(false);
        socketClient.onAuthSuccess(onSuccess);
        socketClient.onAuthFailed(onFailure);
        socketClient.authenticate(token);
      });
      if (!isCurrent()) return;
      if (!authResult) {
        addLog('WebSocket 认证失败', false);
        socketClient.skipAutoJoin = false;
        setSwitchingId(null);
        return;
      }

      // 4. 加入场景（PL 需指定 actorId 以绑定控制权）
      socketClient.joinScene(SCENE_ID, preset.actorId || undefined);

      // 4. 更新 store 中的权限（简化版，实际由 JOIN_SUCCESS 事件驱动）
      useGameStore.getState().setPermission({
        userId: json.data.userId,
        role: json.data.role,
        sessionId: json.data.sessionId ?? 'local',
        source: 'local',
        controlledEntityIds: preset.role === 'GM' ? [] : [preset.actorId],
        visibleEntityIds: [],
        allowedSceneIds: [],
        capabilities: preset.role === 'GM'
          ? ['ALL']
          : ['VIEW_ASSETS', 'VIEW_MAP', 'BROWSE_DICTIONARY', 'SEND_INTENT'],
        snapshotVersion: Date.now()
      });

      addLog(`已切换 → ${preset.emoji} ${preset.label}`, true);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      identityCleanupRef.current?.();
      socketClient.skipAutoJoin = false;
      const message = err instanceof Error ? err.message : String(err);
      addLog(`切换失败: ${message}`, false);
    }
    setSwitchingId(null);
  }, [addLog]);

  const handleToggleExplore = useCallback(async () => {
    if (exploreMode) {
      // 退出探索模式，返回战斗场景
      addLog('退出探索模式 → room_1');
      useExploreStore.getState().setExploreMode(false);
      socketClient.joinScene('room_1');
    } else {
      // 进入探索模式
      addLog('进入探索模式 → explore_1');
      useExploreStore.getState().setExploreMode(true);
      socketClient.joinScene('explore_1');
    }
  }, [exploreMode, addLog]);

  const clearLogs = useCallback(() => setLogs([]), []);

  const toggleSection = (key: string) => setExpanded(prev => prev === key ? null : key);

  const LogBadge = ({ ok }: { ok?: boolean }) =>
    ok === undefined ? null : (
      <span className={`ml-1 text-[10px] ${ok ? 'text-green-400' : 'text-red-400'}`}>
        {ok ? '✓' : '✗'}
      </span>
    );

  return (
    <div className="pointer-events-auto absolute top-2 right-2 z-50 w-80 max-h-[90vh] flex flex-col bg-zinc-900/95 border border-zinc-700 rounded-xl shadow-2xl shadow-black/50 backdrop-blur-md overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-700 bg-zinc-800/50">
        <h3 className="text-sm font-bold text-zinc-200">🧪 测试工具箱</h3>
        <div className="flex gap-1">
          <span
            className={`inline-block w-2 h-2 rounded-full ${socketClient.connected ? 'bg-green-500' : 'bg-red-500'}`}
            title={socketClient.connected ? '已连接' : '未连接'}
          />
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg leading-none">&times;</button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto text-xs">
        {/* 连接测试 */}
        <Section title="连接测试" expanded={expanded === 'connection'} onToggle={() => toggleSection('connection')}>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">WebSocket</span>
              <span className={socketClient.connected ? 'text-green-400' : 'text-red-400'}>
                {socketClient.connected ? '已连接' : '未连接'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">延迟</span>
              <span className="font-mono text-zinc-200">{latency !== null ? `${latency}ms` : '--'}</span>
            </div>
            <div className="flex gap-1.5">
              <button onClick={testPing} disabled={testingPing || !socketClient.connected}
                className="flex-1 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-40 transition-colors">
                {testingPing ? '测试中...' : '📡 测延迟'}
              </button>
              <button onClick={handleResync} disabled={!socketClient.connected}
                className="flex-1 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-40 transition-colors">
                🔄 重新同步
              </button>
            </div>
          </div>
        </Section>

        {/* 角色身份切换 */}
        <Section title="角色身份" expanded={expanded === 'identity'} onToggle={() => toggleSection('identity')}>
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px] text-zinc-500 mb-1">
              <span>当前: {permission.role} / {permission.userId}</span>
              <span>控制: {permission.controlledEntityIds.length > 0 ? permission.controlledEntityIds.join(',') : '全部'}</span>
            </div>
            {IDENTITY_PRESETS.map(p => {
              const isActive = permission.userId === p.userId;
              const isLoading = switchingId === p.userId;
              return (
                <button
                  key={p.userId}
                  onClick={() => handleSwitchIdentity(p)}
                  disabled={isActive || switchingId !== null || !socketClient.connected}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
                    isActive
                      ? 'bg-emerald-800/50 border border-emerald-700/50 text-emerald-300'
                      : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700/50'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  <span className="text-sm">{p.emoji}</span>
                  <span className="flex-1 text-left">{p.label}</span>
                  {isLoading && <span className="animate-spin text-[10px]">⏳</span>}
                  {isActive && <span className="text-[10px] text-emerald-400">当前</span>}
                </button>
              );
            })}
          </div>
        </Section>

        {/* 技能测试 */}
        <Section title="技能测试" expanded={expanded === 'skills'} onToggle={() => toggleSection('skills')}>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-zinc-400 w-8">目标</span>
              <select
                value={targetEntityId}
                onChange={e => setTargetEntityId(e.target.value)}
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-xs"
              >
                <option value="">-- 选择实体 --</option>
                {actorEntities.map(e => (
                  <option key={e.id} value={e.id}>{e.templateId} ({e.id})</option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-1">
              {TARGET_ACTIONS.map(a => (
                <button
                  key={a.id}
                  onClick={() => setSelectedAction(a.id)}
                  className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                    selectedAction === a.id
                      ? 'bg-sky-600 text-white'
                      : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                  }`}
                  title={a.desc}
                >
                  {a.label}
                </button>
              ))}
            </div>
            <button onClick={handleCastAction}
              disabled={!socketClient.connected}
              className="w-full px-2 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white font-bold disabled:opacity-40 transition-colors">
              ▶ 发送技能
            </button>
          </div>
        </Section>

        {/* 移动测试 */}
        <Section title="移动测试" expanded={expanded === 'move'} onToggle={() => toggleSection('move')}>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-zinc-400 w-8">实体</span>
              <select
                value={targetEntityId}
                onChange={e => setTargetEntityId(e.target.value)}
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-xs"
              >
                <option value="">-- 选择实体 --</option>
                {actorEntities.map(e => (
                  <option key={e.id} value={e.id}>{e.templateId} ({e.id})</option>
                ))}
              </select>
            </div>
            <div className="flex gap-2 items-center">
              <span className="text-zinc-400">目标</span>
              <label className="text-zinc-500">X</label>
              <input type="number" step="0.1" value={moveX} onChange={e => setMoveX(e.target.value)}
                className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-xs" />
              <label className="text-zinc-500">Y</label>
              <input type="number" step="0.1" value={moveY} onChange={e => setMoveY(e.target.value)}
                className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-xs" />
              <button onClick={handleMove}
                className="px-2 py-1 rounded bg-amber-700 hover:bg-amber-600 text-white text-xs font-bold transition-colors">
                移动
              </button>
            </div>
          </div>
        </Section>

        {/* 批量测试 */}
        <Section title="批量测试" expanded={expanded === 'batch'} onToggle={() => toggleSection('batch')}>
          <div className="space-y-1.5">
            <p className="text-zinc-500">所有 ACTOR 同步施法 (BATCH_CAST)，验证时间轴重叠</p>
            <button onClick={handleBatchSync}
              disabled={actorEntities.length < 2 || !socketClient.connected}
              className="w-full px-2 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-white font-bold disabled:opacity-40 transition-colors">
              ⚡ 全员同步测试 ({actorEntities.length} 角色)
            </button>
          </div>
        </Section>

        {/* 场景快照 */}
        <Section title="场景快照" expanded={expanded === 'snapshot'} onToggle={() => toggleSection('snapshot')}>
          <div className="space-y-1">
            <div className="flex justify-between text-zinc-400">
              <span>Tick</span><span className="font-mono text-amber-400">{tick}</span>
            </div>
            <div className="flex justify-between text-zinc-400">
              <span>实体数</span><span className="font-mono text-zinc-200">{Object.keys(entities).length}</span>
            </div>
            <div className="flex justify-between text-zinc-400">
              <span>时间轴动作</span><span className="font-mono text-zinc-200">{scheduledActions.length}</span>
            </div>
            <div className="flex justify-between text-zinc-400">
              <span>角色</span><span className="font-mono text-zinc-200">{permission.role}</span>
            </div>
            {actorEntities.length > 0 && (
              <div className="mt-1 border-t border-zinc-800 pt-1 space-y-0.5">
                {actorEntities.map(e => (
                  <div key={e.id} className="flex justify-between text-[10px]">
                    <span className="text-zinc-300 truncate max-w-24">{e.templateId}</span>
                    <span className="font-mono text-zinc-500">
                      HP:{e.resources.current.hp ?? '?'} PP:{e.resources.current.poise ?? '?'} FP:{e.resources.current.focus ?? '?'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>

        {/* 探索模式 */}
        <Section title="探索模式 (Phase 4)" expanded={expanded === 'explore'} onToggle={() => toggleSection('explore')}>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">当前模式</span>
              <span className={`font-mono text-xs font-bold ${exploreMode ? 'text-emerald-400' : 'text-amber-400'}`}>
                {exploreMode ? '探索' : '战斗'}
              </span>
            </div>
            <button
              onClick={handleToggleExplore}
              disabled={!socketClient.connected}
              className={`w-full px-2 py-1.5 rounded font-bold text-xs transition-colors disabled:opacity-40 ${
                exploreMode
                  ? 'bg-amber-700 hover:bg-amber-600 text-white'
                  : 'bg-emerald-700 hover:bg-emerald-600 text-white'
              }`}
            >
              {exploreMode ? '⬅ 返回战斗模式' : '🌍 进入探索模式'}
            </button>
            {exploreMode && (
              <div className="mt-1 border-t border-zinc-800 pt-1 space-y-1">
                <div className="flex justify-between text-zinc-400">
                  <span>地图</span>
                  <span className="font-mono text-zinc-200 text-[10px]">{mapData?.name ?? '未加载'}</span>
                </div>
                {mapData && (
                  <>
                    <div className="flex justify-between text-zinc-400">
                      <span>尺寸</span>
                      <span className="font-mono text-zinc-200">{mapData.width}×{mapData.height}</span>
                    </div>
                    <div className="flex justify-between text-zinc-400">
                      <span>瓦片数</span>
                      <span className="font-mono text-zinc-200">{mapData.tiles.length}</span>
                    </div>
                  </>
                )}
                <div className="flex justify-between text-zinc-400">
                  <span>实体数</span>
                  <span className="font-mono text-zinc-200">{Object.keys(exploreEntities).length}</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>FOW 已探索</span>
                  <span className="font-mono text-zinc-200">
                    {Object.values(hexVisibility).filter(v => v.explored).length}
                  </span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>FOW 可见</span>
                  <span className="font-mono text-zinc-200">
                    {Object.values(hexVisibility).filter(v => v.visible).length}
                  </span>
                </div>
                {/* FOW 视角切换 */}
                <div className="mt-2 pt-2 border-t border-zinc-800">
                  <div className="text-[10px] text-zinc-500 mb-1">FOW 视角</div>
                  <div className="flex flex-wrap gap-1">
                    {/* GM 可取消选择 → 全图无迷雾 */}
                    {permission.role === 'GM' && (
                      <button
                        onClick={() => useExploreStore.getState().setViewingEntityId(null)}
                        className={`px-2 py-1 rounded text-[10px] transition-colors ${
                          !viewingEntityId
                            ? 'bg-emerald-600 text-white'
                            : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                        }`}
                        title="GM 全局视野"
                      >
                        全图
                      </button>
                    )}
                    {Object.values(exploreEntities).map(e => {
                      const visibleCount = entityHexVisibility[e.id]?.length ?? 0;
                      return (
                        <button
                          key={e.id}
                          onClick={() => useExploreStore.getState().setViewingEntityId(e.id)}
                          className={`px-2 py-1 rounded text-[10px] transition-colors ${
                            viewingEntityId === e.id
                              ? 'bg-sky-600 text-white'
                              : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                          }`}
                          title={`可见 ${visibleCount} hex`}
                        >
                          {e.templateId ?? e.id.slice(0, 6)}
                          <span className="ml-1 text-[8px] opacity-60">({visibleCount})</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </Section>

        {/* 日志 */}
        <Section title={`操作日志 (${logs.length})`} expanded={expanded === 'log'} onToggle={() => toggleSection('log')}>
          <div className="max-h-32 overflow-y-auto space-y-0.5">
            {logs.length === 0 && (
              <div className="text-zinc-600 italic">暂无日志</div>
            )}
            {logs.map((log, i) => (
              <div key={i} className="flex gap-1 text-[10px]">
                <span className="text-zinc-600 font-mono shrink-0">{log.time}</span>
                <span className={log.ok ? 'text-green-300' : log.ok === false ? 'text-red-300' : 'text-zinc-300'}>
                  {log.text}
                </span>
                <LogBadge ok={log.ok} />
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
          {logs.length > 0 && (
            <button onClick={clearLogs} className="mt-1 text-[10px] text-zinc-600 hover:text-zinc-400">
              清空日志
            </button>
          )}
        </Section>
      </div>
    </div>
  );
};

// Collapsible section helper
const Section: React.FC<{
  title: string; expanded: boolean; onToggle: () => void; children: React.ReactNode;
}> = ({ title, expanded, onToggle, children }) => (
  <div className="border-b border-zinc-800 last:border-b-0">
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between px-3 py-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 transition-colors"
    >
      <span className="font-medium text-xs">{title}</span>
      <span className={`transform transition-transform ${expanded ? 'rotate-90' : ''}`}>▸</span>
    </button>
    {expanded && <div className="px-3 pb-2">{children}</div>}
  </div>
);
