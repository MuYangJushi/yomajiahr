// Yoma+HR 交互日志插件（Sprint 10 #31，支柱三数据链路第一环）。
//
// 职责：观察型 hooks 采集「员工提问 → 检索 → 回答」全链事件，按 runId 串链，
// 落 $STATE_DIR/data/interactions/events-YYYYMMDD.jsonl（按天分文件）。
// 设计依据与载荷实测：kb 50-research/06（#30 研究门控）。
//
// 红线：
// - 纯观察，任何 hook 都不返回决策，插件异常绝不影响 agent 主流程；
// - 检索类工具（*__knowledge_search / *__knowledge_import）记 query 与结果文本，
//   其他工具（如 exec）只记元数据不记参数原文，防敏感命令进交互库；
// - 交互库与审计日志同等对待：落 $STATE_DIR/data/ 下，发布包部署不覆盖。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || join(process.env.HOME || "/tmp", ".openclaw");
const OUT_DIR = join(STATE_DIR, "data", "interactions");
const MAX_TEXT = 4000;

function today() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function clip(v) {
  if (typeof v !== "string") return v;
  return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) + "…[TRUNC]" : v;
}

function emit(record) {
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    appendFileSync(join(OUT_DIR, `events-${today()}.jsonl`), JSON.stringify(record) + "\n");
  } catch {
    // 落盘失败静默：采集是旁路，绝不影响主流程
  }
}

function base(hook, event) {
  const ctx = (event && event.context) || {};
  return {
    ts: new Date().toISOString(),
    hook,
    runId: event?.runId ?? ctx.runId ?? null,
    agentId: ctx.agentId ?? event?.agentId ?? null,
    sessionKey: ctx.sessionKey ?? event?.sessionKey ?? null,
    sessionId: event?.sessionId ?? ctx.sessionId ?? null,
    channel: ctx.messageProvider ?? null,
  };
}

function isKnowledgeTool(name) {
  return typeof name === "string" && /__knowledge_(search|import)$/.test(name);
}

// agent_end.messages 里取最后一条 assistant 可见文本
function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        const texts = m.content.filter((c) => c && c.type === "text").map((c) => c.text);
        if (texts.length) return texts.join("\n");
      }
    }
  }
  return null;
}

// after_tool_call.result.content[].text 拼接（检索结果文本，含 score 与 [来源: ...]）
function toolResultText(result) {
  if (!result) return null;
  const content = result.content;
  if (Array.isArray(content)) {
    return content.filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
  }
  if (typeof result === "string") return result;
  return null;
}

export default definePluginEntry({
  id: "hook-logger",
  name: "Yoma+HR Interaction Logger",
  register(api) {
    api.on("message_received", async (event) => {
      emit({
        ...base("message_received", event),
        senderId: event?.senderId ?? null,
        messageId: event?.messageId ?? null,
        threadId: event?.threadId ?? null,
        content: clip(event?.content ?? event?.body ?? null),
      });
    });

    api.on("before_tool_call", async (event) => {
      const knowledge = isKnowledgeTool(event?.toolName);
      emit({
        ...base("tool_call_start", event),
        toolName: event?.toolName ?? null,
        toolCallId: event?.toolCallId ?? null,
        // 非检索类工具不记参数原文（防 exec 命令等敏感内容进交互库）
        query: knowledge ? clip(event?.params?.query ?? null) : undefined,
      });
    });

    api.on("after_tool_call", async (event) => {
      const knowledge = isKnowledgeTool(event?.toolName);
      emit({
        ...base("tool_call_end", event),
        toolName: event?.toolName ?? null,
        toolCallId: event?.toolCallId ?? null,
        durationMs: event?.durationMs ?? null,
        error: event?.error ? clip(String(event.error)) : null,
        resultText: knowledge ? clip(toolResultText(event?.result)) : undefined,
      });
    });

    api.on("agent_end", async (event) => {
      emit({
        ...base("agent_end", event),
        success: event?.success ?? null,
        durationMs: event?.durationMs ?? null,
        replyText: clip(lastAssistantText(event?.messages)),
      });
    });

    api.on("llm_output", async (event) => {
      emit({
        ...base("llm_output", event),
        model: event?.model ?? null,
        provider: event?.provider ?? null,
        usage: event?.usage ?? null,
      });
    });

    api.on("session_start", async (event) => {
      emit({ ...base("session_start", event), reason: event?.reason ?? null });
    });

    api.on("session_end", async (event) => {
      emit({ ...base("session_end", event), reason: event?.reason ?? null });
    });

    api.on("message_sent", async (event) => {
      emit({
        ...base("message_sent", event),
        messageId: event?.messageId ?? null,
        ok: event?.ok ?? event?.success ?? null,
        error: event?.error ? clip(String(event.error)) : null,
      });
    });
  },
});
