// 员工模板（只读，扩展 ADR-014）：罗列系统自带数字员工模板，可一键据此招募。
// ⚠️ 与 ClawMax「组织模板」不同：这里是解耦的 agent-profile 模板（不捆绑 workflow/community）。
// 用户可编辑/导入模板留后续（ADR-014 deferred）。后端只读 GET /config/agent-templates。
import { useEffect, useState } from "react";
import { Button, Card, Descriptions, Empty, Space, Spin, Tag, Typography, message } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { fetchAgentTemplates, type AgentTemplate } from "./api";
import CreateAgentWizard from "./CreateAgentWizard";

const ROLE_TAG: Record<string, { color: string; label: string }> = {
  employee: { color: "blue", label: "员工（只读）" },
  admin: { color: "red", label: "管理员" },
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
      <Typography.Paragraph type="secondary">
        系统自带数字员工模板（只读）。「用此模板招募」会带入档案预填，可在招募向导中继续修改岗位、权限与各段档案。
      </Typography.Paragraph>
      {templates.length === 0 ? (
        <Empty description="暂无系统模板" />
      ) : (
        <Space direction="vertical" size="middle" style={{ display: "flex" }}>
          {templates.map((t) => (
            <Card
              key={t.id}
              size="small"
              title={<Space>{t.name}<Tag color={ROLE_TAG[t.role]?.color}>{ROLE_TAG[t.role]?.label || t.role}</Tag></Space>}
              extra={<Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setRecruitFrom(t)}>用此模板招募</Button>}
            >
              <Descriptions column={1} size="small" items={[
                { key: "desc", label: "说明", children: t.description },
                { key: "jobTitle", label: "岗位", children: t.profile.jobTitle },
                { key: "responsibilities", label: "职责", children: t.profile.responsibilities },
                { key: "personality", label: "个性", children: t.profile.personality },
                { key: "tone", label: "语气", children: t.profile.tone },
                { key: "boundaries", label: "边界", children: t.profile.boundaries },
                { key: "skills", label: "建议技能", children: t.suggestedSkills.length ? <Space wrap>{t.suggestedSkills.map((s) => <Tag key={s}>{s}</Tag>)}</Space> : "—" },
              ]} />
            </Card>
          ))}
        </Space>
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
