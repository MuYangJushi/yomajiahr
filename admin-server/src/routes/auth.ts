// 平台登录路由（决策六 ①）：飞书 OAuth 登录 + session 颁发 + me/logout。
// 本路由公开（挂在 authMiddleware 之前）。
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { Router, type Request, type Response } from "express";
import {
  DEMO_ACCESS_CODE,
  DEMO_ACCESS_ENABLED,
  DEMO_ACCESS_ROLE,
  OPEN_ENTERPRISE_LOGIN_ROLE,
  DEV_LOCALHOST_ADMIN,
  PUBLIC_BASE_URL,
  SESSION_SECRET,
} from "../config.js";
import { isLocalhost, rateLimit } from "../middleware.js";
import { feishuAuthorizeUrl, feishuConfigured, feishuExchangeCode } from "../auth/feishu.js";
import { dingtalkAuthorizeUrl, dingtalkConfigured, dingtalkExchangeCode } from "../auth/dingtalk.js";
import {
  clearOauthState,
  clearSession,
  issueOauthState,
  issueSession,
  readSession,
  verifyOauthState,
} from "../auth/session.js";
import { resolveUser } from "../auth/users.js";
import { log } from "../util.js";

export const authRouter = Router();
const demoLoginLimiter = rateLimit({ windowMs: 60_000, max: 10, message: "访问码尝试过于频繁，请稍后再试" });

/** 恒定时间校验访问码；长度不同时仍执行一次 timingSafeEqual。 */
export function verifyDemoAccessCode(candidate: unknown): boolean {
  if (!DEMO_ACCESS_ENABLED || typeof candidate !== "string") return false;
  const actual = Buffer.from(DEMO_ACCESS_CODE);
  const input = Buffer.from(candidate);
  const comparable = input.length === actual.length ? input : Buffer.alloc(actual.length);
  return timingSafeEqual(actual, comparable) && input.length === actual.length;
}

/** 计算回调基址：优先 PUBLIC_BASE_URL，否则按请求头推导（反代需正确转发协议/host）。 */
function baseUrl(req: Request): string {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "";
  return `${proto}://${host}`;
}

/** 前端用：哪些 IdP 可用 + 是否已启用 session（SESSION_SECRET 配置与否）。 */
authRouter.get("/auth/providers", (_req: Request, res: Response) => {
  res.json({
    session_enabled: Boolean(SESSION_SECRET),
    providers: {
      feishu: feishuConfigured() && Boolean(SESSION_SECRET),
      dingtalk: dingtalkConfigured() && Boolean(SESSION_SECRET),
    },
    open_enterprise_login: {
      enabled: Boolean(OPEN_ENTERPRISE_LOGIN_ROLE),
      role: OPEN_ENTERPRISE_LOGIN_ROLE || null,
    },
    demo_access_code: {
      enabled: DEMO_ACCESS_ENABLED,
      role: DEMO_ACCESS_ENABLED ? DEMO_ACCESS_ROLE : null,
    },
  });
});

/** 当前登录用户（无 session → 401）。 */
authRouter.get("/auth/me", (req: Request, res: Response) => {
  const s = readSession(req);
  if (s) return res.json({ platformUserId: s.platformUserId, name: s.name, platformRole: s.platformRole, idp: s.idp });
  // 开发兜底：与 authMiddleware ③ 一致（ADMIN_PORTAL_DEV_LOCALHOST_ADMIN=1 且 localhost），
  // 让 SPA 登录闸放行；受保护路由仍由 authMiddleware 按 localhost 授予 admin。
  if (DEV_LOCALHOST_ADMIN && isLocalhost(req)) {
    return res.json({ platformUserId: "dev-localhost", name: "Dev (localhost)", platformRole: "admin", idp: "dev" });
  }
  return res.status(401).json({ error: "未登录" });
});

/** 登出。 */
authRouter.post("/auth/logout", (_req: Request, res: Response) => {
  clearSession(res);
  res.json({ ok: true });
});

/** 比赛访问码登录：绕过企业 IdP，但仅签发 ops/audit 临时会话。 */
authRouter.post("/auth/demo/login", demoLoginLimiter, (req: Request, res: Response) => {
  if (!DEMO_ACCESS_ENABLED) return res.status(404).json({ error: "比赛访问码登录未启用" });
  if (!verifyDemoAccessCode(req.body?.code)) {
    log("WARN", `比赛访问码登录失败：ip=${req.ip || req.socket.remoteAddress || "unknown"}`);
    return res.status(401).json({ error: "访问码错误" });
  }

  const visitorId = randomUUID();
  issueSession(res, {
    platformUserId: `demo:${visitorId}`,
    name: "比赛访客",
    platformRole: DEMO_ACCESS_ROLE as "ops" | "audit",
    idp: "demo",
  });
  log("INFO", `比赛访问码登录成功：visitor=${visitorId}（${DEMO_ACCESS_ROLE}）`);
  return res.json({ ok: true });
});

/** 飞书登录入口：生成 state，跳转飞书授权页。 */
authRouter.get("/auth/feishu/login", (req: Request, res: Response) => {
  if (!SESSION_SECRET) return res.status(503).send("平台未配置 SESSION_SECRET，登录不可用");
  if (!feishuConfigured()) return res.status(503).send("飞书登录未配置（缺 FEISHU_LOGIN_APP_ID/SECRET）");
  const state = randomUUID();
  issueOauthState(res, state);
  const redirectUri = `${baseUrl(req)}/api/auth/feishu/callback`;
  res.redirect(feishuAuthorizeUrl(state, redirectUri));
});

/** 飞书回调：校验 state → 换 code → 角色映射 → 颁 session → 回根 /。 */
authRouter.get("/auth/feishu/callback", async (req: Request, res: Response) => {
  try {
    if (!verifyOauthState(req, req.query.state as string | undefined)) {
      log(
        "WARN",
        `飞书 state 校验失败：host=${req.headers.host || ""} has_cookie=${Boolean(req.headers.cookie)} has_state=${Boolean(req.query.state)}`,
      );
      return res.status(400).send("state 校验失败（可能为 CSRF 或已过期），请重新登录");
    }
    clearOauthState(res);
    const code = req.query.code as string | undefined;
    const error = req.query.error as string | undefined;
    if (error) {
      log("WARN", `飞书授权被拒：${error}`);
      return res.redirect("/login?error=access_denied");
    }
    if (!code) return res.status(400).send("缺少授权 code");

    // redirect_uri 必须与授权阶段完全一致
    const redirectUri = `${baseUrl(req)}/api/auth/feishu/callback`;
    const identity = await feishuExchangeCode(code, redirectUri);
    const user = resolveUser(identity);
    if (!user) {
      log("WARN", `飞书登录被拒（未获授权/未过企业成员闸门）：${identity.name} union_id=${identity.unionId}`);
      return res.redirect("/login?error=unauthorized");
    }

    issueSession(res, {
      platformUserId: user.platformUserId,
      name: user.name,
      platformRole: user.platformRole,
      idp: "feishu",
    });
    log("INFO", `飞书登录成功：${user.name}（${user.platformRole}）`);
    res.redirect("/");
  } catch (err) {
    log("ERROR", `飞书回调失败：${(err as Error).message}`);
    res.redirect("/login?error=login_failed");
  }
});

/** 钉钉登录入口：生成 state，跳转钉钉授权页。 */
authRouter.get("/auth/dingtalk/login", (req: Request, res: Response) => {
  if (!SESSION_SECRET) return res.status(503).send("平台未配置 SESSION_SECRET，登录不可用");
  if (!dingtalkConfigured()) return res.status(503).send("钉钉登录未配置（缺 DINGTALK_LOGIN_CLIENT_ID/SECRET）");
  const state = randomUUID();
  issueOauthState(res, state);
  const redirectUri = `${baseUrl(req)}/api/auth/dingtalk/callback`;
  res.redirect(dingtalkAuthorizeUrl(state, redirectUri));
});

/** 钉钉回调：校验 state → 换 authCode → 角色映射 → 颁 session → 回根 /。 */
authRouter.get("/auth/dingtalk/callback", async (req: Request, res: Response) => {
  try {
    if (!verifyOauthState(req, req.query.state as string | undefined)) {
      log(
        "WARN",
        `钉钉 state 校验失败：host=${req.headers.host || ""} has_cookie=${Boolean(req.headers.cookie)} has_state=${Boolean(req.query.state)}`,
      );
      return res.status(400).send("state 校验失败（可能为 CSRF 或已过期），请重新登录");
    }
    clearOauthState(res);
    // ⚠️ 钉钉回调用 authCode（兼容 code 以防文档/版本差异）
    const code = (req.query.authCode || req.query.code) as string | undefined;
    const error = req.query.error as string | undefined;
    if (error) {
      log("WARN", `钉钉授权被拒：${error}`);
      return res.redirect("/login?error=access_denied");
    }
    if (!code) return res.status(400).send("缺少授权 authCode");

    const identity = await dingtalkExchangeCode(code);
    const user = resolveUser(identity);
    if (!user) {
      log("WARN", `钉钉登录被拒（未获授权/未过企业成员闸门）：${identity.name} union_id=${identity.unionId} corp_id=${identity.corpId || "-"}`);
      return res.redirect("/login?error=unauthorized");
    }

    issueSession(res, {
      platformUserId: user.platformUserId,
      name: user.name,
      platformRole: user.platformRole,
      idp: "dingtalk",
    });
    log("INFO", `钉钉登录成功：${user.name}（${user.platformRole}）`);
    res.redirect("/");
  } catch (err) {
    log("ERROR", `钉钉回调失败：${(err as Error).message}`);
    res.redirect("/login?error=login_failed");
  }
});
