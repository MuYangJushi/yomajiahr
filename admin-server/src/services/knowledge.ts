// 知识库平台适配（ADR-006 / FastGPT 集成）。
// admin-server 是唯一对 FastGPT 说话的人：持 API Key、做探活、做回退、记审计（审计在路由层）。
// #37 范围：health 完整可用 + 骨架；import/search/collections 在 FastGPT 实例就绪（Gate-B）后接通。
// 硬约束（CLAUDE.md / ADR-006）：FastGPT 不可用/未配置时必须能回退本地 memory_search / 本地归档，链路不能断。
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FASTGPT_API_KEY,
  FASTGPT_BASE_URL,
  FASTGPT_EMBEDDING_MODEL,
  FASTGPT_KB_ID,
  KNOWLEDGE_PLATFORM,
} from "../config.js";
import { STORE_DIR } from "./store.js";

// —— 类型 ——
export interface KbHealth {
  platform: "fastgpt" | "local";
  configured: boolean; // 必需 env 是否齐全（不回传值）
  reachable: boolean; // 探活结果（local 恒为 false，但 fallback 永远可用）
  kbId?: string;
  embeddingModel?: string;
  baseUrlHint?: string; // 仅回主机名提示，不回完整地址/凭据
  indexStatus: "ready" | "indexing" | "error" | "unknown";
  fallback: "local-memory-search";
  message?: string;
  checkedAt: string;
}
export interface KbChunk {
  text: string;
  score: number;
  source: { filename: string; doc_id?: string; version?: string; collectionId?: string };
}
export interface KbCollection {
  externalDocId: string;
  title: string;
  category?: string;
  doc_id?: string;
  version?: string;
  chunkCount?: number;
  indexStatus: "ready" | "indexing" | "error" | "unknown" | "local-archive";
  source: "fastgpt" | "local";
}

// —— 配置判定 ——
export function isFastgpt(): boolean {
  return KNOWLEDGE_PLATFORM === "fastgpt";
}
/** FastGPT 必需配置是否齐全（不暴露值）。 */
export function isConfigured(): boolean {
  return isFastgpt() && Boolean(FASTGPT_BASE_URL && FASTGPT_API_KEY && FASTGPT_KB_ID);
}

/** 未配置/未就绪时抛出，路由层翻成 503，前端据此回退/提示。 */
export class KnowledgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeUnavailableError";
  }
}

function baseUrlHint(): string | undefined {
  if (!FASTGPT_BASE_URL) return undefined;
  try {
    return new URL(FASTGPT_BASE_URL).host; // 仅 host:port，不含 path/凭据
  } catch {
    return undefined;
  }
}

// —— FastGPT HTTP（带超时；永不把 Key/原始错误外泄给前端）——
const DEFAULT_TIMEOUT_MS = 8000;

async function fgFetch(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${FASTGPT_BASE_URL}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${FASTGPT_API_KEY}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

// —— 探活 ——
export async function health(): Promise<KbHealth> {
  const base: KbHealth = {
    platform: isFastgpt() ? "fastgpt" : "local",
    configured: isConfigured(),
    reachable: false,
    kbId: FASTGPT_KB_ID || undefined,
    embeddingModel: FASTGPT_EMBEDDING_MODEL || undefined,
    baseUrlHint: baseUrlHint(),
    indexStatus: "unknown",
    fallback: "local-memory-search",
    checkedAt: new Date().toISOString(),
  };

  if (!isFastgpt()) {
    return { ...base, message: "当前使用本地知识库（memory_search / hr-chunks）" };
  }
  if (!isConfigured()) {
    return { ...base, message: "FastGPT 未配置完整（缺 BASE_URL/API_KEY/KB_ID）—— 已回退本地检索" };
  }
  // 可达性探活：用确认存在的轻量端点（4.8.22 实测 200）。
  try {
    const res = await fgFetch("/api/common/system/getInitData", { method: "GET" }, 5000);
    base.reachable = res.ok || res.status < 500;
    base.indexStatus = base.reachable ? "ready" : "unknown";
    base.message = base.reachable ? "FastGPT 可达" : `FastGPT 返回 ${res.status}`;
  } catch (err) {
    base.reachable = false;
    base.message = `FastGPT 不可达（${(err as Error).name}）—— 已回退本地检索`;
  }
  return base;
}

// FastGPT searchTest 的 score 是 [{type,value}]（embedding/fullText/reRank/rrf）；取最终分。
function pickScore(score: unknown): number {
  if (typeof score === "number") return score;
  if (!Array.isArray(score)) return 0;
  const byType = (t: string) => (score.find((s) => (s as any)?.type === t) as any)?.value;
  return byType("reRank") ?? byType("rrf") ?? byType("embedding") ?? (score[0] as any)?.value ?? 0;
}

// —— 检索（已对接 FastGPT 4.8.22 `POST /api/core/dataset/searchTest`，2026-06-10 实测）——
// 返回 chunk+来源元数据；retrieval-only，不生成答案（ADR-006）。失败抛 Unavailable，由调用方回退本地。
export async function search(query: string, topK = 5): Promise<KbChunk[]> {
  if (!isConfigured()) throw new KnowledgeUnavailableError("FastGPT 未配置，检索请回退本地 memory_search");
  let res: Response;
  try {
    res = await fgFetch("/api/core/dataset/searchTest", {
      method: "POST",
      body: JSON.stringify({
        datasetId: FASTGPT_KB_ID,
        text: query,
        limit: Math.max(1500, topK * 600), // FastGPT 用 token 预算而非条数；下方再按 topK 截断
        similarity: 0,
        searchMode: "embedding",
      }),
    });
  } catch (err) {
    throw new KnowledgeUnavailableError(`FastGPT 不可达（${(err as Error).name}）`);
  }
  if (!res.ok) throw new KnowledgeUnavailableError(`FastGPT 检索返回 ${res.status}`);
  const json = (await res.json()) as { data?: { list?: any[] } };
  const list = json?.data?.list ?? [];
  return list.slice(0, topK).map((it) => ({
    text: it.q || it.a || "",
    score: pickScore(it.score),
    source: {
      filename: it.sourceName || "",
      // doc_id/version：web 导入未注入自定义元数据 → undefined（路A best-effort 省略）；
      // #38 导入代理注入后，由 collection 元数据回填。
      doc_id: it.doc_id || undefined,
      version: it.version || undefined,
      collectionId: it.collectionId,
    },
  }));
}
export async function importDocument(
  _buf: Buffer,
  _name: string,
  _meta: Record<string, unknown>,
): Promise<{ externalDocId: string; collectionId: string }> {
  if (!isConfigured()) throw new KnowledgeUnavailableError("FastGPT 未配置，导入请走本地 doc-chunker");
  // TODO(Gate-B)：对接导入 API，注入 doc_id/version 为 per-chunk 自定义元数据（路A引用格式依赖）。
  throw new KnowledgeUnavailableError("FastGPT 导入 API 待实例就绪后接通（#38）");
}
export async function listCollections(): Promise<KbCollection[]> {
  if (!isConfigured()) throw new KnowledgeUnavailableError("FastGPT 未配置");
  // TODO(Gate-B)：列 FastGPT collection + 切片数 + 索引状态。
  throw new KnowledgeUnavailableError("FastGPT 集合列表待实例就绪后接通（#38）");
}
export async function removeCollection(_externalDocId: string): Promise<void> {
  if (!isConfigured()) throw new KnowledgeUnavailableError("FastGPT 未配置");
  throw new KnowledgeUnavailableError("FastGPT 删除 API 待实例就绪后接通（#38）");
}

// —— KB↔数字员工绑定（存自有平台 config-store/knowledge.json，守 ADR-002 边界）——
export interface KnowledgeBinding {
  id: string;
  name: string;
  provider: "fastgpt" | "local";
  externalKbId?: string;
  boundAgents: string[];
}
export interface KnowledgeStore {
  platform: "fastgpt" | "local";
  knowledgeBases: KnowledgeBinding[];
}

const STORE_PATH = join(STORE_DIR, "knowledge.json");
const DEFAULT_STORE: KnowledgeStore = {
  platform: "local",
  knowledgeBases: [
    { id: "kb_hr_policy", name: "HR 制度知识库", provider: "local", boundAgents: ["hr-assistant"] },
  ],
};

/** 读绑定；文件缺失（旧部署未播种）时返回默认，不抛错。 */
export function readKnowledgeStore(): KnowledgeStore {
  if (!existsSync(STORE_PATH)) return structuredClone(DEFAULT_STORE);
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf-8")) as KnowledgeStore;
  } catch {
    return structuredClone(DEFAULT_STORE);
  }
}

/** 原子写绑定。 */
export function writeKnowledgeStore(s: KnowledgeStore): void {
  const tmp = `${STORE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, STORE_PATH);
}
