import {
  ModalForm,
  ProFormDependency,
  ProFormRadio,
  ProFormSelect,
  ProFormText,
  ProFormTextArea,
} from "@ant-design/pro-components";
import { Alert, Divider, Space, Tag, message } from "antd";
import { updateAgent, type AgentRow, type ChannelsInfo, type Skill } from "./api";

interface Props {
  agent: AgentRow | null;
  skills: Skill[];
  channels: ChannelsInfo;
  onClose: () => void;
  onUpdated: () => void;
}

const DOMAIN_LABEL: Record<string, string> = {
  feishu: "飞书",
  "dingtalk-connector": "钉钉",
};

export default function EditAgentModal({ agent, skills, channels, onClose, onUpdated }: Props) {
  const connectedDomains = new Set(agent?.channels.map((channel) => channel.domain) || []);
  const availableDomains = channels.supported.filter((domain) => !connectedDomains.has(domain));
  return (
    <ModalForm
      key={agent?.id || "closed"}
      title={`修改数字员工：${agent?.name || ""}`}
      open={Boolean(agent)}
      initialValues={agent || undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      modalProps={{ destroyOnClose: true }}
      onFinish={async (values) => {
        if (!agent) return false;
        try {
          await updateAgent(agent.id, {
            name: values.name,
            role: values.role,
            persona: values.persona,
            skills: values.skills,
            addChannel: values.addChannelDomain
              ? {
                  domain: values.addChannelDomain,
                  accountId: values.addChannelAccountId || undefined,
                  credentials: {
                    clientId: values.addChannelClientId,
                    clientSecret: values.addChannelClientSecret,
                  },
                }
              : undefined,
          });
          message.success("数字员工已更新");
          onUpdated();
          return true;
        } catch (err: any) {
          message.error(err?.response?.data?.error || err.message || "更新失败");
          return false;
        }
      }}
    >
      <ProFormText name="id" label="ID" disabled />
      <ProFormText name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]} />
      <ProFormRadio.Group
        name="role"
        label="岗位"
        options={[
          { label: "员工面（只读）", value: "employee" },
          { label: "管理面（可写）", value: "admin" },
        ]}
        rules={[{ required: true }]}
      />
      <ProFormTextArea name="persona" label="人设" placeholder="一句话描述该数字员工的职责与风格" />
      <ProFormSelect
        name="skills"
        label="分配技能"
        mode="multiple"
        rules={[{ required: true, message: "至少分配一个技能" }]}
        options={skills.map((s) => ({ label: s.name, value: s.name, title: s.description }))}
      />
      <Divider orientation="left">渠道接入</Divider>
      <Space wrap style={{ marginBottom: 16 }}>
        {agent?.channels.map((channel) => (
          <Tag key={`${channel.domain}/${channel.accountId}`} color="geekblue">
            {DOMAIN_LABEL[channel.domain] || channel.domain}/{channel.accountId}
          </Tag>
        ))}
      </Space>
      {availableDomains.length === 0 ? (
        <Alert type="info" showIcon message="该数字员工已接入所有支持的渠道" />
      ) : (
        <>
          <ProFormSelect
            name="addChannelDomain"
            label="同时新增渠道（可选）"
            placeholder="不新增渠道"
            options={availableDomains.map((domain) => ({
              label: DOMAIN_LABEL[domain] || domain,
              value: domain,
            }))}
          />
          <ProFormDependency name={["addChannelDomain"]}>
            {({ addChannelDomain }) => addChannelDomain ? (
              <>
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="使用已有应用凭据接入；保存后将应用配置并验证渠道连接。"
                />
                <ProFormText
                  name="addChannelAccountId"
                  label="账号 ID"
                  tooltip="留空则使用数字员工 ID"
                  placeholder={agent?.id}
                />
                <ProFormText
                  name="addChannelClientId"
                  label={addChannelDomain === "feishu" ? "App ID" : "Client ID"}
                  rules={[{ required: true, message: "请输入应用 ID" }]}
                />
                <ProFormText.Password
                  name="addChannelClientSecret"
                  label={addChannelDomain === "feishu" ? "App Secret" : "Client Secret"}
                  rules={[{ required: true, message: "请输入应用密钥" }]}
                />
              </>
            ) : null}
          </ProFormDependency>
        </>
      )}
    </ModalForm>
  );
}
