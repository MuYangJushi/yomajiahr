// 平台 session：HMAC 签名的 HttpOnly cookie（零外部依赖，用 node:crypto）。
// 格式：base64url(JSON) "." base64url(HMAC-SHA256)；verify 用 timingSafeEqual 防时序攻击。
import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import type { Request, Response } from "express";
import { IS_PROD, SESSION_MAX_AGE_SEC, SESSION_SECRET } from "../config.js";
import type { SessionPayload } from "./types.js";

export const SESSION_COOKIE = "hr_portal_session";
const STATE_COOKIE = "hr_oauth_state";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(obj: unknown): string {
  return b64url(Buffer.from(JSON.stringify(obj), "utf-8"));
}

/** 用 SESSION_SECRET 对任意对象签名，产出 `payload.sig` 字符串。 */
export function sign(obj: unknown): string {
  const body = b64urlJson(obj);
  const sig = b64url(createHmac("sha256", SESSION_SECRET).update(body).digest());
  return `${body}.${sig}`;
}

/** 校验签名并解析；签名不符 / 格式错误返回 null。 */
export function verify<T>(token: string | undefined | null): T | null {
  if (!token || !SESSION_SECRET) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(createHmac("sha256", SESSION_SECRET).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")) as T;
  } catch {
    return null;
  }
}

/** 极简 cookie 解析（避免引入 cookie-parser 依赖）。 */
export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function cookieAttrs(maxAgeSec: number): string {
  const attrs = [`Path=/`, `HttpOnly`, `SameSite=Lax`, `Max-Age=${maxAgeSec}`];
  if (IS_PROD) attrs.push("Secure");
  return attrs.join("; ");
}

/** 颁发平台 session cookie。 */
export function issueSession(res: Response, payload: Omit<SessionPayload, "exp">): void {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC;
  const token = sign({ ...payload, exp } satisfies SessionPayload);
  res.append("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs(SESSION_MAX_AGE_SEC)}`);
}

/** 读取并校验 session（含过期检查）。 */
export function readSession(req: Request): SessionPayload | null {
  const raw = parseCookies(req)[SESSION_COOKIE];
  const payload = verify<SessionPayload>(raw);
  if (!payload) return null;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** 清除 session cookie（登出）。 */
export function clearSession(res: Response): void {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// —— OAuth state（防 CSRF）：签名后短期 cookie，回调时比对 ——

/** 生成 state 并写入短期 cookie，返回 state 明文（拼进授权 URL）。 */
export function issueOauthState(res: Response, state: string): void {
  const token = sign({ state, exp: Math.floor(Date.now() / 1000) + 600 });
  res.append("Set-Cookie", `${STATE_COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs(600)}`);
}

/** 校验回调带回的 state 与 cookie 中签名值一致且未过期。 */
export function verifyOauthState(req: Request, stateFromQuery: string | undefined): boolean {
  if (!stateFromQuery) return false;
  const raw = parseCookies(req)[STATE_COOKIE];
  const payload = verify<{ state: string; exp: number }>(raw);
  if (!payload) return false;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return false;
  const a = Buffer.from(payload.state);
  const b = Buffer.from(stateFromQuery);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function clearOauthState(res: Response): void {
  res.append("Set-Cookie", `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
