/**
 * 统一错误码定义
 * 用于权限系统、认证和网络层的错误响应
 */

export const ErrorCodes = {
    // 认证相关 (1xxx)
    UNAUTHENTICATED: 'UNAUTHENTICATED',           // 未认证或令牌无效
    AUTH_FAILED: 'AUTH_FAILED',                   // 认证失败
    INVALID_TOKEN: 'INVALID_TOKEN',               // 无效令牌
    TOKEN_EXPIRED: 'TOKEN_EXPIRED',               // 令牌已过期
    SESSION_EXPIRED: 'SESSION_EXPIRED',           // 会话已过期
    SESSION_REVOKED: 'SESSION_REVOKED',           // 会话已撤销

    // 授权相关 (2xxx)
    UNAUTHORIZED: 'UNAUTHORIZED',                 // 无权限执行操作
    PERMISSION_DENIED: 'PERMISSION_DENIED',       // 权限被拒绝
    INSUFFICIENT_PRIVILEGE: 'INSUFFICIENT_PRIVILEGE', // 权限不足
    PERMISSION_EXPIRED: 'PERMISSION_EXPIRED',     // 权限已过期

    // 意图与目标 (3xxx)
    INVALID_INTENT: 'INVALID_INTENT',             // 意图格式无效
    INVALID_TARGET: 'INVALID_TARGET',             // 目标不合法或不在作用域内
    INVALID_SCOPE: 'INVALID_SCOPE',               // 作用域无效
    INVALID_ACTOR: 'INVALID_ACTOR',               // actor 无效

    // 场景和连接状态 (4xxx)
    NOT_IN_SCENE: 'NOT_IN_SCENE',                 // 未加入任何场景
    NO_SUBJECT: 'NO_SUBJECT',                     // 权限主体未初始化
    NOT_CONNECTED: 'NOT_CONNECTED',               // Socket 未连接
    DUPLICATE_AUTHENTICATION: 'DUPLICATE_AUTHENTICATION', // 重复认证

    // 审计与操作 (5xxx)
    AUDIT_REQUIRED: 'AUDIT_REQUIRED',             // 操作需要审计确认
    OPERATION_NOT_AUDITABLE: 'OPERATION_NOT_AUDITABLE', // 操作不可审计

    // 资源与数据 (6xxx)
    RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',     // 资源不存在
    SNAPSHOT_NOT_FOUND: 'SNAPSHOT_NOT_FOUND',     // 权限快照不存在
    ENTITY_NOT_FOUND: 'ENTITY_NOT_FOUND',         // 实体不存在
    SCENE_NOT_FOUND: 'SCENE_NOT_FOUND',           // 场景不存在

    // 服务器错误 (5xxx)
    INTERNAL_ERROR: 'INTERNAL_ERROR',             // 内部服务器错误
    SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',   // 服务暂时不可用
    DATABASE_ERROR: 'DATABASE_ERROR',             // 数据库错误

    // 客户端错误 (4xxx)
    BAD_REQUEST: 'BAD_REQUEST',                   // 请求格式错误
    MISSING_PARAMETER: 'MISSING_PARAMETER',       // 缺少必需参数
    INVALID_PARAMETER: 'INVALID_PARAMETER',       // 参数无效

    // 限制与配额 (7xxx)
    RATE_LIMITED: 'RATE_LIMITED',                 // 超过速率限制
    QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',             // 超过配额限制
} as const;

/**
 * 错误消息映射
 */
export const ErrorMessages: Record<string, string> = {
    // 认证
    UNAUTHENTICATED: '未认证或认证令牌无效',
    AUTH_FAILED: '认证失败，请检查凭证',
    INVALID_TOKEN: '令牌格式或签名无效',
    TOKEN_EXPIRED: '令牌已过期，请重新登录',
    SESSION_EXPIRED: '会话已过期',
    SESSION_REVOKED: '会话已被撤销',

    // 授权
    UNAUTHORIZED: '您无权执行此操作',
    PERMISSION_DENIED: '权限被拒绝',
    INSUFFICIENT_PRIVILEGE: '权限等级不足',
    PERMISSION_EXPIRED: '权限已过期，请重新授权',

    // 意图与目标
    INVALID_INTENT: '控制意图格式无效',
    INVALID_TARGET: '目标实体不合法或不在您的可控范围内',
    INVALID_SCOPE: '作用域范围无效',
    INVALID_ACTOR: '角色或施事者无效',

    // 场景和连接状态
    NOT_IN_SCENE: '您未加入任何场景',
    NO_SUBJECT: '权限主体未初始化，请重新认证',
    NOT_CONNECTED: 'Socket 连接已断开',
    DUPLICATE_AUTHENTICATION: '已认证，无需重复认证',

    // 审计与操作
    AUDIT_REQUIRED: '此操作需要审计或 GM 确认',
    OPERATION_NOT_AUDITABLE: '此操作无法审计',

    // 资源与数据
    RESOURCE_NOT_FOUND: '请求的资源不存在',
    SNAPSHOT_NOT_FOUND: '权限快照不存在',
    ENTITY_NOT_FOUND: '实体不存在',
    SCENE_NOT_FOUND: '场景不存在',

    // 服务器错误
    INTERNAL_ERROR: '内部服务器错误',
    SERVICE_UNAVAILABLE: '服务暂时不可用',
    DATABASE_ERROR: '数据库操作失败',

    // 客户端错误
    BAD_REQUEST: '请求格式错误',
    MISSING_PARAMETER: '缺少必需参数',
    INVALID_PARAMETER: '参数值无效',

    // 限制与配额
    RATE_LIMITED: '请求过于频繁，请稍后重试',
    QUOTA_EXCEEDED: '已超过限额',
};

/**
 * HTTP 状态码映射
 */
export const ErrorHttpStatus: Record<string, number> = {
    UNAUTHENTICATED: 401,
    AUTH_FAILED: 401,
    INVALID_TOKEN: 401,
    TOKEN_EXPIRED: 401,
    SESSION_EXPIRED: 401,
    SESSION_REVOKED: 401,

    UNAUTHORIZED: 403,
    PERMISSION_DENIED: 403,
    INSUFFICIENT_PRIVILEGE: 403,
    PERMISSION_EXPIRED: 403,

    INVALID_INTENT: 400,
    INVALID_TARGET: 400,
    INVALID_SCOPE: 400,
    INVALID_ACTOR: 400,

    NOT_IN_SCENE: 400,
    NO_SUBJECT: 400,
    NOT_CONNECTED: 400,
    DUPLICATE_AUTHENTICATION: 400,

    AUDIT_REQUIRED: 403,
    OPERATION_NOT_AUDITABLE: 400,

    RESOURCE_NOT_FOUND: 404,
    SNAPSHOT_NOT_FOUND: 404,
    ENTITY_NOT_FOUND: 404,
    SCENE_NOT_FOUND: 404,

    INTERNAL_ERROR: 500,
    SERVICE_UNAVAILABLE: 503,
    DATABASE_ERROR: 500,

    BAD_REQUEST: 400,
    MISSING_PARAMETER: 400,
    INVALID_PARAMETER: 400,

    RATE_LIMITED: 429,
    QUOTA_EXCEEDED: 429,
};

/**
 * 标准错误响应
 */
export interface ErrorResponse {
    ok: false;
    code: string;
    message: string;
    details?: any;
    timestamp: number;
}

/**
 * 创建错误响应
 */
export function createErrorResponse(code: string, details?: any): ErrorResponse {
    return {
        ok: false,
        code,
        message: ErrorMessages[code] || '未知错误',
        details,
        timestamp: Date.now()
    };
}

/**
 * 获取错误的 HTTP 状态码
 */
export function getHttpStatus(code: string): number {
    return ErrorHttpStatus[code] || 500;
}
