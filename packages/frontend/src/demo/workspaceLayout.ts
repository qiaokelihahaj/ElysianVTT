export const PANEL_IDS = ['actions', 'entities', 'timeline', 'logs', 'gm'] as const;
export type PanelId = typeof PANEL_IDS[number];
export type DockEdge = 'top' | 'bottom' | 'left' | 'right';
export interface PanelLayout { collapsed: boolean; hidden: boolean; pinned: boolean; dockEdge: DockEdge; x: number; y: number; width: number; height: number; }
export type WorkspaceLayout = Record<PanelId, PanelLayout>;

export type Viewport = { width: number; height: number; headerHeight?: number };
const fallbackViewport = { width: 1600, height: 1000 };
export function defaultWorkspaceLayout(viewport: Viewport = fallbackViewport): WorkspaceLayout {
  const sidebar = viewport.width >= 1200;
  const rosterWidth = Math.min(500, viewport.width - 24);
  // Reserve both 28px edge tracks and a gap before the entity roster, so
  // independently pinned defaults do not overlap after docking.
  const mainWidth = sidebar ? viewport.width - rosterWidth - 84 : viewport.width - 56;
  const timelineWidth = Math.min(960, mainWidth);
  const barWidth = Math.min(860, mainWidth);
  const mainCenter = sidebar ? 28 + mainWidth / 2 : viewport.width / 2;
  // Keep the two high-frequency windows in separate vertical bands on short
  // laptop viewports.  Their bodies scroll internally, so a smaller shell
  // leaves more of the battlefield visible without removing any controls.
  const timelineHeight = 220;
  const actionHeight = 220;
  const timelineY = (viewport.headerHeight ?? 68) + 12;
  const timelineBottom = timelineY + timelineHeight;
  return {
    actions: { collapsed: false, hidden: false, pinned: false, dockEdge: 'bottom', x: mainCenter - barWidth / 2, y: viewport.height - actionHeight - 12, width: barWidth, height: actionHeight },
    timeline: { collapsed: false, hidden: false, pinned: false, dockEdge: 'top', x: mainCenter - timelineWidth / 2, y: timelineY, width: timelineWidth, height: timelineHeight },
    entities: { collapsed: false, hidden: false, pinned: false, dockEdge: 'right', x: viewport.width - rosterWidth - 28, y: (viewport.headerHeight ?? 68) + 56, width: rosterWidth, height: 420 },
    logs: { collapsed: false, hidden: false, pinned: false, dockEdge: 'left', x: 12, y: timelineBottom + 12, width: 300, height: 420 },
    gm: { collapsed: false, hidden: false, pinned: false, dockEdge: 'left', x: 12, y: timelineBottom + 66, width: 300, height: 480 },
  };
}

export function readWorkspaceLayout(raw: string | null, viewport: Viewport = fallbackViewport): WorkspaceLayout {
  const defaults = defaultWorkspaceLayout(viewport);
  try {
    const parsed: unknown = JSON.parse(raw ?? 'null');
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || (parsed.version !== 2 && parsed.version !== 3) || !('panels' in parsed)) return defaults;
    const panels = parsed.panels;
    if (!panels || typeof panels !== 'object') return defaults;
    for (const id of PANEL_IDS) {
      if (!(id in panels)) continue;
      const value: unknown = panels[id as keyof typeof panels];
      if (!value || typeof value !== 'object') continue;
      const flags = parsed.version === 3 ? ['collapsed', 'hidden', 'pinned'] as const : ['hidden'] as const;
      for (const flag of flags) {
        if (flag in value && typeof value[flag as keyof typeof value] === 'boolean') defaults[id][flag] = value[flag as keyof typeof value] as boolean;
      }
      for (const field of ['x', 'y', 'width', 'height'] as const) {
        if (field in value) {
          const number = value[field as keyof typeof value];
          if (typeof number === 'number' && Number.isFinite(number)) defaults[id][field] = Math.max(0, Math.min(4000, number));
        }
      }
      if (parsed.version === 2) defaults[id].dockEdge = nearestDockEdge(defaults[id], viewport);
      else if ('dockEdge' in value && (value.dockEdge === 'top' || value.dockEdge === 'bottom' || value.dockEdge === 'left' || value.dockEdge === 'right')) defaults[id].dockEdge = value.dockEdge;
    }
  } catch { /* A corrupt or older layout must never block the encounter. */ }
  return defaults;
}

export function nearestDockEdge(panel: PanelLayout, viewport: Viewport, preferred: DockEdge = panel.dockEdge, movement?: { x: number; y: number }): DockEdge {
  // Manual minimization must not make a tall window appear closer to the top.
  const distances: Record<DockEdge, number> = {
    top: Math.abs(panel.y - (viewport.headerHeight ?? 68)),
    bottom: Math.abs(viewport.height - panel.y - panel.height),
    left: Math.abs(panel.x),
    right: Math.abs(viewport.width - panel.x - panel.width),
  };
  let closest = preferred;
  for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
    if (distances[edge] < distances[closest]) closest = edge;
  }
  // Keep a tied existing edge stable. Otherwise use the last actual movement
  // toward a nearest edge, without letting direction override distance.
  if (distances[preferred] === distances[closest] || !movement) return closest;
  const toward: Record<DockEdge, number> = { top: -movement.y, bottom: movement.y, left: -movement.x, right: movement.x };
  let strongest = 0;
  for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
    if (distances[edge] === distances[closest] && toward[edge] > strongest) {
      closest = edge;
      strongest = toward[edge];
    }
  }
  return closest;
}

export function fitDockedPanel(panel: PanelLayout, viewport: Viewport): PanelLayout {
  const viewportWidth = Math.max(1, viewport.width);
  const viewportHeight = Math.max(1, viewport.height);
  const header = Math.max(0, Math.min(viewport.headerHeight ?? 68, viewportHeight - 1));
  // Keep a 28px label track around the work area. Tiny viewports shrink the
  // tracks first so the complete expanded window still fits inside the screen.
  const horizontalInset = Math.min(28, (viewportWidth - 1) / 2);
  const verticalInset = Math.min(28, (viewportHeight - header - 1) / 2);
  const left = horizontalInset;
  const right = viewportWidth - horizontalInset;
  const top = header + verticalInset;
  const bottom = viewportHeight - verticalInset;
  const width = Math.min(Math.max(300, panel.width), right - left);
  const height = Math.min(Math.max(180, panel.height), bottom - top);
  const x = panel.dockEdge === 'left' ? left : panel.dockEdge === 'right' ? right - width : Math.max(left, Math.min(panel.x, right - width));
  const y = panel.dockEdge === 'top' ? top : panel.dockEdge === 'bottom' ? bottom - height : Math.max(top, Math.min(panel.y, bottom - height));
  return { ...panel, x, y, width, height };
}

export function fitPanel(panel: PanelLayout, viewport: Viewport): PanelLayout {
  const top = Math.min((viewport.headerHeight ?? 68) + 12, Math.max(12, viewport.height - 54));
  const width = Math.min(Math.max(300, panel.width), Math.max(1, viewport.width - 24));
  const height = Math.min(Math.max(180, panel.height), Math.max(42, viewport.height - top - 12));
  return { ...panel, width, height,
    x: Math.max(12, Math.min(panel.x, viewport.width - width - 12)),
    y: Math.max(top, Math.min(panel.y, viewport.height - (panel.collapsed ? 42 : height) - 12)),
  };
}

/** Project window centers onto the edge, moving only crowded labels apart. */
export function layoutDockTabs(panels: readonly { id: PanelId; panel: PanelLayout }[], edge: DockEdge, viewport: Viewport): {
  start: number; end: number; extent: number; tabs: { id: PanelId; offset: number; length: number }[];
} {
  const horizontal = edge === 'top' || edge === 'bottom';
  const start = horizontal ? 36 : (viewport.headerHeight ?? 68) + (edge === 'right' ? 58 : 36);
  const end = Math.max(start, horizontal ? viewport.width - 58 : viewport.height - 36);
  const length = horizontal ? 96 : 90;
  const gap = 4;
  const extent = Math.max(end - start, panels.length * length + Math.max(0, panels.length - 1) * gap);
  const anchors = panels.map(({ id, panel }) => {
    const expanded = { ...panel, collapsed: false };
    const fitted = panel.pinned ? fitPanel(expanded, viewport) : fitDockedPanel(expanded, viewport);
    return { id, center: horizontal ? fitted.x + fitted.width / 2 : fitted.y + fitted.height / 2 };
  }).sort((a, b) => a.center - b.center || PANEL_IDS.indexOf(a.id) - PANEL_IDS.indexOf(b.id));
  const tabs = anchors.map(({ id, center }) => ({ id, length, offset: Math.max(0, Math.min(center - start - length / 2, extent - length)) }));
  for (let i = 1; i < tabs.length; i++) tabs[i].offset = Math.max(tabs[i].offset, tabs[i - 1].offset + length + gap);
  // Push a crowded group back inside the track without moving distant labels.
  let limit = extent;
  for (let i = tabs.length - 1; i >= 0; i--) {
    tabs[i].offset = Math.min(tabs[i].offset, limit - length);
    limit = tabs[i].offset - gap;
  }
  return { start, end, extent, tabs };
}
