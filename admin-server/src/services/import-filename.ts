import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import mammoth from "mammoth";
import { STATE_DIR } from "../config.js";
import { normalizeUploadedFilename } from "../util.js";

export type ImportFilenameSource = "original" | "workspace-hash" | "doc-title" | "fallback";

export interface ResolvedImportFilename {
  filename: string;
  source: ImportFilenameSource;
  originalFilename: string;
}

interface ResolveImportFilenameOptions {
  filePath: string;
  fileBuffer: Buffer;
  agentId?: string;
  stateDir?: string;
  now?: Date;
}

const MOJIBAKE_RE = /[ÃÂÐÑØÆæÇçÈèÉéÊêËëÎîÏïÐðÑñÒòÓóÔôÖöØøÙùÚúÛûÜüÝýÞþÿŒœŽžŠšÄäÅå¼½¾]/g;
const UUID_SUFFIX_RE = /---[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[^.]+)$/i;
const TIMESTAMP_SUFFIX_RE = /-\d{13}(\.[^.]+)$/;

export async function resolveImportFilename(options: ResolveImportFilenameOptions): Promise<ResolvedImportFilename> {
  const originalFilename = normalizeUploadedFilename(basename(options.filePath));
  if (!isLikelyCorruptFilename(originalFilename)) {
    return { filename: originalFilename, source: "original", originalFilename };
  }

  const fromWorkspace = recoverFilenameFromWorkspaceInbound(options);
  if (fromWorkspace) {
    return { filename: fromWorkspace, source: "workspace-hash", originalFilename };
  }

  const fromDocTitle = await recoverFilenameFromDocumentTitle(options.fileBuffer, originalFilename);
  if (fromDocTitle) {
    return { filename: fromDocTitle, source: "doc-title", originalFilename };
  }

  return { filename: fallbackImportFilename(originalFilename, options.now ?? new Date()), source: "fallback", originalFilename };
}

export function isLikelyCorruptFilename(filename: string): boolean {
  const name = basename(filename);
  if (!name || name === "upload.bin") return false;
  if (/[一-鿿]/.test(name)) return false;
  if (name.includes("�")) return true;
  const mojibakeCount = name.match(MOJIBAKE_RE)?.length ?? 0;
  const underscoreCount = name.match(/_/g)?.length ?? 0;
  // 飞书 media pipeline 的坏名形态：UTF-8 被按 latin1 误读后，0x80-0x9F 控制字节在 sanitize
  // 时变成 "_" 或直接丢失，如「个」E4 B8 AA → "ä_ª"。普通西文文件名（résumé）不应命中。
  return mojibakeCount >= 3 && underscoreCount >= 1;
}

function recoverFilenameFromWorkspaceInbound(options: ResolveImportFilenameOptions): string | undefined {
  if (!options.agentId) return undefined;
  const inboundDir = join(options.stateDir ?? STATE_DIR, "workspaces", options.agentId, "media", "inbound");
  if (!existsSync(inboundDir)) return undefined;
  const targetSize = options.fileBuffer.byteLength;
  const targetHash = sha256(options.fileBuffer);
  const candidates = readdirSync(inboundDir)
    .map((name) => ({ name, path: join(inboundDir, name) }))
    .filter((item) => {
      try {
        return statSync(item.path).isFile() && statSync(item.path).size === targetSize;
      } catch {
        return false;
      }
    });
  for (const item of candidates) {
    try {
      if (sha256(readFileSync(item.path)) !== targetHash) continue;
      const normalized = stripOpenClawSuffix(normalizeUploadedFilename(item.name));
      if (normalized && !isLikelyCorruptFilename(normalized)) return normalized;
    } catch {
      // 忽略竞态删除/权限异常，继续尝试其他候选。
    }
  }
  return undefined;
}

async function recoverFilenameFromDocumentTitle(fileBuffer: Buffer, originalFilename: string): Promise<string | undefined> {
  const ext = extname(originalFilename).toLowerCase();
  if (ext !== ".docx") return undefined;
  try {
    const { value } = await mammoth.extractRawText({ buffer: fileBuffer });
    const title = titleFromDocumentText(value);
    return title ? `${title}${ext}` : undefined;
  } catch {
    return undefined;
  }
}

export function titleFromDocumentText(text: string): string | undefined {
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return undefined;
  const title = first
    .replace(/\s+/g, " ")
    .split(/\s+HR\s+知识库文档|\s*[|｜]\s*文档编号|\s+文档编号\s*[：:]/)[0]
    .trim();
  const safe = sanitizeFilenameStem(title);
  return safe.length >= 2 ? safe.slice(0, 80) : undefined;
}

function fallbackImportFilename(originalFilename: string, now: Date): string {
  const ext = extname(originalFilename) || ".bin";
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
  return `渠道导入文档-${stamp}${ext}`;
}

function stripOpenClawSuffix(filename: string): string {
  return filename.replace(UUID_SUFFIX_RE, "$1").replace(TIMESTAMP_SUFFIX_RE, "$1");
}

function sanitizeFilenameStem(stem: string): string {
  return stem
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
