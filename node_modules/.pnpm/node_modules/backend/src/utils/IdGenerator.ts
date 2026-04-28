import { randomUUID } from 'crypto';

/**
 * 生成全局唯一的 ID (基于 UUID v4)
 * 用于 Entity、TickEvent、Session 等唯一标识
 */
export function generateId(): string {
    return randomUUID();
}

/**
 * (可选) 生成带有特定前缀的 ID，方便在日志中调试区分
 * 例如: generatePrefixedId('evt') -> 'evt_123e4567-e89b-12d3...'
 */
export function generatePrefixedId(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
}