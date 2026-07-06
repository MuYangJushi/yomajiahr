// citation-enforcer 纯逻辑（与 hook 注册分离，便于 node:test 单测）。
//
// 背景（盲测端到端 v1.1 + 引用契约实验，2026-07-04）：MiniMax M3 约 30% 回复
// 省略 hr-policy-qa 规范的 `[来源: 文件名]` 尾行（内容正确、正文内联有出处），
// 提示词强化实测无效（73.3% vs 70%）。本插件在渠道出站层做确定性兜底。

const SOURCE_RE = /\[来源:\s*([^\]\n]+)\]/g;
const MIN_CONTENT_LEN = 80; // 过滤「好的」「正在查询」类短消息
const ENTRY_TTL_MS = 10 * 60 * 1000;

/** 从 knowledge_search 结果文本提取来源文件名（去重保序）。 */
export function extractSources(resultText) {
  if (typeof resultText !== "string") return [];
  const out = [];
  for (const m of resultText.matchAll(SOURCE_RE)) {
    const name = m[1].trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** 出站文本是否已含规范来源行。 */
export function hasCitation(content) {
  return typeof content === "string" && /\[来源:\s*[^\]\n]+\]/.test(content);
}

/** 追加来源行（保持 skill 规范格式：结尾独立行，多来源逐行）。 */
export function appendCitation(content, sources) {
  const lines = sources.map((s) => `[来源: ${s}]`).join("\n");
  return `${content.replace(/\s+$/, "")}\n\n${lines}`;
}

/** run 级来源登记表：runId/sessionKey → { sources, at }，惰性过期。 */
export class SourceRegistry {
  constructor(now = Date.now) {
    this.map = new Map();
    this.now = now;
  }

  #sweep() {
    const cutoff = this.now() - ENTRY_TTL_MS;
    for (const [k, v] of this.map) {
      if (v.at < cutoff) this.map.delete(k);
    }
  }

  add(key, sources) {
    if (!key || !sources.length) return;
    this.#sweep();
    const entry = this.map.get(key) ?? { sources: [], at: this.now() };
    for (const s of sources) {
      if (!entry.sources.includes(s)) entry.sources.push(s);
    }
    entry.at = this.now();
    this.map.set(key, entry);
  }

  /** 取出并清除（每 run 只补一次，避免分段回复重复追加）。 */
  take(key) {
    if (!key) return [];
    const entry = this.map.get(key);
    if (!entry) return [];
    this.map.delete(key);
    return entry.sources;
  }

  has(key) {
    return !!key && this.map.has(key);
  }
}

/**
 * 出站决策：需要补引用时返回改写后的 content，否则返回 null（无决策）。
 * keys 按优先级尝试（runId 优先，sessionKey 兜底）。
 */
export function decideRewrite(registry, keys, content) {
  if (typeof content !== "string" || content.length < MIN_CONTENT_LEN) return null;
  if (hasCitation(content)) {
    // 模型自己带了规范引用：清除登记，避免 sessionKey 兜底误补到下一条消息
    for (const k of keys) registry.take(k);
    return null;
  }
  for (const k of keys) {
    if (registry.has(k)) {
      const sources = registry.take(k);
      if (sources.length) return appendCitation(content, sources);
    }
  }
  return null;
}
