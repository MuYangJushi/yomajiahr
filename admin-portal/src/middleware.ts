// 中间件（迁自 server.mjs，行为不变）。
import type { NextFunction, Request, Response } from "express";
import { extname } from "node:path";
import multer, { MulterError } from "multer";
import { isSupported, supportedFormats } from "../lib/doc-converter.mjs";
import { AUTH_TOKEN, MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_FILE_MB } from "./config.js";
import { log, normalizeUploadedFilename } from "./util.js";

/** /api 请求日志。 */
export function requestLog(req: Request, _res: Response, next: NextFunction): void {
  log("INFO", `${req.method} ${req.originalUrl}`);
  next();
}

/** Token 鉴权；未配置 token 时仅允许 localhost。 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_TOKEN) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || "";
    const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (isLocal) return next();
    res.status(403).json({ error: "Auth token not configured. Only localhost access allowed." });
    return;
  }
  const token = req.headers.authorization?.replace("Bearer ", "") || (req.query.token as string);
  if (token === AUTH_TOKEN) return next();
  res.status(401).json({ error: "Unauthorized" });
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
