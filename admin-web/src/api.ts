// axios 实例：cookie 会话（决策六）。401 → 跳登录页。
import axios from "axios";

export const api = axios.create({ baseURL: "/api", withCredentials: true });

api.interceptors.response.use(
  (r) => r,
  (err) => {
    const status = err?.response?.status;
    const url: string = err?.config?.url || "";
    const onLogin = window.location.pathname.endsWith("/login");
    // 未认证 → 回登录页；但 /auth/* 自身的 401（如 /auth/me 探活）与已在登录页时不跳，避免循环。
    if (status === 401 && !onLogin && !url.includes("/auth/")) {
      window.location.href = "/console/login";
    }
    return Promise.reject(err);
  },
);

// —— 认证 ——
export type PlatformRole = "admin" | "ops" | "audit";
export interface Me {
  platformUserId: string;
  name: string;
  platformRole: PlatformRole;
  idp: string;
}
export interface Providers {
  session_enabled: boolean;
  providers: { feishu: boolean; dingtalk: boolean };
}

export async function fetchMe(): Promise<Me> {
  return (await api.get("/auth/me")).data;
}
export async function fetchProviders(): Promise<Providers> {
  return (await api.get("/auth/providers")).data;
}
export async function logout(): Promise<void> {
  await api.post("/auth/logout");
}

// —— 类型 ——
export interface AgentRow {
  id: string;
  role: "employee" | "admin";
  name: string;
  default: boolean;
  skills: string[];
  channels: Array<{ domain: string; accountId: string }>;
}
export interface Skill {
  name: string;
  description: string;
}
export interface ChannelsInfo {
  supported: string[];
  channels: Record<string, { accounts: string[] }>;
  env_keys: string[];
}

export async function fetchAgents(): Promise<AgentRow[]> {
  return (await api.get("/config/agents")).data.agents;
}
export async function fetchSkills(): Promise<Skill[]> {
  return (await api.get("/config/skills")).data.skills;
}
export async function fetchChannels(): Promise<ChannelsInfo> {
  return (await api.get("/config/channels")).data;
}
export type OnboardingStatus =
  | "preparing"
  | "awaiting_scan"
  | "authorized"
  | "applying"
  | "verifying"
  | "success"
  | "failed"
  | "expired"
  | "cancelled";
export interface OnboardingSession {
  id: string;
  status: OnboardingStatus;
  message?: string;
  qr_url?: string;
  expires_at: string;
}
export async function startAgentOnboarding(body: unknown): Promise<OnboardingSession> {
  return (await api.post("/config/agent-onboarding", body)).data;
}
export async function fetchAgentOnboarding(id: string): Promise<OnboardingSession> {
  return (await api.get(`/config/agent-onboarding/${id}`)).data;
}
export async function cancelAgentOnboarding(id: string): Promise<void> {
  await api.delete(`/config/agent-onboarding/${id}`);
}

// —— 知识库平台（ADR-006 / FastGPT 集成）——
export interface KnowledgeHealth {
  platform: "fastgpt" | "local";
  configured: boolean;
  reachable: boolean;
  kbId?: string;
  embeddingModel?: string;
  baseUrlHint?: string;
  indexStatus: "ready" | "indexing" | "error" | "unknown";
  fallback: "local-memory-search";
  message?: string;
  checkedAt: string;
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
export interface KbChunk {
  text: string;
  score: number;
  source: { filename: string; doc_id?: string; version?: string; collectionId?: string };
}
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

export async function fetchKnowledgeHealth(): Promise<KnowledgeHealth> {
  return (await api.get("/knowledge/health")).data;
}
export async function fetchKnowledgeCollections(): Promise<{
  collections: KbCollection[];
  source: "fastgpt" | "local";
  notice?: string;
}> {
  return (await api.get("/knowledge/collections")).data;
}
export async function searchTest(query: string, topK = 5): Promise<KbChunk[]> {
  return (await api.post("/knowledge/search-test", { query, topK })).data.chunks;
}
export async function fetchKnowledgeBindings(): Promise<{ store: KnowledgeStore; agents: AgentRow[] }> {
  return (await api.get("/knowledge/bindings")).data;
}
export async function saveKnowledgeBindings(store: KnowledgeStore): Promise<KnowledgeStore> {
  return (await api.put("/knowledge/bindings", store)).data.store;
}

// —— 审计（#44 vanilla→React）——
export interface AuditEntry {
  timestamp: string;
  action: string;
  file: string;
  details?: {
    doc_id?: string;
    version?: string;
    category?: string;
    reason?: string;
    source_format?: string;
    status?: string;
    collectionId?: string;
    operator?: { id?: string; name?: string };
    [k: string]: unknown;
  };
}
export interface AuditFilters {
  action?: string;
  doc_id?: string;
  from?: string;
  to?: string;
}
export interface AuditPage {
  logs: AuditEntry[];
  total: number;
  page: number;
  page_size: number;
}
function auditParams(filters: AuditFilters): Record<string, string> {
  const p: Record<string, string> = {};
  if (filters.action) p.action = filters.action;
  if (filters.doc_id) p.doc_id = filters.doc_id;
  if (filters.from) p.from = filters.from;
  if (filters.to) p.to = filters.to;
  return p;
}
export async function fetchAuditLog(
  filters: AuditFilters,
  page: number,
  pageSize: number,
): Promise<AuditPage> {
  return (
    await api.get("/audit-log", { params: { ...auditParams(filters), page, page_size: pageSize } })
  ).data;
}
/** 导出走浏览器原生下载（带 cookie 会话）：返回带 query 的相对 URL。 */
export function auditExportUrl(filters: AuditFilters): string {
  const qs = new URLSearchParams(auditParams(filters)).toString();
  return `/api/audit-log/export${qs ? `?${qs}` : ""}`;
}
