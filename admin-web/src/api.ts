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

/**
 * 只读列表请求的瞬时失败重试：生产经 nginx 反代，偶发连接抖动/短暂 5xx，
 * 而页面 mount 只发一次 fetch、无重试，一次抖动就弹"加载失败"。
 * 仅对「网络错误 / 5xx / 429」重试一次（400/401/403/404 这类业务态不重试，
 * 重试也只会得到同样结果）。401 已在拦截器里跳登录，不会到这里。
 */
export async function withRetry<T>(fn: () => Promise<T>, retries = 1, delayMs = 400): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const status = err?.response?.status;
    const transient = !err.response || status === 429 || (status >= 500 && status < 600);
    if (!transient || retries <= 0) throw err;
    await new Promise((r) => setTimeout(r, delayMs));
    return fn();
  }
}

// —— 异步 apply 任务（fix/usage-bugs #1）——
// 写操作（招募 / 渠道编辑 / 知识库绑定等）后端 800ms 内未完成会返回 202 + jobId；
// 前端拿到 jobId 立刻关弹窗 / 刷列表 / 起进度提示，轮询直到终态。
export type ApplyJobStatus = "queued" | "running" | "success" | "failed";
export interface ApplyJob {
  id: string;
  label: string;
  status: ApplyJobStatus;
  message?: string;
  result?: unknown;
  startedAt: string;
  finishedAt?: string;
}
export async function fetchApplyJob(jobId: string): Promise<ApplyJob> {
  return (await api.get(`/config/apply-jobs/${encodeURIComponent(jobId)}`)).data;
}

/** 轮询 jobId 直到终态。每 1.5s 一次，超时 90s。终态 result/message 由调用方消费。 */
export async function awaitApplyJob(jobId: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<ApplyJob> {
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const intervalMs = opts?.intervalMs ?? 1500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const job = await fetchApplyJob(jobId);
      if (job.status === "success" || job.status === "failed") return job;
    } catch (err: any) {
      // jobId 在进程重启后会丢失（404）→ 视为终止；调用方通常 reload 列表看现状即可。
      if (err?.response?.status === 404) {
        return { id: jobId, label: "", status: "failed", message: "任务状态已丢失（服务可能已重启），请刷新查看最新状态", startedAt: new Date().toISOString() };
      }
      throw err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { id: jobId, label: "", status: "failed", message: "等待任务完成超时，请刷新查看最新状态", startedAt: new Date().toISOString() };
}

/** 写操作响应里如果带了 jobId（即后端走了异步路径），返回 jobId 字符串供调用方挂轮询；否则 undefined。 */
export function jobIdOf(data: unknown): string | undefined {
  if (data && typeof data === "object" && "jobId" in data) {
    const id = (data as { jobId?: unknown }).jobId;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

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
  open_enterprise_login: { enabled: boolean; role: "ops" | "audit" | null };
  demo_access_code: { enabled: boolean; role: "ops" | "audit" | null };
}

export async function fetchMe(): Promise<Me> {
  return (await api.get("/auth/me")).data;
}
export async function fetchProviders(): Promise<Providers> {
  return (await api.get("/auth/providers")).data;
}
export async function loginWithDemoAccessCode(code: string): Promise<void> {
  await api.post("/auth/demo/login", { code });
}
export async function logout(): Promise<void> {
  await api.post("/auth/logout");
}

// —— 类型 ——
export interface AgentProfile {
  jobTitle?: string;
  responsibilities?: string;
  personality?: string;
  tone?: string;
  boundaries?: string;
}
export interface AgentRow {
  id: string;
  role: "employee" | "admin";
  name: string;
  /** @deprecated 兼容读取；新数据用 profile.personality。 */
  persona: string;
  profile?: AgentProfile;
  default: boolean;
  skills: string[];
  channels: Array<{ domain: string; accountId: string }>;
  derived: { pendingSkills: boolean; pendingChannels: boolean };
}
export type SkillRole = "employee" | "admin";
export interface SkillMeta {
  name: string;
  description: string;
  requiredRole?: SkillRole;
  requiresKnowledge?: boolean;
}
export interface Skill extends SkillMeta {
  body: string;
}
/** 技能分配视图（GET /config/agents/:id/skills）。 */
export interface SkillAssignment {
  skills: string[];
  available: SkillMeta[];
  unmet: Array<{ skill: string; reason: string }>;
}
export interface ChannelsInfo {
  supported: string[];
  channels: Record<string, {
    accounts: Array<{ accountId: string; occupied: boolean; occupiedBy?: string; occupiedByName?: string }>;
  }>;
  env_keys: string[];
}

export async function fetchAgents(): Promise<AgentRow[]> {
  return withRetry(async () => (await api.get("/config/agents")).data.agents);
}
export interface CreateAgentInput {
  id: string;
  name: string;
  role: "employee" | "admin";
  /** @deprecated 由 profile.personality 取代。 */
  persona?: string;
  profile?: AgentProfile;
}
export async function createAgent(input: CreateAgentInput): Promise<unknown> {
  return (await api.post("/config/agents", input)).data;
}
export interface UpdateAgentInput {
  name: string;
  role: "employee" | "admin";
  /** @deprecated 由 profile.personality 取代。 */
  persona?: string;
  profile?: AgentProfile;
}
export async function updateAgent(id: string, input: UpdateAgentInput): Promise<unknown> {
  return (await api.put(`/config/agents/${encodeURIComponent(id)}`, input)).data;
}
export async function deleteAgent(id: string): Promise<unknown> {
  return (await api.delete(`/config/agents/${encodeURIComponent(id)}`)).data;
}
export interface BindChannelInput {
  domain: "feishu" | "dingtalk-connector";
  accountId?: string;
  existing?: boolean;
  credentials?: { clientId: string; clientSecret: string };
}
export async function bindAgentChannel(id: string, input: BindChannelInput): Promise<unknown> {
  return (await api.post(`/config/agents/${encodeURIComponent(id)}/channels`, input)).data;
}
export async function unbindAgentChannel(id: string, domain: string, accountId: string): Promise<unknown> {
  return (await api.delete(`/config/agents/${encodeURIComponent(id)}/channels/${encodeURIComponent(domain)}/${encodeURIComponent(accountId)}`)).data;
}
export async function generateAgentProfile(input: { jobTitle: string; hints?: string; fields?: Array<keyof AgentProfile> }): Promise<AgentProfile> {
  return (await api.post("/config/agent-profile/generate", input)).data.profile;
}

// —— 系统自带数字员工模板（空白起步 + 从模板创建）——
export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  suggestedId: string;
  role: "employee" | "admin";
  profile: Required<Pick<AgentProfile, "jobTitle" | "responsibilities" | "personality" | "tone" | "boundaries">>;
  suggestedSkills: string[];
}
export async function fetchAgentTemplates(): Promise<AgentTemplate[]> {
  return (await api.get("/config/agent-templates")).data.templates;
}

// —— 渠道管理（ADR-013 §渠道独立）——
export interface ChannelHealth {
  configured: boolean;
  running: boolean;
  connected: boolean;
  probe?: { ok: boolean };
  lastError?: string;
  checkedAt: string;
}
export interface ChannelAsset {
  id: string;
  type: "feishu" | "dingtalk";
  displayName: string;
  enabled?: boolean;
  policy?: { dmPolicy?: "open" | "restricted"; groupPolicy?: "open" | "disabled"; requireMention?: boolean };
  credentialsConfigured: boolean;
  occupiedBy?: { agentId: string; agentName: string };
  health?: ChannelHealth;
}
// 账号资产视图走 /config/channel-assets（独立资源）；
// /config/channels 是渠道占用视图（fetchChannels，给 Agents 页绑定下拉用），勿混。
export async function fetchChannelAssets(): Promise<{ channels: ChannelAsset[]; health: ChannelHealth[] }> {
  return withRetry(async () => (await api.get("/config/channel-assets")).data);
}
export async function probeChannels(): Promise<ChannelHealth[]> {
  return (await api.post("/config/channel-assets/probe")).data.health;
}
export async function deleteChannelAsset(type: "feishu" | "dingtalk", id: string): Promise<void> {
  await api.delete(`/config/channel-assets/${type}/${encodeURIComponent(id)}`);
}
export async function createChannelAsset(input: {
  id: string; type: "feishu" | "dingtalk"; displayName: string; policy?: ChannelAsset["policy"];
} & ({ mode: "manual"; clientId: string; secret: string } | { mode: "qrcode" })): Promise<OnboardingSession | void> {
  return (await api.post("/config/channel-assets", input)).data;
}
export async function updateChannelAsset(type: "feishu" | "dingtalk", id: string, input: {
  displayName?: string; clientId?: string; secret?: string; policy?: ChannelAsset["policy"];
}): Promise<unknown> {
  return (await api.patch(`/config/channel-assets/${type}/${encodeURIComponent(id)}`, input)).data;
}
export async function bindChannelAsset(type: "feishu" | "dingtalk", id: string, agentId: string): Promise<unknown> {
  return (await api.post(`/config/channel-assets/${type}/${encodeURIComponent(id)}/bind`, { agentId })).data;
}
export async function unbindChannelAsset(type: "feishu" | "dingtalk", id: string): Promise<unknown> {
  return (await api.post(`/config/channel-assets/${type}/${encodeURIComponent(id)}/unbind`)).data;
}
export async function probeChannelAsset(type: "feishu" | "dingtalk", id: string): Promise<ChannelHealth> {
  return (await api.post(`/config/channel-assets/${type}/${encodeURIComponent(id)}/probe`)).data.health;
}
export async function fetchChannelOnboarding(id: string): Promise<OnboardingSession> {
  return (await api.get(`/config/channel-assets/onboarding/${id}`)).data;
}
export async function cancelChannelAssetOnboarding(id: string): Promise<void> {
  await api.delete(`/config/channel-assets/onboarding/${id}`);
}
export async function fetchSkills(): Promise<SkillMeta[]> {
  return (await api.get("/config/skills")).data.skills;
}
// —— 技能可编辑化（ADR-015 §1）：平台内 CRUD ——
export async function fetchSkill(name: string): Promise<Skill> {
  return (await api.get(`/config/skills/${encodeURIComponent(name)}`)).data.skill;
}
export interface CreateSkillInput {
  name: string;
  description: string;
  requiredRole?: SkillRole;
  requiresKnowledge?: boolean;
  body?: string;
}
export async function createSkill(input: CreateSkillInput): Promise<Skill> {
  return (await api.post("/config/skills", input)).data.skill;
}
export interface UpdateSkillInput {
  description?: string;
  requiredRole?: SkillRole | null;
  requiresKnowledge?: boolean;
  body?: string;
}
export async function updateSkill(name: string, input: UpdateSkillInput): Promise<Skill> {
  return (await api.put(`/config/skills/${encodeURIComponent(name)}`, input)).data.skill;
}
export async function deleteSkill(name: string): Promise<void> {
  await api.delete(`/config/skills/${encodeURIComponent(name)}`);
}
// —— 员工↔技能分配（ADR-015 §3）——
export async function fetchAgentSkills(id: string): Promise<SkillAssignment> {
  return (await api.get(`/config/agents/${encodeURIComponent(id)}/skills`)).data;
}
export async function saveAgentSkills(id: string, skills: string[]): Promise<SkillAssignment & { jobId?: string }> {
  return (await api.put(`/config/agents/${encodeURIComponent(id)}/skills`, { skills })).data;
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
export async function startAgentChannelOnboarding(id: string, body: unknown): Promise<OnboardingSession> {
  return (await api.post(`/config/agents/${encodeURIComponent(id)}/channel-onboarding`, body)).data;
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
  fallback: "none"; // ADR-010：已弃本地回退，FastGPT 为唯一知识源
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
  restricted?: boolean; // ADR-010：受限库，文档列表/切片预览仅 admin 可见
}
export interface KnowledgeStore {
  platform: "fastgpt" | "local";
  knowledgeBases: KnowledgeBinding[];
}

export async function fetchKnowledgeHealth(): Promise<KnowledgeHealth> {
  return withRetry(async () => (await api.get("/knowledge/health")).data);
}
export async function fetchKnowledgeCollections(datasetId?: string): Promise<{
  collections: KbCollection[];
  source: "fastgpt" | "local";
  notice?: string;
}> {
  return (await api.get("/knowledge/collections", { params: { datasetId } })).data;
}
export interface KbChunkPreview {
  id: string;
  q: string;
  a: string;
  chunkIndex: number;
}
export async function fetchCollectionChunks(
  collectionId: string,
  offset = 0,
  pageSize = 20,
): Promise<{ chunks: KbChunkPreview[]; total: number }> {
  return (
    await api.get(`/knowledge/collections/${encodeURIComponent(collectionId)}/chunks`, {
      params: { offset, pageSize },
    })
  ).data;
}
export async function uploadKnowledgeDocument(
  file: File,
  datasetId: string,
): Promise<{ file: string; kbId: string; collectionId: string }> {
  const body = new FormData();
  body.append("file", file);
  body.append("datasetId", datasetId);
  return (await api.post("/upload", body)).data;
}
export async function deleteKnowledgeCollection(collectionId: string, datasetId: string): Promise<void> {
  await api.delete(`/knowledge/collections/${encodeURIComponent(collectionId)}`, { params: { datasetId } });
}
export async function searchTest(query: string, topK = 5, datasetId?: string): Promise<KbChunk[]> {
  return (await api.post("/knowledge/search-test", { query, topK, datasetId })).data.chunks;
}
export async function fetchKnowledgeBindings(): Promise<{ store: KnowledgeStore; agents: AgentRow[] }> {
  return withRetry(async () => (await api.get("/knowledge/bindings")).data);
}
export async function saveKnowledgeBindings(store: KnowledgeStore): Promise<{ store?: KnowledgeStore; jobId?: string }> {
  const data = (await api.put("/knowledge/bindings", store)).data;
  return { store: data?.store, jobId: data?.jobId };
}

// —— #41 多库 ——
export async function fetchKnowledgeBases(): Promise<{ bases: KnowledgeBinding[]; agents: AgentRow[] }> {
  return withRetry(async () => (await api.get("/knowledge/bases")).data);
}
export interface CreateKbInput {
  name: string;
  intro?: string;
  boundAgents?: string[];
  restricted?: boolean;
}
export async function createKnowledgeBase(input: CreateKbInput): Promise<KnowledgeBinding> {
  return (await api.post("/knowledge/bases", input)).data.base;
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
