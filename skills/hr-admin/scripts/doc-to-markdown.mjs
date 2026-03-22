#!/usr/bin/env node

/**
 * Multi-format document to Markdown batch converter for HR policy ingestion.
 *
 * Usage:
 *   node doc-to-markdown.mjs <input>            [--out-dir <dir>] [--category <name>]
 *   node doc-to-markdown.mjs path/to/file.docx  --out-dir memory/hr-policies/ --category leave
 *   node doc-to-markdown.mjs path/to/docs/      --out-dir memory/hr-policies/ --category onboarding
 *
 * Supported inputs:
 *   - PDF (.pdf)
 *   - Word (.docx)
 *   - Text / Markdown (.txt, .md)
 *
 * Output: Markdown with YAML frontmatter placeholders per document.
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { env } from "node:process";
import { parseArgs } from "node:util";
import {
  convertFile,
  isSupported,
  supportedFormats,
} from "../../../admin-portal/lib/doc-converter.mjs";
import { inferDocumentMetadata } from "../../../admin-portal/lib/metadata-inference.mjs";

const { values, positionals } = parseArgs({
  options: {
    "out-dir": { type: "string", default: "." },
    category: { type: "string", default: "" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help || positionals.length === 0) {
  console.log(`Usage: node doc-to-markdown.mjs <input-path> [options]

Arguments:
  input-path          A single supported file or a directory containing supported files

Options:
  --out-dir <dir>     Output directory (default: current directory)
  --category <name>   Sub-directory category name (e.g. leave, onboarding)
  -h, --help          Show this help message

Supported formats:
  ${supportedFormats().join("\n  ")}

Examples:
  node doc-to-markdown.mjs policy.pdf --out-dir memory/hr-policies/ --category leave
  node doc-to-markdown.mjs handbook.docx --out-dir memory/hr-policies/ --category general
  node doc-to-markdown.mjs ./docs/ --out-dir memory/hr-policies/ --category onboarding`);
  process.exit(0);
}

const inputPath = resolve(positionals[0]);
const outDir = resolve(values["out-dir"]);
const category = values.category;
const targetDir = category ? join(outDir, category) : outDir;
const stateDir = env.OPENCLAW_STATE_DIR || join(env.HOME || "", ".ymjhr");

mkdirSync(targetDir, { recursive: true });

function collectSupportedFiles(pathInput) {
  if (!existsSync(pathInput)) {
    console.error(`[ERROR] Input path does not exist: ${pathInput}`);
    process.exit(1);
  }

  const stat = statSync(pathInput);
  if (stat.isFile()) {
    if (!isSupported(extname(pathInput).toLowerCase())) {
      console.error(
        `[ERROR] Unsupported input file: ${pathInput}\nSupported: ${supportedFormats().join(", ")}`,
      );
      process.exit(1);
    }
    return [pathInput];
  }

  if (stat.isDirectory()) {
    const files = readdirSync(pathInput)
      .filter((file) => isSupported(extname(file).toLowerCase()))
      .map((file) => join(pathInput, file))
      .sort();
    if (files.length === 0) {
      console.error(
        `[ERROR] No supported files found in: ${pathInput}\nSupported: ${supportedFormats().join(", ")}`,
      );
      process.exit(1);
    }
    return files;
  }

  console.error(`[ERROR] Input is neither a file nor directory: ${pathInput}`);
  process.exit(1);
}

const inputFiles = collectSupportedFiles(inputPath);
console.log(`Found ${inputFiles.length} supported file(s) to convert.\n`);

function overwriteFrontmatter(markdown, updates) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return markdown;
  }

  const meta = Object.create(null);
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }

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
    .map((key) =>
      key === "total_pages"
        ? `${key}: ${nextMeta[key]}`
        : `${key}: "${String(nextMeta[key]).replaceAll('"', '\\"')}"`,
    );

  const replacement = `---\n${rendered.join("\n")}\n---`;
  return markdown.replace(/^---\n[\s\S]*?\n---/, replacement);
}

let successCount = 0;
let warningCount = 0;

for (const filePath of inputFiles) {
  const name = basename(filePath, extname(filePath));

  try {
    console.log(`Converting: ${basename(filePath)}`);
    const { markdown, warnings, sourceFormat } = await convertFile(filePath, { category });
    const metadata = await inferDocumentMetadata({
      markdown,
      originalName: basename(filePath),
      sourceFormat,
      policiesDir: outDir,
      stateDir,
    });
    const enriched = overwriteFrontmatter(markdown, {
      title: metadata.title,
      source_file: basename(filePath),
      source_format: sourceFormat,
      doc_id: metadata.doc_id,
      version: metadata.version,
      effective_date: metadata.effective_date,
      category: metadata.category,
    });

    const finalDir = join(outDir, metadata.category);
    mkdirSync(finalDir, { recursive: true });
    const finalOutPath = join(finalDir, `${name}.md`);
    writeFileSync(finalOutPath, enriched, "utf-8");
    successCount++;
    console.log(`  -> ${finalOutPath} (${sourceFormat})`);
    console.log(
      `  -> metadata: ${metadata.doc_id} | ${metadata.version} | ${metadata.effective_date || "-"} | ${metadata.category} (${metadata.source})`,
    );

    const combinedWarnings = [...warnings, ...metadata.warnings];
    if (combinedWarnings.length > 0) {
      warningCount += combinedWarnings.length;
      for (const warning of combinedWarnings) {
        console.log(`  [WARN] ${warning}`);
      }
    }
  } catch (err) {
    console.error(`  [ERROR] Failed to convert ${basename(filePath)}: ${err.message}`);
  }
}

console.log(`\nDone. ${successCount}/${inputFiles.length} converted, ${warningCount} warning(s).`);
if (warningCount > 0) {
  console.log(
    "Warnings indicate conversion quality issues. Review generated Markdown before import.",
  );
}
