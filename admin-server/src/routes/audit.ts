// 审计日志路由（迁自 server.mjs，逻辑不变）。
import { Router, type Request, type Response } from "express";
import { csvEscape, readAuditLog } from "../util.js";
import { actionLabel, operatorName, detailExtra, subjectText } from "../audit-labels.js";
import { requireRole } from "../auth/rbac.js";

export const auditRouter = Router();

function applyFilters(logs: any[], query: any): any[] {
  let filtered = logs;
  if (query.action) filtered = filtered.filter((l) => l.action === query.action);
  if (query.doc_id) filtered = filtered.filter((l) => l.details?.doc_id === query.doc_id);
  if (query.from) {
    const from = new Date(query.from);
    filtered = filtered.filter((l) => new Date(l.timestamp) >= from);
  }
  if (query.to) {
    const to = new Date(query.to);
    to.setDate(to.getDate() + 1); // inclusive end date
    filtered = filtered.filter((l) => new Date(l.timestamp) < to);
  }
  return filtered;
}

auditRouter.get("/audit-log", requireRole("audit"), (req: Request, res: Response) => {
  try {
    const filtered = applyFilters(readAuditLog(), req.query);
    filtered.reverse(); // newest first

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 50));
    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const paged = filtered.slice(start, start + pageSize);

    res.json({ logs: paged, total, page, page_size: pageSize });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

auditRouter.get("/audit-log/export", requireRole("audit"), (req: Request, res: Response) => {
  try {
    const filtered = applyFilters(readAuditLog(), req.query);
    filtered.reverse();

    const header = "时间,动作,对象,操作人,文档编号,版本,分类,详情";
    const rows = filtered.map((l) =>
      [
        l.timestamp,
        csvEscape(actionLabel(l.action)),
        csvEscape(subjectText(l)),
        csvEscape(operatorName(l)),
        csvEscape(l.details?.doc_id || ""),
        csvEscape(l.details?.version || ""),
        csvEscape(l.details?.category || ""),
        csvEscape(detailExtra(l)),
      ].join(","),
    );

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    // BOM for Excel UTF-8 compatibility
    res.send("﻿" + header + "\n" + rows.join("\n"));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
