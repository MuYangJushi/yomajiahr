// 钉钉 IdP 适配器（决策六 ②）。
// 严格对齐官方新版 OAuth2「统一授权登录第三方网站」：
//   1) 授权码：GET https://login.dingtalk.com/oauth2/auth
//      （授权域名 login.dingtalk.com，与 API 域名 api.dingtalk.com 不同；prompt=consent）
//      ⚠️ 回调返回的参数名是 authCode（不是 code），见 routes/auth.ts 兼容处理。
//   2) 换 userAccessToken：POST https://api.dingtalk.com/v1.0/oauth2/userAccessToken
//      （body 驼峰 clientId/clientSecret/code/grantType；无需 redirect_uri；读顶层 accessToken）
//   3) 用户信息：GET https://api.dingtalk.com/v1.0/contact/users/me
//      （自定义头 x-acs-dingtalk-access-token，非标准 Bearer；返回顶层 {nick,unionId,openId,mobile,email}）
// 用 Node 全局 fetch（Node 24），不引 HTTP 客户端依赖。
import {
  DINGTALK_API_BASE,
  DINGTALK_LOGIN_BASE,
  DINGTALK_LOGIN_CLIENT_ID,
  DINGTALK_LOGIN_CLIENT_SECRET,
  DINGTALK_LOGIN_SCOPE,
} from "../config.js";
import type { IdpIdentity } from "./types.js";

/** 钉钉登录是否已配置（凭据齐全）。 */
export function dingtalkConfigured(): boolean {
  return Boolean(DINGTALK_LOGIN_CLIENT_ID && DINGTALK_LOGIN_CLIENT_SECRET);
}

/** 构造授权跳转 URL（授权域名 login.dingtalk.com；回调带回 authCode+state）。 */
export function dingtalkAuthorizeUrl(state: string, redirectUri: string): string {
  const u = new URL(`${DINGTALK_LOGIN_BASE}/oauth2/auth`);
  u.searchParams.set("client_id", DINGTALK_LOGIN_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", DINGTALK_LOGIN_SCOPE || "openid");
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

interface TokenResp {
  accessToken?: string;
  refreshToken?: string;
  expireIn?: number;
  corpId?: string;
  // 错误时：{code, message, requestid}
  code?: string;
  message?: string;
}

interface ContactMeResp {
  nick?: string;
  avatarUrl?: string;
  mobile?: string;
  openId?: string;
  unionId?: string;
  email?: string;
  stateCode?: string;
  // 错误时：{code, message, requestid}
  code?: string;
  message?: string;
}

/**
 * 用授权 authCode 换取用户身份，归一化为 IdpIdentity。
 * 钉钉换 token 不需要 redirect_uri（与飞书 v2 不同）。
 */
export async function dingtalkExchangeCode(authCode: string): Promise<IdpIdentity> {
  // 1) authCode → userAccessToken（顶层 accessToken）
  const tokenR = await fetch(`${DINGTALK_API_BASE}/v1.0/oauth2/userAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: DINGTALK_LOGIN_CLIENT_ID,
      clientSecret: DINGTALK_LOGIN_CLIENT_SECRET,
      code: authCode,
      grantType: "authorization_code",
    }),
  });
  const token = (await tokenR.json()) as TokenResp;
  const userToken = token.accessToken;
  if (!userToken) {
    throw new Error(`钉钉 userAccessToken 失败：code=${token.code || tokenR.status} ${token.message || ""}`.trim());
  }

  // 2) userAccessToken → 用户信息（自定义头 x-acs-dingtalk-access-token）
  const infoR = await fetch(`${DINGTALK_API_BASE}/v1.0/contact/users/me`, {
    headers: { "x-acs-dingtalk-access-token": userToken },
  });
  const info = (await infoR.json()) as ContactMeResp;
  const unionId = info.unionId || info.openId;
  if (!infoR.ok || !unionId) {
    throw new Error(`钉钉 contact/users/me 失败：code=${info.code || infoR.status} ${info.message || ""}`.trim());
  }

  return {
    idp: "dingtalk",
    unionId,
    name: info.nick || "未知用户",
    phone: info.mobile, // 需应用「个人手机号信息」权限才返回
    email: info.email, // 需应用「邮箱等个人信息」权限才返回
  };
}
