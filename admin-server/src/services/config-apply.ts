// P0 基石 B：触发配置应用（ADR-010 步骤6：由 lib/config-apply.mjs ts化迁入，行为保持不变）。
// 生产(systemd)：admin-server 仅原子写 control/apply-request.json，由特权 helper 执行重启；轮询结果。
// 开发(无 systemd 或 OPENCLAW_APPLY_DIRECT=1)：直接 spawn apply-config.sh 内联执行。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface ApplyResult {
  status: "success" | "failed" | "pending";
  message?: string;
  version?: string;
  mode?: string;
  ts?: string;
  requestId?: string;
  resetSessions?: Array<{ agentId: string; sessionCount: number }>;
  [k: string]: unknown;
}

function hasSystemd(): boolean {
  return existsSync("/run/systemd/system");
}

function isDirectMode(): boolean {
  return process.env.OPENCLAW_APPLY_DIRECT === "1" || !hasSystemd();
}

function readResult(resultPath: string): ApplyResult | null {
  try {
    return JSON.parse(readFileSync(resultPath, "utf-8")) as ApplyResult;
  } catch {
    return null;
  }
}

/** 触发一次配置应用。生产走 request 文件 + 轮询；开发直接 spawn 脚本。 */
export async function triggerApply({
  stateDir,
  repoDir,
  timeoutMs = 30000,
  resetAgentIds = [],
  revokedKnowledgeAgentIds = [],
}: {
  stateDir: string;
  repoDir: string;
  timeoutMs?: number;
  resetAgentIds?: string[];
  revokedKnowledgeAgentIds?: string[];
}): Promise<ApplyResult> {
  const controlDir = join(stateDir, "control");
  mkdirSync(controlDir, { recursive: true });
  const requestPath = join(controlDir, "apply-request.json");
  const resultPath = join(controlDir, "apply-result.json");
  const id = randomUUID();
  const requestedAt = new Date().toISOString();
  const request = {
    id,
    requestedAt,
    resetAgentIds: [...new Set(resetAgentIds)],
    revokedKnowledgeAgentIds: [...new Set(revokedKnowledgeAgentIds)],
  };
  const tmp = `${requestPath}.${id}.tmp`;
  writeFileSync(tmp, JSON.stringify(request, null, 2) + "\n");
  renameSync(tmp, requestPath);

  if (isDirectMode()) {
    // —— 开发：直接执行流水线脚本 ——
    const script = join(repoDir, "config", "scripts", "apply-config.sh");
    const result = await new Promise<ApplyResult>((resolve) => {
      const child = spawn("bash", [script], {
        env: { ...process.env, REPO_DIR: repoDir, STATE_DIR: stateDir, PROCESS_APPLY_REQUEST: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        const r = readResult(resultPath) || {
          status: code === 0 ? "success" : "failed",
          message: stderr.trim().split("\n").slice(-1)[0] || `exit ${code}`,
        };
        resolve({ ...r, mode: "direct" });
      });
      child.on("error", (e) => resolve({ status: "failed", message: e.message, mode: "direct" }));
    });
    return result;
  }

  // —— 生产：原子写请求文件，轮询结果 ——
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const r = readResult(resultPath);
    if (r?.requestId === id) return { ...r, mode: "request" };
  }
  return { status: "pending", message: "apply 已触发，结果未在超时内返回，请稍后查询", mode: "request" };
}

/** 读取最近一次 apply 结果（供状态查询）。 */
export function readLastResult(stateDir: string): ApplyResult | null {
  return readResult(join(stateDir, "control", "apply-result.json"));
}
