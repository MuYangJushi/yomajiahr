#!/usr/bin/env node

/**
 * HR Admin Portal — standalone web service for document management and audit log.
 *
 * Runs alongside the Yoma+HR gateway. Provides:
 *   - File upload (PDF/Word/Text) with auto-conversion to Markdown
 *   - Document list / search / delete
 *   - Audit log viewer with filtering and CSV export
 *
 * Usage:
 *   node server.mjs                         # defaults: port 18790, ~/.ymjhr
 *   PORT=3000 node server.mjs               # custom port
 *   OPENCLAW_STATE_DIR=/data node server.mjs # custom state dir
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { env } from "node:process";
import express from "express";
import multer, { MulterError } from "multer";
import { CATEGORIES } from "./lib/categories.mjs";
import { convertBuffer, isSupported, supportedFormats } from "./lib/doc-converter.mjs";
import { overwriteFrontmatter, parseFrontmatter } from "./lib/frontmatter.mjs";
import { inferDocumentMetadata } from "./lib/metadata-inference.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(env.ADMIN_PORTAL_PORT || env.PORT || 18790);
const STATE_DIR = env.OPENCLAW_STATE_DIR || join(env.HOME, ".ymjhr");
const POLICIES_DIR = join(STATE_DIR, "data", "hr-policies");
const AUDIT_LOG_PATH = join(STATE_DIR, "data", "hr-admin", "audit-log.jsonl");
const AUTH_TOKEN = env.OPENCLAW_WEB_AUTH_TOKEN || "";
const BIND_HOST = env.ADMIN_PORTAL_BIND || "";
const MAX_UPLOAD_FILE_MB = Math.max(1, Number(env.ADMIN_PORTAL_MAX_UPLOAD_MB || 50));
const MAX_UPLOAD_FILE_BYTES = MAX_UPLOAD_FILE_MB * 1024 * 1024;

if (!AUTH_TOKEN) {
  log(
    "WARN",
    "OPENCLAW_WEB_AUTH_TOKEN is not set — Admin Portal will only accept requests from localhost.",
  );
}

// Ensure directories exist
for (const dir of [
  POLICIES_DIR,
  ...CATEGORIES.map((cat) => join(POLICIES_DIR, cat)),
  join(STATE_DIR, "data", "hr-admin"),
]) {
  mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

const app = express();
app.use(express.json());
app.use(express.static(join(import.meta.dirname, "public")));

// Request logging for API calls
app.use("/api", (req, _res, next) => {
  log("INFO", `${req.method} ${req.originalUrl}`);
  next();
});

// Multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = extname(normalizeUploadedFilename(file.originalname)).toLowerCase();
    if (isSupported(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported format: ${ext}. Supported: ${supportedFormats().join(", ")}`));
    }
  },
});

// ---------------------------------------------------------------------------
// Simple rate limiter (no external dependency)
// ---------------------------------------------------------------------------

function rateLimit({ windowMs = 60_000, max = 10, message = "Too many requests" } = {}) {
  const hits = new Map();
  // Periodically clean up expired entries
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.start > windowMs) {
        hits.delete(key);
      }
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const key = req.ip || req.connection?.remoteAddress || "unknown";
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ error: message });
    }
    next();
  };
}

const uploadLimiter = rateLimit({ windowMs: 60_000, max: 10, message: "上传过于频繁，请稍后再试" });

// ---------------------------------------------------------------------------
// Health check (no auth required — for load balancer / systemd probes)
// ---------------------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "hr-admin-portal" });
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) {
    // No token configured — only allow localhost connections
    const ip = req.ip || req.connection?.remoteAddress || "";
    const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (isLocal) {
      return next();
    }
    return res
      .status(403)
      .json({ error: "Auth token not configured. Only localhost access allowed." });
  }

  const token = req.headers.authorization?.replace("Bearer ", "") || req.query.token;

  if (token === AUTH_TOKEN) {
    return next();
  }

  res.status(401).json({ error: "Unauthorized" });
}

// Apply auth to all /api routes
app.use("/api", authMiddleware);

// ---------------------------------------------------------------------------
// API: Upload
// ---------------------------------------------------------------------------

app.post("/api/upload", uploadLimiter, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file provided" });
    }

    const originalName = normalizeUploadedFilename(req.file.originalname);

    // Convert document
    const { markdown, warnings, sourceFormat } = await convertBuffer(req.file.buffer, originalName);
    const metadata = await inferDocumentMetadata({
      markdown,
      originalName,
      sourceFormat,
      policiesDir: POLICIES_DIR,
      stateDir: STATE_DIR,
    });

    // Ensure category directory exists
    const categoryDir = join(POLICIES_DIR, metadata.category);
    mkdirSync(categoryDir, { recursive: true });

    // Inject metadata into frontmatter
    const enriched = overwriteFrontmatter(markdown, {
      title: metadata.title,
      source_file: originalName,
      source_format: sourceFormat,
      doc_id: metadata.doc_id,
      version: metadata.version,
      effective_date: metadata.effective_date,
      category: metadata.category,
    });

    // Write to knowledge base
    const mdName = basename(originalName, extname(originalName)) + ".md";
    const outPath = join(categoryDir, mdName);
    writeFileSync(outPath, enriched, "utf-8");

    // Audit log
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
      warnings: [...warnings, ...metadata.warnings],
      path: `data/hr-policies/${String(metadata.category)}/${mdName}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err, _req, res, next) => {
  if (!err) {
    return next();
  }
  if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: `文件过大，当前上传上限为 ${MAX_UPLOAD_FILE_MB}MB。请压缩 PDF 或拆分后重试。`,
      code: err.code,
      max_upload_mb: MAX_UPLOAD_FILE_MB,
    });
  }
  if (err instanceof Error) {
    return res.status(400).json({ error: err.message });
  }
  return next(err);
});

// ---------------------------------------------------------------------------
// API: Documents
// ---------------------------------------------------------------------------

app.get("/api/documents", (_req, res) => {
  try {
    const result = [];
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
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/documents/:category/:file", (req, res) => {
  try {
    const filePath = join(POLICIES_DIR, req.params.category, req.params.file);
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: "Document not found" });
    }
    const content = readFileSync(filePath, "utf-8");
    const meta = parseFrontmatter(content);
    res.json({ file: req.params.file, category: req.params.category, meta, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/documents/:category/:file", (req, res) => {
  try {
    const filePath = join(POLICIES_DIR, req.params.category, req.params.file);
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: "Document not found" });
    }

    // Read metadata before deletion for audit
    const content = readFileSync(filePath, "utf-8");
    const meta = parseFrontmatter(content);

    unlinkSync(filePath);
    appendAuditLog("DELETE", req.params.file, {
      doc_id: meta.doc_id || "",
      version: meta.version || "",
      category: req.params.category,
      reason: req.body?.reason || "",
    });

    res.json({ success: true, deleted: req.params.file });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// API: Categories
// ---------------------------------------------------------------------------

app.get("/api/categories", (_req, res) => {
  try {
    const categories = readdirSync(POLICIES_DIR).filter((d) => {
      return statSync(join(POLICIES_DIR, d)).isDirectory();
    });
    res.json({ categories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/categories", (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// API: Audit Log
// ---------------------------------------------------------------------------

app.get("/api/audit-log", (req, res) => {
  try {
    const logs = readAuditLog();

    // Filter by query params
    let filtered = logs;
    if (req.query.action) {
      filtered = filtered.filter((l) => l.action === req.query.action);
    }
    if (req.query.doc_id) {
      filtered = filtered.filter((l) => l.details?.doc_id === req.query.doc_id);
    }
    if (req.query.from) {
      const from = new Date(req.query.from);
      filtered = filtered.filter((l) => new Date(l.timestamp) >= from);
    }
    if (req.query.to) {
      const to = new Date(req.query.to);
      to.setDate(to.getDate() + 1); // inclusive end date
      filtered = filtered.filter((l) => new Date(l.timestamp) < to);
    }

    // Newest first
    filtered.reverse();

    // Pagination
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 50));
    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const paged = filtered.slice(start, start + pageSize);

    res.json({ logs: paged, total, page, page_size: pageSize });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/audit-log/export", (req, res) => {
  try {
    const logs = readAuditLog();

    // Apply same filters
    let filtered = logs;
    if (req.query.action) {
      filtered = filtered.filter((l) => l.action === req.query.action);
    }
    if (req.query.doc_id) {
      filtered = filtered.filter((l) => l.details?.doc_id === req.query.doc_id);
    }
    if (req.query.from) {
      const from = new Date(req.query.from);
      filtered = filtered.filter((l) => new Date(l.timestamp) >= from);
    }
    if (req.query.to) {
      const to = new Date(req.query.to);
      to.setDate(to.getDate() + 1);
      filtered = filtered.filter((l) => new Date(l.timestamp) < to);
    }

    filtered.reverse();

    // CSV export
    const header = "timestamp,action,file,doc_id,version,category,reason";
    const rows = filtered.map((l) =>
      [
        l.timestamp,
        l.action,
        csvEscape(l.file),
        csvEscape(l.details?.doc_id || ""),
        csvEscape(l.details?.version || ""),
        csvEscape(l.details?.category || ""),
        csvEscape(l.details?.reason || ""),
      ].join(","),
    );

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    // BOM for Excel UTF-8 compatibility
    res.send("\uFEFF" + header + "\n" + rows.join("\n"));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// API: Server info
// ---------------------------------------------------------------------------

app.get("/api/info", (_req, res) => {
  res.json({
    name: "HR Admin Portal",
    version: "1.0.0",
    supported_formats: supportedFormats(),
    policies_dir: POLICIES_DIR,
    auth_enabled: Boolean(AUTH_TOKEN),
    max_upload_mb: MAX_UPLOAD_FILE_MB,
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeUploadedFilename(rawName) {
  const baseName = basename(String(rawName || "").replaceAll("\\", "/"));
  if (!baseName) {
    return "upload.bin";
  }

  const decoded = Buffer.from(baseName, "latin1").toString("utf8");
  return scoreFilename(decoded) > scoreFilename(baseName) ? decoded : baseName;
}

function scoreFilename(name) {
  let score = 0;
  if (/[\u4E00-\u9FFF]/.test(name)) {
    score += 4;
  }
  if (/[\u3040-\u30FF]/.test(name)) {
    score += 3;
  }
  if (/[\uAC00-\uD7AF]/.test(name)) {
    score += 3;
  }
  if (name.includes("\uFFFD")) {
    score -= 10;
  }
  const mojibake = name.match(/[ÃÂÐÑØæçèéêëîïðñòóôöøùúûüýþÿœžš]/g);
  score -= mojibake?.length || 0;
  return score;
}

// Simple write queue to prevent concurrent appendFileSync from interleaving JSONL lines
let auditWriteQueue = Promise.resolve();

function appendAuditLog(action, file, details) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    file,
    details,
  };
  const line = JSON.stringify(entry) + "\n";
  auditWriteQueue = auditWriteQueue
    .then(() => appendFileSync(AUDIT_LOG_PATH, line, "utf-8"))
    .catch(() => {});
}

function readAuditLog() {
  if (!existsSync(AUDIT_LOG_PATH)) {
    return [];
  }
  const content = readFileSync(AUDIT_LOG_PATH, "utf-8").trim();
  if (!content) {
    return [];
  }
  return content
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function csvEscape(val) {
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ---------------------------------------------------------------------------
// SPA fallback — serve index.html for client-side routing
// ---------------------------------------------------------------------------

app.get(/^\/(upload|documents|audit-log)?$/, (_req, res) => {
  res.sendFile(join(import.meta.dirname, "public", "index.html"));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Bind to localhost-only when no auth token is configured
const bindHost = BIND_HOST || (AUTH_TOKEN ? "0.0.0.0" : "127.0.0.1");

app.listen(PORT, bindHost, () => {
  log("INFO", `HR Admin Portal running at http://${bindHost}:${PORT}`);
  log("INFO", `  Knowledge base: ${POLICIES_DIR}`);
  log("INFO", `  Audit log: ${AUDIT_LOG_PATH}`);
  log(
    "INFO",
    `  Auth: ${AUTH_TOKEN ? "enabled (token)" : "localhost-only (no OPENCLAW_WEB_AUTH_TOKEN)"}`,
  );
  log("INFO", `  Max upload size: ${MAX_UPLOAD_FILE_MB}MB`);
  log("INFO", `  Supported formats: ${supportedFormats().join(", ")}`);
});
