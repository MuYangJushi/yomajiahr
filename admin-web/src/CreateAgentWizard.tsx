import { useEffect, useRef, useState } from "react";
import { Alert, Button, Descriptions, Form, Modal, Select, Space, Spin, Tag, Typography, message } from "antd";
import { ProForm, ProFormDependency, ProFormRadio, ProFormText, ProFormTextArea, StepsForm } from "@ant-design/pro-components";
import { createAgent, fetchAgentTemplates, generateAgentProfile, type AgentProfile, type AgentTemplate } from "./api";

// 招募向导（ADR-013 #N）。5 步切分对标 ClawMax 招募向导
// （Team Type → Composition → Communication → Workflows → Preview），本土化为：
//   1) 身份定位（Team Type）   2) 档案共创（Composition，描述→AI 填全表）
//   3) 渠道接入（Communication，本 Sprint 仅占位，渠道是独立生命周期）
//   4) 技能配置（Workflows，留空占位，等技能 ADR）   5) 预览确认（Preview）
// 招募只创建员工 + 结构化档案，绝不在此绑技能/接渠道（ADR-013 三生命周期解耦）。
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
  // 从系统模板预填的整份 profile，跨步带到「档案共创」（沿用 jobTitle 的状态提升模式）。
  const [seedProfile, setSeedProfile] = useState<AgentProfile | null>(null);
  return (
    <Modal title="招募数字员工" open={open} footer={null} onCancel={onClose} width={760} destroyOnClose>
      <StepsForm<Values>
        onFinish={async (values) => {
          setSubmitting(true);
          try {
            await createAgent({ id: values.id, name: values.name, role: values.role, profile: values.profile });
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
        {/* ① 身份定位（对标 ClawMax「Team Type」）：名称 / 不可变 ID / 岗位 / 权限级别 */}
        <StepsForm.StepForm name="identity" title="身份定位" onFinish={async (values) => { setJobTitle(values.profile?.jobTitle || ""); return true; }}>
          <TemplatePicker onPick={(t) => { setJobTitle(t.profile.jobTitle); setSeedProfile(t.profile); }} />
          <ProFormText name="name" label="名称" rules={[{ required: true }]} placeholder="如 入离职助手" />
          <ProFormText name="id" label="不可变 ID" rules={[{ required: true, pattern: /^[a-z0-9-]+$/, message: "仅小写字母、数字和连字符" }]} placeholder="如 hr-onboard" />
          <ProFormText name={["profile", "jobTitle"]} label="真实岗位名称" rules={[{ required: true, max: 60 }]} placeholder="如 入离职专员" />
          <ProFormRadio.Group name="role" label="系统权限级别" initialValue="employee" options={[
            { label: "employee（只读）", value: "employee" },
            { label: "admin（管理权限）", value: "admin" },
          ]} />
        </StepsForm.StepForm>

        {/* ② 档案共创（对标 ClawMax「Composition」）：一句话描述 → AI 填全表 */}
        <StepsForm.StepForm name="profile" title="档案共创">
          <ProfileEditor jobTitle={jobTitle} seedProfile={seedProfile} />
          <Alert type="info" showIcon style={{ marginTop: 12 }} message="先用一句话描述这名员工，让 AI 一次生成完整档案；再逐段微调。AI 不可用时可全程手工填写，生成内容只写入结构化档案，不会覆盖系统规则。" />
        </StepsForm.StepForm>

        {/* ③ 渠道接入（对标 ClawMax「Communication」）：本 Sprint 占位，渠道是独立生命周期 */}
        <StepsForm.StepForm name="channels" title="渠道接入">
          <PlaceholderStep
            tag="待接入渠道"
            title="渠道在招募后独立接入"
            desc="按 ADR-013，渠道（飞书 / 钉钉账号）是独立资产与独立生命周期，不在招募时绑定。招募完成后，前往「渠道」页把账号绑定到这名员工即可。"
          />
        </StepsForm.StepForm>

        {/* ④ 技能配置（对标 ClawMax「Workflows」）：留空占位，等技能 ADR */}
        <StepsForm.StepForm name="skills" title="技能配置">
          <PlaceholderStep
            tag="待配置技能"
            title="技能配置留待下一阶段"
            desc="技能（如政策问答 / 文档管理）的配置流程由后续技能 ADR 定义，本向导暂不绑定。新员工招募后默认显示「待配置技能」，可在技能就绪后单独配置。"
          />
        </StepsForm.StepForm>

        {/* ⑤ 预览确认（对标 ClawMax「Preview」） */}
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

// 从系统模板下拉预填（空白起步 + 从模板创建）。本身不是表单字段，避免污染提交体。
function TemplatePicker({ onPick }: { onPick: (t: AgentTemplate) => void }) {
  const form = ProForm.useFormInstance();
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [picked, setPicked] = useState<string>();
  useEffect(() => { fetchAgentTemplates().then(setTemplates).catch(() => {}); }, []);
  if (templates.length === 0) return null;
  return (
    <Form.Item label="从系统模板创建（可选）" extra="选择后预填名称 / ID / 权限 / 档案，可继续逐项修改。">
      <Select
        allowClear
        placeholder="空白创建，或选择一个系统模板预填"
        value={picked}
        options={templates.map((t) => ({ value: t.id, label: `${t.name} — ${t.description}` }))}
        onChange={(value) => {
          setPicked(value);
          const t = templates.find((x) => x.id === value);
          if (!t) return;
          form.setFieldsValue({ name: t.name, id: t.suggestedId, role: t.role, profile: { jobTitle: t.profile.jobTitle } });
          onPick(t);
        }}
      />
    </Form.Item>
  );
}

function ProfileEditor({ jobTitle, seedProfile }: { jobTitle: string; seedProfile: AgentProfile | null }) {
  const form = ProForm.useFormInstance();
  const hints = Form.useWatch("hints", form) || "";
  const [busy, setBusy] = useState<string>();
  // 进入本步时，把模板预填的整份 profile 落到本步表单（仅当本步还没填过，避免覆盖手工编辑）。
  const seededRef = useRef(false);
  useEffect(() => {
    if (!seedProfile || seededRef.current) return;
    const current = form.getFieldValue("profile") || {};
    const hasContent = ["responsibilities", "personality", "tone", "boundaries"].some((k) => current[k]);
    if (!hasContent) form.setFieldValue("profile", { ...seedProfile, ...current, jobTitle: jobTitle || seedProfile.jobTitle });
    seededRef.current = true;
  }, [seedProfile, jobTitle, form]);
  async function generate(fields?: Array<keyof AgentProfile>) {
    if (!jobTitle) return message.warning("请先在上一步填写真实岗位名称");
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
      {/* hero：一句话描述 → AI 生成完整档案（对标 ClawMax「描述→填全表」，而非单字段补全） */}
      <ProFormTextArea name="hints" label="一句话描述这名员工（可选）" fieldProps={{ rows: 2 }} placeholder="如：负责新员工入离职手续答疑与跟进，语气亲切耐心" />
      <Button type="primary" loading={busy === "all"} onClick={() => generate()}>AI 生成完整档案</Button>
      <Typography.Text type="secondary" style={{ marginLeft: 12 }}>下方各段可逐条微调或单独重生成</Typography.Text>
      {PROFILE_FIELDS.map((field) => (
        <div key={field.key} style={{ marginTop: 12 }}>
          <Space style={{ marginBottom: 4 }}>
            <Typography.Text strong>{field.label}</Typography.Text>
            <Button size="small" type="text" loading={busy === field.key} onClick={() => generate([field.key])}>重新生成本段</Button>
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

// 渠道 / 技能两步在本 Sprint 是「解耦后的占位说明」，不是死点击：每步解释独立生命周期。
function PlaceholderStep({ tag, title, desc }: { tag: string; title: string; desc: string }) {
  return (
    <div style={{ padding: "12px 0" }}>
      <Space align="center" style={{ marginBottom: 8 }}>
        <Tag color="default">{tag}</Tag>
        <Typography.Text strong>{title}</Typography.Text>
      </Space>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>{desc}</Typography.Paragraph>
    </div>
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
