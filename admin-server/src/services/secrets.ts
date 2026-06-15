// .env 键级 upsert（保留既有键/注释/非 bot 秘钥；原子 + chmod 600）。
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_DIR, STATE_DIR } from "../config.js";

export const ENV_PATH = join(STATE_DIR, ".env");
/** 模板（占位符判定的对照源）；与 generate-config CLI 默认 .env-example 一致。 */
const ENV_EXAMPLE_PATH = resolve(REPO_DIR, "config", ".env.example");

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

/** 读取 .env / .env.example 的 key→value 映射；行为与 generate-config 的 readEnvMap 一致。 */
function readEnvValueMap(path: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(path)) return map;
  const text = readFileSync(path, "utf-8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map.set(m[1]!, value);
  }
  return map;
}

/** 占位符值判定（与 config/src/generate-config.ts 的 isPlaceholderValue 同源）：
 *  - 空 / 只有空白 / `${...}` 字面量 / 与 .env.example 模板同值 / 已知模板尾巴（change-me、xxxxxxxx）
 *  → 视为「未配置」。
 *  这是 admin-server 与生成器共同的"凭证就绪"判定；任何一处变了另一处必须同步。
 */
export function isPlaceholderValue(actual: string | undefined, template: string | undefined): boolean {
  if (actual === undefined) return true;
  const v = actual.trim();
  if (v === "") return true;
  if (/^\$\{[A-Z0-9_]+\}$/.test(v)) return true;
  if (template !== undefined && v === template.trim()) return true;
  if (/^change[-_]me/i.test(v)) return true;
  if (/^x{4,}$/i.test(v)) return true;
  if (/x{8,}/.test(v)) return true;
  return false;
}

/** 判定一组 envKeys 是否全部已配置（在 .env 中且不是占位值）。 */
export function envKeysAllConfigured(envKeys: string[] | undefined): boolean {
  if (!envKeys || envKeys.length === 0) return false;
  const envMap = readEnvValueMap(ENV_PATH);
  const exampleMap = readEnvValueMap(ENV_EXAMPLE_PATH);
  return envKeys.every((key) => !isPlaceholderValue(envMap.get(key), exampleMap.get(key)));
}
