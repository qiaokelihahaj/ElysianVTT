/**
 * 安全解析 JSON 字符串为任意对象。
 * 解析失败或结果类型不匹配时返回 fallback，并输出警告日志。
 */
export declare function safeParse<T>(json: string, fallback: T, label?: string): T;
/**
 * 安全解析 JSON 字符串为数组。
 * 解析结果不是数组时返回 fallback。
 */
export declare function safeParseArray<T>(json: string, fallback: T[], label?: string): T[];
/**
 * 安全解析 JSON 字符串为 Record。
 * 解析结果不是普通对象时（包括 null、数组）返回 fallback。
 */
export declare function safeParseRecord(json: string, fallback: Record<string, any>, label?: string): Record<string, any>;
//# sourceMappingURL=SafeJsonParser.d.ts.map