// config-store 与运行时配置的 Zod schema + 类型（同源）。
// schema 既校验 store/运行时配置，又通过 z.infer 反推 TS 类型，供 portal 与未来日志插件复用。
import { z } from 'zod';

/** 渠道账号：字段随渠道而异，保持宽松（passthrough），仅做存在性/占位符校验。 */
export const ChannelAccountSchema = z.object({}).passthrough();

/** channels.json：domain → accountId → account */
export const ChannelsStoreSchema = z.record(
  z.string(),
  z.record(z.string(), ChannelAccountSchema),
);

export const AgentToolsSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .passthrough();

/** agent 角色：决定权限红线。缺省最小权限（employee → 强制只读）。 */
export const AgentRoleSchema = z.enum(['employee', 'admin']);

/** agents.json 的单个 agent。passthrough 透传 openclaw 其余字段（model 覆盖等）。 */
export const AgentSchema = z
  .object({
    id: z.string().min(1),
    role: AgentRoleSchema.default('employee'),
    name: z.string().optional(),
    /** 平台编辑字段，仅用于渲染 workspace，不进入 OpenClaw 运行时 agents.list。 */
    persona: z.string().optional(),
    default: z.boolean().optional(),
    workspace: z.string().min(1),
    skills: z.array(z.string()).default([]),
    tools: AgentToolsSchema.optional(),
  })
  .passthrough();

export const AgentsStoreSchema = z.array(AgentSchema);

export const BindingSchema = z
  .object({
    agentId: z.string().min(1),
    match: z
      .object({
        channel: z.string().min(1),
        accountId: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

export const BindingsStoreSchema = z.array(BindingSchema);

/** knowledge.json：KB↔agent 绑定（与 admin-server services/knowledge.ts 同源；ADR-010/011）。
 *  passthrough 透传 admin-server 写入的其余字段（intro 等），生成器仅消费 provider/externalKbId/boundAgents。 */
export const KnowledgeBindingSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    provider: z.enum(['fastgpt', 'local']),
    externalKbId: z.string().optional(),
    boundAgents: z.array(z.string()).default([]),
    restricted: z.boolean().optional(),
  })
  .passthrough();

export const KnowledgeStoreSchema = z
  .object({
    platform: z.enum(['fastgpt', 'local']),
    knowledgeBases: z.array(KnowledgeBindingSchema).default([]),
  })
  .passthrough();

export type ChannelAccount = z.infer<typeof ChannelAccountSchema>;
export type ChannelsStore = z.infer<typeof ChannelsStoreSchema>;
export type AgentTools = z.infer<typeof AgentToolsSchema>;
export type AgentRole = z.infer<typeof AgentRoleSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type AgentsStore = z.infer<typeof AgentsStoreSchema>;
export type Binding = z.infer<typeof BindingSchema>;
export type BindingsStore = z.infer<typeof BindingsStoreSchema>;
export type KnowledgeBinding = z.infer<typeof KnowledgeBindingSchema>;
export type KnowledgeStore = z.infer<typeof KnowledgeStoreSchema>;

/** 动态 store 的合集。knowledge 可选：旧部署无 knowledge.json 时缺省（走默认库兜底，见生成器）。 */
export interface ConfigStore {
  channels: ChannelsStore;
  agents: AgentsStore;
  bindings: BindingsStore;
  knowledge?: KnowledgeStore;
}

/** 运行时配置（openclaw.json）——宽松类型，仅约束我们关心的部分。 */
export type RuntimeConfig = Record<string, unknown>;

/** 写权限相关工具（ADR-003：员工面 agent 不得有效授予这些）。 */
export const WRITE_TOOLS = ['memory_write', 'memory_delete', 'exec'] as const;

/** sub-agent 相关工具（ADR-001：任何 agent 不得有效授予）。 */
export const SUBAGENT_TOOLS = ['sessions_spawn'] as const;

// ADR-012：内置 memorySearch 退役 → ADR-004 的 LOCKED_CHUNKING（chunking 锁）随之移除（约束对象已不存在）。
