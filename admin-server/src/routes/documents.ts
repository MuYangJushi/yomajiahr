// 文档 + 分类路由（迁自 server.mjs，逻辑不变）。
import { Router, type Request, type Response } from "express";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../../lib/frontmatter.mjs";
import { removeChunks } from "../../lib/doc-chunker.mjs";
import { CHUNKS_DIR, POLICIES_DIR } from "../config.js";
import { requireRole } from "../auth/rbac.js";
import { appendAuditLog } from "../util.js";

export const documentsRouter = Router();

documentsRouter.get("/documents", requireRole("ops"), (_req: Request, res: Response) => {
  try {
    const result: any[] = [];
    const categories = readdirSync(POLICIES_DIR).filter((d) => {
      const fullPath = join(POLICIES_DIR, d);
      return existsSync(fullPath) && statSync(fullPath).isDirectory();
    });

    for (const cat of categories) {
      const catDir = join(POLICIES_DIR, cat);
      const files = readdirSync(catDir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        const content = readFileSync(join(catDir, file), "utf-8");
        const meta = parseFrontmatter(content);
        result.push({
          file,
          category: cat,
          doc_id: meta.doc_id || "",
          version: meta.version || "",
          effective_date: meta.effective_date || "",
          title: meta.title || file,
          source_format: meta.source_format || "",
          converted_date: meta.converted_date || "",
        });
      }
    }
    res.json({ documents: result, total: result.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

documentsRouter.get("/documents/:category/:file", requireRole("ops"), (req: Request, res: Response) => {
  try {
    const filePath = join(POLICIES_DIR, String(req.params.category), String(req.params.file));
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: "Document not found" });
    }
    const content = readFileSync(filePath, "utf-8");
    const meta = parseFrontmatter(content);
    res.json({ file: req.params.file, category: req.params.category, meta, content });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

documentsRouter.delete("/documents/:category/:file", requireRole("ops"), (req: Request, res: Response) => {
  try {
    const filePath = join(POLICIES_DIR, String(req.params.category), String(req.params.file));
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: "Document not found" });
    }
    const content = readFileSync(filePath, "utf-8");
    const meta = parseFrontmatter(content);

    unlinkSync(filePath);
    const chunksRemoved = removeChunks(meta.doc_id || "", CHUNKS_DIR);
    appendAuditLog("DELETE", String(req.params.file), {
      doc_id: meta.doc_id || "",
      version: meta.version || "",
      category: req.params.category,
      chunks_removed: chunksRemoved,
      reason: req.body?.reason || "",
    });
    res.json({ success: true, deleted: req.params.file });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

documentsRouter.get("/categories", requireRole("ops"), (_req: Request, res: Response) => {
  try {
    const categories = readdirSync(POLICIES_DIR).filter((d) =>
      statSync(join(POLICIES_DIR, d)).isDirectory(),
    );
    res.json({ categories });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

documentsRouter.post("/categories", requireRole("ops"), (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || !/^[a-z0-9-]+$/.test(name)) {
      return res
        .status(400)
        .json({ error: "Invalid category name. Use lowercase letters, numbers, hyphens only." });
    }
    const dir = join(POLICIES_DIR, name);
    mkdirSync(dir, { recursive: true });
    appendAuditLog("CREATE_CATEGORY", name, {});
    res.json({ success: true, category: name });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
