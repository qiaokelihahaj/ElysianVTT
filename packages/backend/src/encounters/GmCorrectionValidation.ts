import type { EncounterEntity } from '@hard-vtt/shared';

export type CorrectionValidation =
    | { ok: true; changes: Record<string, number | 'PUBLIC' | 'GM'> }
    | { ok: false; reason: string };

/** Validate the complete correction before changing any authoritative field. */
export function validateGmCorrection(entity: EncounterEntity, input: unknown): CorrectionValidation {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, reason: '修正内容必须是字段与数值的映射' };
    }
    const entries = Object.entries(input);
    if (entries.length === 0 || entries.length > 64) {
        return { ok: false, reason: '修正必须包含 1 至 64 个字段' };
    }
    const changes: Record<string, number | 'PUBLIC' | 'GM'> = {};
    for (const [path, value] of entries) {
        if (path === 'visibility') {
            if (value !== 'PUBLIC' && value !== 'GM') return { ok: false, reason: '可见性只能设为公开或仅 GM' };
            changes[path] = value;
            continue;
        }
        const resource = /^resources\.(current|max)\.([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(path);
        const coordinate = /^transform\.coords\.[xyz]$/.test(path);
        if (!resource && !coordinate && path !== 'transform.facing') {
            return { ok: false, reason: `不允许修正字段：${path}` };
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return { ok: false, reason: `字段 ${path} 必须是有限数字` };
        }
        if (resource) {
            const section = resource[1] === 'max' ? entity.resources.max : entity.resources.current;
            if (!Object.prototype.hasOwnProperty.call(section, resource[2])) {
                return { ok: false, reason: `实体没有资源：${resource[2]}` };
            }
            if (resource[1] === 'max' && value < 0) return { ok: false, reason: '资源上限不能为负数' };
        }
        changes[path] = value;
    }
    return { ok: true, changes };
}
