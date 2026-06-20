// Web 内置对话服务（ADR-016 §2，方案 B：per-turn `spawn openclaw --local`，不经常驻 gateway）。
//
// 关键认知：ClawMax 的「免重启」= Web 对话经 per-turn spawn 绕开会掉线的常驻 gateway。
// 每轮调 `openclaw agent --agent <id> --local --json --session-id <sid> --message ...`，
// 从磁盘重读 openclaw.json（新建 agent 落盘即可聊），executionTrace.runner=embedded。
//
// 权限：Web 对话调真实 openclaw agent，`tools.allow/deny` 由 openclaw 按 openclaw.json 强制，
// 受限内容由 /mcp/:agentId handler 把关——天然继承（ADR-003/012），无需额外旁路代码。
//
// 会话：落 `$STATE_DIR/agents/<agentId>/sessions/<sid>.jsonl`（openclaw 原生路径，ADR-016 §2.1）。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, REPO_DIR } from "../config.js";
import { runtimeEnv } from "./secrets.js";
import { readStore } from "./store.js";
import { workspaceDir } from "./workspace.js";

/** 单轮默认超时（ms），可用 OPENCLAW_WEB_CHAT_TIMEOUT_MS 覆盖。 */
const DEFAULT_TIMEOUT_MS = 60_000;
/** 全局并发上限，可用 OPENCLAW_WEB_CHAT_CONCURRENCY 覆盖。 */
const DEFAULT_CONCURRENCY = 4;
/** 排队等待上限（ms），超限返回 429。 */
const QUEUE_TIMEOUT_MS = 5_000;

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  ts?: string;
}

export interface ChatSessionMeta {
  sessionId: string;
  createdAt?: string;
  updatedAt?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
}

export interface ChatResult {
  reply: string;
  sessionId: string;
  durationMs: number;
}

export class ChatError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

function timeoutMs(): number {
  const v = Number(process.env.OPENCLAW_WEB_CHAT_TIMEOUT_MS);
  return v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

function concurrency(): number {
  const v = Number(process.env.OPENCLAW_WEB_CHAT_CONCURRENCY);
  return v > 0 ? v : DEFAULT_CONCURRENCY;
}

function sessionsDir(agentId: string): string {
  return join(STATE_DIR, "agents", agentId, "sessions");
}

/** 校验 agentId 存在且 workspace 已渲染。 */
function assertAgentReady(agentId: string): void {
  if (!/^[a-z0-9-]+$/.test(agentId)) throw new ChatError("BAD_AGENT", "agentId 非法", 400);
  const { agents } = readStore();
  if (!agents.some((a) => a.id === agentId)) throw new ChatError("AGENT_NOT_FOUND", `agent 不存在：${agentId}`, 404);
  if (!existsSync(workspaceDir(agentId))) {
    throw new ChatError("WORKSPACE_MISSING", `agent workspace 未渲染：${agentId}`, 409);
  }
}

/** 生成默认 sessionId：chat_<yyyymmddHHMMSS>_<8随机>。 */
function generateSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 10);
  return `chat_${ts}_${rand}`;
}

function cleanMessage(raw: string): string {
  return raw.replace(CONTROL_RE, "").trim();
}

// —— 并发控制：全局信号量 + 同 session 单飞 ——
let activeCount = 0;
const waitQueue: Array<() => void> = [];
const inFlight = new Map<string, Promise<ChatResult>>();

async function acquireSlot(): Promise<void> {
  if (activeCount < concurrency()) {
    activeCount++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waitQueue.indexOf(resolve);
      if (idx >= 0) waitQueue.splice(idx, 1);
      reject(new ChatError("TOO_BUSY", "对话并发已满，请稍后重试", 429));
    }, QUEUE_TIMEOUT_MS);
    waitQueue.push(() => {
      clearTimeout(timer);
      activeCount++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  activeCount--;
  const next = waitQueue.shift();
  if (next) next();
}

/** 执行一次 agent turn（spawn openclaw --local）。 */
function runAgentTurn(agentId: string, sessionId: string, message: string, timeout: number): Promise<{ reply: string; raw: string }> {
  return new Promise((resolve, reject) => {
    const tmpDir = join(STATE_DIR, "tmp");
    try {
      mkdirSync(tmpDir, { recursive: true });
    } catch {
      /* ignore */
    }
    const env = {
      ...process.env,
      ...runtimeEnv(),
      OPENCLAW_CONFIG_PATH: join(STATE_DIR, "openclaw.json"),
      OPENCLAW_STATE_DIR: STATE_DIR,
      TMPDIR: tmpDir,
    };
    const args = [
      "agent",
      "--agent", agentId,
      "--local",
      "--json",
      "--session-id", sessionId,
      "--message", message,
      "--timeout", String(Math.max(1, Math.floor(timeout / 1000))),
    ];
    const child = spawn("openclaw", args, { env, cwd: REPO_DIR, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ChatError("TIMEOUT", "对话执行超时", 504));
    }, timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ChatError("SPAWN_FAILED", `无法启动 openclaw：${e.message}`, 500));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // 错误摘要：stderr 末行，去敏感；不回传完整 stderr/prompt。
        const tail = stderr.trim().split("\n").filter(Boolean).slice(-1)[0] || `exit ${code}`;
        reject(new ChatError("AGENT_RUN_FAILED", `对话执行失败：${tail.slice(0, 200)}`, 502));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const reply = parsed?.finalAssistantVisibleText ?? parsed?.finalAssistantRawText ?? "";
        if (!reply) {
          reject(new ChatError("EMPTY_REPLY", "对话未返回内容", 502));
          return;
        }
        resolve({ reply: String(reply), raw: stdout });
      } catch {
        reject(new ChatError("PARSE_FAILED", "对话输出解析失败", 502));
      }
    });
  });
}

/**
 * 与 agent 对话一轮（ADR-016 §2.1）。
 * 同 agentId+sessionId 单飞；全局并发限制；超时 kill；返回 {reply, sessionId, durationMs}。
 */
export async function chatWithAgent(input: {
  agentId: string;
  message: string;
  sessionId?: string;
}): Promise<ChatResult> {
  assertAgentReady(input.agentId);
  const message = cleanMessage(input.message);
  if (!message) throw new ChatError("EMPTY_MESSAGE", "message 不能为空", 400);
  if (message.length > 8000) throw new ChatError("MESSAGE_TOO_LONG", "message 过长（≤8000 字符）", 400);

  let sessionId = input.sessionId?.trim();
  if (sessionId) {
    if (!SESSION_ID_RE.test(sessionId) || sessionId.length > 128) {
      throw new ChatError("BAD_SESSION", "sessionId 非法", 400);
    }
    if (sessionId.includes("..")) throw new ChatError("BAD_SESSION", "sessionId 非法", 400);
  } else {
    sessionId = generateSessionId();
  }

  const lockKey = `${input.agentId}::${sessionId}`;
  const existing = inFlight.get(lockKey);
  if (existing) {
    // 同 session 并发：复用进行中的请求（单飞），但语义上两个调用方都期待自己的回复。
    // 这里改为拒绝第二个，避免交错写同一 session。
    throw new ChatError("SESSION_BUSY", "该会话正在处理中，请稍候", 409);
  }

  const startedAt = Date.now();
  const promise = (async () => {
    await acquireSlot();
    try {
      const { reply } = await runAgentTurn(input.agentId, sessionId!, message, timeoutMs());
      return { reply, sessionId: sessionId!, durationMs: Date.now() - startedAt };
    } finally {
      releaseSlot();
      inFlight.delete(lockKey);
    }
  })();
  inFlight.set(lockKey, promise);
  return promise;
}

/** 解析单条 jsonl 消息行，提取 role 与可见文本（跳过 thinking 片段）。 */
function extractMessage(line: string): ChatMessage | undefined {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (obj?.type !== "message" || !obj.message) return undefined;
  const role = obj.message.role;
  if (role !== "user" && role !== "assistant") return undefined;
  const content = obj.message.content;
  let text = "";
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && part.type === "text" && typeof part.text === "string") text += part.text;
    }
  } else if (typeof content === "string") {
    text = content;
  }
  text = text.trim();
  if (!text) return undefined;
  return { role, text, ts: typeof obj.timestamp === "string" ? obj.timestamp : undefined };
}

function readSessionMessages(agentId: string, sid: string): ChatMessage[] {
  const file = join(sessionsDir(agentId), `${sid}.jsonl`);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf-8").split("\n");
  const out: ChatMessage[] = [];
  for (const line of lines) {
    const m = extractMessage(line);
    if (m) out.push(m);
  }
  return out;
}

function summarize(text: string, max = 80): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** 列出某 agent 的全部 Web 对话会话（元信息，不含完整历史）。 */
export function listSessions(agentId: string): ChatSessionMeta[] {
  assertAgentReady(agentId);
  const dir = sessionsDir(agentId);
  if (!existsSync(dir)) return [];
  const out: ChatSessionMeta[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl") || name.endsWith(".trajectory.jsonl")) continue;
    const sid = name.slice(0, -6); // 去掉 .jsonl
    const file = join(dir, name);
    const messages = readSessionMessages(agentId, sid);
    if (messages.length === 0) continue;
    let st: { ctime: string; mtime: string };
    try {
      const s = statSync(file);
      st = { ctime: s.ctime.toISOString(), mtime: s.mtime.toISOString() };
    } catch {
      continue;
    }
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    out.push({
      sessionId: sid,
      createdAt: st.ctime,
      updatedAt: st.mtime,
      lastUserMessage: lastUser ? summarize(lastUser.text) : undefined,
      lastAssistantMessage: lastAssistant ? summarize(lastAssistant.text) : undefined,
    });
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

/** 取某会话完整消息历史。 */
export function getSession(agentId: string, sid: string): { sessionId: string; messages: ChatMessage[] } {
  assertAgentReady(agentId);
  if (!SESSION_ID_RE.test(sid) || sid.includes("..")) {
    throw new ChatError("BAD_SESSION", "sessionId 非法", 400);
  }
  const messages = readSessionMessages(agentId, sid);
  return { sessionId: sid, messages };
}

/** 删除某会话（jsonl + trajectory*）。 */
export function deleteSession(agentId: string, sid: string): void {
  assertAgentReady(agentId);
  if (!SESSION_ID_RE.test(sid) || sid.includes("..")) {
    throw new ChatError("BAD_SESSION", "sessionId 非法", 400);
  }
  const dir = sessionsDir(agentId);
  if (!existsSync(dir)) return;
  let removed = false;
  for (const name of readdirSync(dir)) {
    if (name === `${sid}.jsonl` || name.startsWith(`${sid}.`)) {
      rmSync(join(dir, name), { force: true });
      removed = true;
    }
  }
  if (!removed) throw new ChatError("SESSION_NOT_FOUND", `会话不存在：${sid}`, 404);
}
