// 审计页（#44 vanilla→React）。横切设施：所有管理写操作的统一台账，独立一级菜单。
// 后端 `auditRouter`（GET /audit-log、/audit-log/export）逻辑不变，前端照 Agents/Knowledge 模式用 antd 重写。
import { useEffect, useRef, useState } from "react";
import { Button, DatePicker, Input, Select, Space, Tag } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { ProTable, type ActionType, type ProColumns } from "@ant-design/pro-components";
import dayjs from "dayjs";
import { auditExportUrl, fetchAuditLog, type AuditEntry, type AuditFilters } from "./api";

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

export default function Audit() {
  const actionRef = useRef<ActionType>();
  const [filters, setFilters] = useState<AuditFilters>({});

  useEffect(() => {
    actionRef.current?.reload();
  }, [filters]);

  const columns: ProColumns<AuditEntry>[] = [
    {
      title: "时间",
      dataIndex: "timestamp",
      width: 180,
      render: (_, r) => dayjs(r.timestamp).format("YYYY-MM-DD HH:mm:ss"),
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
    <ProTable<AuditEntry>
      headerTitle="审计台账"
      actionRef={actionRef}
      rowKey={(r) => `${r.timestamp}-${r.action}-${r.file}`}
      columns={columns}
      search={false}
      options={{ reload: true, density: false, setting: false }}
      toolbar={{
        filter: (
          <Space wrap>
            <Select
              allowClear
              placeholder="动作"
              style={{ width: 140 }}
              options={ACTION_OPTIONS}
              onChange={(action) => {
                setFilters((f) => ({ ...f, action }));
              }}
            />
            <Input.Search
              allowClear
              placeholder="文档编号"
              style={{ width: 160 }}
              onSearch={(doc_id) => {
                setFilters((f) => ({ ...f, doc_id: doc_id || undefined }));
              }}
            />
            <DatePicker.RangePicker
              onChange={(range) => {
                setFilters((f) => ({
                  ...f,
                  from: range?.[0] ? range[0].format("YYYY-MM-DD") : undefined,
                  to: range?.[1] ? range[1].format("YYYY-MM-DD") : undefined,
                }));
              }}
            />
          </Space>
        ),
        actions: [
          <Button
            key="export"
            icon={<DownloadOutlined />}
            href={auditExportUrl(filters)}
            target="_blank"
          >
            导出 CSV
          </Button>,
        ],
      }}
      request={async (params) => {
        const data = await fetchAuditLog(filters, params.current ?? 1, params.pageSize ?? 50);
        return { data: data.logs, total: data.total, success: true };
      }}
      pagination={{ pageSize: 50, showSizeChanger: false }}
    />
  );
}
