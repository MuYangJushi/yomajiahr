// 平台账号表 users.json（config-store/）+ 身份归一化 + 角色映射。
// 已核实安全：generate-config / validate-config 只读 channels/agents/bindings 三具名文件，
// 不 glob config-store/*.json，故此处新增 users.json 不会被生成器/校验器绊到。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BOOTSTRAP_ADMINS, DEMO_OPEN_LOGIN_ROLE } from "../config.js";
import { STORE_DIR } from "../services/store.js";
import { isPlatformRole } from "./types.js";
import type { IdpIdentity, PlatformRole, PlatformUser } from "./types.js";

const USERS_PATH = join(STORE_DIR, "users.json");

/** users.json 单条记录（跨 IdP 归一化 + 角色）。 */
export interface StoredUser {
  platformUserId: string;
  name: string;
  platformRole: PlatformRole;
  feishuUnionId?: string;
  dingtalkUnionId?: string;
  phone?: string;
  email?: string;
  source?: "allowlist" | "org-auto";
}

export function readUsers(): StoredUser[] {
  if (!existsSync(USERS_PATH)) return [];
  try {
    const data = JSON.parse(readFileSync(USERS_PATH, "utf-8"));
    return Array.isArray(data) ? (data as StoredUser[]) : [];
  } catch {
    return [];
  }
}

/** 用同一 IdP 的 unionId 命中。 */
function matchByUnionId(users: StoredUser[], idp: IdpIdentity["idp"], unionId: string): StoredUser | undefined {
  if (idp === "demo") return undefined;
  const key = idp === "feishu" ? "feishuUnionId" : "dingtalkUnionId";
  return users.find((u) => u[key] && u[key] === unionId);
}

/** 用连接键（手机号/邮箱）跨命名空间命中（②归一化）。 */
function matchByConnKey(users: StoredUser[], id: IdpIdentity): StoredUser | undefined {
  return users.find(
    (u) =>
      (id.phone && u.phone && u.phone === id.phone) ||
      (id.email && u.email && u.email.toLowerCase() === id.email!.toLowerCase()),
  );
}

function inBootstrap(id: IdpIdentity): boolean {
  if (BOOTSTRAP_ADMINS.length === 0) return false;
  return BOOTSTRAP_ADMINS.some((entry) => entry === id.unionId || (id.phone && entry === id.phone));
}

/**
 * 认证身份 → 平台用户（角色映射）。来源优先级（ADR-005 决策六 §角色映射）：
 *   ① users.json 命中（先同 IdP unionId，再连接键）→ 用其角色
 *   ② 引导管理员名单（env）→ admin
 *   ③ 组织架构自动判定（③ 阶段接入，本步留空）
 *   ④ 比赛展示临时开放角色（env，仅 ops/audit）
 *   ⑤ 默认拒绝（返回 null，调用方提示联系管理员）
 */
export function resolveUser(id: IdpIdentity): PlatformUser | null {
  const users = readUsers();
  const hit = matchByUnionId(users, id.idp, id.unionId) || matchByConnKey(users, id);
  if (hit) {
    // fail-loud：users.json 里角色拼错（如 "Admin"/"administrator"）在登录时即拒绝，
    // 不让非法角色进入 session（否则下游 requireRole 只能靠 fail-closed 兜底）。
    if (!isPlatformRole(hit.platformRole)) return null;
    return {
      platformUserId: hit.platformUserId,
      name: hit.name || id.name,
      platformRole: hit.platformRole,
      type: "human",
      idp: id.idp,
    };
  }
  if (inBootstrap(id)) {
    return {
      platformUserId: `${id.idp}:${id.unionId}`,
      name: id.name,
      platformRole: "admin",
      type: "human",
      idp: id.idp,
    };
  }
  if (DEMO_OPEN_LOGIN_ROLE) {
    return {
      platformUserId: `${id.idp}:${id.unionId}`,
      name: id.name,
      platformRole: DEMO_OPEN_LOGIN_ROLE,
      type: "human",
      idp: id.idp,
    };
  }
  return null;
}
