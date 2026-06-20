// 审计页（#44 vanilla→React，脱离 ProTable）。横切设施：所有管理写操作的统一台账。
// 后端 `auditRouter`（GET /audit-log、/audit-log/export）逻辑不变；前端用 antd Table + 手动服务端分页。
import { useCallback, useEffect, useState } from "react";
import { Button, DatePicker, Input, Select, Space, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { auditExportUrl, fetchAuditLog, type AuditEntry, type AuditFilters } from "./api";
import { PageTopbar, TableCard } from "./shell";

// 动作 → 中文标签 + 配色（含 #40 起新增的 KB_IMPORT、未来 CREATE_KB/BIND_KB）。
const ACTION_META: Record<string, { label: string; color: string }> = {
  UPLOAD: { label: "上传", color: "blue" },
  DELETE: { label: "删除", color: "red" },
  UPDATE: { label: "更新", color: "gold" },
  CREATE_CATEGORY: { label: "新增分类", color: "geekblue" },
  KB_IMPORT: { label: "知识库导入", color: "cyan" },
  CREATE_KB: { label: "新建知识库", color: "green" },
  BIND_KB: { label: "绑定知识库", color: "purple" },
};

const ACTION_OPTIONS = Object.entries(ACTION_META).map(([value, m]) => ({ value, label: m.label }));
const PAGE_SIZE = 50;

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
      width: 120,
      render: (_, r) => {
        const m = ACTION_META[r.action];
        return <Tag color={m?.color}>{m?.label ?? r.action}</Tag>;
      },
    },
    { title: "文件", dataIndex: "file", ellipsis: true },
    { title: "文档编号", width: 130, render: (_, r) => r.details?.doc_id || "—" },
    { title: "版本", width: 80, render: (_, r) => r.details?.version || "—" },
    { title: "分类", width: 110, render: (_, r) => r.details?.category || "—" },
    { title: "操作人", width: 110, render: (_, r) => r.details?.operator?.name || "—" },
    {
      title: "备注",
      ellipsis: true,
      render: (_, r) => r.details?.reason || r.details?.status || r.details?.source_format || "—",
    },
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
        />
      </TableCard>
    </>
  );
}
