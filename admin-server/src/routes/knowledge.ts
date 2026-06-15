// 知识库平台路由（ADR-006 / FastGPT 集成，#37 骨架）。
// RBAC：读=ops；改绑定（影响员工检索）=admin。审计：导入/删除/绑定变更进 audit-log.jsonl。
import { Router, type Request, type Response } from "express";
import { requireRole } from "../auth/rbac.js";
import { appendAuditLog } from "../util.js";
import { listAgents } from "../services/orchestrator.js";
import { triggerApply } from "../services/config-apply.js";
import { enqueueApplyJob } from "../services/apply-jobs.js";
import { REPO_DIR, STATE_DIR } from "../config.js";
import {
  KnowledgeStore,
  KnowledgeUnavailableError,
  createKnowledgeBase,
  health,
  isCollectionRestricted,
  isKbRestricted,
  listChunks,
  listCollections,
  listKnowledgeBases,
  readKnowledgeStore,
  removeCollection,
  resolveCollectionBoundAgents,
  search,
  updateKnowledgeConfig,
  validateKnowledgeStore,
  writeKnowledgeStore,
  type CreateKbInput,
  type KnowledgeConfigInput,
} from "../services/knowledge.js";

export const knowledgeRouter = Router();

// GET /knowledge/health —— 平台类型/可达/回退态（#37 核心，不依赖实例）。
knowledgeRouter.get("/knowledge/health", requireRole("ops"), async (_req: Request, res: Response) => {
  try {
    res.json(await health());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /knowledge/config —— 值只键级 upsert 到 $STATE_DIR/.env；不进 config-store、不回传值。
knowledgeRouter.put("/knowledge/config", requireRole("admin"), (req: Request, res: Response) => {
  try {
    const updatedKeys = updateKnowledgeConfig(req.body as KnowledgeConfigInput);
    appendAuditLog("CONFIG_KNOWLEDGE", "knowledge-platform", {
      operator: req.user?.platformUserId || "",
      updatedKeys,
    });
    res.json({ success: true, updatedKeys, restartRequired: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /knowledge/collections —— FastGPT 优先；不可用回退本地归档列表。
// #41/ADR-009：可选 ?datasetId 指定库（单库文档管理 Tab）；省略退默认。指定的库必须已登记。
knowledgeRouter.get("/knowledge/collections", requireRole("ops"), async (req: Request, res: Response) => {
  const datasetId = req.query?.datasetId ? String(req.query.datasetId) : undefined;
  if (
    datasetId &&
    !readKnowledgeStore().knowledgeBases.some((kb) => kb.provider === "fastgpt" && kb.externalKbId === datasetId)
  ) {
    res.status(400).json({ error: "目标知识库未在平台登记" });
    return;
  }
  // ADR-010：受限库（薪酬/绩效）的文档列表仅 admin 可见（与切片预览、员工召回层一致）。
  if (datasetId && isKbRestricted(datasetId) && req.user?.platformRole !== "admin") {
    res.status(403).json({ error: "该知识库为受限库，仅管理员可查看文档列表" });
    return;
  }
  try {
    const collections = await listCollections(datasetId);
    res.json({ collections, source: "fastgpt" });
  } catch (err) {
    // ADR-010：无本地归档回退；FastGPT 不可用即如实返回 503。
    if (err instanceof KnowledgeUnavailableError) {
      res.status(503).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /knowledge/collections/:collectionId/chunks —— 切片预览（ADR-009）。
// ⚠️ Gate-3：暴露整段 chunk 正文。受限分类（按 collection category 派生，fail-closed）内容仅 admin 可见。
// 注意：路由顺序须在 DELETE /knowledge/collections/:docId 之前不冲突——方法+子路径不同，安全。
knowledgeRouter.get(
  "/knowledge/collections/:collectionId/chunks",
  requireRole("ops"),
  async (req: Request, res: Response) => {
    const collectionId = String(req.params.collectionId);
    const offset = Math.max(0, Number(req.query?.offset) || 0);
    const pageSize = Math.min(100, Math.max(1, Number(req.query?.pageSize) || 20));
    try {
      // 先判受限——内容是敏感面，必须在取正文之前过角色闸（fail-closed：解析失败按受限）。
      const restricted = await isCollectionRestricted(collectionId);
      if (restricted && req.user?.platformRole !== "admin") {
        res.status(403).json({ error: "受限分类内容仅管理员可查看切片正文" });
        return;
      }
      res.json(await listChunks(collectionId, offset, pageSize));
    } catch (err) {
      if (err instanceof KnowledgeUnavailableError) {
        res.status(503).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// POST /knowledge/search-test —— 召回测试（管理员页用，非员工通道）。
knowledgeRouter.post("/knowledge/search-test", requireRole("ops"), async (req: Request, res: Response) => {
  const query = String(req.body?.query || "").trim();
  const topK = Math.min(20, Math.max(1, Number(req.body?.topK) || 5));
  // #45：可指定某个库做召回测试；省略则走默认。
  const datasetId = req.body?.datasetId ? String(req.body.datasetId) : undefined;
  if (!query) {
    res.status(400).json({ error: "query 不能为空" });
    return;
  }
  if (
    datasetId &&
    !readKnowledgeStore().knowledgeBases.some((kb) => kb.provider === "fastgpt" && kb.externalKbId === datasetId)
  ) {
    res.status(400).json({ error: "目标知识库未在平台登记" });
    return;
  }
  try {
    res.json({ chunks: await search(query, topK, datasetId ? [datasetId] : undefined) });
  } catch (err) {
    if (err instanceof KnowledgeUnavailableError) {
      res.status(503).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /knowledge/import —— 导入（#38 接通；当前未配置返回 503）。审计 IMPORT。
knowledgeRouter.post("/knowledge/import", requireRole("ops"), async (_req: Request, res: Response) => {
  res.status(503).json({ error: "FastGPT 导入待实例就绪后接通（#38）；当前请用现有 /upload 走本地链路" });
});

// DELETE /knowledge/collections/:docId —— 删除（#38 接通）。审计 DELETE。
knowledgeRouter.delete("/knowledge/collections/:docId", requireRole("ops"), async (req: Request, res: Response) => {
  try {
    const collectionId = String(req.params.docId);
    const datasetId = req.query?.datasetId ? String(req.query.datasetId) : undefined;
    if (
      datasetId &&
      !readKnowledgeStore().knowledgeBases.some((kb) => kb.provider === "fastgpt" && kb.externalKbId === datasetId)
    ) {
      res.status(400).json({ error: "目标知识库未在平台登记" });
      return;
    }
    const affectedAgents = await resolveCollectionBoundAgents(collectionId, datasetId);
    await removeCollection(collectionId);
    const apply = affectedAgents.length > 0
      ? await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, timeoutMs: 60_000, resetAgentIds: affectedAgents })
      : undefined;
    const resetSessions = apply?.resetSessions ?? [];
    appendAuditLog("DELETE", collectionId, {
      source: "fastgpt",
      resetSessions,
      applyStatus: apply?.status,
    });
    if (apply?.status === "failed") {
      res.status(502).json({
        error: "文档已删除且当前会话已归档，但 Gateway 重启失败；需重试应用配置以清除进程内上下文",
        resetSessions,
        apply,
      });
      return;
    }
    res.status(apply?.status === "pending" ? 202 : 200).json({
      success: apply?.status !== "pending",
      resetSessions,
      apply,
    });
  } catch (err) {
    if (err instanceof KnowledgeUnavailableError) {
      res.status(503).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /knowledge/bindings —— 读绑定关系 + 可绑定数字员工列表。
knowledgeRouter.get("/knowledge/bindings", requireRole("ops"), (_req: Request, res: Response) => {
  try {
    res.json({ store: readKnowledgeStore(), agents: listAgents() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /knowledge/bases —— #45 多库列表（平台登记 + 可绑定数字员工）。
knowledgeRouter.get("/knowledge/bases", requireRole("ops"), (_req: Request, res: Response) => {
  try {
    res.json({ bases: listKnowledgeBases(), agents: listAgents() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /knowledge/bases —— #45 原生新建知识库（FastGPT dataset/create + 写 knowledge.json）。审计 CREATE_KB。
knowledgeRouter.post("/knowledge/bases", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const input = req.body as CreateKbInput;
    const validAgents = new Set(listAgents().map((agent) => agent.id));
    if (
      input.boundAgents !== undefined &&
      (!Array.isArray(input.boundAgents) ||
        input.boundAgents.some((agentId) => typeof agentId !== "string" || !validAgents.has(agentId)))
    ) {
      res.status(400).json({ error: "boundAgents 必须只包含已登记的 Agent ID" });
      return;
    }
    const binding = await createKnowledgeBase(input);
    // 新库若已绑 agent，需 apply 才会暴露 knowledge_search（ADR-011）。库已建好，apply 失败
    // 不回滚库（FastGPT dataset 合法存在）——回传 apply 状态供前端提示，运维可重试 apply。
    // pending：apply 仍在进行，不报错；前端可轮询。
    // 审计顺序：apply 之后才落库——若 apply 失败，审计记 FAILED；否则记 CREATED，使审计与 apply 终态一致。
    const apply =
      binding.boundAgents.length > 0
        ? await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, timeoutMs: 60_000 })
        : undefined;
    const applyFailed = apply?.status === "failed";
    appendAuditLog(applyFailed ? "CREATE_KB_FAILED" : "CREATE_KB", binding.id, {
      operator: req.user?.platformUserId || "",
      name: binding.name,
      externalKbId: binding.externalKbId,
      boundAgents: binding.boundAgents,
      applyStatus: apply?.status,
      applyMessage: apply?.message,
    });
    res.status(applyFailed ? 502 : apply?.status === "pending" ? 202 : 200).json({
      success: !applyFailed,
      base: binding,
      apply,
    });
  } catch (err) {
    if (err instanceof KnowledgeUnavailableError) {
      res.status(503).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

// PUT /knowledge/bindings —— 改 KB↔Agent 绑定（写 config-store，原子）。审计 BIND_KB。
// 绑定即真相（ADR-011）：绑/解绑后必须 triggerApply 重新生成 per-agent MCP 注册与
// knowledge_search 工具暴露，否则解绑不立即生效（工具残留到下次其他 apply）。失败回滚 + 复原。
//
// 异步化（fix/usage-bugs #1）：HTTP 立即 202 + jobId；后台跑校验 + writeStore + apply + 失败回滚链路。
// 校验失败（结构错 / 引用未知 agent）走 800ms race，仍能立即 400。
knowledgeRouter.put("/knowledge/bindings", requireRole("admin"), async (req: Request, res: Response) => {
  const operator = req.user?.platformUserId || "";
  const { jobId, promise } = enqueueApplyJob(
    async () => {
      // 回滚契约：只要拿到了 prev 快照（writeKnowledgeStore 之前），就负责复原。
      let prev: KnowledgeStore | undefined;
      let ownsRollback = false;
      try {
        const next = validateKnowledgeStore(req.body, listAgents().map((agent) => agent.id));
        prev = readKnowledgeStore();
        ownsRollback = true;
        const revokedAgentIds = [
          ...new Set(
            prev.knowledgeBases.flatMap((oldKb) => {
              const nextKb = next.knowledgeBases.find((kb) => kb.id === oldKb.id);
              return oldKb.boundAgents.filter((agentId) => !nextKb?.boundAgents.includes(agentId));
            }),
          ),
        ];
        writeKnowledgeStore(next);
        const apply = await triggerApply({
          stateDir: STATE_DIR,
          repoDir: REPO_DIR,
          timeoutMs: 60_000,
          resetAgentIds: revokedAgentIds,
          revokedKnowledgeAgentIds: revokedAgentIds,
        });
        appendAuditLog(apply.status === "failed" ? "BIND_KB_FAILED" : "BIND_KB", "knowledge.json", {
          operator,
          bases: next.knowledgeBases.map((b) => ({ id: b.id, boundAgents: b.boundAgents })),
          revokedAgentIds,
          resetSessions: apply.resetSessions ?? [],
          applyStatus: apply.status,
          applyMessage: apply.message,
        });
        if (apply.status === "failed") {
          try {
            writeKnowledgeStore(prev);
            await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR });
          } catch {
            /* 复原失败：调用方 catch 会拿到原 apply 错误 */
          }
          throw new Error(`应用失败：${apply.message || apply.status}；已回滚绑定`);
        }
        ownsRollback = false;
        return {
          success: apply.status === "success",
          store: readKnowledgeStore(),
          apply,
        };
      } catch (err) {
        if (ownsRollback && prev) {
          try {
            writeKnowledgeStore(prev);
            await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR });
          } catch {
            /* 复原失败：保持错误返回，运维可手工 apply */
          }
        }
        throw err;
      }
    },
    "knowledge.bind",
  );
  const raced = await Promise.race([
    promise.then((r) => ({ kind: "done" as const, value: r })).catch((err: Error) => ({ kind: "error" as const, err })),
    new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 800)),
  ]);
  if (raced.kind === "done") return res.json({ ...raced.value, jobId });
  if (raced.kind === "error") return res.status(400).json({ error: raced.err.message, jobId });
  res.status(202).json({ jobId, status: "running" });
});
