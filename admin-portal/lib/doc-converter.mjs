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
// PDF structure reconstruction helpers
// ---------------------------------------------------------------------------

const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const LIST_BULLET_RE = /^[•·◦\-–]\s*/;
const LIST_NUM_RE = /^\d+[.)）]\s*/;
const LIST_CJK_PAREN_RE = /^[（(][一二三四五六七八九十\d]+[)）]\s*/;
const LIST_CJK_NUM_RE = /^[一二三四五六七八九十]+、/;

/**
 * Determine the most common font size (body text baseline) from collected items.
 * Uses character-count-weighted frequency.
 */
function computeBodyFontSize(items) {
  const freq = new Map();
  for (const item of items) {
    const size = Math.round(item.fontSize * 10) / 10; // round to 0.1
    const weight = item.str.length;
    freq.set(size, (freq.get(size) || 0) + weight);
  }
  let bestSize = 12;
  let bestWeight = 0;
  for (const [size, weight] of freq) {
    if (weight > bestWeight) {
      bestWeight = weight;
      bestSize = size;
    }
  }
  return bestSize;
}

/**
 * Group TextItems into logical lines based on Y-coordinate proximity.
 * Returns lines sorted top-to-bottom, items within each line sorted left-to-right.
 */
function groupIntoLines(items, tolerance) {
  if (items.length === 0) return [];

  // Sort by Y descending (PDF origin is bottom-left), then X ascending
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  let currentLine = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    const prevY = currentLine[0].y;
    if (Math.abs(item.y - prevY) < tolerance) {
      currentLine.push(item);
    } else {
      // Sort items in current line by X
      currentLine.sort((a, b) => a.x - b.x);
      lines.push(currentLine);
      currentLine = [item];
    }
  }
  currentLine.sort((a, b) => a.x - b.x);
  lines.push(currentLine);

  return lines;
}

/**
 * Concatenate items within a line into a single text string,
 * inserting spaces only when appropriate (not between adjacent CJK chars).
 */
function joinLineItems(items, wordSpaceThreshold) {
  if (items.length === 0) return "";
  let result = items[0].str;
  let avgFontSize = items[0].fontSize;

  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const curr = items[i];
    avgFontSize = (avgFontSize + curr.fontSize) / 2;
    const gap = curr.x - (prev.x + prev.width);

    const prevEnd = result.slice(-1);
    const currStart = curr.str.charAt(0);
    const bothCjk = CJK_RANGE.test(prevEnd) && CJK_RANGE.test(currStart);

    if (gap > wordSpaceThreshold && !bothCjk) {
      result += " " + curr.str;
    } else {
      result += curr.str;
    }
  }
  return { text: result.trim(), fontSize: avgFontSize };
}

/**
 * Detect heading level based on font size ratio to body text.
 * Only applies to short lines (< 80 chars).
 */
function detectHeadingLevel(fontSize, bodyFontSize, textLength) {
  if (textLength >= 80) return 0;
  const ratio = fontSize / bodyFontSize;
  if (ratio >= 1.8) return 1;
  if (ratio >= 1.4) return 2;
  if (ratio >= 1.2) return 3;
  return 0;
}

/**
 * Detect if a line is a list item and return its Markdown prefix.
 * Returns { prefix, content } or null.
 */
function detectListItem(text) {
  let m;
  if ((m = text.match(LIST_BULLET_RE))) {
    return { prefix: "- ", content: text.slice(m[0].length) };
  }
  if ((m = text.match(LIST_NUM_RE))) {
    return { prefix: `${m[0].trim()} `, content: text.slice(m[0].length) };
  }
  if ((m = text.match(LIST_CJK_PAREN_RE))) {
    return { prefix: "- ", content: text };
  }
  if ((m = text.match(LIST_CJK_NUM_RE))) {
    return { prefix: "- ", content: text };
  }
  return null;
}

/**
 * Detect if consecutive lines form a table (3+ lines each with 3+ column clusters).
 * Returns { rows: string[][], startIdx, endIdx } or null.
 */
function detectTable(lines, startIdx, bodyFontSize) {
  const minRows = 3;
  const minCols = 3;
  const colGapThreshold = bodyFontSize * 3;

  function getColumnClusters(lineItems) {
    if (lineItems.length < minCols) return null;
    const clusters = [];
    let cluster = [lineItems[0]];
    for (let i = 1; i < lineItems.length; i++) {
      const gap = lineItems[i].x - (lineItems[i - 1].x + lineItems[i - 1].width);
      if (gap > colGapThreshold) {
        clusters.push(cluster);
        cluster = [lineItems[i]];
      } else {
        cluster.push(lineItems[i]);
      }
    }
    clusters.push(cluster);
    return clusters.length >= minCols ? clusters : null;
  }

  let endIdx = startIdx;
  const tableRows = [];
  while (endIdx < lines.length) {
    const clusters = getColumnClusters(lines[endIdx].items);
    if (!clusters) break;
    tableRows.push(clusters.map((c) => c.map((i) => i.str).join("").trim()));
    endIdx++;
  }

  if (tableRows.length < minRows) return null;

  return { rows: tableRows, startIdx, endIdx };
}

/**
 * Render detected table rows as a Markdown table.
 */
function renderMarkdownTable(rows) {
  if (rows.length === 0) return "";
  const colCount = Math.max(...rows.map((r) => r.length));
  const normalized = rows.map((r) => {
    while (r.length < colCount) r.push("");
    return r;
  });
  const header = `| ${normalized[0].join(" | ")} |`;
  const sep = `| ${normalized[0].map(() => "---").join(" | ")} |`;
  const body = normalized
    .slice(1)
    .map((r) => `| ${r.join(" | ")} |`)
    .join("\n");
  return `${header}\n${sep}\n${body}`;
}

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
  let scannedPageCount = 0;

  // --- Pass 1: Collect all TextItems across pages, track scanned pages ---
  const allItems = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    let pageCharCount = 0;

    for (const item of textContent.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const str = String(item.str);
      pageCharCount += str.length;
      allItems.push({
        str,
        fontSize: Math.abs(item.transform[3]),
        x: item.transform[4],
        y: item.transform[5],
        width: item.width || 0,
        fontName: item.fontName || "",
        hasEOL: Boolean(item.hasEOL),
        pageNum,
      });
    }

    if (pageCharCount < minCharsPerPage) {
      scannedPageCount++;
      warnings.push(
        `第 ${pageNum} 页仅提取到 ${pageCharCount} 个字符（可能是扫描件图片，建议上传可编辑版本）`,
      );
    }
  }

  if (scannedPageCount > 0 && scannedPageCount >= pdf.numPages * 0.5) {
    warnings.unshift(
      `此文档大部分页面（${scannedPageCount}/${pdf.numPages}）疑似扫描件，内容提取可能不完整。建议上传可编辑版本（Word 或文字版 PDF）。`,
    );
  }

  if (allItems.length === 0) {
    return { text: "(no text extracted)", warnings, pageCount: pdf.numPages };
  }

  // --- Pass 2: Reconstruct document structure ---
  const bodyFontSize = computeBodyFontSize(allItems);
  const lineTolerance = bodyFontSize * 0.5;
  const wordSpaceThreshold = bodyFontSize * 0.3;

  // Group items by page first (to preserve page order), then into lines
  const pageGroups = new Map();
  for (const item of allItems) {
    if (!pageGroups.has(item.pageNum)) pageGroups.set(item.pageNum, []);
    pageGroups.get(item.pageNum).push(item);
  }

  // Build structured lines across all pages
  const structuredLines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const pageItems = pageGroups.get(p);
    if (!pageItems) continue;
    const lines = groupIntoLines(pageItems, lineTolerance);
    for (const lineItems of lines) {
      const { text, fontSize } = joinLineItems(lineItems, wordSpaceThreshold);
      if (!text) continue;
      structuredLines.push({ text, fontSize, items: lineItems, y: lineItems[0].y, pageNum: p });
    }
  }

  // Convert structured lines to Markdown
  const mdLines = [];
  let prevY = null;
  let prevPage = null;
  let i = 0;

  while (i < structuredLines.length) {
    const line = structuredLines[i];

    // Paragraph break detection: large Y gap or page change
    if (prevY !== null) {
      const lineHeight = bodyFontSize * 1.2;
      const isNewPage = line.pageNum !== prevPage;
      const yGap = isNewPage ? lineHeight * 2 : Math.abs(prevY - line.y);
      if (yGap > lineHeight * 1.5) {
        mdLines.push("");
      }
    }

    // Table detection
    const table = detectTable(
      structuredLines.slice(i).map((l) => ({ items: l.items })),
      0,
      bodyFontSize,
    );
    if (table && table.endIdx > 0) {
      mdLines.push("");
      mdLines.push(renderMarkdownTable(table.rows));
      mdLines.push("");
      i += table.endIdx;
      prevY = structuredLines[i - 1]?.y ?? null;
      prevPage = structuredLines[i - 1]?.pageNum ?? null;
      continue;
    }

    // Heading detection
    const headingLevel = detectHeadingLevel(line.fontSize, bodyFontSize, line.text.length);
    if (headingLevel > 0) {
      mdLines.push("");
      mdLines.push(`${"#".repeat(headingLevel)} ${line.text}`);
      mdLines.push("");
      prevY = line.y;
      prevPage = line.pageNum;
      i++;
      continue;
    }

    // List detection
    const listItem = detectListItem(line.text);
    if (listItem) {
      mdLines.push(`${listItem.prefix}${listItem.content}`);
      prevY = line.y;
      prevPage = line.pageNum;
      i++;
      continue;
    }

    // Regular body text
    mdLines.push(line.text);
    prevY = line.y;
    prevPage = line.pageNum;
    i++;
  }

  // Clean up: collapse multiple blank lines
  const text = mdLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, warnings, pageCount: pdf.numPages };
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
