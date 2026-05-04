# ElysianVTT 文档索引

## 快速导航

| 文档 | 位置 | 说明 |
|------|------|------|
| [项目概要](./PROJECT_OVERVIEW.md) | `docs/` | 架构师与开发人员快速入门，含模块清单、类型体系、数据库模型、引擎机制 |
| [认证握手流程](./AUTHENTICATION_HANDSHAKE.md) | `docs/` | Socket 认证握手完整流程与客户端示例 |

---

## 权限系统设计

| 文档 | 说明 |
|------|------|
| [权限系统文稿索引](./permissions/权限系统文稿索引.md) | 四份权限文稿的导航与阅读顺序 |
| [权限系统架构与开发计划](./permissions/权限系统架构与开发计划.md) | 总架构、设计取舍、分阶段实施路线 |
| [权限矩阵表](./permissions/权限矩阵表.md) | GM/PL/OB 在 6 个资源域的权限边界 |
| [接口草案](./permissions/接口草案.md) | 认证、授权、日志、骰子、审计接口定义 |
| [数据模型草案](./permissions/数据模型草案.md) | 数据库实体、关系、索引设计 |

---

## 代码审查报告 (2026-04-30)

| 文档 | 说明 |
|------|------|
| [审查文档索引](./review/REVIEW_DOCUMENTATION_INDEX.md) | 审查报告体系导航 |
| [最终验证报告](./review/ISSUES_VERIFICATION_FINAL.md) | 14 个 Critical Issue 逐项代码验证 |
| [完整问题清单](./review/ISSUES_CONSOLIDATED_REPORT.md) | 53 个去重问题的详细描述与修复建议 |
| [CSV 问题表](./review/ISSUES_CONSOLIDATED_REPORT.csv) | 可导入 Jira/Excel 的 CSV 格式 |
| [按模块分类](./review/ISSUES_BY_MODULE.md) | 7 个模块的问题分布与工作量 |
| [快速参考](./review/ISSUES_QUICK_REFERENCE.md) | 按优先级排序的速查表 |
| [执行清单](./review/REVIEW_EXECUTION_CHECKLIST.md) | 项目经理与技术负责人的行动清单 |
| [测试规范报告](./review/COMPLIANCE_REPORT.md) | 测试规范符合性检查 |
| [集成测试摘要](./review/INTEGRATION_TEST_SUMMARY.md) | 测试覆盖与通过状态 |

---

## 实现报告

| 文档 | 日期 | 说明 |
|------|------|------|
| [权限系统修复报告](./reports/PERMISSIONS_FIX_REPORT.md) | 2026-05-04 | CORS/错误码/权限矩阵测试修复 |
| [权限实现评审](./reports/PERMISSIONS_IMPLEMENTATION_REVIEW.md) | 2026-05-04 | 5 个 Phase 的实现进度全面评审 |

---

## 其他

- 测试套件文档：[test/README.md](../test/README.md)
- 后端架构文档：[packages/backend/src/README.md](../packages/backend/src/README.md)
