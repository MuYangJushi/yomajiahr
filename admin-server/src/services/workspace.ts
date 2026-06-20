// 从模板渲染 agent 的 workspace 5 文件。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
  // 清理旧版本生成的兼容软链。
  const claude = join(dir, "CLAUDE.md");
  rmSync(claude, { force: true });
  return { dir, written };
}
