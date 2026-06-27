// Web 内置对话路由（ADR-016 §2）：平台侧管理员调试/验证，requireRole("ops")。
//   POST   /config/agents/:id/chat                     body { message, sessionId? } → { reply, sessionId, durationMs }
//   GET    /config/agents/:id/chat/sessions            → { sessions: [...] }
//   GET    /config/agents/:id/chat/sessions/:sid       → { sessionId, messages: [...] }
//   DELETE /config/agents/:id/chat/sessions/:sid       → { success: true }
//
// 对话走 services/agent-chat.ts（per-turn spawn openclaw --local，不经常驻 gateway）。
// 写操作（对话 + 会话重置）落 audit-log.jsonl（agent.chat.*），不记录完整消息正文。
import { Router, type Request, type Response } from "express";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { requireRole } from "../auth/rbac.js";
import { STATE_DIR } from "../config.js";
import { upload } from "../middleware.js";
import { appendAuditLog, auditOperator, normalizeUploadedFilename } from "../util.js";
import {
  ChatError,
  chatWithAgent,
  deleteSession,
  getSession,
  listSessions,
} from "../services/agent-chat.js";

export const agentChatRouter = Router();

const chatUpload = upload.single("file");

function statusFor(err: unknown): number {
  if (err instanceof ChatError) return err.status;
  return 500;
}

agentChatRouter.post("/config/agents/:id/chat", requireRole("ops"), chatUpload, async (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  const rawMessage = typeof req.body?.message === "string" ? req.body.message : "";
  const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined;
  const operator = auditOperator(req);
  const startedAt = Date.now();
  let tempDir: string | undefined;
  let tempPath: string | undefined;
  let message = rawMessage;
  try {
    if (req.file) {
      const originalName = normalizeUploadedFilename(req.file.originalname);
      const uploadRoot = join(STATE_DIR, "tmp", "chat-uploads", agentId);
      tempDir = join(uploadRoot, `${Date.now()}-${randomUUID()}`);
      mkdirSync(tempDir, { recursive: true });
      tempPath = join(tempDir, originalName);
      writeFileSync(tempPath, req.file.buffer);
      const attachmentLine = `[media attached: ${tempPath}]`;
      message = rawMessage.trim() ? `${rawMessage.trim()}\n\n${attachmentLine}` : attachmentLine;
    }

    const result = await chatWithAgent({ agentId, message, sessionId });
    appendAuditLog("agent.chat.message", agentId, operator, {
      agent_id: agentId,
      session_id: result.sessionId,
      message_length: rawMessage.length,
      attachment: req.file ? { filename: normalizeUploadedFilename(req.file.originalname), size: req.file.size } : undefined,
      status: "success",
      duration_ms: result.durationMs,
    });
    res.json(result);
  } catch (err) {
    const e = err as Error & ChatError;
    appendAuditLog("agent.chat.message", agentId, operator, {
      agent_id: agentId,
      session_id: sessionId,
      message_length: rawMessage.length,
      attachment: req.file ? { filename: normalizeUploadedFilename(req.file.originalname), size: req.file.size } : undefined,
      status: "failed",
      code: e.code,
      duration_ms: Date.now() - startedAt,
    });
    res.status(statusFor(err)).json({ error: e.message, code: e.code });
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
});

agentChatRouter.get("/config/agents/:id/chat/sessions", requireRole("ops"), (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  try {
    res.json({ sessions: listSessions(agentId) });
  } catch (err) {
    res.status(statusFor(err)).json({ error: (err as Error).message, code: (err as ChatError).code });
  }
});

agentChatRouter.get("/config/agents/:id/chat/sessions/:sid", requireRole("ops"), (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  const sid = String(req.params.sid);
  try {
    res.json(getSession(agentId, sid));
  } catch (err) {
    res.status(statusFor(err)).json({ error: (err as Error).message, code: (err as ChatError).code });
  }
});

agentChatRouter.delete("/config/agents/:id/chat/sessions/:sid", requireRole("ops"), (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  const sid = String(req.params.sid);
  const operator = auditOperator(req);
  try {
    deleteSession(agentId, sid);
    appendAuditLog("agent.chat.session.delete", agentId, operator, {
      agent_id: agentId,
      session_id: sid,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(statusFor(err)).json({ error: (err as Error).message, code: (err as ChatError).code });
  }
});
