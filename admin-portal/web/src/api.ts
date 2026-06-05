// axios 实例：cookie 会话（决策六）。401 → 跳登录页。
import axios from "axios";

export const api = axios.create({ baseURL: "/api", withCredentials: true });

api.interceptors.response.use(
  (r) => r,
  (err) => {
    const status = err?.response?.status;
    const url: string = err?.config?.url || "";
    const onLogin = window.location.pathname.endsWith("/login");
    // 未认证 → 回登录页；但 /auth/* 自身的 401（如 /auth/me 探活）与已在登录页时不跳，避免循环。
    if (status === 401 && !onLogin && !url.includes("/auth/")) {
      window.location.href = "/console/login";
    }
    return Promise.reject(err);
  },
);

// —— 认证 ——
export type PlatformRole = "admin" | "ops" | "audit";
export interface Me {
  platformUserId: string;
  name: string;
  platformRole: PlatformRole;
  idp: string;
}
export interface Providers {
  session_enabled: boolean;
  providers: { feishu: boolean; dingtalk: boolean };
}

export async function fetchMe(): Promise<Me> {
  return (await api.get("/auth/me")).data;
}
export async function fetchProviders(): Promise<Providers> {
  return (await api.get("/auth/providers")).data;
}
export async function logout(): Promise<void> {
  await api.post("/auth/logout");
}

// —— 类型 ——
export interface AgentRow {
  id: string;
  role: "employee" | "admin";
  name: string;
  default: boolean;
  skills: string[];
  channels: Array<{ domain: string; accountId: string }>;
}
export interface Skill {
  name: string;
  description: string;
}
export interface ChannelsInfo {
  supported: string[];
  channels: Record<string, { accounts: string[] }>;
  env_keys: string[];
}

export async function fetchAgents(): Promise<AgentRow[]> {
  return (await api.get("/config/agents")).data.agents;
}
export async function fetchSkills(): Promise<Skill[]> {
  return (await api.get("/config/skills")).data.skills;
}
export async function fetchChannels(): Promise<ChannelsInfo> {
  return (await api.get("/config/channels")).data;
}
export async function createAgent(body: unknown) {
  return (await api.post("/config/agents", body)).data;
}
