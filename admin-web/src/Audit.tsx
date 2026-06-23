// 审计页（#44 vanilla→React，脱离 ProTable）。横切设施：所有管理写操作的统一台账。
// 后端 `auditRouter`（GET /audit-log、/audit-log/export）逻辑不变；前端用 antd Table + 手动服务端分页。
//
// 「对象 / 详情」展示设计（fix/0623 #71）：
//  - 后端 `appendAuditLog` 的 `file` 字段是一锅大杂烩——有时是文件名（IMPORT）、有时是 agentId、
//    有时是 collectionId、有时是字面量（"knowledge.json" / "agent-profile" / "all"）。
//    直接渲染 `r.file` 会让人完全摸不到头脑。
//  - 这里按 action 分发 `subjectRender`，把每个动作的 file/details 翻成「[类别 Tag] 主显示名 · 短 ID」。
//  - 详情列则去掉与对象列重复的字段（name / agent_id 等），只列动作特有的关键信息（角色 / 技能差集
//    / 渠道类型 / 引用关系等），让一行看一眼就知道发生了什么。
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button, DatePicker, Input, Select, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { auditExportUrl, fetchAuditLog, type AuditEntry, type AuditFilters } from "./api";
import { PageTopbar, TableCard } from "./shell";

// 动作 → 中文标签 + 配色。覆盖后端 appendAuditLog 写入的全部动作（知识库大写动作 +
// 数字员工/渠道/技能/员工模板点分动作）。`legacy` 标记的是当前代码已不再写、但历史 audit-log.jsonl
// 仍可能存在的旧动作，保留映射避免老记录退回英文；`legacy`/失败态不进筛选下拉，避免列表臃肿。
const ACTION_META: Record<string, { label: string; color: string; legacy?: boolean }> = {
  // —— 知识库 / 文档 ——
  IMPORT: { label: "知识库导入", color: "cyan" },
  DELETE: { label: "删除文档", color: "red" },
  CONFIG_KNOWLEDGE: { label: "知识库配置", color: "geekblue" },
  CREATE_KB: { label: "新建知识库", color: "green" },
  CREATE_KB_FAILED: { label: "新建知识库（失败）", color: "volcano", legacy: true },
  BIND_KB: { label: "绑定知识库", color: "purple" },
  BIND_KB_FAILED: { label: "绑定知识库（失败）", color: "volcano", legacy: true },
  // —— 数字员工 ——
  "agent.create": { label: "创建数字员工", color: "green" },
  "agent.update": { label: "编辑数字员工", color: "gold" },
  "agent.delete": { label: "删除数字员工", color: "red" },
  "agent.profile.generate": { label: "生成员工档案", color: "geekblue" },
  "agent.skill.update": { label: "配置员工技能", color: "cyan" },
  "agent.channel.bind": { label: "员工绑定渠道", color: "purple" },
  "agent.channel.unbind": { label: "员工解绑渠道", color: "volcano" },
  "agent.chat.message": { label: "对话消息", color: "default" },
  "agent.chat.session.delete": { label: "删除对话会话", color: "red" },
  // —— 渠道 ——
  "channel.create": { label: "新建渠道", color: "green" },
  "channel.update": { label: "编辑渠道", color: "gold" },
  "channel.delete": { label: "删除渠道", color: "red" },
  "channel.bind": { label: "绑定渠道", color: "purple" },
  "channel.unbind": { label: "解绑渠道", color: "volcano" },
  "channel.probe": { label: "渠道连通性探测", color: "default" },
  // —— 技能 ——
  "skill.create": { label: "新建技能", color: "green" },
  "skill.update": { label: "编辑技能", color: "gold" },
  "skill.delete": { label: "删除技能", color: "red" },
  "skill.body.generate": { label: "生成技能内容", color: "geekblue" },
  // —— 员工模板 (ADR-018) ——
  "agent-template.create": { label: "新建员工模板", color: "green" },
  "agent-template.update": { label: "编辑员工模板", color: "gold" },
  "agent-template.delete": { label: "删除员工模板", color: "red" },
  "agent-template.restore": { label: "恢复员工模板", color: "geekblue" },
  // —— 历史遗留（当前代码已不写，仅为兼容旧台账记录）——
  UPLOAD: { label: "上传", color: "blue", legacy: true },
  UPDATE: { label: "更新", color: "gold", legacy: true },
  CREATE_CATEGORY: { label: "新增分类", color: "geekblue", legacy: true },
  KB_IMPORT: { label: "知识库导入", color: "cyan", legacy: true },
};

const ACTION_OPTIONS = Object.entries(ACTION_META)
  .filter(([, m]) => !m.legacy)
  .map(([value, m]) => ({ value, label: m.label }));
const PAGE_SIZE = 50;

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

// 长 ID（collectionId / sessionId 等）只取首尾几位，正文里看一眼能辨认即可。
function shortId(s: string | undefined | null, head = 6, tail = 4): string {
  const v = String(s ?? "");
  if (v.length <= head + tail + 1) return v;
  return `${v.slice(0, head)}…${v.slice(-tail)}`;
}

function toStr(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

// 操作人：后端有的写 { id, name }，有的直接写字符串 platformUserId，两种都兜住。
// operator 必填改造前的历史日志会丢操作人，统一标「(历史·未落操作人)」，不伪造来源。
function operatorName(r: AuditEntry): string {
  const op = r.details?.operator as { id?: string; name?: string } | string | undefined;
  if (typeof op === "string") return op || "(历史·未落操作人)";
  // fix/0623：结构化 { id, name }——优先人类可读 name（飞书/钉钉真名、demo「比赛访客」），退化到短 id。
  return op?.name || (op?.id ? shortId(op.id) : "") || "(历史·未落操作人)";
}

// 把每个动作的 file/details 翻译成「[类别 Tag] 主显示名 · 次要短 ID」。
// 主显示名优先取人类可读字段（name / 文件名），次要短 ID 仅在与主名不同且能辅助辨认时附上。
function subjectRender(r: AuditEntry): ReactNode {
  const d = (r.details ?? {}) as Record<string, unknown>;
  const file = toStr(r.file);
  const a = r.action;

  // —— 数字员工 ——
  if (a === "agent.profile.generate") {
    // file 是字面量 "agent-profile"，对用户没意义，直接显示动作语义。
    const fields = Array.isArray(d.fields) ? (d.fields as string[]).length : 0;
    return (
      <span>
        <Tag color="processing">员工档案</Tag>AI 起草{fields ? `（${fields} 字段）` : ""}
      </span>
    );
  }
  if (a.startsWith("agent.")) {
    // 其余 agent.* 的 file 一律是 agentId（agent.create/update/delete/channel.bind/skill.update/chat.*）。
    const agentId = toStr(d.agent_id) || file;
    const name = toStr(d.name);
    return (
      <span>
        <Tag color="blue">员工</Tag>
        {name || agentId}
        {name && agentId && name !== agentId && (
          <Typography.Text type="secondary"> · {agentId}</Typography.Text>
        )}
      </span>
    );
  }

  // —— 员工模板 ——
  if (a.startsWith("agent-template.")) {
    const tplId = toStr(d.id) || file;
    const name = toStr(d.name);
    return (
      <span>
        <Tag color="cyan">模板</Tag>
        {name || tplId}
        {name && tplId && name !== tplId && (
          <Typography.Text type="secondary"> · {tplId}</Typography.Text>
        )}
      </span>
    );
  }

  // —— 渠道 ——
  if (a.startsWith("channel.")) {
    if (a === "channel.probe" && file === "all") {
      return (
        <span>
          <Tag color="default">渠道</Tag>全部渠道
        </span>
      );
    }
    const type = CHANNEL_TYPE_LABEL[toStr(d.type)] || "渠道";
    return (
      <span>
        <Tag color="purple">{type}</Tag>
        {toStr(d.id) || file || "—"}
      </span>
    );
  }

  // —— 技能 ——
  if (a.startsWith("skill.")) {
    const name = toStr(d.name) || file;
    return (
      <span>
        <Tag color="gold">技能</Tag>
        {name || "—"}
      </span>
    );
  }

  // —— 知识库 / 文档 ——
  if (a === "IMPORT") {
    return (
      <span>
        <Tag color="cyan">文档</Tag>
        {file || "—"}
      </span>
    );
  }
  if (a === "DELETE") {
    // file 是 FastGPT collectionId（一长串），靠 details.doc_id / name 找人类可读名。
    const docId = toStr(d.doc_id);
    const name = toStr(d.name);
    const display = name || docId || (file ? shortId(file) : "—");
    return (
      <span>
        <Tag color="red">文档</Tag>
        {display}
        {file && display !== file && (
          <Typography.Text type="secondary"> · {shortId(file)}</Typography.Text>
        )}
      </span>
    );
  }
  if (a === "CONFIG_KNOWLEDGE") {
    return (
      <span>
        <Tag color="geekblue">知识库</Tag>平台连接配置
      </span>
    );
  }
  if (a === "CREATE_KB" || a === "CREATE_KB_FAILED") {
    const name = toStr(d.name);
    return (
      <span>
        <Tag color="green">知识库</Tag>
        {name || file}
        {name && file && name !== file && (
          <Typography.Text type="secondary"> · {file}</Typography.Text>
        )}
      </span>
    );
  }
  if (a === "BIND_KB" || a === "BIND_KB_FAILED") {
    const bases = Array.isArray(d.bases) ? (d.bases as { id?: string }[]) : [];
    return (
      <span>
        <Tag color="purple">知识库</Tag>绑定关系变更
        {bases.length > 0 && (
          <Typography.Text type="secondary"> · {bases.length} 个库</Typography.Text>
        )}
      </span>
    );
  }

  // —— 历史遗留 / 未知动作的兜底 ——
  return file || "—";
}

// 详情：动作特有的关键字段（已被对象列消费的不再重复）。每段用 `·` 分隔，缺失即省略。
function detailRender(r: AuditEntry): ReactNode {
  const d = r.details as Record<string, unknown> | undefined;
  if (!d) return "—";
  const a = r.action;
  const parts: string[] = [];

  // 状态（成功/失败/去重复用）尽量靠前——一眼看到出错与否最关键。
  const statusKey = toStr(d.status);
  if (statusKey) parts.push(STATUS_LABEL[statusKey] ?? statusKey);
  // success: true / false 这种布尔状态（agent.profile.generate / skill.body.generate）也归一。
  if (typeof d.success === "boolean") parts.push(d.success ? "成功" : "失败");

  // —— 各动作的特征字段 ——
  if (a === "IMPORT" || a === "DELETE") {
    if (d.doc_id) parts.push(`编号 ${d.doc_id}`);
    if (d.version) parts.push(`版本 ${d.version}`);
    if (d.category) parts.push(`分类 ${d.category}`);
    if (d.kbId) parts.push(`库 ${toStr(d.kbId)}`);
  } else if (a === "agent.create" || a === "agent.update") {
    if (typeof d.role === "string") parts.push(`角色 ${ROLE_LABEL[d.role] ?? d.role}`);
    if (Array.isArray(d.skills)) parts.push(`技能 ${(d.skills as string[]).length}`);
  } else if (a === "agent.skill.update") {
    // 显示新增/移除的具体技能，让审计能复现「这次到底动了什么」。
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
    if (d.session_id) parts.push(`会话 ${shortId(toStr(d.session_id))}`);
    if (typeof d.message_length === "number") parts.push(`${d.message_length} 字`);
    if (typeof d.duration_ms === "number") parts.push(`${d.duration_ms} ms`);
    if (d.code) parts.push(`错误码 ${toStr(d.code)}`);
  } else if (a === "agent.chat.session.delete") {
    if (d.session_id) parts.push(`会话 ${shortId(toStr(d.session_id))}`);
  } else if (a === "agent.profile.generate") {
    const fields = Array.isArray(d.fields) ? (d.fields as string[]) : [];
    if (fields.length) parts.push(`字段 ${fields.join("/")}`);
    if (typeof d.duration_ms === "number") parts.push(`${d.duration_ms} ms`);
  } else if (a === "channel.create" || a === "channel.update" || a === "channel.delete") {
    // 对象列已含 type+id；这里只补充 mode 等少见字段。
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

  // 失败原因（reason / applyMessage）放最后，长度截断避免撑爆列。
  const reason = toStr(d.reason) || toStr(d.applyMessage);
  if (reason) parts.push(reason.length > 60 ? `${reason.slice(0, 60)}…` : reason);

  return parts.length ? parts.join(" · ") : "—";
}

export default function Audit() {
  const [filters, setFilters] = useState<AuditFilters>({});
  const [data, setData] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (f: AuditFilters, p: number) => {
    setLoading(true);
    try {
      const res = await fetchAuditLog(f, p, PAGE_SIZE);
      setData(res.logs);
      setTotal(res.total);
    } catch {
      setData([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  // 筛选变化回到第 1 页并重载；分页变化只重载。
  useEffect(() => { void load(filters, page); }, [filters, page, load]);

  const columns: ColumnsType<AuditEntry> = [
    {
      title: "时间",
      dataIndex: "timestamp",
      width: 170,
      render: (_, r) => (
        <span style={{ fontFamily: '"SF Mono", Menlo, monospace' }}>
          {dayjs(r.timestamp).format("YYYY-MM-DD HH:mm:ss")}
        </span>
      ),
    },
    {
      title: "动作",
      dataIndex: "action",
      width: 140,
      render: (_, r) => {
        const m = ACTION_META[r.action];
        return <Tag color={m?.color}>{m?.label ?? r.action}</Tag>;
      },
    },
    { title: "对象", dataIndex: "file", width: 260, ellipsis: true, render: (_, r) => subjectRender(r) },
    { title: "操作人", width: 120, ellipsis: true, render: (_, r) => operatorName(r) },
    { title: "详情", ellipsis: true, render: (_, r) => detailRender(r) },
  ];

  return (
    <>
      <PageTopbar
        title="审计台账"
        right={
          <>
            <Select
              allowClear
              placeholder="动作"
              style={{ width: 140 }}
              options={ACTION_OPTIONS}
              onChange={(action) => { setFilters((f) => ({ ...f, action })); setPage(1); }}
            />
            <Input.Search
              allowClear
              placeholder="文档编号"
              style={{ width: 150 }}
              onSearch={(doc_id) => { setFilters((f) => ({ ...f, doc_id: doc_id || undefined })); setPage(1); }}
            />
            <DatePicker.RangePicker
              onChange={(range) => {
                setFilters((f) => ({
                  ...f,
                  from: range?.[0] ? range[0].format("YYYY-MM-DD") : undefined,
                  to: range?.[1] ? range[1].format("YYYY-MM-DD") : undefined,
                }));
                setPage(1);
              }}
            />
            <Button shape="round" icon={<ReloadOutlined />} onClick={() => void load(filters, page)} />
            <Button
              shape="round"
              icon={<DownloadOutlined />}
              href={auditExportUrl(filters)}
              target="_blank"
            >
              导出 CSV
            </Button>
          </>
        }
      />
      <TableCard>
        <Table<AuditEntry>
          rowKey={(r) => `${r.timestamp}-${r.action}-${r.file}`}
          loading={loading}
          dataSource={data}
          columns={columns}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total,
            showSizeChanger: false,
            onChange: (p) => setPage(p),
            showTotal: (t) => `总共 ${t} 条`,
          }}
          onChange={(pag) => setPage(pag.current ?? 1)}
          scroll={{ x: 1000 }}
        />
      </TableCard>
    </>
  );
}
