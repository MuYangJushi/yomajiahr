// 新建数字员工向导（StepsForm）：身份岗位 → 技能 → 渠道接入 → 提交上线。
import { Modal, message } from "antd";
import {
  ProFormDependency,
  ProFormRadio,
  ProFormSelect,
  ProFormText,
  ProFormTextArea,
  StepsForm,
} from "@ant-design/pro-components";
import { createAgent, type ChannelsInfo, type Skill } from "./api";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  skills: Skill[];
  channels: ChannelsInfo;
}

const DOMAIN_LABEL: Record<string, string> = {
  feishu: "飞书",
  "dingtalk-connector": "钉钉",
};

export default function CreateAgentWizard({ open, onClose, onCreated, skills, channels }: Props) {
  async function handleFinish(values: any): Promise<boolean> {
    const { id, name, role, persona, skills: chosenSkills, domain, accountId, cred1, cred2 } = values;
    const up = String(id).toUpperCase().replace(/-/g, "_");
    let account: Record<string, unknown>;
    let secrets: Record<string, string>;
    if (domain === "feishu") {
      account = {
        appId: `\${FEISHU_${up}_APP_ID}`,
        appSecret: `\${FEISHU_${up}_APP_SECRET}`,
        dmPolicy: "open",
        groupPolicy: "open",
        requireMention: true,
      };
      secrets = { [`FEISHU_${up}_APP_ID`]: cred1, [`FEISHU_${up}_APP_SECRET`]: cred2 };
    } else {
      account = {
        enabled: true,
        name,
        clientId: `\${DINGTALK_${up}_CLIENT_ID}`,
        clientSecret: `\${DINGTALK_${up}_CLIENT_SECRET}`,
        dmPolicy: "open",
        groupPolicy: "open",
        requireMention: true,
      };
      secrets = { [`DINGTALK_${up}_CLIENT_ID`]: cred1, [`DINGTALK_${up}_CLIENT_SECRET`]: cred2 };
    }
    const body = {
      id,
      name,
      role,
      persona,
      skills: chosenSkills,
      channels: [{ domain, accountId: accountId || id, account, secrets }],
    };
    try {
      const hide = message.loading("正在上线数字员工…", 0);
      const res = await createAgent(body);
      hide();
      if (res?.apply?.status === "success") {
        message.success(`已上线：${name}（版本 ${res.apply.version}）`);
        onCreated();
        return true;
      }
      message.error(`上线未成功：${res?.apply?.message || "未知"}`);
      return false;
    } catch (err: any) {
      message.error(err?.response?.data?.error || err.message || "创建失败");
      return false;
    }
  }

  return (
    <Modal
      title="招募一名 HR 数字员工"
      open={open}
      footer={null}
      onCancel={onClose}
      width={640}
      destroyOnClose
    >
      <StepsForm onFinish={handleFinish}>
        <StepsForm.StepForm name="identity" title="身份与岗位">
        <ProFormText
          name="id"
          label="ID（创建后不可改）"
          rules={[{ required: true, pattern: /^[a-z0-9-]+$/, message: "仅小写字母/数字/连字符" }]}
          placeholder="如 hr-onboard"
        />
        <ProFormText name="name" label="名称" rules={[{ required: true }]} placeholder="如 入离职助手" />
        <ProFormRadio.Group
          name="role"
          label="岗位"
          initialValue="employee"
          options={[
            { label: "员工面（只读）", value: "employee" },
            { label: "管理面（可写）", value: "admin" },
          ]}
          rules={[{ required: true }]}
        />
        <ProFormTextArea name="persona" label="人设" placeholder="一句话描述该数字员工的职责与风格" />
      </StepsForm.StepForm>

      <StepsForm.StepForm name="skills" title="技能">
        <ProFormSelect
          name="skills"
          label="分配技能"
          mode="multiple"
          rules={[{ required: true, message: "至少分配一个技能" }]}
          options={skills.map((s) => ({ label: `${s.name}`, value: s.name, title: s.description }))}
          fieldProps={{ optionRender: (o: any) => <span title={o.data.title}>{o.label}</span> }}
        />
      </StepsForm.StepForm>

      <StepsForm.StepForm name="channel" title="渠道接入">
        <ProFormSelect
          name="domain"
          label="渠道"
          initialValue="feishu"
          options={channels.supported.map((d) => ({ label: DOMAIN_LABEL[d] || d, value: d }))}
          rules={[{ required: true }]}
        />
        <ProFormText name="accountId" label="账号 ID" tooltip="留空则用 agent ID" placeholder="留空则同 agent ID" />
        <ProFormDependency name={["domain"]}>
          {({ domain }) =>
            domain === "dingtalk-connector" ? (
              <>
                <ProFormText name="cred1" label="Client ID" rules={[{ required: true }]} />
                <ProFormText.Password name="cred2" label="Client Secret" rules={[{ required: true }]} />
              </>
            ) : (
              <>
                <ProFormText name="cred1" label="App ID" rules={[{ required: true }]} />
                <ProFormText.Password name="cred2" label="App Secret" rules={[{ required: true }]} />
              </>
            )
          }
        </ProFormDependency>
      </StepsForm.StepForm>
      </StepsForm>
    </Modal>
  );
}
