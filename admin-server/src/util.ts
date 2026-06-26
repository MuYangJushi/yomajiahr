// 工具函数（迁自 server.mjs Helpers 段，逻辑逐字不变）。
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { Buffer } from "node:buffer";
import { AUDIT_LOG_PATH } from "./config.js";

export function log(level: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

export function normalizeUploadedFilename(rawName: string): string {
  const baseName = basename(String(rawName || "").replaceAll("\\", "/"));
  if (!baseName) {
    return "upload.bin";
  }
  const decoded = Buffer.from(baseName, "latin1").toString("utf8");
  return scoreFilename(decoded) > scoreFilename(baseName) ? decoded : baseName;
}

function scoreFilename(name: string): number {
  let score = 0;
  if (/[一-鿿]/.test(name)) score += 4;
  if (/[぀-ヿ]/.test(name)) score += 3;
  if (/[가-힯]/.test(name)) score += 3;
  if (name.includes("�")) score -= 10;
  const mojibake = name.match(/[ÃÂÐÑØæçèéêëîïðñòóôöøùúûüýþÿœžš]/g);
  score -= mojibake?.length || 0;
  return score;
}

// 写队列，避免并发 appendFileSync 交错 JSONL 行
let auditWriteQueue: Promise<void> = Promise.resolve();

/**
 * 操作人落审计的结构化形态（fix/0623）：`{ id, name }`——id 是稳定取证锚点（platformUserId），
 * name 是人类可读显示名（飞书/钉钉真实姓名、demo「比赛访客」）。审计台账/CSV 的 operatorName 优先显示 name。
 */
export type AuditOperator = { id: string; name?: string };

/** 从请求会话派生审计操作人 `{ id, name }`。无登录态时 id/name 皆空（→ 历史/系统来源语义）。 */
export function auditOperator(req: { user?: { platformUserId?: string; name?: string } }): AuditOperator {
  return { id: req.user?.platformUserId || "", name: req.user?.name || undefined };
}

// operator 是必填参数（#29）：编译器强制每个写操作落操作人。
// 形态二选一（fix/0623 起推荐对象）：
//   - AuditOperator `{ id, name }`：存结构化，台账显示 name、保留 id 取证；
//   - string（历史/兼容）：直接当 platformUserId 存。
// 内部合并进 details.operator；audit-labels.operatorName 两种都兜。空值视为系统/匿名/历史来源。
export function appendAuditLog(
  action: string,
  file: string,
  operator: string | AuditOperator,
  details?: Record<string, unknown>,
): void {
  const normalizedOperator =
    typeof operator === "string" ? operator || "" : { id: operator.id || "", name: operator.name || undefined };
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    file,
    details: { ...(details ?? {}), operator: normalizedOperator },
  };
  const line = JSON.stringify(entry) + "\n";
  auditWriteQueue = auditWriteQueue
    .then(() => appendFileSync(AUDIT_LOG_PATH, line, "utf-8"))
    .catch(() => {});
}

export function readAuditLog(): any[] {
  if (!existsSync(AUDIT_LOG_PATH)) return [];
  const content = readFileSync(AUDIT_LOG_PATH, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function csvEscape(val: unknown): string {
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
