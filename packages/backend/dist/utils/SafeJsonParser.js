"use strict";
// packages/backend/src/utils/SafeJsonParser.ts
// 安全 JSON 解析工具 — 替代裸 JSON.parse，防止数据库脏数据导致引擎崩溃
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeParse = safeParse;
exports.safeParseArray = safeParseArray;
exports.safeParseRecord = safeParseRecord;
/**
 * 安全解析 JSON 字符串为任意对象。
 * 解析失败或结果类型不匹配时返回 fallback，并输出警告日志。
 */
function safeParse(json, fallback, label) {
    if (!json || json.trim().length === 0) {
        warn('输入为空', label);
        return fallback;
    }
    try {
        const parsed = JSON.parse(json);
        return parsed;
    }
    catch (error) {
        warn(`解析异常: ${error.message}`, label);
        return fallback;
    }
}
/**
 * 安全解析 JSON 字符串为数组。
 * 解析结果不是数组时返回 fallback。
 */
function safeParseArray(json, fallback, label) {
    if (!json || json.trim().length === 0) {
        warn('输入为空', label);
        return fallback;
    }
    try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed)) {
            warn(`期望数组，实际得到: ${typeof parsed}`, label);
            return fallback;
        }
        return parsed;
    }
    catch (error) {
        warn(`解析异常: ${error.message}`, label);
        return fallback;
    }
}
/**
 * 安全解析 JSON 字符串为 Record。
 * 解析结果不是普通对象时（包括 null、数组）返回 fallback。
 */
function safeParseRecord(json, fallback, label) {
    if (!json || json.trim().length === 0) {
        warn('输入为空', label);
        return fallback;
    }
    try {
        const parsed = JSON.parse(json);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            warn(`期望普通对象，实际得到: ${parsed === null ? 'null' : typeof parsed === 'object' ? 'array' : typeof parsed}`, label);
            return fallback;
        }
        return parsed;
    }
    catch (error) {
        warn(`解析异常: ${error.message}`, label);
        return fallback;
    }
}
// --- 内部工具 ---
function warn(message, label) {
    const context = label ? `[SafeJsonParser] ${label}: ${message}` : `[SafeJsonParser] ${message}`;
    console.warn(context);
}
//# sourceMappingURL=SafeJsonParser.js.map