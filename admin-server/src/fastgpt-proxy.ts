// #46 FastGPT 反向代理（独立端口 19450）：把 FastGPT 整套 web UI 嵌进平台（知识库页 iframe）。
//
// ⚠️ 外露端口，能打到 FastGPT 全套 admin API —— 安全模型（不可省）：
//   ① fail-closed 平台 RBAC：仅持平台会话且 ≥ops 的用户可达（authMiddleware + requireRole）。
//   ② FastGPT 仍不公开（仅 WireGuard 10.99.0.1:3000 可达），浏览器只经本代理到它。
//   ③ 上游应配最小权限 FastGPT 凭据。
//   ④ 剥离 X-Frame-Options/CSP frame-ancestors，允许被平台 iframe 嵌入。
//
// SSO 接缝（#46 验证：dataset Bearer key 认证不了 SPA 的 user-session 闸 tokenLogin）：
//   配齐 FASTGPT_WEB_USERNAME/PASSWORD → 服务端登录 FastGPT、缓存会话 token、注入每个代理请求 →
//   管理员免二次登录。未配 → 透明代理，iframe 内走 FastGPT 自带登录一次（功能可用，仅多一次登录）。
import express, { type NextFunction, type Request, type Response } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import {
  FASTGPT_BASE_URL,
  FASTGPT_PROXY_ENABLED,
  FASTGPT_PROXY_PORT,
  FASTGPT_WEB_PASSWORD,
  FASTGPT_WEB_USERNAME,
} from "./config.js";
import { authMiddleware } from "./middleware.js";
import { requireRole } from "./auth/rbac.js";
import { log } from "./util.js";

const READ_ONLY_POST_PATHS = new Set([
  "/api/common/system/getInitData",
  "/api/core/dataset/list",
  "/api/core/dataset/detail",
  "/api/core/dataset/searchTest",
  "/api/core/dataset/collection/list",
  "/api/core/dataset/collection/detail",
  "/api/core/dataset/data/list",
  "/api/support/user/account/loginByPassword",
]);

/** 反代只用于读/检视。未明确列入的 POST 及所有写方法一律 fail-closed。 */
export function isAllowedFastgptProxyRequest(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = path.split("?", 1)[0].replace(/\/+$/, "") || "/";
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD" || normalizedMethod === "OPTIONS") return true;
  return normalizedMethod === "POST" && READ_ONLY_POST_PATHS.has(normalizedPath);
}

function requireReadOnlyProxy(req: Request, res: Response, next: NextFunction): void {
  if (!isAllowedFastgptProxyRequest(req.method, req.originalUrl)) {
    res.status(403).json({ error: "FastGPT 反代仅允许读/检视；写操作请使用平台原生知识库接口" });
    return;
  }
  next();
}

// —— SSO：服务端登录 FastGPT，拿会话 token，缓存复用 ——
let cachedToken: { value: string; expiresAt: number } | null = null;
const TOKEN_TTL_MS = 30 * 60_000; // 保守缓存 30 分钟，到期重登

async function fetchFastgptToken(): Promise<string | null> {
  if (!FASTGPT_WEB_USERNAME || !FASTGPT_WEB_PASSWORD) return null; // 未配凭据 → 不注入（login-once 模式）
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  try {
    const res = await fetch(`${FASTGPT_BASE_URL}/api/support/user/account/loginByPassword`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: FASTGPT_WEB_USERNAME, password: FASTGPT_WEB_PASSWORD }),
    });
    if (!res.ok) {
      log("WARN", `FastGPT SSO 登录失败 ${res.status}（回退 login-once）`);
      return null;
    }
    // token 落点按 4.8.x：优先响应体 data.token，回退 Set-Cookie 的 token=。
    const body = (await res.json().catch(() => null)) as { data?: { token?: string } } | null;
    let token = body?.data?.token || "";
    if (!token) {
      const setCookie = res.headers.get("set-cookie") || "";
      token = setCookie.match(/(?:^|[;,\s])token=([^;]+)/)?.[1] || "";
    }
    if (!token) {
      log("WARN", "FastGPT SSO 登录成功但未取到 token（回退 login-once）");
      return null;
    }
    cachedToken = { value: token, expiresAt: Date.now() + TOKEN_TTL_MS };
    return token;
  } catch (err) {
    log("WARN", `FastGPT SSO 登录异常（回退 login-once）：${(err as Error).message}`);
    return null;
  }
}

/** 在代理前取好 SSO token 挂到 req（proxyReq 钩子是同步的，必须预取）。 */
async function attachSsoToken(req: Request, _res: Response, next: NextFunction): Promise<void> {
  (req as Request & { __fgToken?: string }).__fgToken = (await fetchFastgptToken()) || undefined;
  next();
}

export function startFastgptProxy(): void {
  if (!FASTGPT_PROXY_ENABLED) {
    log("INFO", "FastGPT 反代未启用（FASTGPT_PROXY_ENABLED!=1）");
    return;
  }
  if (!FASTGPT_BASE_URL) {
    log("WARN", "FastGPT 反代已启用但缺 FASTGPT_BASE_URL —— 跳过");
    return;
  }

  const app = express();

  // ① fail-closed 平台 RBAC：认人 → 要求 ≥ops。ops 可做读/检视，写操作由下方只读闸统一拒绝。
  app.use(authMiddleware);
  app.use(requireRole("ops"));
  // ② 只读闸：FastGPT 写操作必须走平台原生接口，确保治理与审计不被绕过。
  app.use(requireReadOnlyProxy);
  // ③ SSO token 预取（有凭据才注入）。
  app.use(attachSsoToken);
  // ④ 透明代理到 FastGPT（含 _next 资源 / api）。
  app.use(
    createProxyMiddleware({
      target: FASTGPT_BASE_URL,
      changeOrigin: true,
      // WebSocket upgrade 不经过上述 Express 只读/RBAC 中间件，禁用以免形成旁路。
      ws: false,
      on: {
        proxyReq: (proxyReq, req) => {
          const token = (req as Request & { __fgToken?: string }).__fgToken;
          if (token) {
            // 注入 FastGPT 会话（覆盖浏览器侧 cookie 的 token；其余 cookie 对 FastGPT 无意义）。
            proxyReq.setHeader("cookie", `token=${token}`);
            proxyReq.setHeader("token", token);
          }
        },
        proxyRes: (proxyRes) => {
          // 允许被平台 iframe 嵌入。
          delete proxyRes.headers["x-frame-options"];
          delete proxyRes.headers["content-security-policy"];
        },
        error: (err, _req, res) => {
          log("ERROR", `FastGPT 反代错误：${err.message}`);
          if (res && "writeHead" in res && !res.headersSent) {
            (res as Response).status(502).end("知识库平台暂不可达");
          }
        },
      },
    }),
  );

  app.listen(FASTGPT_PROXY_PORT, "0.0.0.0", () => {
    const sso = FASTGPT_WEB_USERNAME && FASTGPT_WEB_PASSWORD ? "SSO 注入" : "login-once";
    log("INFO", `FastGPT 只读反代监听 :${FASTGPT_PROXY_PORT} → ${FASTGPT_BASE_URL}（${sso}，仅 ≥ops 会话可达）`);
  });
}
