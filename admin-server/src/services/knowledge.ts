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
import { upsertEnv } from "./secrets.js";
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
export interface KnowledgeConfigInput {
  platform?: "fastgpt" | "local";
  baseUrl?: string;
  apiKey?: string;
  kbId?: string;
  embeddingModel?: string;
  mcpToken?: string;
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

function envValue(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} 必须是字符串`);
  if (/[\r\n]/.test(value)) throw new Error(`${name} 不能包含换行`);
  return value;
}

/** 配置值只进 secrets 服务管理的 .env；调用方只能拿到更新过的键名。 */
export function updateKnowledgeConfig(input: KnowledgeConfigInput): string[] {
  const entries: Record<string, string> = {};
  if (input.platform !== undefined) {
    if (input.platform !== "fastgpt" && input.platform !== "local") throw new Error("platform 仅支持 fastgpt 或 local");
    entries.KNOWLEDGE_PLATFORM = input.platform;
  }
  if (input.baseUrl !== undefined) {
    const baseUrl = envValue("baseUrl", input.baseUrl);
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("baseUrl 仅支持 http/https");
    if (url.username || url.password) throw new Error("baseUrl 不能包含用户名或密码");
    entries.FASTGPT_BASE_URL = baseUrl.replace(/\/$/, "");
  }
  if (input.apiKey !== undefined) entries.FASTGPT_API_KEY = envValue("apiKey", input.apiKey);
  if (input.kbId !== undefined) entries.FASTGPT_KB_ID = envValue("kbId", input.kbId);
  if (input.embeddingModel !== undefined) entries.FASTGPT_EMBEDDING_MODEL = envValue("embeddingModel", input.embeddingModel);
  if (input.mcpToken !== undefined) entries.KNOWLEDGE_MCP_TOKEN = envValue("mcpToken", input.mcpToken);
  if (Object.keys(entries).length === 0) throw new Error("至少提供一个知识库配置项");
  upsertEnv(entries);
  return Object.keys(entries);
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
    // 系统探活只能证明 FastGPT 可达，不能证明目标 KB 已完成索引。
    // collection/index API 在后续任务接通前，必须诚实返回 unknown。
    base.message = res.ok ? "FastGPT 可达" : `FastGPT 可达，但探活返回 ${res.status}`;
  } catch (err) {
    base.reachable = false;
    base.message = `FastGPT 不可达（${(err as Error).name}）—— 已回退本地检索`;
  }
  return base;
}

// —— collectionId → 结构化元数据 回填（#40 探针实测：searchTest 不扁平回吐 doc_id/version，
//    元数据存在 collection 级，需经 collection/detail 解析）。带 TTL 缓存；失败静默降级（回退链不能断）。——
interface CollectionMeta {
  doc_id?: string;
  version?: string;
  category?: string;
  filename?: string;
}
const COLLECTION_META_TTL_MS = 5 * 60_000;
const collectionMetaCache = new Map<string, { meta: CollectionMeta; expiresAt: number }>();

/** 去掉导入时注入的 `[doc_id] ` name 前缀，还原可读文件名。 */
function stripDocIdPrefix(name: string): string {
  return name.replace(/^\[[^\]]+\]\s*/, "");
}

/** 取单个 collection 的结构化元数据；任何失败返回 {}（best-effort，绝不抛、绝不断检索）。 */
async function resolveCollectionMeta(collectionId: string): Promise<CollectionMeta> {
  if (!collectionId) return {};
  const cached = collectionMetaCache.get(collectionId);
  if (cached && cached.expiresAt > Date.now()) return cached.meta;
  let meta: CollectionMeta = {};
  try {
    const res = await fgFetch(`/api/core/dataset/collection/detail?id=${encodeURIComponent(collectionId)}`, { method: "GET" });
    if (res.ok) {
      const json = (await res.json()) as { data?: { name?: string; sourceName?: string; metadata?: Record<string, unknown> } };
      const m = json?.data?.metadata ?? {};
      const rawName = json?.data?.sourceName || json?.data?.name || "";
      meta = {
        doc_id: typeof m.doc_id === "string" ? m.doc_id : undefined,
        version: typeof m.version === "string" ? m.version : undefined,
        category: typeof m.category === "string" ? m.category : undefined,
        filename: (typeof m.source_file === "string" && m.source_file) || stripDocIdPrefix(rawName) || undefined,
      };
    }
  } catch {
    // 网络/超时/解析失败：保持 {}，引用按路 A best-effort 省略 doc_id/version。
  }
  collectionMetaCache.set(collectionId, { meta, expiresAt: Date.now() + COLLECTION_META_TTL_MS });
  return meta;
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

/** 对单个 dataset 跑一次 searchTest 并回填来源元数据。失败抛 KnowledgeUnavailableError。 */
async function searchOneDataset(datasetId: string, query: string, topK: number): Promise<KbChunk[]> {
  let res: Response;
  try {
    res = await fgFetch("/api/core/dataset/searchTest", {
      method: "POST",
      body: JSON.stringify({
        datasetId,
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
  const hits = (json?.data?.list ?? []).slice(0, topK);

  // searchTest 不回吐 doc_id/version（#40 探针实测）→ 按命中里出现的 collectionId 批量回填结构化元数据。
  // 每个唯一 collectionId 仅解析一次（TTL 缓存）；解析失败者 best-effort 省略，不影响命中返回。
  const uniqueCollectionIds = [...new Set(hits.map((it) => it.collectionId).filter(Boolean) as string[])];
  const metaByCollection = new Map<string, CollectionMeta>();
  await Promise.all(
    uniqueCollectionIds.map(async (cid) => {
      metaByCollection.set(cid, await resolveCollectionMeta(cid));
    }),
  );

  return hits.map((it) => {
    const meta = (it.collectionId && metaByCollection.get(it.collectionId)) || {};
    return {
      text: it.q || it.a || "",
      score: pickScore(it.score),
      source: {
        filename: meta.filename || it.sourceName || "",
        doc_id: meta.doc_id || undefined, // 路A：导入注入则回填；UI 导入/解析失败则省略，绝不编造。
        version: meta.version || undefined,
        collectionId: it.collectionId,
      },
    };
  });
}

/**
 * 检索。`datasetIds` 显式给定则搜其并集（按 score 合并截断 topK）；省略则退默认单库 `FASTGPT_KB_ID`
 * （向后兼容现有单注册）。#45：多库下由调用方（mcp.ts 按 agent 绑定 / search-test 按选定库）传入。
 * 多库容错：用 allSettled——部分库挂不影响其余；**全部失败才抛**（触发上层回退本地，回退链不能断）。
 */
export async function search(query: string, topK = 5, datasetIds?: string[]): Promise<KbChunk[]> {
  if (!isConfigured()) throw new KnowledgeUnavailableError("FastGPT 未配置，检索请回退本地 memory_search");
  // undefined 表示旧调用方，兼容默认单库；显式 [] 表示该 agent 没有任何绑定，必须返回空而非越权回退默认库。
  const ids = datasetIds === undefined ? [FASTGPT_KB_ID] : datasetIds;
  if (ids.length === 0) return [];
  const settled = await Promise.allSettled(ids.map((id) => searchOneDataset(id, query, topK)));
  const ok = settled.filter((s): s is PromiseFulfilledResult<KbChunk[]> => s.status === "fulfilled");
  if (ok.length === 0) {
    const firstErr = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
    throw firstErr?.reason instanceof Error
      ? firstErr.reason
      : new KnowledgeUnavailableError("FastGPT 检索失败");
  }
  return ok
    .flatMap((s) => s.value)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
export interface ImportMeta {
  title?: string;
  doc_id?: string;
  version?: string;
  category?: string;
  datasetId?: string; // #45：多库目标；省略则导入默认 FASTGPT_KB_ID
}

/**
 * 把一篇文档（已带 frontmatter 的 Markdown 全文）导入 FastGPT，作为一个 text collection。
 * 切片交给 FastGPT（ADR-006 路 A，自研预切片仅作 fallback）。
 * doc_id/version 双通道注入：① collection 级 metadata；② collection name 前缀 `[doc_id] title`
 *   —— name 必经 searchTest 的 sourceName 回吐，是引用回填的兜底通道（#40 探针核实落点）。
 * 返回 { externalDocId, collectionId }：FastGPT 中该文档的稳定标识 = collectionId。
 */
export async function importDocument(
  text: string,
  name: string,
  meta: ImportMeta = {},
): Promise<{ externalDocId: string; collectionId: string }> {
  if (!isConfigured()) throw new KnowledgeUnavailableError("FastGPT 未配置，导入请走本地 doc-chunker");
  const title = meta.title || name;
  const collectionName = meta.doc_id ? `[${meta.doc_id}] ${title}` : title;
  let res: Response;
  try {
    res = await fgFetch(
      "/api/core/dataset/collection/create/text",
      {
        method: "POST",
        body: JSON.stringify({
          datasetId: meta.datasetId || FASTGPT_KB_ID,
          parentId: null,
          name: collectionName,
          text,
          trainingType: "chunk",
          chunkSize: 512,
          chunkSplitter: "",
          qaPrompt: "",
          metadata: {
            doc_id: meta.doc_id,
            version: meta.version,
            category: meta.category,
            source_file: name,
          },
        }),
      },
      30_000, // 创建 + 入队训练可能较慢
    );
  } catch (err) {
    throw new KnowledgeUnavailableError(`FastGPT 导入不可达（${(err as Error).name}）`);
  }
  if (!res.ok) throw new KnowledgeUnavailableError(`FastGPT 导入返回 ${res.status}`);
  const json = (await res.json()) as { data?: { collectionId?: string; insertId?: string } | string };
  const collectionId =
    (typeof json.data === "string" ? json.data : json.data?.collectionId || json.data?.insertId) || "";
  if (!collectionId) throw new KnowledgeUnavailableError("FastGPT 导入未返回 collectionId");
  return { externalDocId: collectionId, collectionId };
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

/**
 * #45 多库检索路由：解析某 agent 应检索的 FastGPT datasetId 集合（按 knowledge.json 绑定）。
 * 仅取 provider=fastgpt 且 boundAgents 含该 agent、且有 externalKbId 的库。
 * 仅旧部署尚无 knowledge.json 时退默认 `FASTGPT_KB_ID`；文件存在后绑定即权限真相，未绑定返回空。
 */
export function resolveDatasetIdsForAgent(agentId: string): string[] {
  // 旧部署尚无 knowledge.json 时才兼容默认单库；文件一旦存在，绑定即为权限真相。
  if (!existsSync(STORE_PATH)) return FASTGPT_KB_ID ? [FASTGPT_KB_ID] : [];
  const store = readKnowledgeStore();
  const ids = store.knowledgeBases
    .filter(
      (kb) =>
        kb.provider === "fastgpt" &&
        kb.externalKbId &&
        Array.isArray(kb.boundAgents) &&
        kb.boundAgents.includes(agentId),
    )
    .map((kb) => kb.externalKbId as string);
  return [...new Set(ids)];
}

/** #45：列出平台登记的知识库（读 knowledge.json；FastGPT 侧富状态由 UI 另取 health/collections）。 */
export function listKnowledgeBases(): KnowledgeBinding[] {
  return readKnowledgeStore().knowledgeBases;
}

export interface CreateKbInput {
  name: string;
  intro?: string;
  boundAgents?: string[];
}

/** 校验并规范化平台提交的绑定配置，拒绝畸形数据、重复 ID 和未知 Agent。 */
export function validateKnowledgeStore(input: unknown, validAgentIds: string[]): KnowledgeStore {
  if (!input || typeof input !== "object") throw new Error("请求体应为知识库配置对象");
  const raw = input as Partial<KnowledgeStore>;
  if (raw.platform !== "fastgpt" && raw.platform !== "local") throw new Error("platform 仅支持 fastgpt 或 local");
  if (!Array.isArray(raw.knowledgeBases)) throw new Error("请求体应含 knowledgeBases[]");
  const validAgents = new Set(validAgentIds);
  const seenIds = new Set<string>();
  const knowledgeBases = raw.knowledgeBases.map((kb, index) => {
    if (!kb || typeof kb !== "object") throw new Error(`knowledgeBases[${index}] 非法`);
    const id = typeof kb.id === "string" ? kb.id.trim() : "";
    const name = typeof kb.name === "string" ? kb.name.trim() : "";
    if (!id || !name) throw new Error(`knowledgeBases[${index}] 的 id/name 不能为空`);
    if (seenIds.has(id)) throw new Error(`知识库 id 重复：${id}`);
    seenIds.add(id);
    if (kb.provider !== "fastgpt" && kb.provider !== "local") throw new Error(`knowledgeBases[${index}] provider 非法`);
    const externalKbId = typeof kb.externalKbId === "string" ? kb.externalKbId.trim() : undefined;
    if (kb.provider === "fastgpt" && !externalKbId) throw new Error(`FastGPT 知识库 ${id} 缺少 externalKbId`);
    if (!Array.isArray(kb.boundAgents) || kb.boundAgents.some((agentId) => typeof agentId !== "string")) {
      throw new Error(`knowledgeBases[${index}] boundAgents 必须是字符串数组`);
    }
    const boundAgents = [...new Set(kb.boundAgents)];
    const unknownAgent = boundAgents.find((agentId) => !validAgents.has(agentId));
    if (unknownAgent) throw new Error(`知识库 ${id} 绑定了未知 Agent：${unknownAgent}`);
    return { id, name, provider: kb.provider, ...(externalKbId ? { externalKbId } : {}), boundAgents };
  });
  return { platform: raw.platform, knowledgeBases };
}

/** 解析上传目标库；显式目标必须已经登记，省略时兼容默认单库。 */
export function resolveImportDatasetId(requestedDatasetId?: string): string {
  const requested = requestedDatasetId?.trim();
  if (!requested) return FASTGPT_KB_ID;
  const exists = readKnowledgeStore().knowledgeBases.some(
    (kb) => kb.provider === "fastgpt" && kb.externalKbId === requested,
  );
  if (!exists) throw new Error("目标知识库未在平台登记");
  return requested;
}

/**
 * #45 新建知识库（原生治理）：FastGPT `dataset/create` → 写 knowledge.json 绑定。
 * 审计 CREATE_KB 在路由层落。⚠️ dataset/create 的端点/字段需按 4.8.22 实测核对（部署时验证）。
 */
export async function createKnowledgeBase(input: CreateKbInput): Promise<KnowledgeBinding> {
  if (!isFastgpt() || !FASTGPT_BASE_URL || !FASTGPT_API_KEY) {
    throw new KnowledgeUnavailableError("FastGPT 未配置，无法新建知识库");
  }
  const name = (input.name || "").trim();
  if (!name) throw new Error("知识库名称不能为空");
  let res: Response;
  try {
    res = await fgFetch(
      "/api/core/dataset/create",
      {
        method: "POST",
        body: JSON.stringify({
          name,
          intro: input.intro || "",
          type: "dataset",
          vectorModel: FASTGPT_EMBEDDING_MODEL || "text-embedding-v4",
          agentModel: "qwen-plus",
          parentId: null,
        }),
      },
      30_000,
    );
  } catch (err) {
    throw new KnowledgeUnavailableError(`FastGPT 新建库不可达（${(err as Error).name}）`);
  }
  if (!res.ok) throw new KnowledgeUnavailableError(`FastGPT 新建库返回 ${res.status}`);
  const json = (await res.json()) as { data?: { datasetId?: string; _id?: string } | string };
  const datasetId =
    (typeof json.data === "string" ? json.data : json.data?.datasetId || json.data?._id) || "";
  if (!datasetId) throw new KnowledgeUnavailableError("FastGPT 新建库未返回 datasetId");

  const binding: KnowledgeBinding = {
    id: `kb_${datasetId}`,
    name,
    provider: "fastgpt",
    externalKbId: datasetId,
    boundAgents: input.boundAgents ?? [],
  };
  const store = readKnowledgeStore();
  store.platform = "fastgpt";
  store.knowledgeBases.push(binding);
  writeKnowledgeStore(store);
  return binding;
}
