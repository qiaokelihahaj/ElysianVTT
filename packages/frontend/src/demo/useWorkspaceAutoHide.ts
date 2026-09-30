import { useEffect, useRef, useState, type RefObject } from 'react';
import { PANEL_IDS, type PanelId, type WorkspaceLayout } from './workspaceLayout';

interface Options {
  layout: WorkspaceLayout;
  compact: boolean;
  attention: boolean;
  panels: RefObject<Partial<Record<PanelId, HTMLElement>>>;
  busy: RefObject<PanelId | null>;
}

/** Transient visibility only; hovering must never overwrite a saved layout. */
export function useWorkspaceAutoHide(options: Options) {
  const [expanded, setExpanded] = useState<Partial<Record<PanelId, boolean>>>({});
  const latest = useRef(options);
  const inside = useRef(new Set<PanelId>());
  const retained = useRef(new Set<PanelId>());
  const suppressed = useRef(new Set<PanelId>());
  const keyboard = useRef(false);
  const touch = useRef(false);
  const opening = useRef(new Map<PanelId, ReturnType<typeof setTimeout>>());
  const closing = useRef(new Map<PanelId, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const previous = latest.current;
    latest.current = options;
    // A close timer may have expired while a reaction or compact layout held
    // the window open. Re-evaluate after that protection ends.
    if (previous.compact && !options.compact) PANEL_IDS.forEach(scheduleClose);
    else if (previous.attention && !options.attention) scheduleClose('actions');
  });

  function clearTimer(timers: typeof opening, id: PanelId) {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }
  function clear(id: PanelId) {
    clearTimer(opening, id);
    clearTimer(closing, id);
  }
  function protectedPanel(id: PanelId) {
    const current = latest.current;
    return current.compact || current.layout[id].pinned || (id === 'actions' && current.attention) || current.busy.current === id;
  }
  function focusHeld(id: PanelId) {
    const active = document.activeElement;
    return active instanceof HTMLElement && latest.current.panels.current[id]?.contains(active)
      && (keyboard.current || active.matches('input, textarea, select, [contenteditable="true"]')
        || Boolean(active.closest('[data-workspace-menu][open]')));
  }
  function close(id: PanelId) {
    clear(id);
    retained.current.delete(id);
    setExpanded(current => current[id] ? { ...current, [id]: false } : current);
    const active = document.activeElement;
    if (active instanceof HTMLElement && latest.current.panels.current[id]?.contains(active)) active.blur();
  }
  function scheduleClose(id: PanelId) {
    clearTimer(closing, id);
    closing.current.set(id, setTimeout(() => {
      closing.current.delete(id);
      if (protectedPanel(id) || inside.current.has(id) || retained.current.has(id) || focusHeld(id)) return;
      close(id);
    }, 500));
  }
  function open(id: PanelId, explicit = true) {
    clear(id);
    if (explicit) {
      suppressed.current.delete(id);
      retained.current.add(id);
    }
    setExpanded(current => ({ ...current, [id]: true }));
  }
  function enter(id: PanelId, tab: boolean, pointerType: string) {
    if (pointerType === 'touch' || latest.current.compact) return;
    inside.current.add(id);
    clearTimer(closing, id);
    if (!tab) {
      retained.current.delete(id);
      return;
    }
    const panel = latest.current.layout[id];
    if (suppressed.current.has(id) || (panel.pinned && panel.collapsed)) return;
    clearTimer(opening, id);
    opening.current.set(id, setTimeout(() => {
      opening.current.delete(id);
      if (inside.current.has(id) && !suppressed.current.has(id)) open(id, false);
    }, 150));
  }
  function leave(id: PanelId, pointerType: string) {
    if (pointerType === 'touch') return;
    inside.current.delete(id);
    clearTimer(opening, id);
    scheduleClose(id);
  }
  function minimize(id: PanelId) {
    suppressed.current.add(id);
    inside.current.delete(id);
    close(id);
  }
  function reset() {
    for (const id of PANEL_IDS) clear(id);
    inside.current.clear();
    retained.current.clear();
    suppressed.current.clear();
    setExpanded({});
  }

  useEffect(() => {
    const openingTimers = opening.current;
    const closingTimers = closing.current;
    const keydown = () => { keyboard.current = true; touch.current = false; };
    const pointerdown = (event: globalThis.PointerEvent) => {
      keyboard.current = false;
      touch.current = event.pointerType === 'touch';
      if (!(event.target instanceof Element)) return;
      const owner = event.target.closest('.workspace-window, .workspace-dock-tab')?.getAttribute('data-panel');
      for (const id of PANEL_IDS) {
        if (id === owner) {
          if (touch.current) retained.current.add(id);
          else retained.current.delete(id);
        }
        if (id !== owner && !protectedPanel(id)) close(id);
      }
    };
    const pointermove = (event: globalThis.PointerEvent) => {
      if (suppressed.current.size === 0 || !(event.target instanceof Element)) return;
      const owner = event.target.closest('.workspace-window, .workspace-dock-tab')?.getAttribute('data-panel');
      for (const id of suppressed.current) if (id !== owner) suppressed.current.delete(id);
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('pointerdown', pointerdown, true);
    document.addEventListener('pointermove', pointermove, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('pointerdown', pointerdown, true);
      document.removeEventListener('pointermove', pointermove, true);
      for (const timer of openingTimers.values()) clearTimeout(timer);
      for (const timer of closingTimers.values()) clearTimeout(timer);
    };
    // Event handlers read live layout and focus state; timer ownership is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { expanded, open, close, enter, leave, minimize, reset, clear, scheduleClose,
    focus: (id: PanelId) => { if (!touch.current) retained.current.delete(id); if (focusHeld(id)) clearTimer(closing, id); },
    blur: (id: PanelId) => scheduleClose(id),
  };
}
