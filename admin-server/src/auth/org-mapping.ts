// 组织架构自动判定（#72，Sprint 9 工作流 Q）。
//
// 设计红线（守 Sprint「fail-closed 是硬约束」）：
//  1. 默认关：PLATFORM_ORG_ROLE_MAPPING_ENABLED=1 才生效。生产部门 API scope 未开通前不应启用
//     （飞书需 contact:department.base:readonly 等；钉钉需 qyapi_get_department_list）。
//  2. 仅提升、不降级：只在「确证命中 admin 部门」时返回 admin，否则一律返回 null（回落到
//     企业开放登录基线 ops/audit），绝不因映射结果把人降到比基线更低或凭不确定信息提权。
//  3. fail-closed：拉取部门超时/抛错/为空/不在名单 → null。任何不确定都不提权。
//
// 角色目标是平台角色 admin|ops|audit（**不是**被创建数字员工的 employee|admin，见 auth/types.ts），
// 故 Sprint 文案「其余→employee」按平台语义落为「不提升、回落基线」。
//
// ⚠️ live 部门 API（fetchDepartmentIdsLive）在 scope 开通前无法联调；其 HTTP 细节待 Dennis 在
//    飞书/钉钉开发者后台授予部门读取权限后实测核验。在此之前 enabled=1 也会因 API 拒绝而 fail-closed。
import {
  DINGTALK_LOGIN_CLIENT_ID,
  DINGTALK_LOGIN_CLIENT_SECRET,
  FEISHU_LOGIN_APP_ID,
  FEISHU_LOGIN_APP_SECRET,
  FEISHU_OPEN_BASE,
  ORG_ADMIN_DEPT_IDS,
  ORG_ROLE_MAPPING_ENABLED,
} from "../config.js";
import type { IdpIdentity, PlatformRole } from "./types.js";

/** 注入点：测试用 mock fetcher / enabled / 规则覆盖默认 env 配置。 */
export interface OrgMappingDeps {
  enabled?: boolean;
  adminDeptIds?: string[];
  /** 返回该身份所属部门 ID 列表；抛错/超时由 resolveOrgRole 兜成 fail-closed。 */
  fetchDepartmentIds?: (id: IdpIdentity) => Promise<string[]>;
}

const FETCH_TIMEOUT_MS = 5000;

/**
 * 身份 → 平台角色（仅提升）。命中 admin 部门 → "admin"；其余/未开通/失败 → null。
 * resolveUser 在 bootstrap 之后、企业开放登录基线之前调用本函数。
 */
export async function resolveOrgRole(id: IdpIdentity, deps: OrgMappingDeps = {}): Promise<PlatformRole | null> {
  const enabled = deps.enabled ?? ORG_ROLE_MAPPING_ENABLED;
  if (!enabled) return null;
  if (id.idp === "demo") return null; // 访客无组织
  const adminDeptIds = deps.adminDeptIds ?? ORG_ADMIN_DEPT_IDS;
  if (adminDeptIds.length === 0) return null; // 无规则 → 不提升（避免误配把所有人当 admin）
  const fetcher = deps.fetchDepartmentIds ?? fetchDepartmentIdsLive;
  try {
    const deptIds = await fetcher(id);
    if (Array.isArray(deptIds) && deptIds.some((d) => adminDeptIds.includes(d))) return "admin";
    return null; // 不在 admin 部门 → 回落基线
  } catch {
    return null; // fail-closed：任何异常都不提权
  }
}

/** 带超时的 fetch（AbortController），避免登录被部门 API 卡死。 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * live 部门拉取（scope 开通后生效；未开通时 API 返回权限错误 → 抛错 → 上层 fail-closed）。
 * 飞书：tenant_access_token → GET contact/v3/users/{union_id}?user_id_type=union_id 读 department_ids。
 * 钉钉：access_token → POST user/getbyunionid 取 userid → user/get 读 dept_id_list。
 */
async function fetchDepartmentIdsLive(id: IdpIdentity): Promise<string[]> {
  if (id.idp === "feishu") return fetchFeishuDepartmentIds(id.unionId);
  if (id.idp === "dingtalk") return fetchDingtalkDepartmentIds(id.unionId);
  return [];
}

async function fetchFeishuDepartmentIds(unionId: string): Promise<string[]> {
  const tokenR = await fetchWithTimeout(`${FEISHU_OPEN_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: FEISHU_LOGIN_APP_ID, app_secret: FEISHU_LOGIN_APP_SECRET }),
  });
  const token = (await tokenR.json()) as { code?: number; tenant_access_token?: string };
  if (token.code !== 0 || !token.tenant_access_token) throw new Error("飞书 tenant_access_token 失败");
  const userR = await fetchWithTimeout(
    `${FEISHU_OPEN_BASE}/open-apis/contact/v3/users/${encodeURIComponent(unionId)}?user_id_type=union_id`,
    { headers: { Authorization: `Bearer ${token.tenant_access_token}` } },
  );
  const body = (await userR.json()) as { code?: number; data?: { user?: { department_ids?: string[] } } };
  if (body.code !== 0) throw new Error(`飞书 contact/users 失败：code=${body.code}`);
  return body.data?.user?.department_ids ?? [];
}

async function fetchDingtalkDepartmentIds(unionId: string): Promise<string[]> {
  const tokenR = await fetchWithTimeout(
    `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(DINGTALK_LOGIN_CLIENT_ID)}&appsecret=${encodeURIComponent(DINGTALK_LOGIN_CLIENT_SECRET)}`,
    { method: "GET" },
  );
  const token = (await tokenR.json()) as { errcode?: number; access_token?: string };
  if (token.errcode !== 0 || !token.access_token) throw new Error("钉钉 access_token 失败");
  const at = token.access_token;
  const byUnion = await fetchWithTimeout(`https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${at}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unionid: unionId }),
  });
  const ub = (await byUnion.json()) as { errcode?: number; result?: { userid?: string } };
  const userid = ub.result?.userid;
  if (ub.errcode !== 0 || !userid) throw new Error(`钉钉 getbyunionid 失败：errcode=${ub.errcode}`);
  const userR = await fetchWithTimeout(`https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${at}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userid }),
  });
  const body = (await userR.json()) as { errcode?: number; result?: { dept_id_list?: number[] } };
  if (body.errcode !== 0) throw new Error(`钉钉 user/get 失败：errcode=${body.errcode}`);
  return (body.result?.dept_id_list ?? []).map((n) => String(n));
}
