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
import multer from "multer";
import { convertBuffer, isSupported, supportedFormats } from "./lib/doc-converter.mjs";
import { inferDocumentMetadata } from "./lib/metadata-inference.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(env.ADMIN_PORTAL_PORT || env.PORT || 18790);
const STATE_DIR = env.OPENCLAW_STATE_DIR || join(env.HOME, ".ymjhr");
const POLICIES_DIR = join(STATE_DIR, "memory", "hr-policies");
const AUDIT_LOG_PATH = join(STATE_DIR, "memory", "hr-admin", "audit-log.jsonl");
const AUTH_TOKEN = env.OPENCLAW_WEB_AUTH_TOKEN || "";

// Ensure directories exist
for (const dir of [
  POLICIES_DIR,
  join(POLICIES_DIR, "leave"),
  join(POLICIES_DIR, "onboarding"),
  join(POLICIES_DIR, "attendance"),
  join(POLICIES_DIR, "compensation"),
  join(POLICIES_DIR, "training"),
  join(POLICIES_DIR, "general"),
  join(STATE_DIR, "memory", "hr-admin"),
]) {
  mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(join(import.meta.dirname, "public")));

// Multer for file uploads (10MB limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    if (isSupported(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported format: ${ext}. Supported: ${supportedFormats().join(", ")}`));
    }
  },
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function authMiddleware(req, res, next) {
  // Static files are public (login page needs to load)
  if (!AUTH_TOKEN) {
    return next();
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

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file provided" });
    }

    // Convert document
    const { markdown, warnings, sourceFormat } = await convertBuffer(
      req.file.buffer,
      req.file.originalname,
    );
    const metadata = await inferDocumentMetadata({
      markdown,
      originalName: req.file.originalname,
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
      source_file: req.file.originalname,
      source_format: sourceFormat,
      doc_id: metadata.doc_id,
      version: metadata.version,
      effective_date: metadata.effective_date,
      category: metadata.category,
    });

    // Write to knowledge base
    const mdName = basename(req.file.originalname, extname(req.file.originalname)) + ".md";
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
      path: `memory/hr-policies/${String(metadata.category)}/${mdName}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return {};
  }
  const meta = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      // Strip surrounding quotes
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1);
      }
      meta[key] = val;
    }
  }
  return meta;
}

function overwriteFrontmatter(markdown, updates) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return markdown;
  }
  const meta = parseFrontmatter(markdown);
  const nextMeta = {
    ...meta,
    ...Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined && value !== null),
    ),
  };
  const orderedKeys = [
    "title",
    "source_file",
    "source_format",
    "doc_id",
    "version",
    "effective_date",
    "category",
    "converted_date",
    "total_pages",
  ];
  const rendered = orderedKeys
    .filter((key) => key in nextMeta && String(nextMeta[key]).trim() !== "")
    .map((key) => `${key}: "${String(nextMeta[key]).replaceAll('"', '\\"')}"`);
  if ("total_pages" in nextMeta && String(nextMeta.total_pages).trim() !== "") {
    const idx = rendered.findIndex((line) => line.startsWith('total_pages: "'));
    if (idx >= 0) {
      const totalPages = String(nextMeta.total_pages);
      rendered[idx] = `total_pages: ${totalPages}`;
    }
  }
  const replacement = `---\n${rendered.join("\n")}\n---`;
  return markdown.replace(/^---\n[\s\S]*?\n---/, replacement);
}

function appendAuditLog(action, file, details) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    file,
    details,
  };
  appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
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

app.listen(PORT, () => {
  console.log(`HR Admin Portal running at http://localhost:${PORT}`);
  console.log(`  Knowledge base: ${POLICIES_DIR}`);
  console.log(`  Audit log: ${AUDIT_LOG_PATH}`);
  console.log(
    `  Auth: ${AUTH_TOKEN ? "enabled (token)" : "disabled (no OPENCLAW_WEB_AUTH_TOKEN)"}`,
  );
  console.log(`  Supported formats: ${supportedFormats().join(", ")}`);
});
