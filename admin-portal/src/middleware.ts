// 中间件（迁自 server.mjs，行为不变）。
import type { NextFunction, Request, Response } from "express";
import { extname } from "node:path";
import multer, { MulterError } from "multer";
import { isSupported, supportedFormats } from "../lib/doc-converter.mjs";
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

function isLocalhost(req: Request): boolean {
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

/** /api 请求日志。 */
export function requestLog(req: Request, _res: Response, next: NextFunction): void {
  log("INFO", `${req.method} ${req.originalUrl}`);
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
