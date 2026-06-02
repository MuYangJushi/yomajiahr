// axios 实例：注入 Bearer token（localStorage），401 时提示重输。
import axios from "axios";

const TOKEN_KEY = "hr_admin_token";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || "";
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}

export const api = axios.create({ baseURL: "/api" });

api.interceptors.request.use((config) => {
  const t = getToken();
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401) {
      const t = window.prompt("请输入 Admin Portal 访问令牌（OPENCLAW_WEB_AUTH_TOKEN）：");
      if (t) {
        setToken(t);
        // 重试一次
        err.config.headers.Authorization = `Bearer ${t}`;
        return api.request(err.config);
      }
    }
    return Promise.reject(err);
  },
);

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
