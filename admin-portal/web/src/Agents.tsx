// 数字员工列表（ProTable）+ 新建入口。
import { useEffect, useRef, useState } from "react";
import { Button, Space, Tag } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { ProTable, type ActionType, type ProColumns } from "@ant-design/pro-components";
import {
  fetchAgents,
  fetchChannels,
  fetchSkills,
  type AgentRow,
  type ChannelsInfo,
  type Skill,
} from "./api";
import CreateAgentWizard from "./CreateAgentWizard";

const ROLE_TAG: Record<string, { color: string; label: string }> = {
  employee: { color: "blue", label: "员工面（只读）" },
  admin: { color: "red", label: "管理面（可写）" },
};

export default function Agents() {
  const actionRef = useRef<ActionType>();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [channels, setChannels] = useState<ChannelsInfo | null>(null);

  useEffect(() => {
    fetchSkills().then(setSkills).catch(() => {});
    fetchChannels().then(setChannels).catch(() => {});
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
      render: (_, r) => <Tag color={ROLE_TAG[r.role]?.color}>{ROLE_TAG[r.role]?.label || r.role}</Tag>,
    },
    {
      title: "技能",
      dataIndex: "skills",
      render: (_, r) => (
        <Space wrap>
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
          {r.channels.map((c) => (
            <Tag key={`${c.domain}/${c.accountId}`} color="geekblue">
              {c.domain}/{c.accountId}
            </Tag>
          ))}
        </Space>
      ),
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
            icon={<PlusOutlined />}
            disabled={!channels}
            onClick={() => setWizardOpen(true)}
          >
            招募数字员工
          </Button>,
        ]}
      />
      {channels && (
        <CreateAgentWizard
          open={wizardOpen}
          onClose={() => setWizardOpen(false)}
          onCreated={() => {
            setWizardOpen(false);
            actionRef.current?.reload();
          }}
          skills={skills}
          channels={channels}
        />
      )}
    </>
  );
}
