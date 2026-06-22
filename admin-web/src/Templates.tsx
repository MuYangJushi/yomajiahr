// 员工模板（ADR-018）：按部门分组展示 + CRUD（新建 / 编辑 / 删除）+ 用此模板招募。
// 与 ClawMax「组织模板」不同：这里是解耦的 agent-profile 模板（不捆绑 workflow/community）。
// 内置只读种子 + config-store overlay（用户可变态）合并；删除内置 = 软隐藏，自建 = 真删。
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Collapse,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, UndoOutlined } from "@ant-design/icons";
import {
  createAgentTemplate,
  deleteAgentTemplate,
  fetchAgentTemplates,
  fetchDepartments,
  restoreAgentTemplate,
  updateAgentTemplate,
  type AgentTemplate,
  type CreateAgentTemplateInput,
  type Department,
  type UpdateAgentTemplateInput,
} from "./api";
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

/** 内置 id 集合：通过比对「显式自建」推断（custom 模板的 description/profile 可识别，但简化做法是
 *  保留服务端 delete 返回值识别；这里前端无足够上下文，所以一律按「能否撤销」靠 hidden 列表标记。
 *  为简洁，删除操作直接读 service 返回 kind 决定 UX；列表层不区分。 */

export default function Templates() {
  const [templates, setTemplates] = useState<AgentTemplate[] | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [recruitFrom, setRecruitFrom] = useState<AgentTemplate | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AgentTemplate | null>(null);

  function refresh() {
    fetchAgentTemplates()
      .then(setTemplates)
      .catch((err: any) => { message.error(err?.response?.data?.error || "加载模板失败"); setTemplates([]); });
  }
  useEffect(() => {
    refresh();
    fetchDepartments().then(setDepartments).catch(() => {});
  }, []);

  // 按部门分组（聚合到部门表顺序；空部门收起）。
  const grouped = useMemo(() => {
    if (!templates) return [] as Array<{ dept: Department; items: AgentTemplate[] }>;
    const byDept = new Map<string, AgentTemplate[]>();
    for (const t of templates) {
      const d = t.department || "other";
      if (!byDept.has(d)) byDept.set(d, []);
      byDept.get(d)!.push(t);
    }
    return departments
      .filter((d) => byDept.has(d.id))
      .map((d) => ({ dept: d, items: byDept.get(d.id)! }));
  }, [templates, departments]);

  async function handleDelete(tpl: AgentTemplate) {
    try {
      const result = await deleteAgentTemplate(tpl.id);
      if (result.kind === "hidden") {
        message.success({
          content: `已隐藏「${tpl.name}」（内置模板，可恢复）`,
          duration: 6,
          // 自带「撤销」按钮通过 message 不太自然，这里仅文案提示；恢复用「已隐藏」分页里的按钮。
        });
      } else {
        message.success(`已删除「${tpl.name}」`);
      }
      refresh();
    } catch (err: any) {
      message.error(err?.response?.data?.error || "删除失败");
    }
  }

  async function handleRestore(id: string, name: string) {
    try {
      await restoreAgentTemplate(id);
      message.success(`已恢复「${name}」`);
      refresh();
    } catch (err: any) {
      message.error(err?.response?.data?.error || "恢复失败");
    }
  }

  if (templates === null) return <div style={{ padding: 48, textAlign: "center" }}><Spin /></div>;

  return (
    <>
      <Space style={{ marginBottom: 12, justifyContent: "space-between", width: "100%" }}>
        <Typography.Paragraph type="secondary" style={{ maxWidth: 640, lineHeight: 1.6, marginBottom: 0 }}>
          员工模板按部门分组。「用此模板招募」预填档案进入招募向导；可新建自定义模板或编辑/删除现有模板（删除内置 = 隐藏，可恢复）。
        </Typography.Paragraph>
        <Button
          type="primary"
          shape="round"
          icon={<PlusOutlined />}
          onClick={() => { setEditing(null); setEditorOpen(true); }}
        >
          新建模板
        </Button>
      </Space>
      {grouped.length === 0 ? (
        <Empty description="暂无可用模板" />
      ) : (
        <Collapse defaultActiveKey={grouped.map((g) => g.dept.id)} ghost>
          {grouped.map(({ dept, items }) => (
            <Collapse.Panel
              key={dept.id}
              header={
                <Space>
                  <span style={{ fontSize: 18 }}>{dept.emoji}</span>
                  <Typography.Text strong style={{ fontSize: 15 }}>{dept.label}</Typography.Text>
                  <Tag>{items.length}</Tag>
                </Space>
              }
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {items.map((t) => (
                  <Card
                    key={t.id}
                    styles={{ body: { padding: "20px 24px" } }}
                    title={
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {t.emoji && <span style={{ fontSize: 18 }}>{t.emoji}</span>}
                        <span style={{ fontSize: 16, fontWeight: 600 }}>{t.name}</span>
                        <Tag color={ROLE_TAG[t.role]?.color}>{ROLE_TAG[t.role]?.label || t.role}</Tag>
                      </div>
                    }
                    extra={
                      <Space>
                        <Button icon={<EditOutlined />} onClick={() => { setEditing(t); setEditorOpen(true); }}>编辑</Button>
                        <Popconfirm
                          title={`确认删除「${t.name}」`}
                          description="内置模板将被隐藏（可恢复），自建模板将真删除。"
                          okText="删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          onConfirm={() => handleDelete(t)}
                        >
                          <Button icon={<DeleteOutlined />} danger>删除</Button>
                        </Popconfirm>
                        <Button type="primary" shape="round" icon={<PlusOutlined />} onClick={() => setRecruitFrom(t)}>用此模板招募</Button>
                      </Space>
                    }
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
            </Collapse.Panel>
          ))}
        </Collapse>
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
      {editorOpen && (
        <TemplateEditor
          open
          template={editing}
          departments={departments}
          existingIds={templates.map((t) => t.id)}
          onClose={() => { setEditorOpen(false); setEditing(null); }}
          onSaved={() => { setEditorOpen(false); setEditing(null); refresh(); }}
        />
      )}
    </>
  );
}

/** 模板新建/编辑弹窗。编辑模式下 id 锁定；新建时 id 必须唯一。 */
function TemplateEditor(props: {
  open: boolean;
  template: AgentTemplate | null;
  departments: Department[];
  existingIds: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { open, template, departments, existingIds, onClose, onSaved } = props;
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const isEdit = !!template;
  useEffect(() => {
    if (open) {
      form.resetFields();
      if (template) {
        form.setFieldsValue({
          id: template.id,
          name: template.name,
          role: template.role,
          description: template.description,
          emoji: template.emoji,
          department: template.department,
          profile: template.profile,
          suggestedSkills: template.suggestedSkills,
        });
      } else {
        form.setFieldsValue({ role: "employee", department: "other" });
      }
    }
  }, [open, template, form]);

  async function handleSubmit() {
    try {
      const values = await form.validateFields();
      setSaving(true);
      if (isEdit && template) {
        const patch: UpdateAgentTemplateInput = {
          name: values.name,
          role: values.role,
          description: values.description ?? "",
          emoji: values.emoji,
          department: values.department,
          profile: values.profile,
          suggestedSkills: Array.isArray(values.suggestedSkills) ? values.suggestedSkills : [],
        };
        await updateAgentTemplate(template.id, patch);
        message.success(`已保存「${values.name}」`);
      } else {
        const input: CreateAgentTemplateInput = {
          id: values.id,
          name: values.name,
          role: values.role,
          description: values.description ?? "",
          emoji: values.emoji,
          department: values.department,
          profile: values.profile,
          suggestedSkills: Array.isArray(values.suggestedSkills) ? values.suggestedSkills : [],
        };
        await createAgentTemplate(input);
        message.success(`已新建「${values.name}」`);
      }
      onSaved();
    } catch (err: any) {
      if (err?.errorFields) return; // 表单校验失败，已显示
      message.error(err?.response?.data?.error || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={isEdit ? "编辑模板" : "新建模板"}
      open={open}
      onCancel={onClose}
      onOk={handleSubmit}
      confirmLoading={saving}
      width={720}
      okText="保存"
      cancelText="取消"
      destroyOnClose
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item
          name="id"
          label="模板 ID"
          rules={[
            { required: true, message: "请填模板 ID" },
            { pattern: /^[a-z][a-z0-9-]{1,63}$/, message: "仅小写字母/数字/连字符，2-64 位，首字符须为字母" },
            ...(isEdit ? [] : [{
              validator: (_: unknown, value: string) =>
                existingIds.includes(value) ? Promise.reject(new Error("ID 已存在")) : Promise.resolve(),
            }]),
          ]}
          extra={isEdit ? "编辑模式下 ID 不可改" : "用于标识模板，保存后不可修改"}
        >
          <Input disabled={isEdit} placeholder="如 finance-clerk" />
        </Form.Item>
        <Form.Item name="name" label="模板名称" rules={[{ required: true, max: 120 }]}>
          <Input placeholder="如 财务出纳" />
        </Form.Item>
        <Form.Item name="emoji" label="Emoji（可选）">
          <Input placeholder="如 💼" maxLength={8} style={{ width: 120 }} />
        </Form.Item>
        <Form.Item name="department" label="部门" rules={[{ required: true }]}>
          <Select
            options={departments.map((d) => ({ value: d.id, label: `${d.emoji ? d.emoji + " " : ""}${d.label}` }))}
            placeholder="选择部门"
          />
        </Form.Item>
        <Form.Item name="role" label="系统权限级别" rules={[{ required: true }]}>
          <Select
            options={[
              { value: "employee", label: "员工" },
              { value: "admin", label: "管理员" },
            ]}
          />
        </Form.Item>
        <Form.Item name="description" label="一句话说明" rules={[{ max: 500 }]}>
          <Input placeholder="模板说明（向导下拉里会显示）" />
        </Form.Item>
        <Typography.Title level={5} style={{ marginTop: 16 }}>员工档案</Typography.Title>
        <Form.Item name={["profile", "jobTitle"]} label="岗位名" rules={[{ required: true, max: 60 }]}>
          <Input placeholder="如 出纳" />
        </Form.Item>
        <Form.Item name={["profile", "responsibilities"]} label="职责" rules={[{ required: true }]}>
          <Input.TextArea rows={3} placeholder="2-4 条职责要点（换行或分号分隔）" />
        </Form.Item>
        <Form.Item name={["profile", "personality"]} label="个性" rules={[{ required: true }]}>
          <Input placeholder="如 严谨, 细致, 守秘" />
        </Form.Item>
        <Form.Item name={["profile", "tone"]} label="沟通语气" rules={[{ required: true }]}>
          <Input placeholder="如 专业克制" />
        </Form.Item>
        <Form.Item name={["profile", "boundaries"]} label="工作边界" rules={[{ required: true }]}>
          <Input.TextArea rows={2} placeholder="如 不审批支付，仅记录与对账" />
        </Form.Item>
        <Form.Item name="suggestedSkills" label="建议技能（可选）">
          <Select
            mode="tags"
            tokenSeparators={[",", " "]}
            placeholder="按回车或逗号添加；招募时仅展示参考，不自动绑定"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
