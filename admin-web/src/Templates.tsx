// 员工模板（只读，扩展 ADR-014）：罗列系统自带数字员工模板，可一键据此招募。
// ⚠️ 与 ClawMax「组织模板」不同：这里是解耦的 agent-profile 模板（不捆绑 workflow/community）。
// 用户可编辑/导入模板留后续（ADR-014 deferred）。后端只读 GET /config/agent-templates。
import { useEffect, useState } from "react";
import { Button, Card, Empty, Spin, Tag, Typography, message } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { fetchAgentTemplates, type AgentTemplate } from "./api";
import CreateAgentWizard from "./CreateAgentWizard";

const ROLE_TAG: Record<string, { color: string; label: string }> = {
  employee: { color: "default", label: "员工" },
  admin: { color: "gold", label: "管理员" },
};

const FIELD_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "72px 1fr",
  rowGap: 10,
  columnGap: 12,
  fontSize: 13,
  margin: 0,
};
const DT: React.CSSProperties = { color: "#aeaeb2" };
const DD: React.CSSProperties = { margin: 0, color: "#48484a", lineHeight: 1.6 };
const SKILL_TAG: React.CSSProperties = {
  display: "inline-flex", padding: "2px 8px", borderRadius: 6, fontSize: 12,
  background: "#e8f1fd", color: "#0071e3", marginRight: 6, fontWeight: 600,
};

export default function Templates() {
  const [templates, setTemplates] = useState<AgentTemplate[] | null>(null);
  const [recruitFrom, setRecruitFrom] = useState<AgentTemplate | null>(null);

  useEffect(() => {
    fetchAgentTemplates()
      .then(setTemplates)
      .catch((err: any) => { message.error(err?.response?.data?.error || "加载模板失败"); setTemplates([]); });
  }, []);

  if (templates === null) return <div style={{ padding: 48, textAlign: "center" }}><Spin /></div>;

  return (
    <>
      <Typography.Paragraph type="secondary" style={{ maxWidth: 640, lineHeight: 1.6 }}>
        系统自带数字员工模板。「用此模板招募」会带入档案预填，可在招募向导中继续修改岗位、权限与各段档案。
      </Typography.Paragraph>
      {templates.length === 0 ? (
        <Empty description="暂无系统模板" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {templates.map((t) => (
            <Card
              key={t.id}
              styles={{ body: { padding: "20px 24px" } }}
              title={
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 16, fontWeight: 600 }}>{t.name}</span>
                  <Tag color={ROLE_TAG[t.role]?.color}>{ROLE_TAG[t.role]?.label || t.role}</Tag>
                </div>
              }
              extra={<Button type="primary" shape="round" icon={<PlusOutlined />} onClick={() => setRecruitFrom(t)}>用此模板招募</Button>}
            >
              <dl style={FIELD_STYLE}>
                <dt style={DT}>说明</dt><dd style={DD}>{t.description}</dd>
                <dt style={DT}>岗位</dt><dd style={DD}>{t.profile.jobTitle}</dd>
                <dt style={DT}>职责</dt><dd style={DD}>{t.profile.responsibilities}</dd>
                <dt style={DT}>个性</dt><dd style={DD}>{t.profile.personality}</dd>
                <dt style={DT}>语气</dt><dd style={DD}>{t.profile.tone}</dd>
                <dt style={DT}>边界</dt><dd style={DD}>{t.profile.boundaries}</dd>
                <dt style={DT}>建议技能</dt>
                <dd style={DD}>
                  {t.suggestedSkills.length
                    ? t.suggestedSkills.map((s) => <span key={s} style={SKILL_TAG}>{s}</span>)
                    : "—"}
                </dd>
              </dl>
            </Card>
          ))}
        </div>
      )}
      {recruitFrom && (
        <CreateAgentWizard
          key={recruitFrom.id}
          open
          initialTemplate={recruitFrom}
          onClose={() => setRecruitFrom(null)}
          onCreated={() => setRecruitFrom(null)}
        />
      )}
    </>
  );
}
