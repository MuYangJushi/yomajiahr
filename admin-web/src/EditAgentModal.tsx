// 修改数字员工（ADR-013 §招募向导）：仅改资料 + 权限 + 技能。
// 渠道的解绑/绑定/复用统一在「渠道管理」页通过独立 API 完成，不再在本弹窗中编辑。
import { ModalForm, ProFormRadio, ProFormSelect, ProFormText, ProFormTextArea } from "@ant-design/pro-components";
import { Alert, Tag, message } from "antd";
import { updateAgent, type AgentRow, type Skill } from "./api";

interface Props {
  agent: AgentRow | null;
  skills: Skill[];
  onClose: () => void;
  onUpdated: () => void;
}

const DOMAIN_LABEL: Record<string, string> = {
  feishu: "飞书",
  "dingtalk-connector": "钉钉",
};

export default function EditAgentModal({ agent, skills, onClose, onUpdated }: Props) {
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
            profile: {
              ...(agent.profile || {}),
              jobTitle: values.jobTitle,
              responsibilities: values.responsibilities,
              personality: values.personality,
              tone: values.tone,
              boundaries: values.boundaries,
            },
            skills: values.skills,
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
        label="系统权限"
        tooltip="这是平台权限级别，不是真实岗位（岗位由 profile.jobTitle 表达）"
        options={[
          { label: "员工（只读）", value: "employee" },
          { label: "管理员（可写）", value: "admin" },
        ]}
        rules={[{ required: true }]}
      />

      <Alert
        type="info"
        showIcon
        style={{ margin: "8px 0" }}
        message="职业档案：岗位名 + 5 段结构化描述。AGENTS.md 会按此渲染「待配置技能 / 待接入渠道」状态提示。"
      />
      <ProFormText
        name="jobTitle"
        label="岗位名"
        rules={[{ required: true, max: 60 }]}
        initialValue={agent?.profile?.jobTitle}
        fieldProps={{ autoComplete: "off" }}
      />
      <ProFormTextArea
        name="responsibilities"
        label="职责"
        initialValue={agent?.profile?.responsibilities}
        fieldProps={{ rows: 3 }}
      />
      <ProFormText
        name="personality"
        label="人设（3~5 形容词）"
        initialValue={agent?.profile?.personality || agent?.persona}
      />
      <ProFormText name="tone" label="语气" initialValue={agent?.profile?.tone} />
      <ProFormTextArea
        name="boundaries"
        label="边界"
        initialValue={agent?.profile?.boundaries}
        fieldProps={{ rows: 2 }}
      />

      <ProFormSelect
        name="skills"
        label="分配技能"
        mode="multiple"
        allowClear
        placeholder="可留空，AGENTS.md 会显示「待配置技能」"
        options={skills.map((s) => ({ label: s.name, value: s.name, title: s.description }))}
        fieldProps={{ optionRender: (o: any) => <span title={o.data.title}>{o.label}</span> }}
      />

      <Alert
        type="info"
        showIcon
        style={{ margin: "12px 0 0" }}
        message="渠道绑定 / 解绑 / 账号复用请在「渠道管理」页完成。"
      />
      {agent?.channels.length ? (
        <div style={{ marginTop: 8 }}>
          当前接入：
          {agent.channels.map((c) => (
            <Tag key={`${c.domain}/${c.accountId}`} color="geekblue" style={{ marginLeft: 4 }}>
              {DOMAIN_LABEL[c.domain] || c.domain}/{c.accountId}
            </Tag>
          ))}
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <Tag color="warning">暂未接入渠道</Tag>
        </div>
      )}
    </ModalForm>
  );
}
