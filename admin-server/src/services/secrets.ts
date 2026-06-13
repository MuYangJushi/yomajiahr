// .env 键级 upsert（保留既有键/注释/非 bot 秘钥；原子 + chmod 600）。
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../config.js";

export const ENV_PATH = join(STATE_DIR, ".env");

const KEY_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** 键级 upsert：更新已存在的键，追加新键；保留注释与其它键。 */
export function upsertEnv(entries: Record<string, string>): void {
  if (Object.keys(entries).length === 0) return;
  const remaining = new Map(Object.entries(entries));
  let lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf-8").split("\n") : [];

  lines = lines.map((line) => {
    const m = line.match(KEY_RE);
    if (m && remaining.has(m[1])) {
      const k = m[1];
      const v = remaining.get(k)!;
      remaining.delete(k);
      return `${k}=${v}`;
    }
    return line;
  });

  // 去掉结尾空行后追加新键
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  for (const [k, v] of remaining) lines.push(`${k}=${v}`);

  const tmp = `${ENV_PATH}.tmp`;
  writeFileSync(tmp, lines.join("\n") + "\n");
  renameSync(tmp, ENV_PATH);
  chmodSync(ENV_PATH, 0o600);
}

/** 删除指定环境变量，保留其它键、注释与顺序。 */
export function removeEnv(keys: Iterable<string>): void {
  const removing = new Set(keys);
  if (removing.size === 0 || !existsSync(ENV_PATH)) return;
  const lines = readFileSync(ENV_PATH, "utf-8")
    .split("\n")
    .filter((line) => {
      const m = line.match(KEY_RE);
      return !m || !removing.has(m[1]);
    });
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  const tmp = `${ENV_PATH}.tmp`;
  writeFileSync(tmp, lines.join("\n") + "\n");
  renameSync(tmp, ENV_PATH);
  chmodSync(ENV_PATH, 0o600);
}

/** 读取已声明的变量名集合（用于“是否已设置”状态，不回传值）。 */
export function envKeysSet(): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(ENV_PATH)) return keys;
  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const m = line.match(KEY_RE);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/** 读取运行时 .env 供子进程使用；不对外暴露、不写日志。 */
export function runtimeEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(ENV_PATH)) return out;
  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const m = line.match(KEY_RE);
    if (!m) continue;
    const eq = line.indexOf("=");
    out[m[1]] = line.slice(eq + 1);
  }
  return out;
}
