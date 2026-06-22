// 飞书 IdP 适配器（决策六 ①）。
// 严格对齐官方「网页应用 SSO」文档：https://open.feishu.cn/document/sso/web-application-sso/login-overview
//   1) 授权码：GET https://accounts.feishu.cn/open-apis/authen/v1/authorize
//      （注意授权域名是 accounts.feishu.cn，与 API 域名 open.feishu.cn 不同）
//   2) 换 user_access_token：POST https://open.feishu.cn/open-apis/authen/v2/oauth/token
//      （v2 端点，body 带 client_id/client_secret/code，无需先取 app_access_token，无 Authorization 头）
//   3) 用户信息：GET https://open.feishu.cn/open-apis/authen/v1/user_info（Bearer user_access_token）
// 飞书 API 在部分 Node 24.16.0 运行环境下会触发全局 fetch/undici 原生崩溃（SEGV）。
// 这里用 curl 子进程绕开该运行时问题，避免 OAuth callback 把 admin 服务打挂。
import { spawn } from "node:child_process";
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

function curlJson<T>(url: string, init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: unknown } = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const args = ["-sS", "--max-time", "10", "-X", init.method || "GET"];
    for (const [key, value] of Object.entries(init.headers || {})) {
      args.push("-H", `${key}: ${value}`);
    }
    if (init.body !== undefined) args.push("--data-binary", "@-");
    args.push(url);

    const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`curl 飞书请求失败：exit=${code} ${stderr.trim()}`.trim()));
      try {
        resolve(JSON.parse(stdout) as T);
      } catch {
        reject(new Error(`飞书返回非 JSON：${stdout.slice(0, 200)}`));
      }
    });
    if (init.body !== undefined) child.stdin.end(JSON.stringify(init.body));
    else child.stdin.end();
  });
}

/**
 * 用授权 code 换取用户身份，归一化为 IdpIdentity。
 * @param redirectUri 必须与授权阶段使用的回调地址一致。
 */
export async function feishuExchangeCode(code: string, redirectUri: string): Promise<IdpIdentity> {
  // 1) code → user_access_token（v2，无需 app_access_token，无 Authorization 头）
  const token = await curlJson<TokenResp>(`${FEISHU_OPEN_BASE}/open-apis/authen/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: {
      grant_type: "authorization_code",
      client_id: FEISHU_LOGIN_APP_ID,
      client_secret: FEISHU_LOGIN_APP_SECRET,
      code,
      redirect_uri: redirectUri,
    },
  });
  const userToken = token.access_token;
  if (!userToken || (typeof token.code === "number" && token.code !== 0)) {
    throw new Error(`飞书 oauth/token 失败：code=${token.code} ${token.error || ""} ${token.error_description || ""}`.trim());
  }

  // 2) user_access_token → 用户信息（authen/v1/user_info，返回 {code,msg,data}）
  const infoResp = await curlJson<UserInfoWrap>(`${FEISHU_OPEN_BASE}/open-apis/authen/v1/user_info`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
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
