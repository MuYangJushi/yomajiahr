// 运行时配置与目录（迁自 server.mjs 顶部 Config 段，行为不变）。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";

// 运行文件位于 dist/server.js；据此推导目录。
const ADMIN_DIR = join(import.meta.dirname, ".."); // admin-server/
export const REPO_DIR = join(ADMIN_DIR, ".."); // 仓库根（含 config/）
export const PUBLIC_DIR = join(ADMIN_DIR, "public");

export const PORT = Number(env.ADMIN_PORTAL_PORT || env.PORT || 18790);
export const STATE_DIR = env.OPENCLAW_STATE_DIR || join(env.HOME!, ".openclaw");
export const AUDIT_LOG_PATH = join(STATE_DIR, "data", "hr-admin", "audit-log.jsonl");
// ADR-010：文档存于 FastGPT，平台不再本地归档/切片，故移除 POLICIES_DIR / CHUNKS_DIR。
export const AUTH_TOKEN = env.OPENCLAW_WEB_AUTH_TOKEN || "";
/** 机器/服务 token 的能力档（显式覆盖）。合法值 admin|ops|audit。 */
export const AUTH_TOKEN_ROLE = (env.OPENCLAW_WEB_AUTH_TOKEN_ROLE || "").trim();
export const BIND_HOST = env.ADMIN_PORTAL_BIND || "";

// —— 平台认证 / RBAC（决策六）——
/** 平台 session 签名密钥；未配置则 IdP 登录禁用（回落到 token/localhost）。 */
export const SESSION_SECRET = env.SESSION_SECRET || "";
/** 平台 session 有效期（秒），默认 12 小时。 */
export const SESSION_MAX_AGE_SEC = Math.max(300, Number(env.ADMIN_PORTAL_SESSION_MAX_AGE_SEC || 12 * 3600));
/** 生产环境标记：cookie 加 Secure、收口 localhost 兜底。 */
export const IS_PROD = (env.NODE_ENV || "") === "production";
/** 飞书"网页登录"应用凭据（可单开应用，或复用管理 Bot 应用）。 */
export const FEISHU_LOGIN_APP_ID = env.FEISHU_LOGIN_APP_ID || env.FEISHU_ADMIN_BOT_APP_ID || "";
export const FEISHU_LOGIN_APP_SECRET = env.FEISHU_LOGIN_APP_SECRET || env.FEISHU_ADMIN_BOT_APP_SECRET || "";
/** OAuth 回调基址（如 https://portal.example.com）；用于拼回调 URL。 */
export const PUBLIC_BASE_URL = (env.ADMIN_PORTAL_PUBLIC_URL || "").replace(/\/$/, "");
/**
 * 仅 localhost SSH 隧道联调的明文 http 回调才去掉 Secure cookie，
 * 否则 OAuth state/session cookie 不会随明文回调可靠返回。
 * 非回环主机即使配成 http 也保留 Secure，避免误配明文公网地址
 * 静默导致 session cookie 被明文传输/嗅探。
 * 未显式配置回调基址时，生产环境仍默认 Secure，适配 HTTPS 反代。
 */
const PUBLIC_BASE_IS_LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(PUBLIC_BASE_URL);
export const COOKIE_SECURE = PUBLIC_BASE_URL
  ? PUBLIC_BASE_URL.startsWith("https://") || !PUBLIC_BASE_IS_LOOPBACK
  : IS_PROD;
/** 飞书开放平台 API 地址（token/user_info），默认国内站。 */
export const FEISHU_OPEN_BASE = (env.FEISHU_OPEN_BASE || "https://open.feishu.cn").replace(/\/$/, "");
/** 飞书 OAuth 授权域名（与 API 域名不同！授权走 accounts.feishu.cn）。 */
export const FEISHU_ACCOUNTS_BASE = (env.FEISHU_ACCOUNTS_BASE || "https://accounts.feishu.cn").replace(/\/$/, "");
/** 申请的授权 scope（空格分隔）。② 归一化需手机号/邮箱时填
 *  `contact:user.phone:readonly contact:user.email:readonly`；① 仅 union_id 可留空。 */
export const FEISHU_LOGIN_SCOPE = (env.FEISHU_LOGIN_SCOPE || "").trim();
/** 钉钉"网页登录"应用凭据（可单开应用，或复用管理 Bot 应用）。 */
export const DINGTALK_LOGIN_CLIENT_ID = env.DINGTALK_LOGIN_CLIENT_ID || env.DINGTALK_ADMIN_BOT_CLIENT_ID || "";
export const DINGTALK_LOGIN_CLIENT_SECRET =
  env.DINGTALK_LOGIN_CLIENT_SECRET || env.DINGTALK_ADMIN_BOT_CLIENT_SECRET || "";
/** 钉钉 OAuth 授权域名（登录页，与 API 域名不同）。 */
export const DINGTALK_LOGIN_BASE = (env.DINGTALK_LOGIN_BASE || "https://login.dingtalk.com").replace(/\/$/, "");
/** 钉钉开放平台 API 地址（换 token / 取用户信息）。 */
export const DINGTALK_API_BASE = (env.DINGTALK_API_BASE || "https://api.dingtalk.com").replace(/\/$/, "");
/** 钉钉授权 scope，默认 openid（手机号/邮箱由应用权限决定，非 scope）。 */
export const DINGTALK_LOGIN_SCOPE = (env.DINGTALK_LOGIN_SCOPE || "openid").trim();
/**
 * 本企业钉钉 corpId（企业开放登录的成员闸门）。钉钉「统一登录」可放进任意钉钉用户，
 * 故开放登录时必须用 token 响应里的 corpId 比对本企业；未配置 = 钉钉开放登录 fail-closed。
 * 飞书自建应用换 code 成功即证明本租户成员，无需对应配置。
 */
export const DINGTALK_LOGIN_CORP_ID = (env.DINGTALK_LOGIN_CORP_ID || "").trim();
/** 开发兜底：显式置 1 时，localhost 无凭据请求按 admin 放行（生产请勿开启）。 */
export const DEV_LOCALHOST_ADMIN = env.ADMIN_PORTAL_DEV_LOCALHOST_ADMIN === "1";
/** 引导管理员名单（解决首个 admin 的鸡生蛋）：逗号分隔的手机号或 IdP unionId。
 *  命中者按 admin 放行；待 users.json 建立后由其接管，env 仍作为长期兜底。 */
export const BOOTSTRAP_ADMINS = (env.PLATFORM_BOOTSTRAP_ADMINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
/**
 * 企业开放登录：未命中名单的已认证 IdP 用户（须通过企业成员闸门，见 auth/users.ts）
 * 获得指定基线角色。空值/非法值/admin 均关闭该通道，避免误配置把任意账号提升为管理员。
 * 旧名 PLATFORM_DEMO_OPEN_LOGIN_ROLE 保留兼容（比赛展示期遗留）。
 */
const OPEN_ENTERPRISE_LOGIN_ROLE_RAW = (
  env.PLATFORM_OPEN_ENTERPRISE_LOGIN_ROLE ||
  env.PLATFORM_DEMO_OPEN_LOGIN_ROLE ||
  ""
).trim();
export const OPEN_ENTERPRISE_LOGIN_ROLE: "ops" | "audit" | "" =
  OPEN_ENTERPRISE_LOGIN_ROLE_RAW === "ops" || OPEN_ENTERPRISE_LOGIN_ROLE_RAW === "audit"
    ? OPEN_ENTERPRISE_LOGIN_ROLE_RAW
    : "";
/**
 * 比赛访问码登录：独立于企业 IdP，供外部评委/体验用户临时进入。
 * 访问码至少 16 字符，角色只允许 ops/audit；任一条件不满足即关闭。
 */
export const DEMO_ACCESS_CODE = env.PLATFORM_DEMO_ACCESS_CODE || "";
const DEMO_ACCESS_ROLE_RAW = (env.PLATFORM_DEMO_ACCESS_ROLE || "ops").trim();
export const DEMO_ACCESS_ROLE: "ops" | "audit" | "" =
  DEMO_ACCESS_ROLE_RAW === "ops" || DEMO_ACCESS_ROLE_RAW === "audit" ? DEMO_ACCESS_ROLE_RAW : "";
export const DEMO_ACCESS_ENABLED = Boolean(SESSION_SECRET && DEMO_ACCESS_CODE.length >= 16 && DEMO_ACCESS_ROLE);
export const MAX_UPLOAD_FILE_MB = Math.max(1, Number(env.ADMIN_PORTAL_MAX_UPLOAD_MB || 50));
export const MAX_UPLOAD_FILE_BYTES = MAX_UPLOAD_FILE_MB * 1024 * 1024;

// —— 知识库平台（ADR-006 / FastGPT 集成）——
// fastgpt | local。ADR-010：FastGPT 为唯一知识源（已弃本地 doc-chunker/memory_search 回退）；local 仅作未配置态标记。
export const KNOWLEDGE_PLATFORM = (env.KNOWLEDGE_PLATFORM || "local").trim();
export const FASTGPT_BASE_URL = (env.FASTGPT_BASE_URL || "").replace(/\/$/, "");
export const FASTGPT_API_KEY = env.FASTGPT_API_KEY || "";
export const FASTGPT_KB_ID = env.FASTGPT_KB_ID || "";
export const FASTGPT_EMBEDDING_MODEL = env.FASTGPT_EMBEDDING_MODEL || "";
/** MCP 端点（/mcp）的 Bearer 令牌：供 openclaw `mcp add --header` 鉴权。
 *  必须强随机、与 OPENCLAW_WEB_AUTH_TOKEN 不同；未配置则 /mcp fail-closed（拒绝全部）。
 *  admin-server 在公网主机绑 0.0.0.0 时，此令牌即 /mcp 的唯一守卫——务必当真密钥对待。 */
export const KNOWLEDGE_MCP_TOKEN = env.KNOWLEDGE_MCP_TOKEN || "";

/** 确保运行所需目录存在。ADR-010：不再本地归档/切片，仅保留审计日志目录。 */
export function ensureDirs(): void {
  mkdirSync(join(STATE_DIR, "data", "hr-admin"), { recursive: true });
}
