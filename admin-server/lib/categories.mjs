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

export const CATEGORY_DOC_ID_PREFIX = {
  attendance: "HR-ATT",
  staffing: "HR-STAFF",
  compensation: "HR-COMP",
  training: "HR-TRAIN",
  performance: "HR-PERF",
  general: "HR-GEN",
};
