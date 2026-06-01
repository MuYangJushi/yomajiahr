// 上传路由（迁自 server.mjs /api/upload，逻辑不变）。
import { Router, type Request, type Response } from "express";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { convertBuffer } from "../../lib/doc-converter.mjs";
import { overwriteFrontmatter } from "../../lib/frontmatter.mjs";
import { inferDocumentMetadata } from "../../lib/metadata-inference.mjs";
import { chunkDocument, writeChunks } from "../../lib/doc-chunker.mjs";
import { CHUNKS_DIR, POLICIES_DIR, STATE_DIR } from "../config.js";
import { rateLimit, upload } from "../middleware.js";
import { appendAuditLog, normalizeUploadedFilename } from "../util.js";

const uploadLimiter = rateLimit({ windowMs: 60_000, max: 10, message: "上传过于频繁，请稍后再试" });

export const uploadRouter = Router();

uploadRouter.post(
  "/upload",
  uploadLimiter,
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file provided" });
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

      appendAuditLog("UPLOAD", mdName, {
        doc_id: metadata.doc_id,
        version: metadata.version,
        category: metadata.category,
        source_format: sourceFormat,
        metadata_source: metadata.source,
      });

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
        warnings: [...warnings, ...metadata.warnings, ...chunkWarnings],
        path: `data/hr-policies/${String(metadata.category)}/${mdName}`,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);
