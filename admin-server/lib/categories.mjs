/**
 * Single source of truth for HR policy categories.
 *
 * Used by: server.mjs (directory init + API), metadata-inference.mjs, frontend (via GET /api/categories).
 */

export const CATEGORIES = [
  "attendance",
  "staffing",
  "compensation",
  "training",
  "performance",
  "general",
];

// 受限分类：内容仅 admin 可见（ADR-009 Gate-3 / 员工层 hr-policy-qa 受限级一致）。
// 真相源在此，知识库管理页切片预览与员工召回层共用同一判定。
export const RESTRICTED_CATEGORIES = ["compensation", "performance"];

export const CATEGORY_DOC_ID_PREFIX = {
  attendance: "HR-ATT",
  staffing: "HR-STAFF",
  compensation: "HR-COMP",
  training: "HR-TRAIN",
  performance: "HR-PERF",
  general: "HR-GEN",
};
