// AI 技能正文生成（design 重做技能编辑抽屉 → 落地）：
// 由技能 ID + 描述 + 一句话场景，生成 Markdown 行为约定正文。
// 与 agent-profile 同走 MiniMax Anthropic 兼容端点；区别：本模块输出单段 Markdown 正文（非结构化 JSON）。
// 仅生成「正文」——frontmatter（name/description/requiredRole/requiresKnowledge）由表单维护，
// 系统红线（AGENTS/TOOLS/MEMORY）不在此生成。失败一律抛可读 Error。
import { env } from "node:process";

const DEFAULT_BASE_URL = "https://api.minimaxi.com/anthropic";
const DEFAULT_MODEL = "MiniMax-Text-01";
const MAX_TOKENS = 1500;
const HTTP_TIMEOUT_MS = 30_000;
const BODY_MAX = 8000;

export interface SkillBodyInput {
  name: string;
  description?: string;
  hints?: string;
}

const SYSTEM_PROMPT = `你是 HR 数字员工「技能」（skill）撰写助手。技能是一段 Markdown 能力提示词，约束数字员工"何时触发该技能、如何组织答案、如何引用、未命中怎么处理"。
请根据技能 ID、描述与一句话场景，生成一段规范、可直接落地的 Markdown 正文。
要求：
  1. 只输出 Markdown 正文，不要输出 frontmatter（name/description/requiredRole/requiresKnowledge 由表单维护）。
  2. 结构建议含：## 触发（何时启用该技能）、## 行为约定（有序步骤），必要时补 ## 引用规范 / ## 边界。
  3. 若涉及知识库问答，必须包含：先检索知识库（knowledge_search）再回答、按来源引用（如 [来源: filename, 文档编号, 版本]）、未命中明确拒答不编造、受限内容（薪酬/绩效）不外泄。
  4. 不得编造具体公司名、制度条款、数字。
  5. 使用简体中文。
仅输出 Markdown 正文，不要任何额外解释，也不要用代码围栏包裹。`;

// 去控制字符但保留 Markdown 必需的制表/换行/回车（codePointAt 数字字面，避免在源码内写控制字符）。
function clean(value: string): string {
  let out = "";
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)) out += ch;
  }
  return out.trim();
}
// 模型偶尔会用 ```markdown ... ``` 围栏包裹，去一次围栏。
function stripFence(text: string): string {
  const fenced = text.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

function buildUserMessage(input: SkillBodyInput): string {
  const parts: string[] = [`技能 ID：${input.name.trim()}`];
  if (input.description && input.description.trim()) parts.push(`描述：${input.description.trim()}`);
  if (input.hints && input.hints.trim()) parts.push(`场景描述：${input.hints.trim()}`);
  parts.push("请按 system 规则生成 Markdown 正文。");
  return parts.join("\n");
}

export async function generateSkillBody(input: SkillBodyInput): Promise<string> {
  if (typeof input.name !== "string" || !input.name.trim()) throw new Error("name 不能为空");
  const apiKey = env.MINIMAX_API_KEY || "";
  if (!apiKey) throw new Error("MINIMAX_API_KEY 未配置");
  const baseUrl = (env.MINIMAX_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = env.MINIMAX_AGENT_PROFILE_MODEL || DEFAULT_MODEL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserMessage(input) }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`调 MiniMax 失败：${(err as Error).message}`);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`MiniMax HTTP ${res.status}：${txt.slice(0, 200)}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("MiniMax 返回 content 缺少 text 块");
  const body = clean(stripFence(text));
  if (!body) throw new Error("模型输出为空");
  return body.length > BODY_MAX ? body.slice(0, BODY_MAX) : body;
}
