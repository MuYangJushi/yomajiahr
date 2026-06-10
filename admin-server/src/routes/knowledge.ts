// 知识库平台路由（ADR-006 / FastGPT 集成，#37 骨架）。
// RBAC：读=ops；改绑定（影响员工检索）=admin。审计：导入/删除/绑定变更进 audit-log.jsonl。
import { Router, type Request, type Response } from "express";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../../lib/frontmatter.mjs";
import { POLICIES_DIR } from "../config.js";
import { requireRole } from "../auth/rbac.js";
import { appendAuditLog } from "../util.js";
import { listAgents } from "../services/orchestrator.js";
import {
  KnowledgeUnavailableError,
  health,
  importDocument,
  listCollections,
  readKnowledgeStore,
  removeCollection,
  search,
  writeKnowledgeStore,
  type KbCollection,
  type KnowledgeStore,
} from "../services/knowledge.js";

export const knowledgeRouter = Router();

// 本地归档列表（FastGPT 不可用时的回退数据源，复用 documents 的读法）。
function listLocalCollections(): KbCollection[] {
  const out: KbCollection[] = [];
  if (!existsSync(POLICIES_DIR)) return out;
  for (const cat of readdirSync(POLICIES_DIR)) {
    const catDir = join(POLICIES_DIR, cat);
    if (!statSync(catDir).isDirectory()) continue;
    for (const file of readdirSync(catDir).filter((f) => f.endsWith(".md"))) {
      const meta = parseFrontmatter(readFileSync(join(catDir, file), "utf-8"));
      out.push({
        externalDocId: meta.doc_id || file,
        title: meta.title || file,
        category: cat,
        doc_id: meta.doc_id || undefined,
        version: meta.version || undefined,
        indexStatus: "local-archive",
        source: "local",
      });
    }
  }
  return out;
}

// GET /knowledge/health —— 平台类型/可达/回退态（#37 核心，不依赖实例）。
knowledgeRouter.get("/knowledge/health", requireRole("ops"), async (_req: Request, res: Response) => {
  try {
    res.json(await health());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /knowledge/collections —— FastGPT 优先；不可用回退本地归档列表。
knowledgeRouter.get("/knowledge/collections", requireRole("ops"), async (_req: Request, res: Response) => {
  try {
    const collections = await listCollections();
    res.json({ collections, source: "fastgpt" });
  } catch (err) {
    if (err instanceof KnowledgeUnavailableError) {
      res.json({ collections: listLocalCollections(), source: "local", notice: err.message });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /knowledge/search-test —— 召回测试（管理员页用，非员工通道）。
knowledgeRouter.post("/knowledge/search-test", requireRole("ops"), async (req: Request, res: Response) => {
  const query = String(req.body?.query || "").trim();
  const topK = Math.min(20, Math.max(1, Number(req.body?.topK) || 5));
  if (!query) {
    res.status(400).json({ error: "query 不能为空" });
    return;
  }
  try {
    res.json({ chunks: await search(query, topK) });
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
    await removeCollection(String(req.params.docId));
    appendAuditLog("DELETE", String(req.params.docId), { source: "fastgpt" });
    res.json({ success: true });
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

// PUT /knowledge/bindings —— 改 KB↔Agent 绑定（写 config-store，原子）。审计 BIND_KB。
knowledgeRouter.put("/knowledge/bindings", requireRole("admin"), (req: Request, res: Response) => {
  try {
    const next = req.body as KnowledgeStore;
    if (!next || !Array.isArray(next.knowledgeBases)) {
      res.status(400).json({ error: "请求体应含 knowledgeBases[]" });
      return;
    }
    writeKnowledgeStore(next);
    appendAuditLog("BIND_KB", "knowledge.json", {
      operator: req.user?.platformUserId || "",
      bases: next.knowledgeBases.map((b) => ({ id: b.id, boundAgents: b.boundAgents })),
    });
    res.json({ success: true, store: readKnowledgeStore() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
