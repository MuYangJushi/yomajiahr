// 上传路由（ADR-010 原生解析）：把**原始文件**直传 FastGPT 由其解析/切片/向量化。
// 不再本地转换/切片/归档/元数据推断；FastGPT 为文档唯一存储；无本地回退——导入失败=上传失败。
import { Router, type Request, type Response } from "express";
import { rateLimit, upload } from "../middleware.js";
import { requireRole } from "../auth/rbac.js";
import { appendAuditLog, normalizeUploadedFilename } from "../util.js";
import { KnowledgeUnavailableError, importDocument, isConfigured, resolveImportDatasetId } from "../services/knowledge.js";

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
      if (!isConfigured()) {
        return res.status(503).json({ error: "知识库平台（FastGPT）未配置，无法导入" });
      }
      let datasetId: string;
      try {
        datasetId = resolveImportDatasetId(typeof req.body?.datasetId === "string" ? req.body.datasetId : undefined);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
      const originalName = normalizeUploadedFilename(req.file.originalname);
      const operator = { id: req.user?.platformUserId ?? "unknown", name: req.user?.name ?? "unknown" };

      // ADR-010：原始文件直传 FastGPT 解析/切片/向量化。审计 IMPORT（无本地副本，FastGPT 唯一存储）。
      try {
        const { collectionId, deduped } = await importDocument(req.file.buffer, originalName, datasetId);
        appendAuditLog("IMPORT", originalName, {
          status: deduped ? "deduped" : "success",
          platform: "fastgpt",
          collectionId,
          kbId: datasetId,
          operator,
        });
        res.json({
          success: true,
          file: originalName,
          kbId: datasetId,
          collectionId,
          deduped,
          message: deduped ? `已存在同名文档「${originalName}」，复用已有集合，未重复导入` : undefined,
        });
      } catch (err) {
        appendAuditLog("IMPORT", originalName, {
          status: "failed",
          platform: "fastgpt",
          reason: (err as Error).message,
          kbId: datasetId,
          operator,
        });
        // 无本地兜底（ADR-010）：导入失败即上传失败。
        const status = err instanceof KnowledgeUnavailableError ? 503 : 500;
        res.status(status).json({ error: (err as Error).message });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);
