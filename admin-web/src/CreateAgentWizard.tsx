// 新建数字员工向导（ADR-013 §招募向导）：
//   Step 1 身份与岗位：id / name / role（岗位 = 系统权限级别，不作真实岗位表达）
//   Step 2 职业档案：jobTitle 必填；可点「AI 共创」生成 5 段 profile；可手填/覆盖
//   Step 3 技能分配（可空，状态显示"待配置技能"）
//   Step 4 确认提交：调 POST /config/agents，createAgentProfile 原子写入
// 渠道接入不再属于招募向导——统一在「渠道管理」页通过 bindAgentChannel 走独立生命周期。
import { useState } from "react";
import { Alert, Button, Form, Input, Modal, Space, Spin, Typography, message } from "antd";
import {
  ProForm,
  ProFormDependency,
  ProFormRadio,
  ProFormSelect,
  ProFormText,
  ProFormTextArea,
  StepsForm,
} from "@ant-design/pro-components";
import {
  createAgent,
  generateAgentProfile,
  type AgentProfile,
  type Skill,
} from "./api";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  skills: Skill[];
}

interface IdentityValues {
  id: string;
  name: string;
  role: "employee" | "admin";
}
interface ProfileValues {
  jobTitle: string;
  hints?: string;
  profile: AgentProfile;
}
interface SkillsValues {
  skills: string[];
}

export default function CreateAgentWizard({ open, onClose, onCreated, skills }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);

  async function handleFinish(values: IdentityValues & ProfileValues & SkillsValues): Promise<boolean> {
    setSubmitting(true);
    try {
      await createAgent({
        id: values.id,
        name: values.name,
        role: values.role,
        profile: values.profile,
        skills: values.skills,
      });
      message.success("数字员工已创建。技能/渠道可在对应页面继续配置。");
      onCreated();
      onClose();
      return true;
    } catch (err: any) {
      message.error(err?.response?.data?.error || err.message || "创建失败");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="招募一名 HR 数字员工"
      open={open}
      footer={null}
      onCancel={onClose}
      width={720}
      destroyOnClose
    >
      <StepsForm<IdentityValues & ProfileValues & SkillsValues>
        onFinish={handleFinish}
        submitter={{
          submitButtonProps: { loading: submitting },
          render: (props, _doms) => [
            <Button key="submit" type="primary" loading={submitting} onClick={() => props.submit?.()}>
              提交
            </Button>,
          ],
        }}
      >
        {/* Step 1: 身份与岗位 */}
        <StepsForm.StepForm name="identity" title="身份与岗位">
          <ProFormText
            name="id"
            label="ID（创建后不可改）"
            rules={[{ required: true, pattern: /^[a-z0-9-]+$/, message: "仅小写字母/数字/连字符" }]}
            placeholder="如 hr-onboard"
            fieldProps={{ autoComplete: "off" }}
          />
          <ProFormText
            name="name"
            label="名称"
            rules={[{ required: true }]}
            placeholder="如 入离职助手"
            fieldProps={{ autoComplete: "off" }}
          />
          <ProFormRadio.Group
            name="role"
            label="系统权限"
            initialValue="employee"
            tooltip="employee=只读/无 exec；admin=可执行管理操作。这是平台权限，不是真实岗位。"
            options={[
              { label: "员工（只读）", value: "employee" },
              { label: "管理员（可写）", value: "admin" },
            ]}
            rules={[{ required: true }]}
          />
        </StepsForm.StepForm>

        {/* Step 2: 职业档案（AI 共创 / 手填） */}
        <StepsForm.StepForm name="profile" title="职业档案">
          <ProFormText
            name={["profile", "jobTitle"]}
            label="岗位名"
            rules={[{ required: true, max: 60 }]}
            placeholder="如 薪酬顾问"
            fieldProps={{ autoComplete: "off" }}
          />
          <ProFormTextArea
            name="hints"
            label="补充描述（可选）"
            placeholder="例：负责薪酬政策答疑与流程指引"
            fieldProps={{ autoComplete: "off" }}
          />
          <AiCoCreateFields
            skillsHint={skills.length > 0 ? `平台已有技能：${skills.map((s) => s.name).join("、")}` : ""}
            onGeneratingChange={setGenerating}
          />
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 8 }}
            message="AI 共创结果会覆盖下方 5 个字段；可继续手改，最终以本页填写为准。"
          />
        </StepsForm.StepForm>

        {/* Step 3: 技能（可空） */}
        <StepsForm.StepForm name="skills" title="技能">
          <ProFormSelect
            name="skills"
            label="分配技能"
            mode="multiple"
            allowClear
            placeholder="可留空，状态会显示「待配置技能」并在 AGENTS.md 中提示"
            options={skills.map((s) => ({ label: `${s.name}`, value: s.name, title: s.description }))}
            fieldProps={{ optionRender: (o: any) => <span title={o.data.title}>{o.label}</span> }}
          />
        </StepsForm.StepForm>
      </StepsForm>
      {generating && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(255,255,255,0.6)", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
          <Spin tip="AI 共创中..." />
        </div>
      )}
    </Modal>
  );
}

// 5 段 profile 字段 + 「AI 共创」按钮
function AiCoCreateFields({ skillsHint, onGeneratingChange }: { skillsHint: string; onGeneratingChange: (b: boolean) => void }) {
  const form = ProForm.useFormInstance();
  const jobTitle: string = Form.useWatch(["profile", "jobTitle"], form) || "";
  const hints: string = Form.useWatch("hints", form) || "";
  const role: "employee" | "admin" = Form.useWatch("role", form) || "employee";
  const [busy, setBusy] = useState(false);

  async function runCoCreate() {
    if (!jobTitle.trim()) {
      message.warning("请先填写岗位名");
      return;
    }
    setBusy(true);
    onGeneratingChange(true);
    try {
      const p = await generateAgentProfile({ jobTitle, hints, role });
      // 把 5 段写回表单 profile.* 字段
      form.setFieldsValue({ profile: { jobTitle, ...p } });
      message.success("AI 共创完成，可继续微调");
    } catch (err: any) {
      message.error(err?.response?.data?.error || err.message || "AI 共创失败");
    } finally {
      setBusy(false);
      onGeneratingChange(false);
    }
  }

  return (
    <div style={{ borderTop: "1px dashed #d9d9d9", paddingTop: 12, marginTop: 8 }}>
      <Space style={{ marginBottom: 8 }}>
        <Button loading={busy} onClick={runCoCreate}>AI 共创（基于岗位名 + hints）</Button>
        <Typography.Text type="secondary">{skillsHint}</Typography.Text>
      </Space>
      <ProFormTextArea name={["profile", "responsibilities"]} label="职责" placeholder="2~4 条要点" fieldProps={{ rows: 3 }} />
      <ProFormText name={["profile", "personality"]} label="人设（3~5 形容词）" placeholder="细致、耐心、专业" />
      <ProFormText name={["profile", "tone"]} label="语气" placeholder="简洁、就事论事" />
      <ProFormTextArea name={["profile", "boundaries"]} label="边界" placeholder="不替代 HR 完成人工审批" fieldProps={{ rows: 2 }} />
    </div>
  );
}
