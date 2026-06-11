// 上传路由（迁自 server.mjs /api/upload，逻辑不变）。
import { Router, type Request, type Response } from "express";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { convertBuffer } from "../../lib/doc-converter.mjs";
import { overwriteFrontmatter } from "../../lib/frontmatter.mjs";
import { inferDocumentMetadata } from "../../lib/metadata-inference.js";
import { chunkDocument, writeChunks } from "../../lib/doc-chunker.mjs";
import { CHUNKS_DIR, POLICIES_DIR, STATE_DIR } from "../config.js";
import { rateLimit, upload } from "../middleware.js";
import { requireRole } from "../auth/rbac.js";
import { appendAuditLog, normalizeUploadedFilename } from "../util.js";
import { importDocument, isConfigured, resolveImportDatasetId } from "../services/knowledge.js";

const uploadLimiter = rateLimit({ windowMs: 60_000, max: 10, message: "上传过于频繁，请稍后再试" });

export const uploadRouter = Router();

uploadRouter.post(
  "/upload",
  requireRole("ops"),
  uploadLimiter,
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file provided" });
      }
      let datasetId: string;
      try {
        datasetId = resolveImportDatasetId(typeof req.body?.datasetId === "string" ? req.body.datasetId : undefined);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
      const originalName = normalizeUploadedFilename(req.file.originalname);

      const { markdown, warnings, sourceFormat } = await convertBuffer(req.file.buffer, originalName);
      const metadata = (await inferDocumentMetadata({
        markdown,
        originalName,
        sourceFormat,
        policiesDir: POLICIES_DIR,
        stateDir: STATE_DIR,
      })) as {
        title: string;
        category: string;
        doc_id: string;
        version: string;
        effective_date: string;
        source: string;
        notes: string;
        warnings: string[];
      };

      const categoryDir = join(POLICIES_DIR, metadata.category);
      mkdirSync(categoryDir, { recursive: true });

      const enriched = overwriteFrontmatter(markdown, {
        title: metadata.title,
        source_file: originalName,
        source_format: sourceFormat,
        doc_id: metadata.doc_id,
        version: metadata.version,
        effective_date: metadata.effective_date,
        category: metadata.category,
      });

      const mdName = basename(originalName, extname(originalName)) + ".md";
      const outPath = join(categoryDir, mdName);
      writeFileSync(outPath, enriched, "utf-8");

      const { chunks, warnings: chunkWarnings } = chunkDocument(enriched);
      const chunkPaths = writeChunks(chunks, CHUNKS_DIR);

      const operator = { id: req.user?.platformUserId ?? "unknown", name: req.user?.name ?? "unknown" };
      appendAuditLog("UPLOAD", mdName, {
        doc_id: metadata.doc_id,
        version: metadata.version,
        category: metadata.category,
        source_format: sourceFormat,
        metadata_source: metadata.source,
        kbId: datasetId || undefined,
        operator,
      });

      // #40 附加式 FastGPT 导入：本地归档/切片/审计已落定（回退依据保全）。
      // 导入到 FastGPT 是「增量」——失败绝不让上传失败（回退链不能断）；无论成败都落第二条审计（审计不能漏）。
      // 注入 doc_id/version 为结构化元数据，供路 A 引用格式回填（修 Gate-C #4）。
      let knowledgeImport: { status: "success" | "failed" | "skipped"; kbId?: string; collectionId?: string; externalDocId?: string; reason?: string } = {
        status: "skipped",
        kbId: datasetId || undefined,
      };
      if (isConfigured()) {
        try {
          const { externalDocId, collectionId } = await importDocument(enriched, originalName, {
            title: metadata.title,
            doc_id: metadata.doc_id,
            version: metadata.version,
            category: metadata.category,
            datasetId,
          });
          knowledgeImport = { status: "success", kbId: datasetId, collectionId, externalDocId };
          appendAuditLog("KB_IMPORT", mdName, {
            status: "success",
            platform: "fastgpt",
            collectionId,
            externalDocId,
            doc_id: metadata.doc_id,
            version: metadata.version,
            category: metadata.category,
            kbId: datasetId,
            operator,
          });
        } catch (err) {
          knowledgeImport = { status: "failed", kbId: datasetId, reason: (err as Error).message };
          appendAuditLog("KB_IMPORT", mdName, {
            status: "failed",
            platform: "fastgpt",
            reason: (err as Error).message,
            doc_id: metadata.doc_id,
            version: metadata.version,
            category: metadata.category,
            kbId: datasetId,
            operator,
          });
        }
      }

      res.json({
        success: true,
        file: mdName,
        title: metadata.title,
        category: metadata.category,
        doc_id: metadata.doc_id,
        version: metadata.version,
        effective_date: metadata.effective_date,
        source_format: sourceFormat,
        metadata_source: metadata.source,
        metadata_notes: metadata.notes,
        chunk_count: chunkPaths.length,
        knowledge_import: knowledgeImport,
        warnings: [...warnings, ...metadata.warnings, ...chunkWarnings],
        path: `data/hr-policies/${String(metadata.category)}/${mdName}`,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);
