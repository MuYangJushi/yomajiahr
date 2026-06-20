// 数字员工列表（ProTable）+ 新建入口。
import { useEffect, useRef, useState } from "react";
import { Button, Modal, Space, Tag, message } from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import { ProTable, type ActionType, type ProColumns } from "@ant-design/pro-components";
import {
  fetchAgents,
  fetchChannels,
  deleteAgent,
  type AgentRow,
  type ChannelsInfo,
} from "./api";
import CreateAgentWizard from "./CreateAgentWizard";
import EditAgentModal from "./EditAgentModal";

const ROLE_TAG: Record<string, { color: string; label: string }> = {
  employee: { color: "blue", label: "员工" },
  admin: { color: "red", label: "管理员" },
};
const DOMAIN_LABEL: Record<string, string> = { feishu: "飞书", "dingtalk-connector": "钉钉" };

export default function Agents() {
  const actionRef = useRef<ActionType>();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentRow | null>(null);
  const [channels, setChannels] = useState<ChannelsInfo | null>(null);

  useEffect(() => {
    const refreshChannels = () => fetchChannels().then(setChannels).catch(() => {});
    refreshChannels();
    const timer = window.setInterval(refreshChannels, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const columns: ProColumns<AgentRow>[] = [
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
    { title: "ID", dataIndex: "id", copyable: true },
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
      valueType: "option",
      render: (_, r) => {
        // 空白起步后无永久内置员工；仅默认员工受保护（当前无默认员工，等于全部可删）。
        const protectedAgent = r.default;
        return [
          <Button
            key="edit"
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => setEditingAgent(r)}
          >
            修改
          </Button>,
          <Button
            key="delete"
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
                    actionRef.current?.reload();
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
          </Button>,
        ];
      },
    },
  ];

  return (
    <>
      <ProTable<AgentRow>
        actionRef={actionRef}
        rowKey="id"
        headerTitle="数字员工"
        search={false}
        pagination={false}
        columns={columns}
        request={async () => {
          const data = await fetchAgents();
          return { data, success: true };
        }}
        toolBarRender={() => [
          <Button
            key="new"
            type="primary"
            shape="round"
            icon={<PlusOutlined />}
            disabled={!channels}
            onClick={() => setWizardOpen(true)}
          >
            招募数字员工
          </Button>,
        ]}
      />
      <CreateAgentWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={() => {
          setWizardOpen(false);
          actionRef.current?.reload();
        }}
      />
      <EditAgentModal
        agent={editingAgent}
        onClose={() => setEditingAgent(null)}
        onUpdated={() => {
          setEditingAgent(null);
          actionRef.current?.reload();
          fetchChannels().then(setChannels).catch(() => {});
        }}
      />
    </>
  );
}
