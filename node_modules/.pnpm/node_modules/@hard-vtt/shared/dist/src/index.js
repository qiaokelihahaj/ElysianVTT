"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LogVisibility = exports.LogLevel = void 0;
// ==========================================
// 4. 日志协议 (Log Protocol)
// ==========================================
var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["DEBUG"] = 0] = "DEBUG";
    LogLevel[LogLevel["INFO"] = 1] = "INFO";
    LogLevel[LogLevel["WARN"] = 2] = "WARN";
    LogLevel[LogLevel["ERROR"] = 3] = "ERROR";
    LogLevel[LogLevel["GAME"] = 4] = "GAME"; // 游戏内核心事件（造成伤害、施加Buff等），这部分用于前端展示和回放
})(LogLevel || (exports.LogLevel = LogLevel = {}));
var LogVisibility;
(function (LogVisibility) {
    LogVisibility["DEV"] = "DEV";
    LogVisibility["GM"] = "GM";
    LogVisibility["PLAYER"] = "PLAYER"; // 所有人可见（战斗记录面板）
})(LogVisibility || (exports.LogVisibility = LogVisibility = {}));
//# sourceMappingURL=index.js.map