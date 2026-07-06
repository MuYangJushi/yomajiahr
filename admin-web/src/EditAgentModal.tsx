import { useRef, useState } from "react";
import { ModalForm, ProFormRadio, ProFormText, ProFormTextArea, type ProFormInstance } from "@ant-design/pro-components";
import { Alert, Button, Space, message } from "antd";
import { applyModeLabel, awaitApplyJob, generateAgentProfile, jobApplyPending, jobIdOf, updateAgent, type AgentProfile, type AgentRow } from "./api";

interface Props { agent: AgentRow | null; onClose: () => void; onUpdated: () => void }
const FIELDS: Array<{ key: keyof AgentProfile; label: string; area?: boolean }> = [
  { key: "responsibilities", label: "职责", area: true }, { key: "personality", label: "个性" },
  { key: "tone", label: "沟通语气" }, { key: "boundaries", label: "工作边界", area: true },
];

export default function EditAgentModal({ agent, onClose, onUpdated }: Props) {
  const [busy, setBusy] = useState<string>();
  const formRef = useRef<ProFormInstance>();
  return (
    <ModalForm
      key={agent?.id || "closed"} title={`编辑数字员工：${agent?.name || ""}`} open={Boolean(agent)}
      formRef={formRef}
      initialValues={{ ...agent, ...agent?.profile }} onOpenChange={(open) => !open && onClose()} modalProps={{ destroyOnClose: true }}
      onFinish={async (values) => {
        if (!agent) return false;
        try {
          const data = await updateAgent(agent.id, { name: values.name, role: values.role, profile: Object.fromEntries(["jobTitle", ...FIELDS.map((f) => f.key)].map((key) => [key, values[key]])) });
          const jobId = jobIdOf(data);
          if (jobId) {
            const key = `apply-${jobId}`;
            message.loading({ content: "员工资料已保存，配置应用中…", key, duration: 0 });
            onUpdated();
            awaitApplyJob(jobId).then((job) => {
              if (job.status === "success") {
                const mode = (job.result as any)?.apply?.mode;
                if (jobApplyPending(job)) message.info({ content: "员工资料已保存，配置应用中（请稍后刷新确认）", key, duration: 6 });
                else message.success({ content: `员工资料已应用（${applyModeLabel(mode)}）`, key });
                onUpdated();
              } else {
                message.error({ content: `保存失败：${job.message || job.status}`, key, duration: 6 });
                onUpdated();
              }
            });
            return true;
          }
          message.success("员工资料已保存"); onUpdated(); return true;
        } catch (err: any) { message.error(err?.response?.data?.error || err.message || "更新失败"); return false; }
      }}
    >
      <ProFormText name="id" label="不可变 ID" disabled />
      <ProFormText name="name" label="名称" rules={[{ required: true }]} />
      <ProFormText name="jobTitle" label="真实岗位名称" rules={[{ required: true, max: 60 }]} />
      <ProFormRadio.Group name="role" label="系统权限级别" options={[
        { label: "员工", value: "employee" }, { label: "管理员", value: "admin" },
      ]} />
      <Alert type="info" showIcon message="本页面只修改员工资料与权限，不处理技能和渠道。" />
      {FIELDS.map((field) => (
        <div key={field.key} style={{ marginTop: 12 }}>
          <Space>
            <Button size="small" loading={busy === field.key} onClick={async () => {
              if (!agent) return;
              const jobTitle = String(formRef.current?.getFieldValue("jobTitle") || "").trim();
              if (!jobTitle) { message.warning("请先填写真实岗位名称再生成"); return; }
              setBusy(field.key);
              try {
                const p = await generateAgentProfile({ jobTitle, fields: [field.key] });
                formRef.current?.setFieldValue(field.key, p[field.key]);
                message.success(`${field.label}已生成，请确认后保存`);
              } catch (err: any) {
                const data = err?.response?.data || {};
                message.error(data.message || data.error || "AI 生成不可用");
              }
              finally { setBusy(undefined); }
            }}>AI 重新生成{field.label}</Button>
          </Space>
          {field.area ? <ProFormTextArea name={field.key} label={field.label} fieldProps={{ rows: 3 }} /> : <ProFormText name={field.key} label={field.label} />}
        </div>
      ))}
    </ModalForm>
  );
}
