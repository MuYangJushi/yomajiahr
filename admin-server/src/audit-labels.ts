// 审计动作中文标签（与前端 admin-web/src/Audit.tsx 的 ACTION_META 保持一致）。
// 两端各持一份是因为前后端分属独立包；改动作命名时务必同步两处。
// 覆盖后端 appendAuditLog 写入的全部动作 + 历史遗留动作（兼容旧 audit-log.jsonl）。
export const ACTION_LABEL: Record<string, string> = {
  // 知识库 / 文档
  IMPORT: "知识库导入",
  DELETE: "删除文档",
  CONFIG_KNOWLEDGE: "知识库配置",
  CREATE_KB: "新建知识库",
  CREATE_KB_FAILED: "新建知识库（失败）",
  BIND_KB: "绑定知识库",
  BIND_KB_FAILED: "绑定知识库（失败）",
  // 数字员工
  "agent.create": "创建数字员工",
  "agent.update": "编辑数字员工",
  "agent.delete": "删除数字员工",
  "agent.profile.generate": "生成员工档案",
  "agent.skill.update": "配置员工技能",
  "agent.channel.bind": "员工绑定渠道",
  "agent.channel.unbind": "员工解绑渠道",
  "agent.chat.message": "对话消息",
  "agent.chat.session.delete": "删除对话会话",
  // 渠道
  "channel.create": "新建渠道",
  "channel.update": "编辑渠道",
  "channel.delete": "删除渠道",
  "channel.bind": "绑定渠道",
  "channel.unbind": "解绑渠道",
  "channel.probe": "渠道连通性探测",
  // 技能
  "skill.create": "新建技能",
  "skill.update": "编辑技能",
  "skill.delete": "删除技能",
  "skill.body.generate": "生成技能内容",
  // 员工模板（ADR-018）
  "agent-template.create": "新建员工模板",
  "agent-template.update": "编辑员工模板",
  "agent-template.delete": "删除员工模板",
  "agent-template.restore": "恢复员工模板",
  // 历史遗留（当前代码已不写，仅为兼容旧台账记录）
  UPLOAD: "上传",
  UPDATE: "更新",
  CREATE_CATEGORY: "新增分类",
  KB_IMPORT: "知识库导入",
};

const STATUS_LABEL: Record<string, string> = { success: "成功", ok: "成功", failed: "失败", error: "失败" };
const ROLE_LABEL: Record<string, string> = { employee: "员工", admin: "管理员" };

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

// 操作人：后端有的写 { id, name }，有的直接写字符串 platformUserId，两种都兜住。
// #29/#73：缺 operator 的历史日志（本次「operator 必填」改造前写入）标注「(历史·未落操作人)」，
// 不回填伪造——新日志必带 operator，空值只可能是历史条目。
export function operatorName(entry: any): string {
  const op = entry?.details?.operator;
  const name = typeof op === "string" ? op : op?.name;
  return name || "(历史·未落操作人)";
}

// 详情摘要（不含文档编号/版本/分类——CSV 中这三项已有独立列，避免重复）。
export function detailExtra(entry: any): string {
  const d = entry?.details;
  if (!d) return "";
  const parts: string[] = [];
  if (typeof d.role === "string") parts.push(`角色 ${ROLE_LABEL[d.role] ?? d.role}`);
  if (typeof d.type === "string") parts.push(`类型 ${d.type}`);
  if (typeof d.name === "string" && d.name !== entry.file) parts.push(String(d.name));
  if (d.account_id) parts.push(`账号 ${d.account_id}`);
  if (typeof d.status === "string") parts.push(STATUS_LABEL[d.status] ?? d.status);
  if (d.reason) parts.push(String(d.reason));
  if (d.source_format) parts.push(String(d.source_format));
  return parts.join(" · ");
}
