/**
 * Single source of truth for HR policy categories.
 *
 * Used by: server.mjs (directory init + API), metadata-inference.mjs, frontend (via GET /api/categories).
 */

export const CATEGORIES = [
  "leave",
  "onboarding",
  "attendance",
  "compensation",
  "training",
  "general",
];

export const CATEGORY_DOC_ID_PREFIX = {
  leave: "HR-LEAVE",
  onboarding: "HR-ONBOARD",
  attendance: "HR-ATT",
  compensation: "HR-COMP",
  training: "HR-TRAIN",
  general: "HR-GEN",
};
