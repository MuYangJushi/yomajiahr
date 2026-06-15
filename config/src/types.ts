// config-store 与运行时配置的 Zod schema + 类型（同源）。
// schema 既校验 store/运行时配置，又通过 z.infer 反推 TS 类型，供 portal 与未来日志插件复用。
import { z } from 'zod';

/** 渠道账号：字段随渠道而异，保持宽松（passthrough），仅做存在性/占位符校验。 */
export const ChannelAccountSchema = z.object({}).passthrough();

/** 渠道策略（policy）字段。 */
export const ChannelPolicySchema = z
  .object({
    dmPolicy: z.enum(['open', 'restricted']).optional(),
    groupPolicy: z.enum(['open', 'disabled']).optional(),
    requireMention: z.boolean().optional(),
  })
  .passthrough();

/** 单条渠道账号资产（ADR-013 §数据与接口）。
 *  - id：账号资产 ID（不可改；与 agent id 解耦）
 *  - type：feishu | dingtalk
 *  - displayName：平台显示名
 *  - account：平台原始字段（appId/appSecret/clientId/clientSecret/...）
 *  - policy：dmPolicy/groupPolicy/requireMention
 *  - enabled：是否启用
 */
export const ChannelAssetSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['feishu', 'dingtalk']),
    displayName: z.string().min(1),
    account: ChannelAccountSchema.optional(),
    policy: ChannelPolicySchema.optional(),
    enabled: z.boolean().optional(),
    /** 引用本账号的 env 键名（FEISHU_<UPPER_ID>_APP_ID 等），供 secrets 服务回写。 */
    envKeys: z.array(z.string()).optional(),
    /** 集中探活缓存（ADR-013 §渠道独立），不进运行时配置（见 generate-config.ts）。 */
    health: z.union([
      z.object({
        configured: z.boolean(),
        running: z.boolean(),
        connected: z.boolean(),
        probe: z.object({ ok: z.boolean() }).optional(),
        lastError: z.string().optional(),
        checkedAt: z.string(),
      }),
      // 兼容 ADR-013 早期实现写入的缓存；下次集中探活会升级为上面的完整结构。
      z.object({ ok: z.boolean(), lastError: z.string().optional(), updatedAt: z.string() }),
    ]).optional(),
  })
  .passthrough();

/** channels.json：顶层账号资产数组（ADR-013 #64）。生成器派生 domain→accountId 形态供运行时消费。 */
export const ChannelsStoreSchema = z.array(ChannelAssetSchema);

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
    /** @deprecated 由 profile.personality 取代；保留字段做兼容性读取，渲染时自动映射。 */
    persona: z.string().optional(),
    /**
     * 结构化职业档案（ADR-013 §数据与接口）。
     * 仅用于平台编辑 + workspace 模板渲染；**生成 OpenClaw 运行时配置时必须剔除**（见 generate-config.ts）。
     * 5 个字段全部可选；缺失字段在 workspace 模板里以"待补充"占位。
     */
    profile: z
      .object({
        jobTitle: z.string().optional(),
        responsibilities: z.string().optional(),
        personality: z.string().optional(),
        tone: z.string().optional(),
        boundaries: z.string().optional(),
      })
      .passthrough()
      .optional(),
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
