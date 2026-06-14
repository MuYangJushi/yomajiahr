import { randomUUID } from "node:crypto";
import * as lark from "@larksuiteoapi/node-sdk";
import {
  createAgentFromCredentials,
  createAgentFromExistingAccount,
  listAgents,
  updateAgent,
  validateAgentDraft,
  type AgentDraft,
  type ChannelCredentials,
  type UpdateAgentInput,
} from "./orchestrator.js";
import { appendAuditLog } from "../util.js";

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

export interface StartOnboardingInput extends AgentDraft {
  mode?: "scan" | "manual" | "existing";
  credentials?: ChannelCredentials;
}

interface Session {
  id: string;
  owner: string;
  draft: AgentDraft;
  updateInput?: UpdateAgentInput;
  status: OnboardingStatus;
  message?: string;
  qrUrl?: string;
  expiresAt: number;
  createdAt: number;
  abort: AbortController;
}

const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const DINGTALK_BASE = "https://oapi.dingtalk.com";

export function publicSession(s: Session) {
  return {
    id: s.id,
    status: s.status,
    message: s.message,
    qr_url: s.qrUrl,
    expires_at: new Date(s.expiresAt).toISOString(),
  };
}

function update(s: Session, status: OnboardingStatus, message?: string): void {
  s.status = status;
  s.message = message;
}

function errorMessage(err: unknown): string {
  const e = err as any;
  return String(e?.description || e?.message || "未知错误").replace(/(client_secret|app_secret|secret)[=:]\s*\S+/gi, "$1=***");
}

async function postDingTalk(path: string, body: unknown, signal: AbortSignal): Promise<any> {
  const res = await fetch(`${DINGTALK_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  const data = await res.json() as any;
  if (!res.ok || data.errcode !== 0) throw new Error(data.errmsg || `钉钉接口错误 ${res.status}`);
  return data;
}

export interface RegistrationCallbacks {
  signal: AbortSignal;
  onQRCode: (url: string, expiresIn: number) => void;
  onStatus?: (message: string) => void;
}

export async function registerFeishuApplication(
  draft: AgentDraft,
  callbacks: RegistrationCallbacks,
  registerApp: typeof lark.registerApp = lark.registerApp,
): Promise<ChannelCredentials> {
  const result = await registerApp({
    source: "yomajiahr-admin-portal",
    signal: callbacks.signal,
    appPreset: { name: draft.name, desc: draft.persona || `${draft.name} 数字员工` },
    onQRCodeReady(info) {
      callbacks.onQRCode(info.url, info.expireIn);
    },
    onStatusChange(info) {
      if (info.status === "slow_down") callbacks.onStatus?.("飞书处理中，请稍候");
      if (info.status === "domain_switched") callbacks.onStatus?.("已切换至 Lark 授权域名");
    },
  });
  return { clientId: result.client_id, clientSecret: result.client_secret };
}

export async function registerDingTalkApplication(
  callbacks: RegistrationCallbacks,
  request: typeof postDingTalk = postDingTalk,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep,
): Promise<ChannelCredentials> {
  const init = await request("/app/registration/init", { source: "openClaw" }, callbacks.signal);
  const begin = await request("/app/registration/begin", { nonce: init.nonce }, callbacks.signal);
  const expiresIn = Number(begin.expires_in || 600);
  callbacks.onQRCode(begin.verification_uri_complete, expiresIn);
  const deadline = Date.now() + expiresIn * 1000;
  const interval = Math.max(1, Number(begin.interval || 5)) * 1000;
  while (!callbacks.signal.aborted && Date.now() < deadline) {
    await sleep(interval, callbacks.signal);
    const poll = await request("/app/registration/poll", { device_code: begin.device_code }, callbacks.signal);
    if (poll.status === "WAITING") continue;
    if (poll.status === "SUCCESS") return { clientId: poll.client_id, clientSecret: poll.client_secret };
    if (poll.status === "EXPIRED") throw Object.assign(new Error("钉钉授权已过期"), { expired: true });
    throw new Error(poll.fail_reason || "钉钉授权失败");
  }
  if (callbacks.signal.aborted) throw Object.assign(new Error("cancelled"), { code: "abort" });
  throw Object.assign(new Error("钉钉授权已过期"), { expired: true });
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("cancelled"), { code: "abort" }));
    }, { once: true });
  });
}

async function finish(s: Session, credentials: ChannelCredentials): Promise<void> {
  if (s.abort.signal.aborted) return;
  const attaching = Boolean(s.updateInput);
  update(s, "authorized", attaching ? "授权成功，正在更新数字员工" : "授权成功，正在创建数字员工");
  update(s, "applying", "正在写入配置并重启网关");
  try {
    if (s.updateInput) {
      await updateAgent(s.draft.id, {
        ...s.updateInput,
        addChannel: {
          domain: s.draft.domain,
          accountId: s.draft.accountId,
          credentials,
        },
      });
    } else {
      await createAgentFromCredentials(s.draft, credentials, () => {
        update(s, "verifying", "正在验证目标渠道连接");
      });
    }
  } catch (err) {
    const message = errorMessage(err).replaceAll(credentials.clientSecret, "***");
    throw new Error(message);
  }
  update(s, "success", attaching ? "数字员工及新渠道已更新" : "数字员工已上线");
  appendAuditLog(attaching ? "agent.update" : "agent.create", s.draft.id, {
    agent_id: s.draft.id,
    name: s.draft.name,
    role: s.draft.role,
    skills: s.draft.skills,
    channel: s.draft.domain,
    account_id: s.draft.accountId || s.draft.id,
    operation: attaching ? "attach_channel" : "create",
  });
}

async function finishExisting(s: Session): Promise<void> {
  const attaching = Boolean(s.updateInput);
  update(s, "applying", attaching ? "正在绑定已有渠道账号" : "正在使用已有渠道账号创建数字员工");
  if (s.updateInput) {
    await updateAgent(s.draft.id, {
      ...s.updateInput,
      addChannel: { domain: s.draft.domain, accountId: s.draft.accountId, existing: true },
    });
  } else {
    await createAgentFromExistingAccount(s.draft, () => update(s, "verifying", "正在验证目标渠道连接"));
  }
  update(s, "success", attaching ? "数字员工及已有渠道已更新" : "数字员工已上线");
  appendAuditLog(attaching ? "agent.update" : "agent.create", s.draft.id, {
    agent_id: s.draft.id,
    channel: s.draft.domain,
    account_id: s.draft.accountId,
    operation: attaching ? "attach_existing_channel" : "create_with_existing_channel",
  });
}

async function runFeishu(s: Session): Promise<void> {
  const credentials = await registerFeishuApplication(s.draft, {
    signal: s.abort.signal,
    onQRCode(url, expiresIn) {
      s.qrUrl = url;
      s.expiresAt = Date.now() + expiresIn * 1000;
      update(s, "awaiting_scan", "请使用飞书扫码并确认创建应用");
    },
    onStatus(message) { s.message = message; },
  });
  await finish(s, credentials);
}

async function runDingTalk(s: Session): Promise<void> {
  const credentials = await registerDingTalkApplication({
    signal: s.abort.signal,
    onQRCode(url, expiresIn) {
      s.qrUrl = url;
      s.expiresAt = Date.now() + expiresIn * 1000;
      update(s, "awaiting_scan", "请使用钉钉扫码并确认创建应用");
    },
  });
  await finish(s, credentials);
}

async function run(s: Session, input: StartOnboardingInput): Promise<void> {
  try {
    if (input.mode === "existing") {
      await finishExisting(s);
    } else if (input.mode === "manual") {
      if (!input.credentials?.clientId?.trim() || !input.credentials?.clientSecret?.trim()) {
        throw new Error("手工接入凭证不能为空");
      }
      await finish(s, input.credentials);
    } else if (s.draft.domain === "feishu") {
      await runFeishu(s);
    } else {
      await runDingTalk(s);
    }
  } catch (err) {
    if (s.abort.signal.aborted) {
      update(s, "cancelled", "已取消");
    } else if ((err as any)?.expired || (err as any)?.code === "expired_token") {
      update(s, "expired", errorMessage(err));
    } else {
      update(s, "failed", errorMessage(err));
    }
  }
}

export function startOnboarding(owner: string, input: StartOnboardingInput) {
  const draft: AgentDraft = {
    id: input.id,
    name: input.name,
    role: input.role,
    persona: input.persona,
    skills: input.skills,
    domain: input.domain,
    accountId: input.accountId,
  };
  validateAgentDraft(draft);
  if (input.mode !== undefined && input.mode !== "scan" && input.mode !== "manual" && input.mode !== "existing") throw new Error("接入方式非法");
  if (input.mode === "existing" && !draft.accountId) throw new Error("请选择已有渠道账号");
  const accountId = draft.accountId || draft.id;
  for (const existing of sessions.values()) {
    if (["success", "failed", "expired", "cancelled"].includes(existing.status)) continue;
    if (existing.draft.id === draft.id) throw new Error(`该 Agent 已有进行中的创建会话：${draft.id}`);
    if (existing.draft.domain === draft.domain && (existing.draft.accountId || existing.draft.id) === accountId) {
      throw new Error(`该渠道账号已有进行中的创建会话：${draft.domain}/${accountId}`);
    }
  }
  const now = Date.now();
  const session: Session = {
    id: randomUUID(),
    owner,
    draft,
    status: "preparing",
    expiresAt: now + SESSION_TTL_MS,
    createdAt: now,
    abort: new AbortController(),
  };
  sessions.set(session.id, session);
  void run(session, input);
  return publicSession(session);
}

export function startChannelOnboarding(
  owner: string,
  agentId: string,
  input: Omit<StartOnboardingInput, "id">,
) {
  const current = listAgents().find((agent) => agent.id === agentId);
  if (!current) throw new Error(`agent 不存在：${agentId}`);
  if (input.domain !== "feishu" && input.domain !== "dingtalk-connector") throw new Error("渠道非法");
  if (current.channels.some((channel) => channel.domain === input.domain)) {
    throw new Error(`数字员工已接入渠道：${input.domain}`);
  }
  if (input.mode !== undefined && input.mode !== "scan" && input.mode !== "manual" && input.mode !== "existing") throw new Error("接入方式非法");
  if (input.mode === "existing" && !input.accountId) throw new Error("请选择已有渠道账号");
  const draft: AgentDraft = {
    id: agentId,
    name: input.name,
    role: input.role,
    persona: input.persona,
    skills: input.skills,
    domain: input.domain,
    accountId: input.accountId,
  };
  const accountId = draft.accountId || draft.id;
  for (const existing of sessions.values()) {
    if (["success", "failed", "expired", "cancelled"].includes(existing.status)) continue;
    if (existing.draft.id === draft.id) throw new Error(`该 Agent 已有进行中的接入会话：${draft.id}`);
    if (existing.draft.domain === draft.domain && (existing.draft.accountId || existing.draft.id) === accountId) {
      throw new Error(`该渠道账号已有进行中的接入会话：${draft.domain}/${accountId}`);
    }
  }
  const now = Date.now();
  const session: Session = {
    id: randomUUID(),
    owner,
    draft,
    updateInput: {
      name: input.name,
      role: input.role,
      persona: input.persona,
      skills: input.skills,
    },
    status: "preparing",
    expiresAt: now + SESSION_TTL_MS,
    createdAt: now,
    abort: new AbortController(),
  };
  sessions.set(session.id, session);
  void run(session, { ...input, id: agentId });
  return publicSession(session);
}

export function getOnboarding(owner: string, id: string) {
  const s = sessions.get(id);
  if (!s || s.owner !== owner) return null;
  return publicSession(s);
}

export function cancelOnboarding(owner: string, id: string) {
  const s = sessions.get(id);
  if (!s || s.owner !== owner) return null;
  if (!["preparing", "awaiting_scan"].includes(s.status)) {
    throw new Error("授权成功后已进入上线事务，不能取消");
  }
  s.abort.abort();
  update(s, "cancelled", "已取消");
  return publicSession(s);
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) {
      session.abort.abort();
      sessions.delete(id);
    }
  }
}, 60_000).unref();
