import type { DemoCatalogAction } from '@hard-vtt/shared';

import { actionGroup } from './format';

/** Original line icons; presentation follows catalog tags, never changes rules. */
export function ActionGlyph({ action }: { action: DemoCatalogAction }) {
  const tags = action.tags.map(tag => tag.toUpperCase());
  const group = actionGroup(action);
  const ranged = action.id.toUpperCase().includes('RANGED') || tags.includes('RANGED') || tags.includes('PROJECTILE');
  const path = action.spatial?.guard ? 'M16 3 27 8v9c0 6-6 10-11 12C11 27 5 23 5 17V8Z M10 16h12 M16 10v12'
    : action.spatial?.rotationDelta !== undefined ? 'M25 12a10 10 0 1 0 1 9 M25 5v8h-8 M13 11l7 5-7 5Z'
    : action.spatial?.weaponOperation ? 'M6 26 24 8 M19 4l9 9 M5 20l7 7 M21 20v9 M17 25l4 4 4-4'
    : action.spatial?.stance ? 'M4 16h24 M16 4v24 M9 9a10 10 0 0 1 14 14 M23 9a10 10 0 0 0-14 14'
    : action.spatial?.blockZone ? 'M6 6h20v20H6Z M4 11h24 M4 21h24 M11 4v24 M21 4v24'
    : group === '移动' ? 'M5 23 13 15 8 10 16 2 M16 2h-7 M16 2v7 M18 27l8-8-5-5 6-6'
    : ranged ? 'M4 16Q16 4 28 16 M5 16Q16 27 27 16 M16 16l9-9 M25 7h-5 M25 7v5'
    : tags.includes('CHANNEL') ? 'M16 3 6 17h8l-3 12 15-17h-9l4-9Z'
    : tags.includes('RESOURCE') ? 'M25 11a10 10 0 1 0 1 9 M25 4v8h-8 M16 11v10 M11 16h10'
    : group === '攻击' ? 'M7 25 25 7l2-4-5 2L5 23 M4 18l10 10 M4 28l4-4'
    : 'M12 4h8v8h8v8h-8v8h-8v-8H4v-8h8Z';
  return <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}
