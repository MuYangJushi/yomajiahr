// 中间件（迁自 server.mjs，行为不变）。
import type { NextFunction, Request, Response } from "express";
import { extname } from "node:path";
import multer, { MulterError } from "multer";
// ADR-010：原始文件直传 FastGPT 解析，平台不再自研转换。上传过滤仅做粗筛（FastGPT 终判）。
export const SUPPORTED_UPLOAD_EXTS = [".pdf", ".docx", ".doc", ".txt", ".md", ".markdown", ".html", ".csv", ".pptx", ".xlsx"];
const isSupported = (ext: string): boolean => SUPPORTED_UPLOAD_EXTS.includes(ext.toLowerCase());
export const supportedFormats = (): string[] => SUPPORTED_UPLOAD_EXTS.map((e) => e.slice(1));
import {
  AUTH_TOKEN,
  AUTH_TOKEN_ROLE,
  DEV_LOCALHOST_ADMIN,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILE_MB,
  SESSION_SECRET,
} from "./config.js";
import { readSession } from "./auth/session.js";
import { isPlatformRole, type PlatformRole } from "./auth/types.js";
import { log, normalizeUploadedFilename } from "./util.js";

export function isLocalhost(req: Request): boolean {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/** 机器/服务 token 的能力档：显式 env 优先；否则 session 启用时保守为 ops，
 *  纯 token 旧模式（未启用 session）回落 admin 以兼容既有部署。 */
function serviceTokenRole(): PlatformRole {
  // 显式 env 必须命中白名单（用 includes，避免 `"toString" in ROLE_RANK` 这类原型链误判）。
  if (isPlatformRole(AUTH_TOKEN_ROLE)) return AUTH_TOKEN_ROLE;
  return SESSION_SECRET ? "ops" : "admin";
}

/** query 中需脱敏的键（OAuth 授权码、共享/用户 token 等），小写比较。 */
const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "code",
  "authcode",
  "access_token",
  "refresh_token",
  "client_secret",
]);

/** 脱敏日志 URL：屏蔽 query 里的敏感值，避免凭据（OAuth code / ?token=）写入日志。 */
function redactUrl(originalUrl: string): string {
  const q = originalUrl.indexOf("?");
  if (q < 0) return originalUrl;
  const params = new URLSearchParams(originalUrl.slice(q + 1));
  const toRedact: string[] = [];
  for (const key of params.keys()) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) toRedact.push(key);
  }
  if (toRedact.length === 0) return originalUrl;
  for (const key of toRedact) params.set(key, "***");
  return `${originalUrl.slice(0, q)}?${params.toString()}`;
}

/** /api 请求日志（query 敏感值已脱敏）。 */
export function requestLog(req: Request, _res: Response, next: NextFunction): void {
  log("INFO", `${req.method} ${redactUrl(req.originalUrl)}`);
  next();
}

/**
 * 双路径鉴权（决策六）：
 *   ① 平台 session cookie（人）→ req.user = human + platformRole
 *   ② Bearer token（机器/应急）→ req.user = service + serviceTokenRole()
 *   ③ DEV_LOCALHOST_ADMIN 开关 + localhost → req.user = service admin（仅开发）
 *   ④ 未配置任何凭据（首次部署）→ localhost 兜底 admin（带告警），非 localhost 403
 *   ⑤ 其余 → 401（提示登录）
 * 角色级守卫由各路由的 requireRole(...) 负责，这里只负责"认人 + 填 req.user"。
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // ① session（人）
  const session = readSession(req);
  if (session) {
    req.user = {
      platformUserId: session.platformUserId,
      name: session.name,
      platformRole: session.platformRole,
      type: "human",
      idp: session.idp,
    };
    return next();
  }

  // ② Bearer / ?token（机器）
  if (AUTH_TOKEN) {
    const token = req.headers.authorization?.replace("Bearer ", "") || (req.query.token as string);
    if (token === AUTH_TOKEN) {
      req.user = { platformUserId: "service", name: "service", platformRole: serviceTokenRole(), type: "service" };
      return next();
    }
  }

  // ③ 开发兜底：显式开关 + localhost
  if (DEV_LOCALHOST_ADMIN && isLocalhost(req)) {
    req.user = { platformUserId: "dev-localhost", name: "dev", platformRole: "admin", type: "service" };
    return next();
  }

  // ④ 完全未配置（无 token 且无 session）：首次部署兜底，仅 localhost
  if (!AUTH_TOKEN && !SESSION_SECRET) {
    if (isLocalhost(req)) {
      req.user = { platformUserId: "unconfigured-localhost", name: "local", platformRole: "admin", type: "service" };
      return next();
    }
    res.status(403).json({ error: "平台未配置认证（SESSION_SECRET / OPENCLAW_WEB_AUTH_TOKEN），仅允许 localhost 访问。" });
    return;
  }

  // ⑤ 需要登录
  res.status(401).json({ error: "未认证，请登录", login: "/api/auth/feishu/login" });
}

/** 无外部依赖的简单限流器。 */
export function rateLimit({ windowMs = 60_000, max = 10, message = "Too many requests" } = {}) {
  const hits = new Map<string, { start: number; count: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.start > windowMs) hits.delete(key);
    }
  }, windowMs).unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
}

/** 文件上传（内存存储 + 格式过滤）。 */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = extname(normalizeUploadedFilename(file.originalname)).toLowerCase();
    if (isSupported(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported format: ${ext}. Supported: ${supportedFormats().join(", ")}`));
    }
  },
});

/** 上传/文件错误处理（迁自 server.mjs 的 app.use 错误中间件）。 */
export function uploadErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!err) return next();
  if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({
      error: `文件过大，当前上传上限为 ${MAX_UPLOAD_FILE_MB}MB。请压缩 PDF 或拆分后重试。`,
      code: err.code,
      max_upload_mb: MAX_UPLOAD_FILE_MB,
    });
    return;
  }
  if (err instanceof Error) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
}
