/**
 * Document pre-chunker for OpenClaw knowledge base indexing.
 *
 * Splits structured Markdown documents into well-scoped chunks,
 * each with inherited frontmatter metadata optimized for hybrid search.
 *
 * Used by: server.mjs (upload pipeline), doc-to-markdown.mjs (CLI)
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";
import { classifyCategoryByScore } from "./metadata-inference.mjs";

const MIN_CHUNK_CHARS = 200;
const MAX_CHUNK_CHARS = 1500;
const HEADING_RE = /^(#{1,3})\s+(.+)$/;

// ---------------------------------------------------------------------------
// Section parsing
// ---------------------------------------------------------------------------

/**
 * Parse Markdown body (without frontmatter) into heading-delimited sections.
 * Each section tracks its heading path for context.
 */
function parseSections(body) {
  const lines = body.split("\n");
  const sections = [];
  let currentHeadings = []; // stack of { level, text }
  let currentBody = [];

  function flushSection() {
    const text = currentBody.join("\n").trim();
    if (text || currentHeadings.length > 0) {
      sections.push({
        headingPath: currentHeadings.map((h) => h.text),
        level: currentHeadings.length > 0 ? currentHeadings[currentHeadings.length - 1].level : 0,
        body: text,
      });
    }
    currentBody = [];
  }

  for (const line of lines) {
    const match = line.match(HEADING_RE);
    if (match) {
      flushSection();
      const level = match[1].length;
      const headingText = match[2].trim();

      // Pop headings at same or deeper level to maintain proper hierarchy
      while (
        currentHeadings.length > 0 &&
        currentHeadings[currentHeadings.length - 1].level >= level
      ) {
        currentHeadings.pop();
      }
      currentHeadings.push({ level, text: headingText });
    } else {
      currentBody.push(line);
    }
  }
  flushSection();

  return sections;
}

// ---------------------------------------------------------------------------
// Merge / split logic
// ---------------------------------------------------------------------------

/**
 * Merge adjacent short sections at the same heading level.
 */
function mergeShortSections(sections) {
  if (sections.length <= 1) return sections;

  const result = [];
  let i = 0;

  while (i < sections.length) {
    const current = { ...sections[i], headingPath: [...sections[i].headingPath] };

    // Try to merge with next sibling if current is too short
    while (
      current.body.length < MIN_CHUNK_CHARS &&
      i + 1 < sections.length &&
      sections[i + 1].level === current.level &&
      current.body.length + sections[i + 1].body.length <= MAX_CHUNK_CHARS
    ) {
      i++;
      const next = sections[i];
      const nextHeading = next.headingPath[next.headingPath.length - 1] || "";
      if (nextHeading) {
        current.body += `\n\n### ${nextHeading}\n\n${next.body}`;
      } else {
        current.body += `\n\n${next.body}`;
      }
    }

    result.push(current);
    i++;
  }

  return result;
}

/**
 * Split sections that exceed MAX_CHUNK_CHARS by paragraph boundaries.
 */
function splitLongSections(sections) {
  const result = [];

  for (const section of sections) {
    if (section.body.length <= MAX_CHUNK_CHARS) {
      result.push(section);
      continue;
    }

    const paragraphs = section.body.split(/\n\n+/);
    let currentChunk = "";
    let partIndex = 1;

    for (const para of paragraphs) {
      if (currentChunk && currentChunk.length + para.length + 2 > MAX_CHUNK_CHARS) {
        // Flush current chunk
        result.push({
          headingPath: [...section.headingPath],
          level: section.level,
          body: currentChunk.trim(),
          partSuffix: partIndex > 1 ? `(续${partIndex - 1})` : "",
        });
        partIndex++;
        currentChunk = para;
      } else {
        currentChunk += (currentChunk ? "\n\n" : "") + para;
      }
    }

    // Flush remaining
    if (currentChunk.trim()) {
      result.push({
        headingPath: [...section.headingPath],
        level: section.level,
        body: currentChunk.trim(),
        partSuffix: partIndex > 1 ? `(续${partIndex})` : "",
      });
    }
  }

  return result;
}

/**
 * Fallback: split text without headings by paragraph boundaries.
 */
function splitByParagraphs(body) {
  const paragraphs = body.split(/\n\n+/).filter((p) => p.trim());
  if (paragraphs.length === 0) return [];

  const chunks = [];
  let currentChunk = "";

  for (const para of paragraphs) {
    if (currentChunk && currentChunk.length + para.length + 2 > MAX_CHUNK_CHARS) {
      chunks.push({ headingPath: [], level: 0, body: currentChunk.trim() });
      currentChunk = para;
    } else {
      currentChunk += (currentChunk ? "\n\n" : "") + para;
    }
  }
  if (currentChunk.trim()) {
    chunks.push({ headingPath: [], level: 0, body: currentChunk.trim() });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Chunk frontmatter generation
// ---------------------------------------------------------------------------

function buildChunkFrontmatter(meta) {
  const lines = ["---"];
  lines.push(`doc_id: "${meta.doc_id}"`);
  lines.push(`chunk_id: "${meta.chunk_id}"`);
  lines.push(`title: "${meta.title}"`);
  lines.push(`category: "${meta.category}"`);
  if (meta.source_category && meta.source_category !== meta.category) {
    lines.push(`source_category: "${meta.source_category}"`);
  }
  if (meta.section) {
    lines.push(`section: "${meta.section}"`);
  }
  lines.push("---");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split a Markdown document (with frontmatter) into well-scoped chunks.
 *
 * @param {string} markdown - Full Markdown with YAML frontmatter
 * @param {{ reclassifyGeneral?: boolean }} options
 * @returns {{ chunks: Array<{ content: string, metadata: object }>, warnings: string[] }}
 */
export function chunkDocument(markdown, options = {}) {
  const { reclassifyGeneral = true } = options;
  const warnings = [];

  const frontmatter = parseFrontmatter(markdown);
  const docId = frontmatter.doc_id || "UNKNOWN";
  const title = frontmatter.title || "";
  const sourceCategory = frontmatter.category || "general";

  // Strip frontmatter from body
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n*/u, "").trim();

  if (!body) {
    warnings.push("文档内容为空，无法生成切片");
    return { chunks: [], warnings };
  }

  // Parse sections by headings
  let sections = parseSections(body);

  // If no headings found, fall back to paragraph splitting
  const hasHeadings = sections.some((s) => s.headingPath.length > 0);
  if (!hasHeadings) {
    sections = splitByParagraphs(body);
  } else {
    sections = mergeShortSections(sections);
    sections = splitLongSections(sections);
  }

  // Filter out empty sections
  sections = sections.filter((s) => s.body.trim().length > 0);

  if (sections.length === 0) {
    warnings.push("文档切片后无有效内容");
    return { chunks: [], warnings };
  }

  // Build chunk objects
  const chunks = sections.map((section, idx) => {
    const chunkIndex = String(idx + 1).padStart(3, "0");
    const sectionLabel = section.headingPath.join(" > ") + (section.partSuffix || "");

    // Reclassify category for general documents using score-based matching.
    // Score-based (not first-match) avoids misclassification when a section
    // mentions keywords from multiple categories (e.g. "绩效奖金" in compensation).
    let category = sourceCategory;
    if (reclassifyGeneral && sourceCategory === "general" && section.body.length > 0) {
      const sectionHeading = section.headingPath[section.headingPath.length - 1] || "";
      const sectionText = `${sectionHeading}\n${section.body}`;
      const inferred = classifyCategoryByScore(sectionText);
      if (inferred !== "general") {
        category = inferred;
      }
    }

    const metadata = {
      doc_id: docId,
      chunk_id: `${docId}_c${chunkIndex}`,
      title,
      category,
      source_category: sourceCategory,
      section: sectionLabel.trim(),
    };

    const fm = buildChunkFrontmatter(metadata);
    const content = `${fm}\n\n${section.body}\n`;

    return { content, metadata };
  });

  return { chunks, warnings };
}

/**
 * Write chunk files to disk, organized by each chunk's category.
 * Removes existing chunks for the same doc_id first (idempotent).
 *
 * @param {Array<{ content: string, metadata: object }>} chunks
 * @param {string} chunksDir - Base chunks directory (e.g. ~/.openclaw/data/hr-chunks)
 * @returns {string[]} Array of written file paths
 */
export function writeChunks(chunks, chunksDir) {
  if (chunks.length === 0) return [];

  // Remove old chunks for this doc_id first
  const docId = chunks[0]?.metadata.doc_id;
  if (docId) {
    removeChunks(docId, chunksDir);
  }

  const written = [];
  for (const chunk of chunks) {
    const catDir = join(chunksDir, chunk.metadata.category);
    mkdirSync(catDir, { recursive: true });
    const filePath = join(catDir, `${chunk.metadata.chunk_id}.md`);
    writeFileSync(filePath, chunk.content, "utf-8");
    written.push(filePath);
  }

  return written;
}

/**
 * Remove all chunk files for a given doc_id across all category subdirectories.
 *
 * @param {string} docId - Document ID (e.g. "HR-ATT-001")
 * @param {string} chunksDir - Base chunks directory
 * @returns {number} Number of files removed
 */
export function removeChunks(docId, chunksDir) {
  if (!docId || !existsSync(chunksDir)) return 0;

  const prefix = `${docId}_c`;
  let removed = 0;

  for (const catName of readdirSync(chunksDir)) {
    const catDir = join(chunksDir, catName);
    try {
      const files = readdirSync(catDir);
      for (const file of files) {
        if (file.startsWith(prefix) && file.endsWith(".md")) {
          unlinkSync(join(catDir, file));
          removed++;
        }
      }
    } catch {
      // Skip non-directories or permission errors
    }
  }

  return removed;
}
