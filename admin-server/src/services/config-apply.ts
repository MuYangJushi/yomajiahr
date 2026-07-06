// P0 基石 B：触发配置应用（ADR-010 步骤6：由 lib/config-apply.mjs ts化迁入，行为保持不变）。
// 生产(systemd)：admin-server 仅原子写 control/apply-request.json，由特权 helper 执行重启；轮询结果。
// 开发(无 systemd 或 OPENCLAW_APPLY_DIRECT=1)：直接 spawn apply-config.sh 内联执行。
//
// ADR-016 §3：apply 拆为两类模式。
//   - mode=restart       渠道账号绑定 / 渠道凭证 / gateway 全局配置 → 走 stop→swap→start（现有强路径，不变）。
//   - mode=runtime-only  创建 agent / 改档案 / 配技能 → 仅生成+校验+原子替换 runtime，**不重启 gateway**。
//     平台内 Web 对话与下一次 CLI run 会从磁盘重读新配置；不承诺常驻 gateway 已热加载。
//   - 知识库绑定会新增/删除 per-agent MCP 注册，需 restart 让常驻 gateway 重载工具表。
// `applyModeForOperation(operation)` 集中判定，避免散落布尔硬编码。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type ApplyMode = "restart" | "runtime-only";

// 用户发起的 agent/channel 写操作会触发生成/校验、gateway restart 或 runtime-only apply；
// 生产上 systemd helper + 探活窗口常超过默认 30s，统一使用扩展等待窗口，避免把 pending 误判为失败。
export const EXTENDED_APPLY_TIMEOUT_MS = 120_000;

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
  // "0" 显式强制队列模式（写 request 文件 + 轮询，即生产语义）；无 systemd 环境下供 pending 路径测试。
  if (process.env.OPENCLAW_APPLY_DIRECT === "0") return false;
  return process.env.OPENCLAW_APPLY_DIRECT === "1" || !hasSystemd();
}

function readResult(resultPath: string): ApplyResult | null {
  try {
    return JSON.parse(readFileSync(resultPath, "utf-8")) as ApplyResult;
  } catch {
    return null;
  }
}

/**
 * 按操作类型判定 apply 模式（ADR-016 §3.1 调用方矩阵）。
 * 渠道无关且不改 MCP 注册的变更（agent 档案/技能）→ runtime-only；知识库绑定会改 MCP 注册，渠道绑定 / 网关全局配置 → restart。
 * `agent.delete` 视是否带渠道而定；未知操作默认 restart（安全兜底）。
 */
export function applyModeForOperation(operation: string | undefined, opts?: { agentHasChannels?: boolean }): ApplyMode {
  switch (operation) {
    case "agent.create":
    case "agent.update.profile":
    case "agent.skill.update":
      return "runtime-only";
    case "knowledge.bind":
    case "knowledge.unbind":
    case "knowledge.delete":
    case "knowledge.base.create":
    case "knowledge.base.delete":
      return "restart";
    case "agent.delete":
      // 删除带渠道的 agent 等同解绑渠道 → restart；纯无渠道 agent → runtime-only。
      return opts?.agentHasChannels ? "restart" : "runtime-only";
    case "agent.channel.bind":
    case "agent.channel.unbind":
    case "knowledge.config":
    case "gateway.restart":
    default:
      return "restart";
  }
}

/** 触发一次配置应用。生产走 request 文件 + 轮询；开发直接 spawn 脚本。 */
export async function triggerApply({
  stateDir,
  repoDir,
  timeoutMs = 30000,
  resetAgentIds = [],
  revokedKnowledgeAgentIds = [],
  mode = "restart",
  operation,
}: {
  stateDir: string;
  repoDir: string;
  timeoutMs?: number;
  resetAgentIds?: string[];
  revokedKnowledgeAgentIds?: string[];
  /** ADR-016 §3：apply 模式。默认 restart（安全兜底，与历史行为一致）。 */
  mode?: ApplyMode;
  /** 业务操作标签，供 applyModeForOperation 与审计/前端展示。 */
  operation?: string;
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
    mode,
    operation: operation ?? "",
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
        resolve({ ...r, mode: r.mode || mode });
      });
      child.on("error", (e) => resolve({ status: "failed", message: e.message, mode }));
    });
    return result;
  }

  // —— 生产：原子写请求文件，轮询结果 ——
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const r = readResult(resultPath);
    if (r?.requestId === id) return { ...r, mode: r.mode || mode };
  }
  // pending = 已触发但终态未知，不是失败；带出 requestId 供调用方/后台继续追踪同一请求的终态。
  return { status: "pending", message: "apply 已触发，结果未在超时内返回，请稍后查询", mode, requestId: id };
}

/** 读取最近一次 apply 结果（供状态查询）。 */
export function readLastResult(stateDir: string): ApplyResult | null {
  return readResult(join(stateDir, "control", "apply-result.json"));
}

/**
 * 按 requestId 轮询 apply 终态。只认同一 requestId 的结果，避免并发写操作时误读他人结果。
 * 局限：apply-result.json 只存最近一次结果，若后续请求覆盖了结果文件则本请求终态不可再得 → 超时返回 null。
 */
export async function waitForApplyResult(
  stateDir: string,
  requestId: string,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<ApplyResult | null> {
  const resultPath = join(stateDir, "control", "apply-result.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = readResult(resultPath);
    if (r?.requestId === requestId) return r;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return null;
}

// 已在后台追踪的 pending requestId，去重防止同一请求起多个轮询。
const trackedPending = new Set<string>();

/** 追踪窗口：pending 后再等 10 分钟。生产 restart apply 含 gateway 重启+探活，正常几分钟内出终态。 */
export const PENDING_TRACK_TIMEOUT_MS = 600_000;

/**
 * pending 后台追踪（fire-and-forget）：继续等同一 requestId 的终态并落日志（journald 可查）。
 * 终态 failed 只记录不自动回滚——store 已写入且用户已收到「应用中」，静默回滚比失败本身更难排查；
 * 生产服务不健康另有监控（#75）兜底。
 */
export function trackPendingApply(stateDir: string, apply: ApplyResult, label: string): void {
  const requestId = apply.requestId;
  if (apply.status !== "pending" || !requestId || trackedPending.has(requestId)) return;
  trackedPending.add(requestId);
  void waitForApplyResult(stateDir, requestId, PENDING_TRACK_TIMEOUT_MS).then((r) => {
    trackedPending.delete(requestId);
    if (!r) {
      console.warn(`[apply-pending] ${label} requestId=${requestId} 追踪超时（${PENDING_TRACK_TIMEOUT_MS / 60000} 分钟内无终态），请人工核查 apply 结果`);
    } else if (r.status === "failed") {
      console.error(`[apply-pending] ${label} requestId=${requestId} 最终失败：${r.message || ""}（store 已写入，需人工重试 apply 或回退变更）`);
    } else {
      console.log(`[apply-pending] ${label} requestId=${requestId} 最终成功`);
    }
  });
}

/**
 * apply 结果判定（pending 语义收口，设计债 apply-pending-design-debt.md 方向 3）：
 * - failed  = 明确失败 → throw，交由调用方回滚；
 * - pending = 终态未知 → 不当失败、不触发回滚，后台继续追踪终态；
 * - success = 通过。
 */
export function ensureApplied(apply: ApplyResult, label: string, stateDir?: string): void {
  if (apply.status === "failed") throw new Error(`${label}：${apply.message || apply.status}`);
  if (apply.status === "pending" && stateDir) trackPendingApply(stateDir, apply, label);
}

/** 结果对象里是否携带 pending 的 apply（供 job message 与前端提示判定）。 */
export function hasPendingApply(result: unknown): boolean {
  const apply = (result as { apply?: ApplyResult } | null | undefined)?.apply;
  return Boolean(apply && typeof apply === "object" && apply.status === "pending");
}
