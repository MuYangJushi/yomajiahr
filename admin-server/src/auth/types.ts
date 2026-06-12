// 平台认证 / RBAC 类型（决策六）。
// ⚠️ 命名隔离：这里的 platformRole 指**平台登录人**的角色，
//    与 services/store.ts、services/orchestrator.ts 里的 `role: employee|admin`
//    （那是**被创建的数字员工 agent** 的角色）是两个完全不同的概念，切勿混用。

/** 平台登录人角色：admin ⊇ ops ⊇ audit。 */
export type PlatformRole = "admin" | "ops" | "audit";

/** 合法角色白名单（显式数组，避免用 `in ROLE_RANK` 被原型链键骗过）。 */
export const PLATFORM_ROLES: readonly PlatformRole[] = ["admin", "ops", "audit"];

/** 运行时类型守卫：来自 JSON/env/session 的字符串是否为合法角色。 */
export function isPlatformRole(v: unknown): v is PlatformRole {
  return typeof v === "string" && (PLATFORM_ROLES as readonly string[]).includes(v);
}

/** 角色等级（用于 requireRole 的"最低角色"比较）。 */
export const ROLE_RANK: Record<PlatformRole, number> = {
  audit: 1,
  ops: 2,
  admin: 3,
};

/** IdP 来源。 */
export type IdpKind = "feishu" | "dingtalk" | "demo";

/** 经 IdP 认证 + 归一化后的平台用户。 */
export interface PlatformUser {
  platformUserId: string;
  name: string;
  platformRole: PlatformRole;
  /** 认证主体类型：人类登录 or 机器/服务通道。 */
  type: "human" | "service";
  /** 人类登录时的来源 IdP。 */
  idp?: IdpKind;
}

/** session cookie 里承载的载荷（最小集）。 */
export interface SessionPayload {
  platformUserId: string;
  name: string;
  platformRole: PlatformRole;
  idp: IdpKind;
  /** 过期时间（epoch 秒）。 */
  exp: number;
}

/** IdP 适配器回传的归一化身份（角色映射前）。 */
export interface IdpIdentity {
  idp: IdpKind;
  /** 该 IdP 命名空间内的稳定 ID（飞书 union_id / 钉钉 unionid）。 */
  unionId: string;
  name: string;
  phone?: string;
  email?: string;
  /** 部门/用户组（③ 角色自动判定用）。 */
  departmentIds?: string[];
}
