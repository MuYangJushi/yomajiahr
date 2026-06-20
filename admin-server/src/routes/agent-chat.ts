// Web 内置对话路由（ADR-016 §2）：平台侧管理员调试/验证，requireRole("ops")。
//   POST   /config/agents/:id/chat                     body { message, sessionId? } → { reply, sessionId, durationMs }
//   GET    /config/agents/:id/chat/sessions            → { sessions: [...] }
//   GET    /config/agents/:id/chat/sessions/:sid       → { sessionId, messages: [...] }
//   DELETE /config/agents/:id/chat/sessions/:sid       → { success: true }
//
// 对话走 services/agent-chat.ts（per-turn spawn openclaw --local，不经常驻 gateway）。
// 写操作（对话 + 会话重置）落 audit-log.jsonl（agent.chat.*），不记录完整消息正文。
import { Router, type Request, type Response } from "express";
import { requireRole } from "../auth/rbac.js";
import { appendAuditLog } from "../util.js";
import {
  ChatError,
  chatWithAgent,
  deleteSession,
  getSession,
  listSessions,
} from "../services/agent-chat.js";

export const agentChatRouter = Router();

function statusFor(err: unknown): number {
  if (err instanceof ChatError) return err.status;
  return 500;
}

agentChatRouter.post("/config/agents/:id/chat", requireRole("ops"), async (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  const message = typeof req.body?.message === "string" ? req.body.message : "";
  const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined;
  const operator = req.user?.platformUserId || "";
  const startedAt = Date.now();
  try {
    const result = await chatWithAgent({ agentId, message, sessionId });
    appendAuditLog("agent.chat.message", agentId, {
      agent_id: agentId,
      session_id: result.sessionId,
      message_length: message.length,
      status: "success",
      duration_ms: result.durationMs,
      operator,
    });
    res.json(result);
  } catch (err) {
    const e = err as Error & ChatError;
    appendAuditLog("agent.chat.message", agentId, {
      agent_id: agentId,
      session_id: sessionId,
      message_length: message.length,
      status: "failed",
      code: e.code,
      duration_ms: Date.now() - startedAt,
      operator,
    });
    res.status(statusFor(err)).json({ error: e.message, code: e.code });
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
  const operator = req.user?.platformUserId || "";
  try {
    deleteSession(agentId, sid);
    appendAuditLog("agent.chat.session.delete", agentId, {
      agent_id: agentId,
      session_id: sid,
      operator,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(statusFor(err)).json({ error: (err as Error).message, code: (err as ChatError).code });
  }
});
