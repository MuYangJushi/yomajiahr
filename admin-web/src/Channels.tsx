// 渠道管理（ADR-013 §渠道独立）：
//  - 账号资产按 type + id 列出
//  - 每条展示：displayName / 渠道 / 占用 agent / health 状态（探活缓存）
//  - 操作：探活（POST /probe）、删除（DELETE，仅无 binding）
//  - 不包含「绑定到数字员工」——绑定走「数字员工」页或 `/config/agents/:id/channels` 路由
import { useEffect, useState } from "react";
import { Button, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchChannelAssets, probeChannels, deleteChannelAsset, type ChannelAsset } from "./api";

const TYPE_LABEL: Record<string, string> = { feishu: "飞书", dingtalk: "钉钉" };

export default function Channels() {
  const [rows, setRows] = useState<ChannelAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [probing, setProbing] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      const { channels } = await fetchChannelAssets();
      setRows(channels);
    } catch (err: any) {
      message.error(err?.response?.data?.error || err.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function runProbe() {
    setProbing(true);
    try {
      await probeChannels();
      await reload();
      message.success("已探活");
    } catch (err: any) {
      message.error(err?.response?.data?.error || err.message || "探活失败");
    } finally {
      setProbing(false);
    }
  }

  useEffect(() => { void reload(); }, []);

  const columns: ColumnsType<ChannelAsset> = [
    { title: "账号 ID", dataIndex: "id", width: 200 },
    { title: "渠道", dataIndex: "type", width: 100, render: (t: string) => <Tag color="blue">{TYPE_LABEL[t] || t}</Tag> },
    { title: "显示名", dataIndex: "displayName" },
    {
      title: "健康",
      dataIndex: "health",
      width: 240,
      render: (h?: ChannelAsset["health"]) => h ? (
        <Space size={4}>
          <Tag color={h.ok ? "success" : "error"}>{h.ok ? "在线" : "异常"}</Tag>
          {!h.ok && h.lastError && <span style={{ color: "#999" }}>{h.lastError}</span>}
          <span style={{ color: "#bbb", fontSize: 12 }}>{new Date(h.updatedAt).toLocaleTimeString()}</span>
        </Space>
      ) : <Tag>未探活</Tag>,
    },
    {
      title: "操作",
      width: 120,
      render: (_, row) => (
        <Button
          danger
          size="small"
          onClick={async () => {
            if (!confirm(`删除账号 ${row.type}/${row.id}？仅当该账号无 binding 时允许。`)) return;
            try {
              await deleteChannelAsset(row.type, row.id);
              message.success("已删除");
              void reload();
            } catch (err: any) {
              message.error(err?.response?.data?.error || err.message || "删除失败");
            }
          }}
        >
          删除
        </Button>
      ),
    },
  ];

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>渠道管理</Typography.Title>
          <Typography.Text type="secondary">账号资产、占用、健康。账号的绑定/解绑请在「数字员工」详情页操作。</Typography.Text>
        </div>
        <Space>
          <Button loading={probing} onClick={runProbe}>探活</Button>
          <Button loading={loading} onClick={reload}>刷新</Button>
        </Space>
      </div>
      <Table<ChannelAsset>
        rowKey={(r) => `${r.type}/${r.id}`}
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
      />
    </>
  );
}
