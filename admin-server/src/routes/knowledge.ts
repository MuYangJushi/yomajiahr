// 知识库平台路由（ADR-006 / FastGPT 集成，#37 骨架）。
// RBAC：读=ops；改绑定（影响员工检索）=admin。审计：导入/删除/绑定变更进 audit-log.jsonl。
import { Router, type Request, type Response } from "express";
import { requireRole } from "../auth/rbac.js";
import { appendAuditLog, auditOperator } from "../util.js";
import { listAgents, rerenderAgentWorkspace } from "../services/orchestrator.js";
import { applyModeForOperation, trackPendingApply, triggerApply } from "../services/config-apply.js";
import { enqueueApplyJob } from "../services/apply-jobs.js";
import { FASTGPT_KB_ID, REPO_DIR, STATE_DIR } from "../config.js";
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
  removeDataset,
  resolveCollectionBoundAgents,
  search,
  updateKnowledgeConfig,
  validateKnowledgeStore,
  writeKnowledgeStore,
  type CreateKbInput,
  type KnowledgeConfigInput,
} from "../services/knowledge.js";

export const knowledgeRouter = Router();

/**
 * 计算本次绑定变更中**完全失去**知识库访问的 agent（全局口径，与
 * config/scripts/verify-knowledge-revocation.mjs 的「是否仍绑任意 FastGPT 库」判定对齐）。
 *
 * 候选 = 从某个 KB 的 boundAgents 被移除的 agent；真正撤权 = 候选里在 next 中
 * 不再绑定**任何** FastGPT 库的 agent。仅从多绑库之一解绑、仍绑其他库的 agent **不算撤权**
 * （它仍合法持有 knowledge_search，生成器也会保留其工具/MCP 注册）——若把它误计入
 * revoked 传给负向验证，会因「runtime still exposes a knowledge tool」判失败回滚整个保存
 * （fix/qa-fixes：hr-admin 同绑默认库+人才发展库时解绑其一必中招）。
 */
export function computeRevokedAgentIds(prev: KnowledgeStore, next: KnowledgeStore): string[] {
  const stillBoundInNext = new Set(
    next.knowledgeBases
      .filter((kb) => kb.provider === "fastgpt" && Boolean(kb.externalKbId))
      .flatMap((kb) => kb.boundAgents),
  );
  return [
    ...new Set(
      prev.knowledgeBases.flatMap((oldKb) => {
        const nextKb = next.knowledgeBases.find((kb) => kb.id === oldKb.id);
        return oldKb.boundAgents.filter((agentId) => !nextKb?.boundAgents.includes(agentId));
      }),
    ),
  ].filter((agentId) => !stillBoundInNext.has(agentId));
}

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
    appendAuditLog("CONFIG_KNOWLEDGE", "knowledge-platform", auditOperator(req), {
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
    // 删单个集合**不解绑** agent：库（datasetId）级绑定不变，agent 仍合法持有知识工具，
    // 即便删的是库里最后一个集合，绑定也照旧。只需 resetAgentIds 归档可能含被删文档内容的会话上下文。
    // 绝不传 revokedKnowledgeAgentIds —— 否则会触发「解绑负向验证」(verify-knowledge-revocation.mjs)，
    // 而 agent 实际仍 bound → 验证判 "still bound" 失败回滚 → 502（fix/0623：任何绑定库的删除都会中招）。
    const apply = affectedAgents.length > 0
      ? await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, timeoutMs: 60_000, mode: applyModeForOperation("knowledge.delete"), operation: "knowledge.delete", resetAgentIds: affectedAgents })
      : undefined;
    const resetSessions = apply?.resetSessions ?? [];
    appendAuditLog("DELETE", collectionId, auditOperator(req), {
      source: "fastgpt",
      resetSessions,
      applyStatus: apply?.status,
    });
    if (apply?.status === "failed") {
      res.status(502).json({
        error: "文档已删除且当前会话已归档，但应用配置失败；需重试应用配置以清除进程内上下文",
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
    if (binding.boundAgents.length > 0) {
      for (const agentId of binding.boundAgents) {
        try {
          rerenderAgentWorkspace(agentId);
        } catch {
          /* workspace 是辅助 prompt，失败不阻断建库主流程 */
        }
      }
    }
    // 新库若已绑 agent，需 apply 才会暴露 knowledge_search（ADR-011）。库已建好，apply 失败
    // 不回滚库（FastGPT dataset 合法存在）——回传 apply 状态供前端提示，运维可重试 apply。
    // pending：apply 仍在进行，不报错；前端可轮询。
    // 审计顺序：apply 之后才落库——若 apply 失败，审计记 FAILED；否则记 CREATED，使审计与 apply 终态一致。
    const apply =
      binding.boundAgents.length > 0
        ? await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, timeoutMs: 60_000, mode: applyModeForOperation("knowledge.base.create"), operation: "knowledge.base.create" })
        : undefined;
    const applyFailed = apply?.status === "failed";
    appendAuditLog(applyFailed ? "CREATE_KB_FAILED" : "CREATE_KB", binding.id, auditOperator(req), {
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

// DELETE /knowledge/bases/:id —— 删除整库（注销平台登记 + 销毁 FastGPT 数据集）。审计 DELETE_KB。
//
// 与 POST /knowledge/bases 对称（同步、admin），但因「删库改绑定」必须借 PUT /knowledge/bindings 的
// 撤权/回滚机制：删的库若被 agent 绑定，那些**只**绑这一个库的 agent 彻底失去知识访问，须计入
// revokedKnowledgeAgentIds（生成器撤工具 + 过负向验证 verify-knowledge-revocation.mjs）；同绑其他库的
// agent 不算撤权（否则「runtime still exposes a knowledge tool」会回滚整次保存 → 502）。复用
// computeRevokedAgentIds 精确区分二者。
//
// 顺序铁律：先写 store + apply，**apply 成功后才删 FastGPT 数据集**——这样 apply 失败回滚 store 时，
// 登记永远不会指向一个已被销毁的数据集。删数据集是销毁性的最后一步，失败只作部分成功提示（库已注销）。
knowledgeRouter.delete("/knowledge/bases/:id", requireRole("admin"), async (req: Request, res: Response) => {
  const operator = auditOperator(req);
  try {
    const kbId = String(req.params.id);
    const prev = readKnowledgeStore();
    const target = prev.knowledgeBases.find((kb) => kb.id === kbId);
    if (!target) {
      res.status(404).json({ error: "知识库未在平台登记" });
      return;
    }
    const next: KnowledgeStore = {
      ...prev,
      knowledgeBases: prev.knowledgeBases.filter((kb) => kb.id !== kbId),
    };
    const revokedAgentIds = computeRevokedAgentIds(prev, next);
    const boundAgents = [...new Set(target.boundAgents)];

    writeKnowledgeStore(next);
    // 解绑后被绑 agent 的 TOOLS.md 须从「已绑定」切回「未绑定」（与 PUT /knowledge/bindings 对称）。
    for (const agentId of boundAgents) {
      try { rerenderAgentWorkspace(agentId); } catch { /* 静默：渲染失败由下次 agent 操作纠正 */ }
    }

    // 无绑定的库（典型：建了测试库从未绑）免 apply，直接落注销。
    const apply = boundAgents.length > 0
      ? await triggerApply({
          stateDir: STATE_DIR,
          repoDir: REPO_DIR,
          timeoutMs: 60_000,
          mode: applyModeForOperation("knowledge.base.delete"),
          operation: "knowledge.base.delete",
          // 删整库=内容全部销毁（强于删单文档）→ 凡绑过该库的 agent 会话都可能残留被销毁内容，
          // 全部归档（与 DELETE /collections 删单文档用 resolveCollectionBoundAgents 的归档口径一致）。
          resetAgentIds: boundAgents,
          // 撤工具/负向验证仍只针对**彻底**失去知识访问的子集（同绑他库者不算撤权，否则回滚 502）。
          revokedKnowledgeAgentIds: revokedAgentIds,
        })
      : undefined;

    if (apply?.status === "failed") {
      // 回滚：复原登记 + workspace + 再 apply 一次（数据集尚未触碰，无需回滚 FastGPT）。
      writeKnowledgeStore(prev);
      for (const agentId of boundAgents) {
        try { rerenderAgentWorkspace(agentId); } catch { /* 静默 */ }
      }
      await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, mode: applyModeForOperation("knowledge.base.delete"), operation: "knowledge.base.delete" });
      appendAuditLog("DELETE_KB_FAILED", kbId, operator, {
        name: target.name,
        externalKbId: target.externalKbId,
        revokedAgentIds,
        applyStatus: apply.status,
        applyMessage: apply.message,
      });
      res.status(502).json({ error: "应用配置失败，已回滚删除；请重试", apply });
      return;
    }

    // apply 成功（或无绑定）后才销毁 FastGPT 数据集。
    // 跳过默认库（externalKbId === FASTGPT_KB_ID）—— 它是 env 配置的共享回退库（resolveImportDatasetId/search
    // 兜底），只注销登记不销毁数据；local 库无外部数据集可删。
    let datasetDeleted: boolean | undefined;
    let datasetNote: string | undefined;
    if (target.provider === "fastgpt" && target.externalKbId && target.externalKbId !== FASTGPT_KB_ID) {
      try {
        await removeDataset(target.externalKbId);
        datasetDeleted = true;
      } catch (err) {
        // 库已从平台注销（部分成功）；FastGPT 侧残留由提示告知，可在平台视图手动清理，不整体失败。
        datasetDeleted = false;
        datasetNote = `平台登记已删除，但 FastGPT 数据集未能删除：${(err as Error).message}`;
      }
    }

    appendAuditLog("DELETE_KB", kbId, operator, {
      name: target.name,
      externalKbId: target.externalKbId,
      revokedAgentIds,
      resetSessions: apply?.resetSessions ?? [],
      applyStatus: apply?.status,
      datasetDeleted,
    });
    res.status(apply?.status === "pending" ? 202 : 200).json({
      success: apply?.status !== "pending",
      revokedAgentIds,
      datasetDeleted,
      note: datasetNote,
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

// PUT /knowledge/bindings —— 改 KB↔Agent 绑定（写 config-store，原子）。审计 BIND_KB。
// 绑定即真相（ADR-011）：绑/解绑后必须 triggerApply 重新生成 per-agent MCP 注册与
// knowledge_search 工具暴露，否则解绑不立即生效（工具残留到下次其他 apply）。失败回滚 + 复原。
//
// 异步化（fix/usage-bugs #1）：HTTP 立即 202 + jobId；后台跑校验 + writeStore + apply + 失败回滚链路。
// 校验失败（结构错 / 引用未知 agent）走 800ms race，仍能立即 400。
//
// 权限 ops（fix/bug-0622）：绑定仅授予员工只读检索工具 knowledge_search，敏感度低于
// 知识库文档导入/删除（已是 ops），与「配技能/绑渠道」对齐；建库 /knowledge/bases 与
// 改连接 /knowledge/config 仍保留 admin。
knowledgeRouter.put("/knowledge/bindings", requireRole("ops"), async (req: Request, res: Response) => {
  const operator = auditOperator(req);
  const { jobId, promise } = enqueueApplyJob(
    async () => {
      // 回滚契约：只要拿到了 prev 快照（writeKnowledgeStore 之前），就负责复原。
      let prev: KnowledgeStore | undefined;
      let ownsRollback = false;
      try {
        const next = validateKnowledgeStore(req.body, listAgents().map((agent) => agent.id));
        prev = readKnowledgeStore();
        ownsRollback = true;
        const revokedAgentIds = computeRevokedAgentIds(prev, next);
        // 同时收集"新增"绑定的 agent —— 它们的 TOOLS.md 也要从"未绑定"切到"已绑定"。
        const grantedAgentIds = [
          ...new Set(
            next.knowledgeBases.flatMap((newKb) => {
              const oldKb = prev!.knowledgeBases.find((kb) => kb.id === newKb.id);
              return newKb.boundAgents.filter((agentId) => !oldKb?.boundAgents.includes(agentId));
            }),
          ),
        ];
        writeKnowledgeStore(next);
        // fix/usage-bugs：KB 绑定变更后必须刷新 workspace（TOOLS.md 等），
        // 否则解绑后 AI 仍以为有 knowledge_search 工具 → 用 exec curl 探 FastGPT 端点撞 404。
        // 先写 store 再渲染：渲染读 knowledge.json 取最新绑定状态。失败不阻塞主流程
        // （workspace 是辅助 prompt，落后一步可下次绑定/编辑修正）。
        for (const agentId of new Set([...revokedAgentIds, ...grantedAgentIds])) {
          try {
            rerenderAgentWorkspace(agentId);
          } catch {
            /* 静默：渲染失败由下次 agent 操作纠正 */
          }
        }
        const apply = await triggerApply({
          stateDir: STATE_DIR,
          repoDir: REPO_DIR,
          timeoutMs: 60_000,
          mode: applyModeForOperation("knowledge.bind"),
          operation: "knowledge.bind",
          resetAgentIds: revokedAgentIds,
          revokedKnowledgeAgentIds: revokedAgentIds,
        });
        appendAuditLog(apply.status === "failed" ? "BIND_KB_FAILED" : "BIND_KB", "knowledge.json", operator, {
          bases: next.knowledgeBases.map((b) => ({ id: b.id, boundAgents: b.boundAgents })),
          revokedAgentIds,
          resetSessions: apply.resetSessions ?? [],
          applyStatus: apply.status,
          applyMessage: apply.message,
          applyMode: apply.mode,
        });
        if (apply.status === "failed") {
          try {
            writeKnowledgeStore(prev);
            // 回滚绑定后同步回滚 workspace（与上面正向变更对称）。
            for (const agentId of new Set([...revokedAgentIds, ...grantedAgentIds])) {
              try { rerenderAgentWorkspace(agentId); } catch { /* 静默 */ }
            }
            await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, mode: applyModeForOperation("knowledge.bind"), operation: "knowledge.bind" });
          } catch {
            /* 复原失败：调用方 catch 会拿到原 apply 错误 */
          }
          throw new Error(`应用失败：${apply.message || apply.status}；已回滚绑定`);
        }
        ownsRollback = false;
        if (apply.status === "pending") trackPendingApply(STATE_DIR, apply, "knowledge.bind");
        return {
          success: apply.status === "success",
          store: readKnowledgeStore(),
          apply,
        };
      } catch (err) {
        if (ownsRollback && prev) {
          try {
            writeKnowledgeStore(prev);
            // 与正向路径相同：回滚绑定后回滚 workspace。这里读不到 grantedAgentIds 局部
            // 变量（在 try 块外），重读 store 重算 affected：所有 prev 与现状有差异的 agent。
            const current = readKnowledgeStore();
            const affected = new Set<string>();
            for (const oldKb of prev.knowledgeBases) {
              const newKb = current.knowledgeBases.find((kb) => kb.id === oldKb.id);
              for (const agentId of oldKb.boundAgents) if (!newKb?.boundAgents.includes(agentId)) affected.add(agentId);
              for (const agentId of newKb?.boundAgents || []) if (!oldKb.boundAgents.includes(agentId)) affected.add(agentId);
            }
            for (const agentId of affected) {
              try { rerenderAgentWorkspace(agentId); } catch { /* 静默 */ }
            }
            await triggerApply({ stateDir: STATE_DIR, repoDir: REPO_DIR, mode: applyModeForOperation("knowledge.bind"), operation: "knowledge.bind" });
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
