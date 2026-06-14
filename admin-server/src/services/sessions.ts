import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { STATE_DIR } from "../config.js";

/**
 * 重置 Agent 当前正在沿用的会话上下文，但保留全部历史会话。
 *
 * OpenClaw 的 sessions.json 是「会话键 → 当前 transcript」索引；移除当前索引后，
 * 下一条消息会创建全新上下文。当前 transcript 按 OpenClaw `/reset` 的命名习惯归档，
 * 不删除历史记录。调用方随后重启 Gateway，确保进程内状态同步失效。
 */
export function resetCurrentAgentSessions(agentIds: Iterable<string>): Array<{ agentId: string; sessionCount: number }> {
  const reset: Array<{ agentId: string; sessionCount: number }> = [];
  const timestamp = new Date().toISOString().replace(/:/g, "-");
  for (const agentId of new Set(agentIds)) {
    if (!agentId) continue;
    const sessionsDir = join(STATE_DIR, "agents", agentId, "sessions");
    const storePath = join(sessionsDir, "sessions.json");
    if (!existsSync(storePath)) continue;
    const store = JSON.parse(readFileSync(storePath, "utf-8")) as Record<string, { sessionFile?: unknown }>;
    const entries = Object.values(store);
    for (const entry of entries) {
      if (
        typeof entry?.sessionFile !== "string" ||
        dirname(resolve(entry.sessionFile)) !== resolve(sessionsDir) ||
        !existsSync(entry.sessionFile)
      ) continue;
      renameSync(entry.sessionFile, `${entry.sessionFile}.reset.${timestamp}`);
    }
    const tmp = `${storePath}.tmp`;
    writeFileSync(tmp, "{}\n");
    renameSync(tmp, storePath);
    reset.push({ agentId, sessionCount: entries.length });
  }
  return reset;
}
