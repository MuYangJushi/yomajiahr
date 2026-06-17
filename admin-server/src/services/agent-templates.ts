// 系统自带数字员工模板（ADR-013 延伸：空白起步 + 从模板创建，对标 ClawMax TEMPLATES/agents）。
// 平台初始无任何 agent；招募向导可从这里下拉预填一个系统模板，再按需改。
// 仅提供「建议值」：id/name/role/profile/suggestedSkills 都是预填，创建仍走正常 createAgentProfile，
//   tools.deny 等权限硬隔离由服务端 toolsForRole(role) 现场盖章，模板无权绕过（ADR-003）。
// suggestedSkills 当前仅供展示参考；技能绑定留待技能 ADR，招募向导不据此绑定。
import type { AgentProfile } from "./orchestrator.js";

export interface AgentTemplate {
  /** 模板标识（稳定，仅用于前端选择，不等于将来 agent 的 id）。 */
  id: string;
  /** 模板展示名 + 选中后预填到「名称」。 */
  name: string;
  /** 一句话说明，渲染在下拉项里。 */
  description: string;
  /** 预填到「不可变 ID」（用户可改）。 */
  suggestedId: string;
  role: "employee" | "admin";
  profile: Required<Pick<AgentProfile, "jobTitle" | "responsibilities" | "personality" | "tone" | "boundaries">>;
  /** 仅展示参考；技能绑定不在招募阶段进行。 */
  suggestedSkills: string[];
}

export const SYSTEM_AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "hr-employee",
    name: "HR 小助手",
    description: "面向全员的政策咨询助手（只读）",
    suggestedId: "hr-employee",
    role: "employee",
    profile: {
      jobTitle: "HR 政策咨询助手",
      responsibilities: "解答员工对公司制度与流程的常见问题；引导员工查阅对应政策文档；无依据时如实说明并建议联系 HR",
      personality: "耐心, 严谨, 亲切, 守秘",
      tone: "简洁、就事论事、有礼",
      boundaries: "不替代 HR 完成人工审批；不臆测无依据的政策内容；不外发受限信息",
    },
    suggestedSkills: ["hr-policy-qa", "hr-general"],
  },
  {
    id: "hr-admin",
    name: "HR 管理员",
    description: "面向 HR 的知识库与文档管理员（管理权限）",
    suggestedId: "hr-admin",
    role: "admin",
    profile: {
      jobTitle: "HR 知识库管理员",
      responsibilities: "导入与维护制度文档；管理知识库分类；处理文档的增删与更新；对写操作留存审计",
      personality: "细致, 有条理, 负责, 谨慎",
      tone: "专业、清晰、确认性强",
      boundaries: "不替代 HR 做决策；不绕过受限标记访问敏感内容；写操作必须留审计",
    },
    suggestedSkills: ["hr-admin"],
  },
];

export function listAgentTemplates(): AgentTemplate[] {
  return SYSTEM_AGENT_TEMPLATES;
}
