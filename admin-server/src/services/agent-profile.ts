// AI 档案共创（ADR-013 #59+#60）：由岗位名 + 少量 hint 生成 5 段结构化 profile。
// 走 MiniMax Anthropic 兼容端点（与 openclaw runtime 共用 baseUrl），输入校验与 zod schema
// 由调用方保证；本模块只负责：
//   1) 构造 system prompt + user message（中文输出，硬约束"不编造具体制度/数字"）
//   2) 调 POST {baseUrl}/v1/messages（Anthropic 兼容）
//   3) 解析 + 截断 → 5 字段；不成功抛可读错误
// 失败语义：网络/HTTP/JSON 解析/字段缺失 → 一律抛 Error 含可读 message。
import { env } from "node:process";

const DEFAULT_BASE_URL = "https://api.minimaxi.com/anthropic";
const DEFAULT_MODEL = "MiniMax-Text-01";
const MAX_TOKENS = 1024;
const HTTP_TIMEOUT_MS = 30_000;

export interface ProfileGenerateInput {
  jobTitle: string;
  hints?: string;
  fields?: ProfileField[];
}

export const PROFILE_FIELDS = ["jobTitle", "responsibilities", "personality", "tone", "boundaries"] as const;
export type ProfileField = typeof PROFILE_FIELDS[number];

export interface GeneratedProfile {
  jobTitle: string;
  responsibilities: string;
  personality: string;
  tone: string;
  boundaries: string;
}

const SYSTEM_PROMPT = `你是 HR 数字员工档案共创助手。
输入是岗位名 + 简短 hint，输出必须是一个 JSON 对象，5 个键全部为中文短句：
  - "responsibilities"：2~4 条职责要点（用换行或 "；" 分隔；不要给具体数字/制度条款）
  - "personality"：3~5 个形容词（中文，逗号分隔）
  - "tone"：语气描述（1~2 句，例："简洁、就事论事"）
  - "boundaries"：1~2 条明确不做什么（例："不替代 HR 完成人工审批"）
硬约束：
  1. 不得编造具体公司名、薪资数字、休假天数等任何制度性内容
  2. 不得输出 JSON 以外的任何字符（包括 markdown 代码块）
  3. 边界（boundaries）必须落在"不替代/不审批/不外发"这类不破坏组织流程的范畴
仅输出 JSON，不要任何解释。`;

function buildUserMessage(input: ProfileGenerateInput): string {
  const parts: string[] = [`岗位：${input.jobTitle.trim()}`];
  if (input.hints && input.hints.trim()) parts.push(`补充描述：${input.hints.trim()}`);
  if (input.fields?.length) parts.push(`本次仅生成这些字段：${input.fields.join(", ")}`);
  parts.push("请按 system 规则输出 JSON。");
  return parts.join("\n");
}

function extractJsonObject(text: string): unknown {
  // 模型偶尔会包 markdown ```json ... ``` 围栏，做一次去围栏。
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  return JSON.parse(body);
}

function clean(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

function normalize(raw: unknown, fallbackJobTitle: string, fields?: ProfileField[]): GeneratedProfile {
  if (raw === null || typeof raw !== "object") throw new Error("模型输出非 JSON 对象");
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? clean(v) : "");
  const resp = str(o.responsibilities);
  const pers = str(o.personality);
  const tone = str(o.tone);
  const bound = str(o.boundaries);
  const required = new Set(fields?.length ? fields : PROFILE_FIELDS);
  const values = { jobTitle: str(o.jobTitle) || fallbackJobTitle, responsibilities: resp, personality: pers, tone, boundaries: bound };
  const missing = [...required].filter((field) => !values[field]);
  if (missing.length) {
    throw new Error(`模型输出缺字段：${missing.join("/")}`);
  }
  // 5 个字段全部强制上限，避免模型输出超长把 profile 灌爆 workspace。
  const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
  return {
    jobTitle: clean(values.jobTitle),
    responsibilities: cap(resp, 400),
    personality: cap(pers, 120),
    tone: cap(tone, 80),
    boundaries: cap(bound, 200),
  };
}

export async function generateAgentProfile(input: ProfileGenerateInput): Promise<GeneratedProfile> {
  if (typeof input.jobTitle !== "string" || !input.jobTitle.trim()) {
    throw new Error("jobTitle 不能为空");
  }
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
  let parsed: unknown;
  try {
    parsed = extractJsonObject(text);
  } catch (err) {
    throw new Error(`MiniMax 返回非 JSON：${(err as Error).message}；原文：${text.slice(0, 200)}`);
  }
  return normalize(parsed, input.jobTitle.trim(), input.fields);
}
