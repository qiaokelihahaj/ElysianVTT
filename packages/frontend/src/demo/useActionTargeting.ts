import { useEffect } from 'react';
import type { DemoActionPreview, DemoCatalogAction } from '@hard-vtt/shared';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { demoApi, getDemoApiError } from './api';
import { useDemoStore } from './store';
import type { DemoCommandSender } from './Panels';
import { actionLabel, actionTacticalSummary, entityLabel, resourceCostLabel } from './format';

interface Selection {
  actorId: string;
  action: DemoCatalogAction;
  phase: 'entity' | 'cell' | 'submitting';
  preview?: DemoActionPreview;
  loading: boolean;
  generation: number;
  epoch?: number;
  message?: string;
}
interface TargetingStore {
  selection: Selection | null;
  generation: number;
  update: (selection: Selection | null) => void;
}
// Ephemeral UI only: never persisted or restored as an intent.
export const useTargetingStore = create<TargetingStore>()(immer((set) => ({
  selection: null, generation: 0,
  update: (selection) => set((state) => { state.selection = selection; state.generation++; }),
})));

export function useActionTargeting(send: DemoCommandSender) {
  const snapshot = useDemoStore((s) => s.snapshot);
  const session = useDemoStore((s) => s.session);
  const catalog = useDemoStore((s) => s.catalog);
  const connection = useDemoStore((s) => s.connection);
  const selectedId = useDemoStore((s) => s.selectedEntityId);
  const state = useTargetingStore((s) => s.selection);
  const enabled = catalog?.capabilities?.actionPreview === true;
  const cancel = () => useTargetingStore.getState().update(null);
  const notice = (message: string) => useDemoStore.getState().addNotice({ tone: 'info', message });

  useEffect(() => {
    const unsubscribe = useDemoStore.subscribe((current, previous) => {
      const selection = useTargetingStore.getState().selection;
      if (!selection) return;
      const actor = current.snapshot?.entities.find((e) => e.id === selection.actorId);
      const control = current.snapshot?.controls.find((c) => c.entityId === selection.actorId);
      const allowed = current.session?.session.role === 'GM' || current.session?.session.controlledEntityIds.includes(selection.actorId);
      const slot = current.snapshot?.plan.slots.find((s) => s.entityId === selection.actorId);
      const invalid = current.connection !== 'connected' || !actor || !allowed || current.snapshot?.paused || current.snapshot?.status !== 'ACTIVE' || control?.controlEpoch !== selection.epoch || current.selectedEntityId !== selection.actorId;
      const unavailable = selection.phase !== 'submitting' && (actor?.currentActionContext || slot?.ready || (actor?.resources.current.hp ?? 0) <= 0);
      if (invalid || unavailable) {
        useTargetingStore.getState().update(null);
        current.addNotice({ tone: 'info', message: '角色或对局状态已变化，已取消目标选择' });
      } else if (selection.phase !== 'submitting' && current.snapshot !== previous.snapshot) {
        useTargetingStore.getState().update({ ...selection, loading: true, preview: undefined, generation: selection.generation + 1 });
      }
    });
    return () => { unsubscribe(); useTargetingStore.getState().update(null); };
  }, []);

  useEffect(() => {
    if (state?.phase !== 'submitting') return;
    const timer = window.setTimeout(() => {
      if (useTargetingStore.getState().selection !== state) return;
      cancel();
      notice('尚未收到确认，请核对多人就绪状态后再操作；不会自动重发');
    }, 11000);
    return () => window.clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    if (!state || !state.loading || state.phase === 'submitting' || !session) return;
    let cancelled = false;
    const selection = state;
    void demoApi.previewAction(session.accessToken, selection.actorId, selection.action.id).then((preview) => {
      if (cancelled || useTargetingStore.getState().selection !== selection) return;
      if (!preview.available) { cancel(); notice(preview.reason ?? '当前动作不可用'); return; }
      if (preview.targetKind === 'none') {
        submit(selection, []);
      } else {
        useTargetingStore.getState().update({ ...selection, phase: preview.targetKind, preview, loading: false });
      }
    }).catch((error: unknown) => {
      if (cancelled || useTargetingStore.getState().selection !== selection) return;
      cancel(); notice(getDemoApiError(error).reason);
    });
    return () => { cancelled = true; };
    // Requests are tied to the immutable selection, including revision refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, session?.accessToken]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && useTargetingStore.getState().selection?.phase !== 'submitting') cancel();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  function submit(selection: Selection, targetIds: string[], cell?: { x: number; y: number }) {
    if (useTargetingStore.getState().selection !== selection) return;
    const sending = { ...selection, phase: 'submitting' as const, loading: false };
    useTargetingStore.getState().update(sending);
    send('ACTION', { entityId: selection.actorId, actionTemplateId: selection.action.id, targetIds, ...(cell ? { targetCoords: { ...cell, z: 0 } } : {}) }, selection.actorId, (result) => {
      if (useTargetingStore.getState().selection !== sending) return;
      if (result.ok) { cancel(); notice('已就绪，等待其他角色'); }
      else useTargetingStore.getState().update({ ...selection, preview: undefined, loading: true, generation: selection.generation + 1, message: result.reason });
    });
  }
  function choose(action: DemoCatalogAction) {
    const liveSelection = useTargetingStore.getState().selection;
    const canControlSelected = session?.session.role === 'GM' || Boolean(selectedId && session?.session.controlledEntityIds.includes(selectedId));
    if (!enabled || !selectedId || !canControlSelected || connection !== 'connected' || liveSelection?.phase === 'submitting') return;
    const epoch = snapshot?.controls.find((c) => c.entityId === selectedId)?.controlEpoch;
    useTargetingStore.getState().update({ actorId: selectedId, action, phase: 'entity', loading: true, generation: useTargetingStore.getState().generation + 1, epoch });
  }
  function pickEntity(id: string) {
    const selection = useTargetingStore.getState().selection;
    if (!selection || selection.loading || selection.phase === 'submitting') return;
    if (selection.phase === 'cell') {
      const entity = useDemoStore.getState().snapshot?.entities.find((e) => e.id === id);
      if (entity) pickCell(entity.transform.coords);
    } else if (selection.preview?.entities.find((e) => e.entityId === id)?.allowed) submit(selection, [id]);
  }
  function pickCell(cell: { x: number; y: number }) {
    const selection = useTargetingStore.getState().selection;
    if (!selection || selection.loading || selection.phase !== 'cell') return;
    if (selection.preview?.cells.find((c) => c.x === cell.x && c.y === cell.y)?.allowed) submit(selection, [], cell);
  }
  function selectEntity(id: string | null) {
    const liveSelection = useTargetingStore.getState().selection;
    if (liveSelection?.phase === 'submitting') return;
    const current = useDemoStore.getState();
    if (id && !current.snapshot?.entities.some((entity) => entity.id === id)) return;
    cancel();
    current.setSelectedEntity(id);
  }
  const immediate: DemoCommandSender = (type, payload, entityId, onResult) => {
    if (useTargetingStore.getState().selection?.phase === 'submitting') return;
    cancel();
    if (!entityId || !['WAIT', 'RECOVER'].includes(type)) { send(type, payload, entityId, onResult); return; }
    const sending: Selection = {
      actorId: entityId, phase: 'submitting', loading: false, generation: useTargetingStore.getState().generation + 1,
      epoch: snapshot?.controls.find((c) => c.entityId === entityId)?.controlEpoch,
      action: { id: type, label: type === 'WAIT' ? '等待' : '恢复资源', tags: [], startupTicks: 0, recoveryTicks: 0, resourceCost: {} },
    };
    useTargetingStore.getState().update(sending);
    send(type, payload, entityId, (result) => {
      if (useTargetingStore.getState().selection === sending) { cancel(); notice(result.ok ? '已就绪，等待其他角色' : result.reason ?? '提交被拒绝'); }
      onResult?.(result);
    });
  };
  const actor = snapshot?.entities.find((e) => e.id === state?.actorId);
  return { enabled, state, choose, cancel, pickEntity, pickCell, selectEntity, immediate,
    isGm: session?.session.role === 'GM',
    controlledIds: session?.session.controlledEntityIds ?? [],
    label: state ? `${actor ? entityLabel(actor) : ''} · ${actionLabel(state.action)}` : '',
    detail: state ? [resourceCostLabel(state.action), `${state.action.startupTicks}T 前摇`, `${state.action.recoveryTicks}T 收招`, actionTacticalSummary(state.action), state.action.description].filter(Boolean).join(' · ') : '',
  };
}
export type ActionTargeting = ReturnType<typeof useActionTargeting>;
