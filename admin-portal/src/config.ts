// 运行时配置与目录（迁自 server.mjs 顶部 Config 段，行为不变）。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { CATEGORIES } from "../lib/categories.mjs";

// 运行文件位于 dist/server.js；据此推导目录。
const ADMIN_DIR = join(import.meta.dirname, ".."); // admin-portal/
export const REPO_DIR = join(ADMIN_DIR, ".."); // 仓库根（含 config/）
export const PUBLIC_DIR = join(ADMIN_DIR, "public");

export const PORT = Number(env.ADMIN_PORTAL_PORT || env.PORT || 18790);
export const STATE_DIR = env.OPENCLAW_STATE_DIR || join(env.HOME!, ".openclaw");
export const POLICIES_DIR = join(STATE_DIR, "data", "hr-policies");
export const AUDIT_LOG_PATH = join(STATE_DIR, "data", "hr-admin", "audit-log.jsonl");
export const CHUNKS_DIR = join(STATE_DIR, "data", "hr-chunks");
export const AUTH_TOKEN = env.OPENCLAW_WEB_AUTH_TOKEN || "";
export const BIND_HOST = env.ADMIN_PORTAL_BIND || "";
export const MAX_UPLOAD_FILE_MB = Math.max(1, Number(env.ADMIN_PORTAL_MAX_UPLOAD_MB || 50));
export const MAX_UPLOAD_FILE_BYTES = MAX_UPLOAD_FILE_MB * 1024 * 1024;

/** 确保知识库目录存在（迁自 server.mjs 启动段）。 */
export function ensureDirs(): void {
  for (const dir of [
    POLICIES_DIR,
    ...CATEGORIES.map((cat: string) => join(POLICIES_DIR, cat)),
    CHUNKS_DIR,
    ...CATEGORIES.map((cat: string) => join(CHUNKS_DIR, cat)),
    join(STATE_DIR, "data", "hr-admin"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
