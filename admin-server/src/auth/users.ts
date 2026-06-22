// 平台账号表 users.json（config-store/）+ 身份归一化 + 角色映射。
// 已核实安全：generate-config / validate-config 只读 channels/agents/bindings 三具名文件，
// 不 glob config-store/*.json，故此处新增 users.json 不会被生成器/校验器绊到。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BOOTSTRAP_ADMINS, DINGTALK_LOGIN_CORP_ID, OPEN_ENTERPRISE_LOGIN_ROLE } from "../config.js";
import { STORE_DIR } from "../services/store.js";
import { resolveOrgRole } from "./org-mapping.js";
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
  /**
   * 记录来源。`allowlist`=管理员显式指定（角色权威，登录时短路生效，覆盖自动映射）；
   * `org-auto`=首次登录自动登记的身份注册（仅作身份台账，角色每次登录 live 重算，不短路）。
   * ⚠️ 手工编辑 users.json 想覆盖角色，必须设 source:"allowlist"（或留空=legacy 视为 allowlist），
   * 否则会被当作 org-auto 身份记录、其 platformRole 被忽略。
   */
  source?: "allowlist" | "org-auto";
  /** 最近一次登录时间（ISO8601）。org-auto 登记后每次登录刷新。 */
  lastSeenAt?: string;
}

/** allowlist 语义：显式名单（source=allowlist）或 legacy 无 source 记录，其角色为权威、登录时短路。 */
function isAllowlist(u: StoredUser): boolean {
  return u.source === "allowlist" || u.source === undefined;
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

// 写串行化：recordLogin 是 read-modify-write，原子 rename 只防「读到半截」，不防「并发写丢更新」。
// 沿用 util.ts auditWriteQueue 同款串行队列，确保并发登录的 upsert 不互相覆盖。
let usersWriteQueue: Promise<void> = Promise.resolve();

/** 原子写 users.json（tmp+rename）。 */
function writeUsersSync(users: StoredUser[]): void {
  mkdirSync(dirname(USERS_PATH), { recursive: true });
  const tmp = `${USERS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(users, null, 2) + "\n");
  renameSync(tmp, USERS_PATH);
}

/**
 * 首次登录登记 / 刷新身份注册表（#71）。串行化 read-modify-write + 按 unionId 去重 + 原子写。
 *  - 命中同 IdP unionId 的记录：刷新 lastSeenAt / name / 缺失的 phone/email；**不动** platformRole/source。
 *  - 未命中：追加 org-auto 记录（platformUserId/role 取自本次已解析的 PlatformUser，作身份台账，角色非权威）。
 * 解析失败（resolveUser 返回 null，未授权）不会走到这里，故不会登记未授权身份。
 */
export function recordLogin(id: IdpIdentity, user: PlatformUser): Promise<void> {
  usersWriteQueue = usersWriteQueue
    .then(() => {
      if (id.idp === "demo") return; // 比赛访客不落注册表
      const users = readUsers();
      const now = new Date().toISOString();
      const key = id.idp === "feishu" ? "feishuUnionId" : "dingtalkUnionId";
      const existing = users.find((u) => u[key] && u[key] === id.unionId);
      if (existing) {
        existing.lastSeenAt = now;
        if (id.name) existing.name = id.name;
        if (id.phone && !existing.phone) existing.phone = id.phone;
        if (id.email && !existing.email) existing.email = id.email;
        if (!existing[key]) existing[key] = id.unionId;
      } else {
        users.push({
          platformUserId: user.platformUserId,
          name: user.name,
          platformRole: user.platformRole,
          [key]: id.unionId,
          phone: id.phone,
          email: id.email,
          source: "org-auto",
          lastSeenAt: now,
        });
      }
      writeUsersSync(users);
    })
    .catch(() => {});
  return usersWriteQueue;
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
 * 企业成员闸门（企业开放登录④ 专用）：登录成功的身份是否确属本企业。
 *  - 飞书：自建应用换 code 成功即证明本租户成员（外部用户无法授权），直接放行。
 *  - 钉钉：「统一登录」可放进任意钉钉用户，必须用 token 回传的 corpId 比对本企业 corpId；
 *    未配置 DINGTALK_LOGIN_CORP_ID 或 corpId 不匹配 → 拒（fail-closed）。
 * 注：本闸门只约束 ④ 开放登录；① users.json / ② BOOTSTRAP_ADMINS 是显式名单，不受此限。
 */
function isEnterpriseMember(id: IdpIdentity): boolean {
  if (id.idp === "feishu") return true;
  if (id.idp === "dingtalk") return Boolean(DINGTALK_LOGIN_CORP_ID) && id.corpId === DINGTALK_LOGIN_CORP_ID;
  return false; // demo 等其它来源不走企业开放登录
}

/**
 * 认证身份 → 平台用户（角色映射）。来源优先级（ADR-005 决策六 §角色映射）：
 *   ① users.json 命中且为 allowlist（显式名单/legacy）→ 用其角色（权威，短路）
 *   ② 引导管理员名单（env）→ admin
 *   ③ 组织架构自动判定（#72，默认关；仅提升 admin、不降级、fail-closed）
 *   ④ 企业开放登录：过企业成员闸门的已认证用户 → 基线角色（env，仅 ops/audit）
 *   ⑤ 默认拒绝（返回 null，调用方提示联系管理员）
 *
 * ⚠️ org-auto 记录（首次登录登记的身份台账）**不短路**：其角色每次登录按 ②③④ live 重算，
 *    确保撤销 bootstrap / 关闭开放登录 / 调部门规则后权限即时回收（fail-closed），
 *    不被历史登记的旧角色钉死（platformUserId 由 `${idp}:${unionId}` 确定性重建，身份连续）。
 */
export async function resolveUser(id: IdpIdentity): Promise<PlatformUser | null> {
  const users = readUsers();
  // 优先采用 allowlist 记录：若同一人既有 org-auto（unionId 命中）又有手工 allowlist（仅按手机号/邮箱
  // 登记，无 unionId），不能让 org-auto 抢先命中遮蔽 allowlist 的显式角色覆盖——故在两类命中里
  // 专门挑出 allowlist 记录，挑不到才落到 org-auto 不短路、走 live 重算。
  const unionHit = matchByUnionId(users, id.idp, id.unionId);
  const connHit = matchByConnKey(users, id);
  const hit = [unionHit, connHit].find((u): u is StoredUser => Boolean(u) && isAllowlist(u as StoredUser));
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
  // ③ 组织架构自动判定（#72）：仅在命中规则时提升角色（当前仅 admin），失败/未开通 → null 走兜底。
  const orgRole = await resolveOrgRole(id);
  if (orgRole) {
    return {
      platformUserId: `${id.idp}:${id.unionId}`,
      name: id.name,
      platformRole: orgRole,
      type: "human",
      idp: id.idp,
    };
  }
  if (OPEN_ENTERPRISE_LOGIN_ROLE && isEnterpriseMember(id)) {
    return {
      platformUserId: `${id.idp}:${id.unionId}`,
      name: id.name,
      platformRole: OPEN_ENTERPRISE_LOGIN_ROLE,
      type: "human",
      idp: id.idp,
    };
  }
  return null;
}
