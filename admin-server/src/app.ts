// Express 应用装配（中间件顺序与 server.mjs 严格一致，行为不变）。
import express, { type Request, type Response } from "express";
import { join } from "node:path";
import {
  AUTH_TOKEN,
  MAX_UPLOAD_FILE_MB,
  PUBLIC_DIR,
} from "./config.js";
import { authMiddleware, requestLog, supportedFormats, uploadErrorHandler } from "./middleware.js";
import { authRouter } from "./routes/auth.js";
import { uploadRouter } from "./routes/upload.js";
import { auditRouter } from "./routes/audit.js";
import { configRouter } from "./routes/config.js";
import { agentsRouter } from "./routes/agents.js";
import { knowledgeRouter } from "./routes/knowledge.js";
import { agentProfileRouter } from "./routes/agent-profile.js";
import { channelsRouter } from "./routes/channels.js";
import { applyJobsRouter } from "./routes/apply-jobs.js";
import { mountMcp } from "./mcp.js";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  // /api 请求日志
  app.use("/api", requestLog);

  // 健康检查：鉴权之前（供 LB/systemd 探针）
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "hr-admin-server" });
  });

  // MCP 端点（架构 I）：自带 Bearer 鉴权，独立于 /api 的 cookie/RBAC，故挂在 authMiddleware 之外。
  mountMcp(app);

  // 平台登录路由：公开（鉴权之前），供 OAuth 登录/回调/me/logout
  app.use("/api", authRouter);

  // 鉴权应用到其余 /api
  app.use("/api", authMiddleware);

  // 业务路由（挂在 /api）
  app.use("/api", uploadRouter);
  app.use("/api", auditRouter);
  app.use("/api", configRouter);
  app.use("/api", agentsRouter);
  app.use("/api", knowledgeRouter);
  app.use("/api", agentProfileRouter);
  app.use("/api", channelsRouter);
  app.use("/api", applyJobsRouter);

  // 服务信息
  app.get("/api/info", (_req: Request, res: Response) => {
    res.json({
      name: "HR Admin Portal",
      version: "1.0.0",
      supported_formats: supportedFormats(),
      auth_enabled: Boolean(AUTH_TOKEN),
      max_upload_mb: MAX_UPLOAD_FILE_MB,
    });
  });

  // 上传/文件错误处理（multer 错误经 next(err) 到此）
  app.use(uploadErrorHandler);

  // 新平台 SPA（React+antd）挂在 /console；静态资源由上方 express.static 提供，
  // 这里仅对非文件路径回退 index.html 以支持前端路由。
  app.get(/^\/console(\/.*)?$/, (_req: Request, res: Response) => {
    res.sendFile(join(PUBLIC_DIR, "console", "index.html"));
  });

  // 旧 vanilla SPA fallback（步骤4 迁入 /console 后移除）
  app.get(/^\/(upload|documents|audit-log)?$/, (_req: Request, res: Response) => {
    res.sendFile(join(PUBLIC_DIR, "index.html"));
  });

  return app;
}
