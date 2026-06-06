// 飞书 IdP 适配器（决策六 ①）。
// 严格对齐官方「网页应用 SSO」文档：https://open.feishu.cn/document/sso/web-application-sso/login-overview
//   1) 授权码：GET https://accounts.feishu.cn/open-apis/authen/v1/authorize
//      （注意授权域名是 accounts.feishu.cn，与 API 域名 open.feishu.cn 不同）
//   2) 换 user_access_token：POST https://open.feishu.cn/open-apis/authen/v2/oauth/token
//      （v2 端点，body 带 client_id/client_secret/code，无需先取 app_access_token，无 Authorization 头）
//   3) 用户信息：GET https://open.feishu.cn/open-apis/authen/v1/user_info（Bearer user_access_token）
// 用 Node 全局 fetch（Node 24），不引 HTTP 客户端依赖。
import {
  FEISHU_ACCOUNTS_BASE,
  FEISHU_LOGIN_APP_ID,
  FEISHU_LOGIN_APP_SECRET,
  FEISHU_LOGIN_SCOPE,
  FEISHU_OPEN_BASE,
} from "../config.js";
import type { IdpIdentity } from "./types.js";

/** 飞书登录是否已配置（app 凭据齐全）。 */
export function feishuConfigured(): boolean {
  return Boolean(FEISHU_LOGIN_APP_ID && FEISHU_LOGIN_APP_SECRET);
}

/** 构造授权跳转 URL（授权域名 accounts.feishu.cn；回调带回 code+state）。 */
export function feishuAuthorizeUrl(state: string, redirectUri: string): string {
  const u = new URL(`${FEISHU_ACCOUNTS_BASE}/open-apis/authen/v1/authorize`);
  u.searchParams.set("client_id", FEISHU_LOGIN_APP_ID);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  if (FEISHU_LOGIN_SCOPE) u.searchParams.set("scope", FEISHU_LOGIN_SCOPE);
  u.searchParams.set("state", state);
  return u.toString();
}

interface TokenResp {
  code?: number; // 0=成功（错误时非 0 + error/error_description）
  error?: string;
  error_description?: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

interface UserInfoWrap {
  code: number;
  msg?: string;
  data?: {
    name?: string;
    en_name?: string;
    open_id?: string;
    union_id?: string;
    mobile?: string;
    email?: string;
    enterprise_email?: string;
  };
}

/**
 * 用授权 code 换取用户身份，归一化为 IdpIdentity。
 * @param redirectUri 必须与授权阶段使用的回调地址一致。
 */
export async function feishuExchangeCode(code: string, redirectUri: string): Promise<IdpIdentity> {
  // 1) code → user_access_token（v2，无需 app_access_token，无 Authorization 头）
  const tokenR = await fetch(`${FEISHU_OPEN_BASE}/open-apis/authen/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: FEISHU_LOGIN_APP_ID,
      client_secret: FEISHU_LOGIN_APP_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const token = (await tokenR.json()) as TokenResp;
  const userToken = token.access_token;
  if (!userToken || (typeof token.code === "number" && token.code !== 0)) {
    throw new Error(`飞书 oauth/token 失败：code=${token.code} ${token.error || ""} ${token.error_description || ""}`.trim());
  }

  // 2) user_access_token → 用户信息（authen/v1/user_info，返回 {code,msg,data}）
  const infoR = await fetch(`${FEISHU_OPEN_BASE}/open-apis/authen/v1/user_info`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  const infoResp = (await infoR.json()) as UserInfoWrap;
  const info = infoResp.data;
  if (infoResp.code !== 0 || !info) {
    throw new Error(`飞书 user_info 失败：code=${infoResp.code} msg=${infoResp.msg || ""}`);
  }

  const unionId = info.union_id || info.open_id;
  if (!unionId) throw new Error("飞书返回缺少 union_id/open_id");

  return {
    idp: "feishu",
    unionId,
    name: info.name || info.en_name || "未知用户",
    phone: info.mobile, // 需 scope contact:user.phone:readonly 才返回
    email: info.email || info.enterprise_email, // 需 scope contact:user.email:readonly
  };
}
