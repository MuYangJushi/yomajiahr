// 从模板渲染 agent 的 workspace 5 文件 + CLAUDE.md 软链。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { REPO_DIR, STATE_DIR } from "../config.js";

const TPL_DIR = join(REPO_DIR, "workspaces", "_templates");
const WS_ROOT = join(STATE_DIR, "workspaces");
const FILES = ["IDENTITY.md", "SOUL.md", "AGENTS.md", "TOOLS.md", "MEMORY.md"];

export function workspaceDir(id: string): string {
  return join(WS_ROOT, id);
}

/** 渲染并写入 workspace 文件；修改时可保留 MEMORY.md。 */
export function renderWorkspace(
  id: string,
  vars: Record<string, string>,
  options: { preserveMemory?: boolean } = {},
): {
  dir: string;
  written: string[];
} {
  const dir = workspaceDir(id);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const f of FILES) {
    if (f === "MEMORY.md" && options.preserveMemory && existsSync(join(dir, f))) continue;
    let text = readFileSync(join(TPL_DIR, f), "utf-8");
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{{${k}}}`, v);
    }
    const out = join(dir, f);
    writeFileSync(out, text);
    written.push(out);
  }
  // CLAUDE.md → AGENTS.md 软链
  const claude = join(dir, "CLAUDE.md");
  try {
    if (existsSync(claude)) rmSync(claude);
    symlinkSync("AGENTS.md", claude);
  } catch {
    /* 软链失败不致命 */
  }
  return { dir, written };
}

/** 列出可分配技能（扫描 $STATE_DIR/skills/<name>/SKILL.md frontmatter）。 */
export function listSkills(): Array<{ name: string; description: string }> {
  const skillsRoot = join(STATE_DIR, "skills");
  if (!existsSync(skillsRoot)) return [];
  const out: Array<{ name: string; description: string }> = [];
  for (const name of readdirSync(skillsRoot)) {
    const skillMd = join(skillsRoot, name, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    let description = "";
    const text = readFileSync(skillMd, "utf-8");
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const m = fm[1].match(/^description:\s*(.+)$/m);
      if (m) description = m[1].trim();
    }
    out.push({ name, description });
  }
  return out;
}
