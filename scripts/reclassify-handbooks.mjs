#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { env } from "node:process";
import { parseArgs } from "node:util";
import { CATEGORY_DOC_ID_PREFIX } from "../admin-portal/lib/categories.mjs";
import { overwriteFrontmatter, parseFrontmatter } from "../admin-portal/lib/frontmatter.mjs";

const { values } = parseArgs({
  options: {
    "state-dir": {
      type: "string",
      default: env.OPENCLAW_STATE_DIR || join(env.HOME || "", ".ymjhr"),
    },
    apply: { type: "boolean", default: false },
  },
  allowPositionals: false,
  strict: true,
});

const STATE_DIR = values["state-dir"];
const APPLY = values.apply;
const POLICIES_DIR = join(STATE_DIR, "data", "hr-policies");
const GENERAL_DIR = join(POLICIES_DIR, "general");
const AUDIT_LOG_PATH = join(STATE_DIR, "data", "hr-admin", "audit-log.jsonl");
const GENERAL_PREFIX = CATEGORY_DOC_ID_PREFIX.general;
const HANDBOOK_PATTERNS = [/员工手册/u, /^新员工须知$/u];

function listMarkdownFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .toSorted();
}

function nextGeneralSequence() {
  let maxSeq = 0;
  for (const file of listMarkdownFiles(GENERAL_DIR)) {
    const content = readFileSync(join(GENERAL_DIR, file), "utf-8");
    const meta = parseFrontmatter(content);
    const match = String(meta.doc_id || "").match(/^HR-GEN-(\d{3})$/);
    if (match) {
      maxSeq = Math.max(maxSeq, Number.parseInt(match[1], 10));
    }
  }
  return maxSeq + 1;
}

function buildAuditEntry(plan) {
  return {
    timestamp: new Date().toISOString(),
    action: "RECLASSIFY",
    file: basename(plan.toPath),
    details: {
      title: plan.title,
      old_category: plan.oldCategory,
      new_category: "general",
      old_doc_id: plan.oldDocId,
      new_doc_id: plan.newDocId,
      reason: "handbook_or_orientation_guide_reclassified_to_general",
    },
  };
}

function isGeneralHandbook(title, file) {
  return HANDBOOK_PATTERNS.some((pattern) => pattern.test(title) || pattern.test(file));
}

function collectPlans() {
  const nextSeq = { value: nextGeneralSequence() };
  const plans = [];

  for (const category of Object.keys(CATEGORY_DOC_ID_PREFIX)) {
    if (category === "general") {
      continue;
    }
    const categoryDir = join(POLICIES_DIR, category);
    for (const file of listMarkdownFiles(categoryDir)) {
      const fromPath = join(categoryDir, file);
      const content = readFileSync(fromPath, "utf-8");
      const meta = parseFrontmatter(content);
      const title = String(meta.title || basename(file, ".md")).trim();
      if (!isGeneralHandbook(title, file)) {
        continue;
      }
      const currentCategory = String(meta.category || "").trim();
      if (!currentCategory || currentCategory === "general") {
        continue;
      }
      const newDocId = `${GENERAL_PREFIX}-${String(nextSeq.value).padStart(3, "0")}`;
      nextSeq.value += 1;
      plans.push({
        title,
        file,
        fromPath,
        toPath: join(GENERAL_DIR, file),
        oldCategory: currentCategory,
        oldDocId: String(meta.doc_id || ""),
        newDocId,
        content,
      });
    }
  }

  return plans;
}

function printPlan(plans) {
  if (plans.length === 0) {
    console.log("No handbook-style documents matched the reclassification rules.");
    return;
  }
  for (const plan of plans) {
    console.log(`${plan.title}`);
    console.log(`  ${plan.fromPath} -> ${plan.toPath}`);
    console.log(`  ${plan.oldCategory}:${plan.oldDocId} -> general:${plan.newDocId}`);
  }
}

const plans = collectPlans();
printPlan(plans);

if (!APPLY) {
  console.log(`\nDry run only. Re-run with --apply to execute ${plans.length} change(s).`);
  process.exit(0);
}

if (plans.length === 0) {
  console.log("\nNothing to apply.");
  process.exit(0);
}

for (const plan of plans) {
  if (existsSync(plan.toPath)) {
    throw new Error(`Refusing to overwrite existing file: ${plan.toPath}`);
  }
}

mkdirSync(GENERAL_DIR, { recursive: true });
mkdirSync(join(STATE_DIR, "data", "hr-admin"), { recursive: true });
for (const plan of plans) {
  const updated = overwriteFrontmatter(plan.content, {
    category: "general",
    doc_id: plan.newDocId,
  });
  renameSync(plan.fromPath, plan.toPath);
  writeFileSync(plan.toPath, updated, "utf-8");
  appendFileSync(AUDIT_LOG_PATH, `${JSON.stringify(buildAuditEntry(plan))}\n`, "utf-8");
}

console.log(`\nApplied ${plans.length} handbook-style reclassification(s).`);
