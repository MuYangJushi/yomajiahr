// 审计页（#44 vanilla→React，脱离 ProTable）。横切设施：所有管理写操作的统一台账。
// 后端 `auditRouter`（GET /audit-log、/audit-log/export）逻辑不变；前端用 antd Table + 手动服务端分页。
import { useCallback, useEffect, useState } from "react";
import { Button, DatePicker, Input, Select, Space, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { auditExportUrl, fetchAuditLog, type AuditEntry, type AuditFilters } from "./api";
import { PageTopbar, TableCard } from "./shell";

// 动作 → 中文标签 + 配色。覆盖后端 appendAuditLog 写入的全部动作（知识库大写动作 +
// 数字员工/渠道/技能点分动作）。`legacy` 标记的是当前代码已不再写、但历史 audit-log.jsonl
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

const STATUS_LABEL: Record<string, string> = { success: "成功", ok: "成功", failed: "失败", error: "失败" };
const ROLE_LABEL: Record<string, string> = { employee: "员工", admin: "管理员" };

// 操作人：后端有的写 { id, name }，有的直接写字符串 platformUserId，两种都兜住。
function operatorName(r: AuditEntry): string {
  const op = r.details?.operator as { name?: string } | string | undefined;
  if (!op) return "—";
  return (typeof op === "string" ? op : op.name) || "—";
}

// 详情：按优先级拼接当前动作实际带的关键字段，不同动作各取所需，缺失即省略。
function detailSummary(r: AuditEntry): string {
  const d = r.details;
  if (!d) return "—";
  const parts: string[] = [];
  if (d.doc_id) parts.push(`编号 ${d.doc_id}`);
  if (d.version) parts.push(`版本 ${d.version}`);
  if (d.category) parts.push(`分类 ${d.category}`);
  if (typeof d.role === "string") parts.push(`角色 ${ROLE_LABEL[d.role] ?? d.role}`);
  if (typeof d.type === "string") parts.push(`类型 ${d.type}`);
  if (typeof d.name === "string" && d.name !== r.file) parts.push(String(d.name));
  if (d.account_id) parts.push(`账号 ${d.account_id}`);
  if (typeof d.status === "string") parts.push(STATUS_LABEL[d.status] ?? d.status);
  if (d.reason) parts.push(String(d.reason));
  if (d.source_format) parts.push(String(d.source_format));
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
      width: 180,
      render: (_, r) => (
        <span style={{ fontFamily: '"SF Mono", Menlo, monospace' }}>
          {dayjs(r.timestamp).format("YYYY-MM-DD HH:mm:ss")}
        </span>
      ),
    },
    {
      title: "动作",
      dataIndex: "action",
      width: 150,
      render: (_, r) => {
        const m = ACTION_META[r.action];
        return <Tag color={m?.color}>{m?.label ?? r.action}</Tag>;
      },
    },
    { title: "对象", dataIndex: "file", width: 220, ellipsis: true, render: (_, r) => r.file || "—" },
    { title: "操作人", width: 120, render: (_, r) => operatorName(r) },
    { title: "详情", ellipsis: true, render: (_, r) => detailSummary(r) },
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
              style={{ width: 120 }}
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
          scroll={{ x: 900 }}
        />
      </TableCard>
    </>
  );
}
