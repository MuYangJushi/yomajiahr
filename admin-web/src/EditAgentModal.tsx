import { useEffect, useState } from "react";
import {
  ModalForm,
  ProFormDependency,
  ProFormRadio,
  ProFormSelect,
  ProFormText,
  ProFormTextArea,
} from "@ant-design/pro-components";
import { Alert, Collapse, Divider, Space, Tag, message } from "antd";
import {
  cancelAgentOnboarding,
  fetchAgentOnboarding,
  startAgentChannelOnboarding,
  updateAgent,
  type AgentRow,
  type ChannelsInfo,
  type OnboardingSession,
  type Skill,
} from "./api";
import { OnboardingProgress } from "./CreateAgentWizard";

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
  const [removedChannels, setRemovedChannels] = useState<AgentRow["channels"]>([]);
  const [session, setSession] = useState<OnboardingSession | null>(null);
  const connectedDomains = new Set(agent?.channels.filter((channel) => !removedChannels.some(
    (removed) => removed.domain === channel.domain && removed.accountId === channel.accountId,
  )).map((channel) => channel.domain) || []);
  const availableDomains = channels.supported.filter((domain) => !connectedDomains.has(domain));
  useEffect(() => {
    setRemovedChannels([]);
    setSession(null);
  }, [agent?.id]);
  useEffect(() => {
    if (!session || ["success", "failed", "expired", "cancelled"].includes(session.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await fetchAgentOnboarding(session.id);
        setSession(next);
        if (next.status === "success") {
          message.success("数字员工及新渠道已更新");
          onUpdated();
        }
      } catch (err: any) {
        setSession((current) => current ? { ...current, status: "failed", message: err?.response?.data?.error || "状态查询失败" } : current);
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [session?.id, session?.status]);
  async function closeModal() {
    if (session && !["success", "failed", "expired", "cancelled"].includes(session.status)) {
      await cancelAgentOnboarding(session.id).catch(() => {});
    }
    setSession(null);
    onClose();
  }
  return (
    <ModalForm
      key={agent?.id || "closed"}
      title={`修改数字员工：${agent?.name || ""}`}
      open={Boolean(agent)}
      initialValues={agent || undefined}
      onOpenChange={(open) => {
        if (!open) void closeModal();
      }}
      modalProps={{ destroyOnClose: true }}
      onFinish={async (values) => {
        if (!agent) return false;
        try {
          const body = {
            name: values.name,
            role: values.role,
            persona: values.persona,
            skills: values.skills,
            removeChannels: removedChannels as Array<{ domain: "feishu" | "dingtalk-connector"; accountId: string }>,
          };
          if (values.addChannelDomain && values.addChannelMode !== "manual") {
            setSession(await startAgentChannelOnboarding(agent.id, {
              ...body,
              domain: values.addChannelDomain,
              accountId: values.addChannelAccountId || undefined,
              mode: "scan",
            }));
            return false;
          }
          await updateAgent(agent.id, {
            ...body,
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
      {session ? (
        <OnboardingProgress session={session} onRetry={() => setSession(null)} onClose={closeModal} />
      ) : <>
      <ProFormText name="id" label="ID" disabled />
      <ProFormText name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]} />
      <ProFormRadio.Group
        name="role"
        label="岗位"
        options={[
          { label: "员工", value: "employee" },
          { label: "管理员", value: "admin" },
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
        {agent?.channels.filter((channel) => !removedChannels.some(
          (removed) => removed.domain === channel.domain && removed.accountId === channel.accountId,
        )).map((channel) => (
          <Tag
            key={`${channel.domain}/${channel.accountId}`}
            color="geekblue"
            closable
            onClose={() => setRemovedChannels((current) => [...current, channel])}
          >
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
                <ProFormRadio.Group
                  name="addChannelMode"
                  label="接入方式"
                  initialValue="scan"
                  options={[
                    { label: "扫码创建新应用", value: "scan" },
                    { label: "使用已有应用", value: "manual" },
                  ]}
                />
                <ProFormText
                  name="addChannelAccountId"
                  label="账号 ID"
                  tooltip="留空则使用数字员工 ID"
                  placeholder={agent?.id}
                />
                <ProFormDependency name={["addChannelMode"]}>
                  {({ addChannelMode }) => addChannelMode === "manual" ? (
                    <Collapse items={[{ key: "credentials", label: "已有应用凭证", children: <>
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
                    </> }]} />
                  ) : <Alert type="info" showIcon message="保存后显示二维码；扫码授权成功后自动更新。" />}
                </ProFormDependency>
              </>
            ) : null}
          </ProFormDependency>
        </>
      )}
      </>}
    </ModalForm>
  );
}
