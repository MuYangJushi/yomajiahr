/**
 * Multi-format document to Markdown converter.
 *
 * Supported formats:
 *   - PDF  (.pdf)   — via pdfjs-dist
 *   - Word (.docx)  — via mammoth
 *   - Text (.txt, .md) — passthrough
 *
 * Usage (standalone):
 *   node doc-converter.mjs <input> --out-dir <dir> --category <name>
 *
 * Usage (as library):
 *   import { convertFile } from './doc-converter.mjs'
 *   const result = await convertFile(filePath, { category: 'leave' })
 */

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

// ---------------------------------------------------------------------------
// Format-specific converters
// ---------------------------------------------------------------------------

/**
 * @param {Buffer} buffer
 * @param {string} fileName
 * @param {number} minCharsPerPage
 * @returns {Promise<{ text: string; warnings: string[]; pageCount: number }>}
 */
async function convertPdf(buffer, fileName, minCharsPerPage = 20) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;

  const warnings = [];
  const pages = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? String(item.str) : ""))
      .filter(Boolean)
      .join(" ")
      .trim();

    if (pageText.length < minCharsPerPage) {
      warnings.push(
        `第 ${pageNum} 页仅提取到 ${pageText.length} 个字符（可能是扫描件图片，建议上传可编辑版本）`,
      );
    }

    pages.push(`## Page ${pageNum}\n\n${pageText || "(no text extracted)"}`);
  }

  // Add a summary warning if most pages look like scanned images
  const scannedCount = warnings.length;
  if (scannedCount > 0 && scannedCount >= pdf.numPages * 0.5) {
    warnings.unshift(
      `此文档大部分页面（${scannedCount}/${pdf.numPages}）疑似扫描件，内容提取可能不完整。建议上传可编辑版本（Word 或文字版 PDF）。`,
    );
  }

  return {
    text: pages.join("\n\n"),
    warnings,
    pageCount: pdf.numPages,
  };
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<{ text: string; warnings: string[]; pageCount: number }>}
 */
async function convertDocx(buffer) {
  const mammoth = await import("mammoth");
  const result = await mammoth.default.convertToMarkdown({ buffer });

  const warnings = result.messages.filter((m) => m.type === "warning").map((m) => m.message);

  return {
    text: result.value,
    warnings,
    pageCount: 0,
  };
}

/**
 * @param {Buffer} buffer
 * @returns {{ text: string; warnings: string[]; pageCount: number }}
 */
function convertText(buffer) {
  return {
    text: buffer.toString("utf-8"),
    warnings: [],
    pageCount: 0,
  };
}

/**
 * @param {Buffer} buffer
 * @returns {{ text: string; warnings: string[]; pageCount: number }}
 */
function convertMarkdown(buffer) {
  const raw = buffer.toString("utf-8");
  const stripped = raw.replace(/^---\n[\s\S]*?\n---\n*/u, "").trim();
  return {
    text: stripped,
    warnings: [],
    pageCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Format registry
// ---------------------------------------------------------------------------

const CONVERTERS = {
  ".pdf": { name: "PDF", convert: convertPdf },
  ".docx": { name: "Word (docx)", convert: convertDocx },
  ".doc": { name: "Word (doc)", convert: null }, // unsupported legacy format
  ".txt": { name: "Text", convert: convertText },
  ".md": { name: "Markdown", convert: convertMarkdown },
};

/**
 * @returns {string[]} list of supported extensions
 */
export function supportedFormats() {
  return Object.entries(CONVERTERS)
    .filter(([, v]) => v.convert !== null)
    .map(([ext, v]) => `${v.name} (${ext})`);
}

/**
 * Check if a file extension is supported.
 * @param {string} ext - file extension including dot (e.g. ".pdf")
 * @returns {boolean}
 */
export function isSupported(ext) {
  const entry = CONVERTERS[ext.toLowerCase()];
  return Boolean(entry && entry.convert);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a document buffer to Markdown.
 *
 * @param {Buffer} buffer - file content
 * @param {string} originalName - original file name (used for extension detection)
 * @param {{ category?: string }} options
 * @returns {Promise<{ markdown: string; warnings: string[]; sourceFormat: string }>}
 */
export async function convertBuffer(buffer, originalName, options = {}) {
  const ext = extname(originalName).toLowerCase();
  const entry = CONVERTERS[ext];

  if (!entry) {
    throw new Error(`Unsupported file format: ${ext}. Supported: ${supportedFormats().join(", ")}`);
  }
  if (!entry.convert) {
    throw new Error(`${entry.name} format is not supported. Please save as .docx and retry.`);
  }

  const { text, warnings, pageCount } = await entry.convert(buffer, originalName);

  const category = options.category || "";
  const now = new Date().toISOString().slice(0, 10);
  const fileBase = basename(originalName, ext);

  const frontmatter = [
    "---",
    `title: "${fileBase}"`,
    `source_file: "${originalName}"`,
    `source_format: "${entry.name}"`,
    `doc_id: ""`,
    `version: ""`,
    `effective_date: ""`,
    `category: "${category}"`,
    `converted_date: "${now}"`,
    pageCount > 0 ? `total_pages: ${pageCount}` : null,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  const normalizedText = text.trimStart();
  const heading = normalizedText.startsWith("# ") ? "" : `# ${fileBase}\n\n`;
  const markdown = `${frontmatter}\n\n${heading}${normalizedText}\n`;

  return { markdown, warnings, sourceFormat: entry.name };
}

/**
 * Convert a file from disk to Markdown.
 *
 * @param {string} filePath - path to the file
 * @param {{ category?: string }} options
 * @returns {Promise<{ markdown: string; warnings: string[]; sourceFormat: string }>}
 */
export async function convertFile(filePath, options = {}) {
  const buffer = readFileSync(filePath);
  return convertBuffer(buffer, basename(filePath), options);
}
