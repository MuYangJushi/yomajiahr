import { useState } from "react";
import { Alert, Button, Descriptions, Form, Modal, Space, Spin, Typography, message } from "antd";
import { ProForm, ProFormDependency, ProFormRadio, ProFormText, ProFormTextArea, StepsForm } from "@ant-design/pro-components";
import { awaitApplyJob, createAgent, generateAgentProfile, jobIdOf, type AgentProfile } from "./api";

interface Props { open: boolean; onClose: () => void; onCreated: () => void }
interface Values {
  id: string;
  name: string;
  role: "employee" | "admin";
  hints?: string;
  profile: AgentProfile;
}

const PROFILE_FIELDS: Array<{ key: keyof AgentProfile; label: string; area?: boolean }> = [
  { key: "responsibilities", label: "职责", area: true },
  { key: "personality", label: "个性" },
  { key: "tone", label: "沟通语气" },
  { key: "boundaries", label: "工作边界", area: true },
];

export default function CreateAgentWizard({ open, onClose, onCreated }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [jobTitle, setJobTitle] = useState("");
  return (
    <Modal title="招募数字员工" open={open} footer={null} onCancel={onClose} width={760} destroyOnClose>
      <StepsForm<Values>
        onFinish={async (values) => {
          setSubmitting(true);
          try {
            const data = await createAgent({ id: values.id, name: values.name, role: values.role, profile: values.profile });
            const jobId = jobIdOf(data);
            if (jobId) {
              // 后端入队异步 apply：立刻关弹窗 + 通知列表刷新；进度提示挂全局轮询，
              // 用户感知"招募已提交，配置正在应用"。
              const key = `apply-${jobId}`;
              message.loading({ content: "招募提交，配置应用中…", key, duration: 0 });
              onCreated();
              onClose();
              awaitApplyJob(jobId).then((job) => {
                if (job.status === "success") {
                  message.success({ content: "数字员工已招募，技能与渠道待独立配置", key });
                  onCreated();
                } else {
                  message.error({ content: `招募失败：${job.message || job.status}`, key, duration: 6 });
                  onCreated();
                }
              });
              return true;
            }
            // 800ms 内同步完成
            message.success("数字员工已招募，技能与渠道待独立配置");
            onCreated();
            onClose();
            return true;
          } catch (err: any) {
            message.error(err?.response?.data?.error || err.message || "创建失败");
            return false;
          } finally { setSubmitting(false); }
        }}
        submitter={{ submitButtonProps: { loading: submitting } }}
      >
        <StepsForm.StepForm name="identity" title="基础信息" onFinish={async (values) => { setJobTitle(values.profile?.jobTitle || ""); return true; }}>
          <ProFormText name="name" label="名称" rules={[{ required: true }]} placeholder="如 入离职助手" />
          <ProFormText name="id" label="不可变 ID" rules={[{ required: true, pattern: /^[a-z0-9-]+$/, message: "仅小写字母、数字和连字符" }]} placeholder="如 hr-onboard" />
          <ProFormText name={["profile", "jobTitle"]} label="真实岗位名称" rules={[{ required: true, max: 60 }]} placeholder="如 入离职专员" />
          <ProFormRadio.Group name="role" label="系统权限级别" initialValue="employee" options={[
            { label: "employee（只读）", value: "employee" },
            { label: "admin（管理权限）", value: "admin" },
          ]} />
        </StepsForm.StepForm>
        <StepsForm.StepForm name="profile" title="档案共创">
          <ProfileEditor jobTitle={jobTitle} />
          <Alert type="info" showIcon message="AI 不可用时可继续手工填写；生成内容只会写入结构化档案，不会覆盖系统规则。" />
        </StepsForm.StepForm>
        <StepsForm.StepForm name="preview" title="预览确认">
          <ProFormDependency name={["name", "id", "role", "profile"]}>
            {(values) => <ProfilePreview values={values as Values} />}
          </ProFormDependency>
          <Alert type="warning" showIcon message="确认后立即生成 workspace 并应用配置。新员工将显示“待配置技能”和“待接入渠道”。" />
        </StepsForm.StepForm>
      </StepsForm>
    </Modal>
  );
}

function ProfileEditor({ jobTitle }: { jobTitle: string }) {
  const form = ProForm.useFormInstance();
  const hints = Form.useWatch("hints", form) || "";
  const [busy, setBusy] = useState<string>();
  async function generate(fields?: Array<keyof AgentProfile>) {
    if (!jobTitle) return message.warning("请先填写真实岗位名称");
    setBusy(fields?.[0] || "all");
    try {
      const generated = await generateAgentProfile({ jobTitle, hints, fields });
      const current = form.getFieldValue("profile") || {};
      form.setFieldValue("profile", { ...current, ...generated, jobTitle });
    } catch (err: any) {
      message.error(err?.response?.data?.message || err?.response?.data?.error || "AI 生成不可用，请继续手工填写");
    } finally { setBusy(undefined); }
  }
  return (
    <>
      <ProFormText name={["profile", "jobTitle"]} hidden initialValue={jobTitle} />
      <ProFormTextArea name="hints" label="共创提示（可选）" fieldProps={{ rows: 2 }} />
      <Button loading={busy === "all"} onClick={() => generate()}>整体 AI 生成</Button>
      {PROFILE_FIELDS.map((field) => (
        <div key={field.key} style={{ marginTop: 12 }}>
          <Space style={{ marginBottom: 4 }}>
            <Typography.Text strong>{field.label}</Typography.Text>
            <Button size="small" loading={busy === field.key} onClick={() => generate([field.key])}>重新生成本段</Button>
          </Space>
          {field.area
            ? <ProFormTextArea name={["profile", field.key]} fieldProps={{ rows: 3 }} />
            : <ProFormText name={["profile", field.key]} />}
        </div>
      ))}
      {busy && <Spin size="small" style={{ marginLeft: 8 }} />}
    </>
  );
}

function ProfilePreview({ values }: { values: Values }) {
  const p = values.profile || {};
  return <Descriptions column={1} bordered size="small" style={{ marginBottom: 16 }} items={[
    { key: "name", label: "名称 / ID", children: `${values.name || ""} / ${values.id || ""}` },
    { key: "role", label: "岗位 / 权限", children: `${p.jobTitle || ""} / ${values.role || "employee"}` },
    ...PROFILE_FIELDS.map((field) => ({ key: field.key, label: field.label, children: p[field.key] || "未填写" })),
    { key: "skills", label: "技能状态", children: "待配置技能" },
    { key: "channels", label: "渠道状态", children: "待接入渠道" },
  ]} />;
}
