// 引用来源行服务端兜底（Backlog P2，2026-07-06）。
//
// after_tool_call（观察）：解析本 run 的 knowledge_search 结果，登记来源文件名；
// message_sending（决策）：出站回复缺 `[来源: ...]` 行且本 run 有检索来源 → 追加。
//
// 边界：仅追加不删改原文；每 run 只补一次（分段回复不重复）；短消息（<80 字符）
// 不处理；模型自己带了规范引用则清登记不干预；登记 10 分钟惰性过期防泄漏。
// 覆盖面：渠道出站路径（飞书/钉钉真实员工回复）；web 试聊为 embedded 无
// message_sending，不覆盖（内容正确且内联有出处，接受现状——见盲测基线报告 §5）。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { SourceRegistry, decideRewrite, extractSources } from "./lib.js";

const registry = new SourceRegistry();

function isKnowledgeSearch(name) {
  return typeof name === "string" && /__knowledge_search$/.test(name);
}

function keysOf(event) {
  const ctx = (event && event.context) || {};
  return [event?.runId ?? ctx.runId, ctx.sessionKey ?? event?.sessionKey].filter(Boolean);
}

function resultText(result) {
  const content = result?.content;
  if (Array.isArray(content)) {
    return content.filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
  }
  return typeof result === "string" ? result : "";
}

export default definePluginEntry({
  id: "citation-enforcer",
  name: "Yoma+HR Citation Enforcer",
  register(api) {
    api.on("after_tool_call", async (event) => {
      try {
        if (!isKnowledgeSearch(event?.toolName) || event?.error) return;
        const sources = extractSources(resultText(event?.result));
        for (const key of keysOf(event)) registry.add(key, sources);
      } catch {
        // 观察路径异常静默
      }
    });

    api.on("message_sending", async (event) => {
      try {
        const rewritten = decideRewrite(registry, keysOf(event), event?.content);
        if (rewritten) return { content: rewritten };
      } catch {
        // 兜底失败不干预投递
      }
      return undefined;
    });
  },
});
