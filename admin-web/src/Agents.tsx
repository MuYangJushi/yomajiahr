// 数字员工列表（antd Table + PageTopbar + TableCard，脱离 ProTable）+ 新建入口。
import { useCallback, useEffect, useState } from "react";
import { Button, Modal, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  fetchAgents,
  fetchChannels,
  deleteAgent,
  type AgentRow,
  type ChannelsInfo,
} from "./api";
import CreateAgentWizard from "./CreateAgentWizard";
import EditAgentModal from "./EditAgentModal";
import { PageTopbar, TableCard } from "./shell";

const ROLE_TAG: Record<string, { color: string; label: string }> = {
  employee: { color: "blue", label: "员工" },
  admin: { color: "gold", label: "管理员" },
};
const DOMAIN_LABEL: Record<string, string> = { feishu: "飞书", "dingtalk-connector": "钉钉" };

// 空状态：design tokens v0.2 的 grad-strip + 标题 + 副文案。
function AgentEmpty() {
  return (
    <div style={{ padding: "64px 0", textAlign: "center" }}>
      <div
        style={{
          width: 48, height: 48, borderRadius: 12, margin: "0 auto 16px",
          background: "linear-gradient(135deg, #0a84ff, #0071e3)",
        }}
      />
      <div style={{ fontSize: 14, color: "#6e6e73", marginBottom: 4 }}>还没有数字员工</div>
      <div style={{ fontSize: 13, color: "#aeaeb2" }}>点击右上角「招募数字员工」创建第一个</div>
    </div>
  );
}

export default function Agents() {
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentRow | null>(null);
  const [channels, setChannels] = useState<ChannelsInfo | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchAgents());
    } catch (err: any) {
      message.error(err?.response?.data?.error || "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const refreshChannels = () => fetchChannels().then(setChannels).catch(() => {});
    refreshChannels();
    const timer = window.setInterval(refreshChannels, 5000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const columns: ColumnsType<AgentRow> = [
    {
      title: "名称",
      dataIndex: "name",
      render: (_, r) => (
        <Space>
          {r.name}
          {r.default && <Tag color="gold">默认</Tag>}
        </Space>
      ),
    },
    {
      title: "ID",
      dataIndex: "id",
      render: (v: string) => <Typography.Text copyable style={{ color: "#48484a" }}>{v}</Typography.Text>,
    },
    {
      title: "岗位",
      dataIndex: "role",
      render: (_, r) => <Space><span>{r.profile?.jobTitle || "未填写岗位"}</span><Tag color={ROLE_TAG[r.role]?.color}>{ROLE_TAG[r.role]?.label || r.role}</Tag></Space>,
    },
    {
      title: "技能",
      dataIndex: "skills",
      render: (_, r) => (
        <Space wrap>
          {r.derived.pendingSkills && <Tag color="warning">待配置技能</Tag>}
          {r.skills.map((s) => (
            <Tag key={s}>{s}</Tag>
          ))}
        </Space>
      ),
    },
    {
      title: "渠道",
      dataIndex: "channels",
      render: (_, r) => (
        <Space wrap>
          {r.derived.pendingChannels && <Tag color="warning">待接入渠道</Tag>}
          {r.channels.map((c) => (
            <Tag key={`${c.domain}/${c.accountId}`} color="geekblue">
              {DOMAIN_LABEL[c.domain] || c.domain}/{c.accountId}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: "操作",
      width: 140,
      render: (_, r) => {
        // 空白起步后无永久内置员工；仅默认员工受保护（当前无默认员工，等于全部可删）。
        const protectedAgent = r.default;
        return (
          <Space size="small">
            <Button
              type="link"
              size="small"
              icon={<EditOutlined />}
              onClick={() => setEditingAgent(r)}
            >
              修改
            </Button>
            <Button
              type="link"
              size="small"
              danger
              icon={<DeleteOutlined />}
              disabled={protectedAgent}
              title={protectedAgent ? "默认数字员工不能删除" : undefined}
              onClick={() => {
                Modal.confirm({
                  title: `删除数字员工“${r.name}”？`,
                  content: "将删除其 workspace 和知识库绑定，并释放渠道账号供其他数字员工复用。此操作上线后立即生效。",
                  okText: "确认删除",
                  okButtonProps: { danger: true },
                  cancelText: "取消",
                  async onOk() {
                    try {
                      await deleteAgent(r.id);
                      message.success("数字员工已删除");
                      void reload();
                      fetchChannels().then(setChannels).catch(() => {});
                    } catch (err: any) {
                      message.error(err?.response?.data?.error || err.message || "删除失败");
                      throw err;
                    }
                  },
                });
              }}
            >
              删除
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <>
      <PageTopbar
        title="数字员工"
        right={
          <>
            <Button shape="round" icon={<ReloadOutlined />} onClick={() => void reload()} />
            <Button
              type="primary"
              shape="round"
              icon={<PlusOutlined />}
              disabled={!channels}
              onClick={() => setWizardOpen(true)}
            >
              招募数字员工
            </Button>
          </>
        }
      />
      <TableCard>
        <Table<AgentRow>
          rowKey="id"
          loading={loading}
          dataSource={rows}
          columns={columns}
          pagination={false}
          locale={{ emptyText: <AgentEmpty /> }}
        />
      </TableCard>
      <CreateAgentWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={() => {
          setWizardOpen(false);
          void reload();
        }}
      />
      <EditAgentModal
        agent={editingAgent}
        onClose={() => setEditingAgent(null)}
        onUpdated={() => {
          setEditingAgent(null);
          void reload();
          fetchChannels().then(setChannels).catch(() => {});
        }}
      />
    </>
  );
}
