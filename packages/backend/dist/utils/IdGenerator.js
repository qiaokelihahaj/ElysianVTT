"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateId = generateId;
exports.generatePrefixedId = generatePrefixedId;
const crypto_1 = require("crypto");
/**
 * 生成全局唯一的 ID (基于 UUID v4)
 * 用于 Entity、TickEvent、Session 等唯一标识
 */
function generateId() {
    return (0, crypto_1.randomUUID)();
}
/**
 * (可选) 生成带有特定前缀的 ID，方便在日志中调试区分
 * 例如: generatePrefixedId('evt') -> 'evt_123e4567-e89b-12d3...'
 */
function generatePrefixedId(prefix) {
    return `${prefix}_${(0, crypto_1.randomUUID)()}`;
}
//# sourceMappingURL=IdGenerator.js.map