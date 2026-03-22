/**
 * Document metadata inference for the HR Admin Portal.
 *
 * Primary path:
 *   - Ask the configured default text model to infer metadata from converted Markdown.
 *
 * Fallback path:
 *   - Use deterministic heuristics so uploads still succeed if model inference fails.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { env } from "node:process";

const KNOWN_CATEGORIES = [
  "leave",
  "onboarding",
  "attendance",
  "compensation",
  "training",
  "general",
];

const CATEGORY_DOC_ID_PREFIX = {
  leave: "HR-LEAVE",
  onboarding: "HR-ONBOARD",
  attendance: "HR-ATT",
  compensation: "HR-COMP",
  training: "HR-TRAIN",
  general: "HR-GEN",
};

const DOC_ID_CATEGORY_MAP = new Map(
  Object.entries(CATEGORY_DOC_ID_PREFIX).map(([category, prefix]) => [prefix, category]),
);

function normalizeAnthropicBaseUrl(baseUrl) {
  return baseUrl
    .trim()
    .replace(/\/v1\/?$/, "")
    .replace(/\/$/, "");
}

function extractJsonObject(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : "";
}

function normalizeDate(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const direct = trimmed.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (direct) {
    return `${direct[1]}-${direct[2]}-${direct[3]}`;
  }
  const zh = trimmed.match(/(\d{4})[年/. -](\d{1,2})[月/. -](\d{1,2})日?/);
  if (!zh) {
    return "";
  }
  const month = zh[2].padStart(2, "0");
  const day = zh[3].padStart(2, "0");
  return `${zh[1]}-${month}-${day}`;
}

function normalizeVersion(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim().replace(/^v/i, "");
  return /^\d+(?:\.\d+)*$/.test(trimmed) ? trimmed : "";
}

function normalizeDocId(value) {
  if (typeof value !== "string") {
    return "";
  }
  const match = value
    .trim()
    .toUpperCase()
    .match(/\b(HR-[A-Z]+-\d{3})\b/);
  return match ? match[1] : "";
}

function normalizeCategory(value) {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (KNOWN_CATEGORIES.includes(trimmed)) {
    return trimmed;
  }
  if (trimmed === "work") {
    return "general";
  }
  return "";
}

function extractFrontmatterValue(markdown, key) {
  const match = markdown.match(new RegExp(`^${key}:\\s*"?(.*?)"?$`, "m"));
  return match ? match[1].trim() : "";
}

function extractHeading(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

function classifyCategoryHeuristically(text, fileName) {
  const corpus = `${fileName}\n${text}`.toLowerCase();
  const tests = [
    ["leave", ["年假", "病假", "请假", "休假", "假期", "婚假", "产假", "丧假", "leave"]],
    [
      "onboarding",
      ["入职", "离职", "转正", "试用期", "报到", "交接", "offer", "onboard", "probation"],
    ],
    ["attendance", ["考勤", "打卡", "加班", "排班", "调班", "attendance", "overtime"]],
    ["compensation", ["薪酬", "工资", "奖金", "补贴", "福利", "社保", "公积金", "compensation"]],
    ["training", ["培训", "学习", "课程", "认证", "考试", "training"]],
  ];
  for (const [category, needles] of tests) {
    if (needles.some((needle) => corpus.includes(needle))) {
      return category;
    }
  }
  return "general";
}

function inferHeuristics({ markdown, originalName }) {
  const title =
    extractFrontmatterValue(markdown, "title") ||
    extractHeading(markdown) ||
    basename(originalName);
  const explicitDocId =
    normalizeDocId(extractFrontmatterValue(markdown, "doc_id")) ||
    normalizeDocId(extractFrontmatterValue(markdown, "source_file")) ||
    normalizeDocId(markdown.match(/文档编号[:：]\s*([A-Z-0-9]+)/)?.[1] ?? "");
  const explicitCategory =
    normalizeCategory(extractFrontmatterValue(markdown, "category")) ||
    DOC_ID_CATEGORY_MAP.get(explicitDocId.replace(/-\d{3}$/, "")) ||
    "";
  const category =
    explicitCategory ||
    classifyCategoryHeuristically(markdown, basename(originalName).toLowerCase());
  const version =
    normalizeVersion(extractFrontmatterValue(markdown, "version")) ||
    normalizeVersion(markdown.match(/版本[:：]\s*([Vv]?\d+(?:\.\d+)+)/)?.[1] ?? "") ||
    "1.0";
  const effectiveDate =
    normalizeDate(extractFrontmatterValue(markdown, "effective_date")) ||
    normalizeDate(markdown.match(/生效日期[:：]\s*([^\n|]+)/)?.[1] ?? "") ||
    "";
  return {
    title,
    category,
    doc_id_explicit: explicitDocId,
    version,
    effective_date: effectiveDate,
    source: "heuristic",
    warnings: [],
  };
}

function resolveInlineEnvString(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  const envMatch = trimmed.match(/^\$\{([A-Z0-9_]+)\}$/);
  if (envMatch) {
    return env[envMatch[1]]?.trim() || "";
  }
  return trimmed;
}

function resolveProviderApiKey(providerId, providerConfig) {
  if (providerConfig?.apiKey && typeof providerConfig.apiKey === "object") {
    if (providerConfig.apiKey.source === "env" && typeof providerConfig.apiKey.id === "string") {
      return env[providerConfig.apiKey.id]?.trim() || "";
    }
  }
  const inline = resolveInlineEnvString(providerConfig?.apiKey);
  if (inline) {
    return inline;
  }
  const fallbacks = {
    minimax: ["MINIMAX_API_KEY"],
    anthropic: ["ANTHROPIC_API_KEY"],
    openai: ["OPENAI_API_KEY"],
  };
  for (const key of fallbacks[providerId] ?? []) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function resolveModelConfig({ stateDir }) {
  const configPath = env.OPENCLAW_CONFIG_PATH || join(stateDir, "ymjhr.json");
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    const primaryModel =
      cfg?.agents?.defaults?.model?.primary || cfg?.agents?.defaults?.models?.primary || "";
    if (!primaryModel || typeof primaryModel !== "string" || !primaryModel.includes("/")) {
      return null;
    }
    const [providerId, modelId] = primaryModel.split("/", 2);
    const providerConfig = cfg?.models?.providers?.[providerId];
    if (!providerConfig || providerConfig.api !== "anthropic-messages") {
      return null;
    }
    const apiKey = resolveProviderApiKey(providerId, providerConfig);
    const baseUrl = typeof providerConfig.baseUrl === "string" ? providerConfig.baseUrl.trim() : "";
    if (!apiKey || !baseUrl) {
      return null;
    }
    return {
      providerId,
      modelId,
      apiKey,
      baseUrl: normalizeAnthropicBaseUrl(baseUrl),
    };
  } catch {
    return null;
  }
}

async function inferWithModel({ markdown, originalName, sourceFormat, stateDir }) {
  const modelConfig = resolveModelConfig({ stateDir });
  if (!modelConfig) {
    return null;
  }

  const prompt = [
    "请从这份中国 HR 制度文档中提取元数据，返回严格 JSON，不要输出 JSON 以外的任何内容。",
    "",
    "要求：",
    `1. category 只能是: ${KNOWN_CATEGORIES.join(", ")}`,
    "2. title 为简洁正式的文档标题",
    "3. doc_id_explicit 只有在文档中已经明确出现文档编号时才填写，否则留空字符串",
    "4. version 只有在文档中明确出现版本号时才填写，否则留空字符串",
    "5. effective_date 只有在文档中明确出现生效日期时才填写，格式必须是 YYYY-MM-DD，否则留空字符串",
    "6. notes 用一句中文简述判断依据",
    "",
    '返回格式: {"title":"","category":"","doc_id_explicit":"","version":"","effective_date":"","notes":""}',
    "",
    `原始文件名: ${originalName}`,
    `源格式: ${sourceFormat}`,
    "",
    "转换后的 Markdown 内容如下：",
    markdown.slice(0, 16000),
  ].join("\n");

  const response = await fetch(`${modelConfig.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${modelConfig.apiKey}`,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelConfig.modelId,
      max_tokens: 400,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`metadata model request failed (${response.status})`);
  }

  const payload = await response.json();
  const text = Array.isArray(payload?.content)
    ? payload.content
        .filter((item) => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n")
    : "";
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    throw new Error("metadata model returned no JSON object");
  }
  const parsed = JSON.parse(jsonText);
  return {
    title: typeof parsed.title === "string" ? parsed.title.trim() : "",
    category: normalizeCategory(parsed.category),
    doc_id_explicit: normalizeDocId(parsed.doc_id_explicit),
    version: normalizeVersion(parsed.version),
    effective_date: normalizeDate(parsed.effective_date),
    notes: typeof parsed.notes === "string" ? parsed.notes.trim() : "",
    source: "model",
    provider: modelConfig.providerId,
    model: modelConfig.modelId,
  };
}

function nextGeneratedDocId({ category, policiesDir }) {
  const prefix = CATEGORY_DOC_ID_PREFIX[category] || CATEGORY_DOC_ID_PREFIX.general;
  const categoryDir = join(policiesDir, category);
  let maxSeq = 0;
  if (existsSync(categoryDir) && statSync(categoryDir).isDirectory()) {
    for (const file of readdirSync(categoryDir)) {
      if (!file.endsWith(".md")) {
        continue;
      }
      try {
        const content = readFileSync(join(categoryDir, file), "utf-8");
        const existingDocId = normalizeDocId(content.match(/^doc_id:\s*"?(.*?)"?$/m)?.[1] ?? "");
        const match = existingDocId.match(new RegExp(`^${prefix}-(\\d{3})$`));
        if (match) {
          maxSeq = Math.max(maxSeq, Number.parseInt(match[1], 10));
        }
      } catch {
        // Ignore malformed files and continue scanning.
      }
    }
  }
  return `${prefix}-${String(maxSeq + 1).padStart(3, "0")}`;
}

export async function inferDocumentMetadata(params) {
  const heuristic = inferHeuristics(params);
  const warnings = [];

  let inferred = null;
  try {
    inferred = await inferWithModel(params);
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
  }

  const title = inferred?.title || heuristic.title;
  const category = inferred?.category || heuristic.category || "general";
  const version = inferred?.version || heuristic.version || "1.0";
  const effectiveDate = inferred?.effective_date || heuristic.effective_date || "";
  const explicitDocId = inferred?.doc_id_explicit || heuristic.doc_id_explicit || "";
  const docId = explicitDocId || nextGeneratedDocId({ category, policiesDir: params.policiesDir });

  return {
    title,
    category,
    doc_id: docId,
    version,
    effective_date: effectiveDate,
    notes: inferred?.notes || "",
    source: inferred?.source || heuristic.source,
    provider: inferred?.provider || "",
    model: inferred?.model || "",
    warnings,
  };
}
