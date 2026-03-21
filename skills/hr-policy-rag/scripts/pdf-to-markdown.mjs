#!/usr/bin/env node

/**
 * PDF to Markdown batch converter for HR policy documents.
 *
 * Usage:
 *   node pdf-to-markdown.mjs <input>           [--out-dir <dir>] [--category <name>]
 *   node pdf-to-markdown.mjs path/to/file.pdf  --out-dir memory/hr-policies/ --category leave
 *   node pdf-to-markdown.mjs path/to/pdf-dir/  --out-dir memory/hr-policies/ --category onboarding
 *
 * Output: structured Markdown with YAML frontmatter metadata per document.
 *
 * Based on pdfjs-dist (see src/media/pdf-extract.ts for reference).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  options: {
    "out-dir": { type: "string", default: "." },
    category: { type: "string", default: "" },
    "min-chars": { type: "string", default: "20" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help || positionals.length === 0) {
  console.log(`Usage: node pdf-to-markdown.mjs <input-path> [options]

Arguments:
  input-path          A single PDF file or a directory containing PDFs

Options:
  --out-dir <dir>     Output directory (default: current directory)
  --category <name>   Sub-directory category name (e.g. leave, onboarding)
  --min-chars <n>     Minimum text chars per page to flag scan warning (default: 20)
  -h, --help          Show this help message

Examples:
  node pdf-to-markdown.mjs policy.pdf --out-dir memory/hr-policies/ --category leave
  node pdf-to-markdown.mjs ./pdfs/ --out-dir memory/hr-policies/ --category onboarding`);
  process.exit(0);
}

const inputPath = resolve(positionals[0]);
const outDir = resolve(values["out-dir"]);
const category = values.category;
const minCharsPerPage = Number.parseInt(values["min-chars"], 10);

// ---------------------------------------------------------------------------
// Resolve output directory (with optional category sub-directory)
// ---------------------------------------------------------------------------

const targetDir = category ? join(outDir, category) : outDir;
mkdirSync(targetDir, { recursive: true });

// ---------------------------------------------------------------------------
// Collect PDF files
// ---------------------------------------------------------------------------

/** @returns {string[]} */
function collectPdfs(inputPath) {
  if (!existsSync(inputPath)) {
    console.error(`[ERROR] Input path does not exist: ${inputPath}`);
    process.exit(1);
  }
  const stat = statSync(inputPath);
  if (stat.isFile()) {
    if (extname(inputPath).toLowerCase() !== ".pdf") {
      console.error(`[ERROR] Input file is not a PDF: ${inputPath}`);
      process.exit(1);
    }
    return [inputPath];
  }
  if (stat.isDirectory()) {
    const files = readdirSync(inputPath)
      .filter((f) => extname(f).toLowerCase() === ".pdf")
      .map((f) => join(inputPath, f))
      .sort();
    if (files.length === 0) {
      console.error(`[ERROR] No PDF files found in: ${inputPath}`);
      process.exit(1);
    }
    return files;
  }
  console.error(`[ERROR] Input is neither a file nor directory: ${inputPath}`);
  process.exit(1);
}

const pdfFiles = collectPdfs(inputPath);
console.log(`Found ${pdfFiles.length} PDF file(s) to convert.\n`);

// ---------------------------------------------------------------------------
// Load pdfjs-dist
// ---------------------------------------------------------------------------

const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

// ---------------------------------------------------------------------------
// Convert a single PDF to Markdown
// ---------------------------------------------------------------------------

/**
 * @param {string} pdfPath
 * @returns {Promise<{ markdown: string; warnings: string[] }>}
 */
async function convertPdf(pdfPath) {
  const buffer = readFileSync(pdfPath);
  const pdf = await getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;

  const fileName = basename(pdfPath, ".pdf");
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
        `Page ${pageNum}: only ${pageText.length} chars extracted (possible scanned image)`,
      );
    }

    pages.push({ pageNum, text: pageText });
  }

  // Build Markdown with YAML frontmatter
  const now = new Date().toISOString().slice(0, 10);
  const lines = [
    "---",
    `title: "${fileName}"`,
    `source_file: "${basename(pdfPath)}"`,
    `doc_id: ""`,
    `version: ""`,
    `effective_date: ""`,
    `category: "${category}"`,
    `converted_date: "${now}"`,
    `total_pages: ${pdf.numPages}`,
    "---",
    "",
    `# ${fileName}`,
    "",
  ];

  for (const { pageNum, text } of pages) {
    lines.push(`## Page ${pageNum}`);
    lines.push("");
    lines.push(text || "(no text extracted)");
    lines.push("");
  }

  return { markdown: lines.join("\n"), warnings };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let successCount = 0;
let warningCount = 0;

for (const pdfPath of pdfFiles) {
  const name = basename(pdfPath, ".pdf");
  const outPath = join(targetDir, `${name}.md`);

  try {
    console.log(`Converting: ${basename(pdfPath)}`);
    const { markdown, warnings } = await convertPdf(pdfPath);
    writeFileSync(outPath, markdown, "utf-8");
    successCount++;
    console.log(`  -> ${outPath}`);

    if (warnings.length > 0) {
      warningCount += warnings.length;
      for (const w of warnings) {
        console.log(`  [WARN] ${w}`);
      }
    }
  } catch (err) {
    console.error(`  [ERROR] Failed to convert ${basename(pdfPath)}: ${err.message}`);
  }
}

console.log(`\nDone. ${successCount}/${pdfFiles.length} converted, ${warningCount} warning(s).`);
if (warningCount > 0) {
  console.log("Warnings indicate pages with very little text - they may be scanned images.");
  console.log("Consider using OCR tools for those pages.");
}
