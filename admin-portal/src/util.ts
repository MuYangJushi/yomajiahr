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

export function appendAuditLog(action: string, file: string, details: unknown): void {
  const entry = { timestamp: new Date().toISOString(), action, file, details };
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
