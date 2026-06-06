// 新建数字员工向导（StepsForm）：身份岗位 → 技能 → 渠道接入 → 提交上线。
import { useEffect, useState } from "react";
import { Alert, Button, Modal, Space, Spin, Typography, message } from "antd";
import { QRCodeSVG } from "qrcode.react";
import {
  ProFormRadio,
  ProFormSelect,
  ProFormText,
  ProFormTextArea,
  StepsForm,
} from "@ant-design/pro-components";
import {
  cancelAgentOnboarding,
  fetchAgentOnboarding,
  startAgentOnboarding,
  type ChannelsInfo,
  type OnboardingSession,
  type Skill,
} from "./api";

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
  const [session, setSession] = useState<OnboardingSession | null>(null);

  useEffect(() => {
    if (!session || ["success", "failed", "expired", "cancelled"].includes(session.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await fetchAgentOnboarding(session.id);
        setSession(next);
        if (next.status === "success") {
          message.success("数字员工已上线");
          onCreated();
        }
      } catch (err: any) {
        setSession((s) => s ? { ...s, status: "failed", message: err?.response?.data?.error || "状态查询失败" } : s);
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [session?.id, session?.status]);

  async function closeWizard() {
    if (session && !["success", "failed", "expired", "cancelled"].includes(session.status)) {
      await cancelAgentOnboarding(session.id).catch(() => {});
    }
    setSession(null);
    onClose();
  }

  async function handleFinish(values: any): Promise<boolean> {
    const { id, name, role, persona, skills: chosenSkills, domain, accountId } = values;
    const body = {
      id, name, role, persona,
      skills: chosenSkills,
      domain,
      accountId: accountId || undefined,
    };
    try {
      setSession(await startAgentOnboarding(body));
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
      onCancel={closeWizard}
      width={640}
      destroyOnClose
    >
      {session ? (
        <OnboardingProgress
          session={session}
          onRetry={() => setSession(null)}
          onClose={closeWizard}
        />
      ) : <StepsForm onFinish={handleFinish}>
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
        <Alert type="info" showIcon message="提交后将显示二维码；扫码授权成功后自动上线。" />
      </StepsForm.StepForm>
      </StepsForm>}
    </Modal>
  );
}

function OnboardingProgress({
  session,
  onRetry,
  onClose,
}: {
  session: OnboardingSession;
  onRetry: () => void;
  onClose: () => void;
}) {
  const terminal = ["success", "failed", "expired", "cancelled"].includes(session.status);
  const error = ["failed", "expired", "cancelled"].includes(session.status);
  return (
    <Space direction="vertical" align="center" size="large" style={{ width: "100%", padding: "24px 0" }}>
      {session.qr_url && session.status === "awaiting_scan" ? (
        <>
          <QRCodeSVG value={session.qr_url} size={240} />
          <Button type="link" href={session.qr_url} target="_blank">无法扫码？打开授权链接</Button>
        </>
      ) : !terminal ? <Spin size="large" /> : null}
      <Alert
        type={error ? "error" : session.status === "success" ? "success" : "info"}
        showIcon
        message={STATUS_LABEL[session.status]}
        description={session.message}
      />
      {session.status === "awaiting_scan" && (
        <Typography.Text type="secondary">
          授权链接过期时间：{new Date(session.expires_at).toLocaleString()}
        </Typography.Text>
      )}
      {terminal && (
        <Space>
          {error && <Button onClick={onRetry}>重新发起</Button>}
          <Button type={session.status === "success" ? "primary" : "default"} onClick={onClose}>关闭</Button>
        </Space>
      )}
    </Space>
  );
}

const STATUS_LABEL: Record<string, string> = {
  preparing: "正在准备扫码会话",
  awaiting_scan: "等待扫码授权",
  authorized: "授权成功",
  applying: "正在应用配置并重启网关",
  verifying: "正在验证目标渠道",
  success: "数字员工已上线",
  failed: "创建失败",
  expired: "授权已过期",
  cancelled: "已取消",
};
