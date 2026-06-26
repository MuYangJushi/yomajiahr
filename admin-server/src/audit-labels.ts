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

const CHANNEL_TYPE_LABEL: Record<string, string> = {
  feishu: "飞书",
  dingtalk: "钉钉",
  "dingtalk-connector": "钉钉",
};
const STATUS_LABEL: Record<string, string> = {
  success: "成功",
  ok: "成功",
  failed: "失败",
  error: "失败",
  deduped: "去重复用",
};
const ROLE_LABEL: Record<string, string> = { employee: "员工", admin: "管理员" };

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

// 操作人：后端有的写 { id, name }，有的直接写字符串 platformUserId，两种都兜住。
// #29/#73：缺 operator 的历史日志（本次「operator 必填」改造前写入）标注「(历史·未落操作人)」，
// 不回填伪造——新日志必带 operator，空值只可能是历史条目。
export function operatorName(entry: any): string {
  const op = entry?.details?.operator;
  if (typeof op === "string") return op || "(历史·未落操作人)";
  // fix/0623：结构化 { id, name }——优先人类可读 name，退化到短 id（仍是真实操作人，不可标历史）。
  return op?.name || (op?.id ? shortId(op.id) : "") || "(历史·未落操作人)";
}

function shortId(s: unknown, head = 6, tail = 4): string {
  const v = typeof s === "string" ? s : s == null ? "" : String(s);
  if (v.length <= head + tail + 1) return v;
  return `${v.slice(0, head)}…${v.slice(-tail)}`;
}

// 「对象」CSV 列：和前端 Audit.tsx 的 subjectRender 同步——把动作 + file/details 翻成「[类别] 主名 · 短 ID」。
// 后端 file 字段一锅杂烩（agentId / collectionId / 字面量 "knowledge.json" 等），CSV 不翻译时用户和台账都看不懂。
export function subjectText(entry: any): string {
  const d = (entry?.details ?? {}) as Record<string, unknown>;
  const file = typeof entry?.file === "string" ? entry.file : "";
  const a = String(entry?.action ?? "");
  const toStr = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

  if (a === "agent.profile.generate") {
    const fields = Array.isArray(d.fields) ? (d.fields as unknown[]).length : 0;
    return `[员工档案] AI 起草${fields ? `（${fields} 字段）` : ""}`;
  }
  if (a.startsWith("agent.")) {
    const agentId = toStr(d.agent_id) || file;
    const name = toStr(d.name);
    return `[员工] ${name || agentId}${name && agentId && name !== agentId ? ` · ${agentId}` : ""}`;
  }
  if (a.startsWith("agent-template.")) {
    const tplId = toStr(d.id) || file;
    const name = toStr(d.name);
    return `[模板] ${name || tplId}${name && tplId && name !== tplId ? ` · ${tplId}` : ""}`;
  }
  if (a.startsWith("channel.")) {
    if (a === "channel.probe" && file === "all") return "[渠道] 全部渠道";
    const type = CHANNEL_TYPE_LABEL[toStr(d.type)] || "渠道";
    return `[${type}] ${toStr(d.id) || file || "—"}`;
  }
  if (a.startsWith("skill.")) {
    return `[技能] ${toStr(d.name) || file || "—"}`;
  }
  if (a === "IMPORT") return `[文档] ${file || "—"}`;
  if (a === "DELETE") {
    const name = toStr(d.name);
    const docId = toStr(d.doc_id);
    const display = name || docId || (file ? shortId(file) : "—");
    return `[文档] ${display}${file && display !== file ? ` · ${shortId(file)}` : ""}`;
  }
  if (a === "CONFIG_KNOWLEDGE") return "[知识库] 平台连接配置";
  if (a === "CREATE_KB" || a === "CREATE_KB_FAILED") {
    const name = toStr(d.name);
    return `[知识库] ${name || file}${name && file && name !== file ? ` · ${file}` : ""}`;
  }
  if (a === "BIND_KB" || a === "BIND_KB_FAILED") {
    const bases = Array.isArray(d.bases) ? (d.bases as unknown[]).length : 0;
    return `[知识库] 绑定关系变更${bases ? ` · ${bases} 个库` : ""}`;
  }
  return file || "—";
}

// 详情：和前端 detailRender 同步——动作特有的关键字段，缺失即省略；对象列已含的字段不重复。
export function detailExtra(entry: any): string {
  const d = entry?.details as Record<string, unknown> | undefined;
  if (!d) return "";
  const a = String(entry?.action ?? "");
  const parts: string[] = [];
  const toStr = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

  const statusKey = toStr(d.status);
  if (statusKey) parts.push(STATUS_LABEL[statusKey] ?? statusKey);
  if (typeof d.success === "boolean") parts.push(d.success ? "成功" : "失败");

  if (a === "IMPORT" || a === "DELETE") {
    if (d.doc_id) parts.push(`编号 ${d.doc_id}`);
    if (d.version) parts.push(`版本 ${d.version}`);
    if (d.category) parts.push(`分类 ${d.category}`);
    if (d.kbId) parts.push(`库 ${toStr(d.kbId)}`);
  } else if (a === "agent.create" || a === "agent.update") {
    if (typeof d.role === "string") parts.push(`角色 ${ROLE_LABEL[d.role] ?? d.role}`);
    if (Array.isArray(d.skills)) parts.push(`技能 ${(d.skills as unknown[]).length}`);
  } else if (a === "agent.skill.update") {
    const before = Array.isArray(d.before) ? (d.before as string[]) : [];
    const after = Array.isArray(d.after) ? (d.after as string[]) : [];
    const added = after.filter((s) => !before.includes(s));
    const removed = before.filter((s) => !after.includes(s));
    if (added.length) parts.push(`+ ${added.join(", ")}`);
    if (removed.length) parts.push(`− ${removed.join(", ")}`);
    if (!added.length && !removed.length) parts.push("无变化");
    if (Array.isArray(d.unmet) && (d.unmet as unknown[]).length > 0) {
      parts.push(`未满足依赖 ${(d.unmet as unknown[]).length}`);
    }
  } else if (a === "agent.channel.bind" || a === "agent.channel.unbind") {
    const ch = CHANNEL_TYPE_LABEL[toStr(d.domain)] || toStr(d.domain);
    if (ch) parts.push(ch);
    if (d.account_id) parts.push(`账号 ${d.account_id}`);
  } else if (a === "agent.chat.message") {
    if (d.session_id) parts.push(`会话 ${shortId(d.session_id)}`);
    if (typeof d.message_length === "number") parts.push(`${d.message_length} 字`);
    if (typeof d.duration_ms === "number") parts.push(`${d.duration_ms} ms`);
    if (d.code) parts.push(`错误码 ${toStr(d.code)}`);
  } else if (a === "agent.chat.session.delete") {
    if (d.session_id) parts.push(`会话 ${shortId(d.session_id)}`);
  } else if (a === "agent.profile.generate") {
    const fields = Array.isArray(d.fields) ? (d.fields as string[]) : [];
    if (fields.length) parts.push(`字段 ${fields.join("/")}`);
    if (typeof d.duration_ms === "number") parts.push(`${d.duration_ms} ms`);
  } else if (a === "channel.create" || a === "channel.update" || a === "channel.delete") {
    if (typeof d.mode === "string") parts.push(`模式 ${d.mode}`);
  } else if (a === "channel.bind" || a === "channel.unbind") {
    if (d.agent_id) parts.push(`员工 ${toStr(d.agent_id)}`);
  } else if (a === "channel.probe") {
    if (typeof d.type === "string") parts.push(`类型 ${CHANNEL_TYPE_LABEL[d.type] ?? d.type}`);
  } else if (a === "skill.create" || a === "skill.update") {
    if (typeof d.requiredRole === "string") parts.push(`需角色 ${ROLE_LABEL[d.requiredRole] ?? d.requiredRole}`);
    if (d.requiresKnowledge === true) parts.push("需绑库");
    if (typeof d.description === "string" && d.description) parts.push(d.description.slice(0, 40));
  } else if (a === "skill.delete") {
    const refs = Array.isArray(d.referencedBy) ? (d.referencedBy as string[]) : [];
    if (refs.length) parts.push(`被 ${refs.length} 个员工引用`);
  } else if (a === "skill.body.generate") {
    if (typeof d.duration_ms === "number") parts.push(`${d.duration_ms} ms`);
  } else if (a.startsWith("agent-template.")) {
    if (typeof d.role === "string") parts.push(`角色 ${ROLE_LABEL[d.role] ?? d.role}`);
    if (typeof d.department === "string" && d.department) parts.push(`部门 ${d.department}`);
    if (typeof d.kind === "string") parts.push(d.kind === "hidden" ? "软隐藏" : "已删除");
  } else if (a === "CONFIG_KNOWLEDGE") {
    const keys = Array.isArray(d.updatedKeys) ? (d.updatedKeys as string[]) : [];
    if (keys.length) parts.push(`更新键 ${keys.join(", ")}`);
  } else if (a === "CREATE_KB" || a === "CREATE_KB_FAILED") {
    if (d.externalKbId) parts.push(`外部库 ${toStr(d.externalKbId)}`);
    const bound = Array.isArray(d.boundAgents) ? (d.boundAgents as string[]) : [];
    if (bound.length) parts.push(`绑 ${bound.length} 员工`);
  } else if (a === "BIND_KB" || a === "BIND_KB_FAILED") {
    const revoked = Array.isArray(d.revokedAgentIds) ? (d.revokedAgentIds as string[]) : [];
    if (revoked.length) parts.push(`解绑 ${revoked.length}`);
    if (typeof d.applyMode === "string") parts.push(`apply ${d.applyMode}`);
  }

  const reason = toStr(d.reason) || toStr(d.applyMessage);
  if (reason) parts.push(reason.length > 60 ? `${reason.slice(0, 60)}…` : reason);

  return parts.join(" · ");
}
