/** 展示层容错：不修改服务端资源值，只将进度条限制在有效区间。 */
export function resourcePercent(current: number | undefined, maximum: number | undefined): number {
    if (current === undefined || maximum === undefined ||
        !Number.isFinite(current) || !Number.isFinite(maximum) || maximum <= 0) return 0;
    return Math.min(100, Math.max(0, current / maximum * 100));
}
