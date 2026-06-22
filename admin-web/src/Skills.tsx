// 技能配置（ADR-015）：技能目录 CRUD（§1 可编辑化）+ 员工↔技能分配（§3）。
// 技能 ≠ 工具授权（正交两轴）：分配技能不会授予 knowledge_search 等工具，那是角色+知识库绑定的事。
// requiresKnowledge 的技能若员工未绑库，仅给「依赖未满足」提示，不阻断分配。
import { useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Card, Checkbox, Col, Drawer, Form, Input, Modal, Row, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography, message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { respWidth } from "./responsive";
import {
  awaitApplyJob, applyModeLabel, createSkill, deleteSkill, fetchAgents, fetchAgentSkills, fetchSkill, fetchSkills, generateSkillBody, jobIdOf, saveAgentSkills, updateSkill,
  type AgentRow, type Skill, type SkillAssignment, type SkillMeta, type SkillRole,
} from "./api";

const ROLE_LABEL: Record<SkillRole, string> = { employee: "员工", admin: "管理员" };

type Action = "create" | "edit" | null;

export default function Skills() {
  return (
    <Tabs
      defaultActiveKey="catalog"
      items={[
        { key: "catalog", label: "技能目录", children: <SkillCatalog /> },
        { key: "assign", label: "员工分配", children: <SkillAssignment /> },
      ]}
    />
  );
}

function SkillCatalog() {
  const [rows, setRows] = useState<SkillMeta[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<Action>(null);
  const [selected, setSelected] = useState<SkillMeta>();
  const [form] = Form.useForm();
  const [aiBusy, setAiBusy] = useState<"body" | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const [skills, agentRows] = await Promise.all([fetchSkills(), fetchAgents()]);
      setRows(skills); setAgents(agentRows);
    } catch (err: any) { message.error(err?.response?.data?.error || "加载失败"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, []);

  // 每个技能被多少员工引用
  const assignedCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of agents) for (const s of a.skills) m.set(s, (m.get(s) ?? 0) + 1);
    return m;
  }, [agents]);

  function open(next: Action, skill?: SkillMeta) {
    setAction(next); setSelected(skill);
    form.resetFields();
    if (skill) {
      form.setFieldsValue({ description: skill.description, requiredRole: skill.requiredRole ?? "", requiresKnowledge: skill.requiresKnowledge ?? false, body: "" });
      // 编辑时拉全文 body
      fetchSkill(skill.name).then((full) => form.setFieldValue("body", full.body)).catch(() => {});
    } else {
      form.setFieldsValue({ requiredRole: "", requiresKnowledge: false, body: "" });
    }
  }

  async function submit(values: any) {
    try {
      const body = values.body ?? "";
      const requiredRole = values.requiredRole ? (values.requiredRole as SkillRole) : undefined;
      if (action === "create") {
        await createSkill({ name: values.name, description: values.description, requiredRole, requiresKnowledge: values.requiresKnowledge, body });
        message.success("技能已创建");
      } else if (action === "edit" && selected) {
        await updateSkill(selected.name, { description: values.description, requiredRole: requiredRole ?? null, requiresKnowledge: values.requiresKnowledge, body });
        message.success("技能已保存");
      }
      setAction(null); await reload();
    } catch (err: any) { message.error(err?.response?.data?.error || err.message || "保存失败"); }
  }

  // AI 生成技能正文（design 重做：技能编辑加 AI）。仅填充正文，不自动保存；失败提示可手工填。
  async function aiGenerateBody() {
    const name = action === "edit" ? selected?.name : form.getFieldValue("name");
    if (!name) { message.warning("请先填写技能 ID"); return; }
    setAiBusy("body");
    try {
      const body = await generateSkillBody({
        name,
        description: form.getFieldValue("description"),
        hints: form.getFieldValue("hints"),
      });
      form.setFieldValue("body", body);
      message.success("已生成技能正文，请确认后保存");
    } catch (err: any) {
      message.error(err?.response?.data?.message || err?.response?.data?.error || "AI 生成不可用，请手工填写");
    } finally { setAiBusy(null); }
  }

  async function remove(skill: SkillMeta) {
    try {
      await deleteSkill(skill.name);
      message.success("技能已删除");
      await reload();
    } catch (err: any) {
      const data = err?.response?.data;
      if (data?.code === "SKILL_IN_USE") {
        message.error(`技能被以下数字员工引用，请先在「员工分配」解绑：${(data.referencedBy || []).join(", ")}`);
      } else {
        message.error(data?.error || err.message || "删除失败");
      }
    }
  }

  const columns: ColumnsType<SkillMeta> = [
    {
      title: "技能", render: (_, r) => (<><b>{r.name}</b><br /><Typography.Text type="secondary">{r.description}</Typography.Text></>),
    },
    { title: "角色要求", width: 110, align: "center", render: (_, r) => r.requiredRole ? <Tag color="purple">{ROLE_LABEL[r.requiredRole]}</Tag> : <Tag>不限</Tag> },
    { title: "依赖知识库", width: 120, align: "center", render: (_, r) => r.requiresKnowledge ? <Tag color="orange">是</Tag> : <Tag>否</Tag> },
    { title: "已分配员工", width: 120, align: "center", render: (_, r) => assignedCount.get(r.name) ?? 0 },
    {
      title: "操作", width: 180, align: "center", render: (_, r) => (<Space wrap={false}>
        <Button size="small" onClick={() => open("edit", r)}>编辑</Button>
        <Button danger size="small" disabled={(assignedCount.get(r.name) ?? 0) > 0} onClick={() => Modal.confirm({
          title: `删除技能 ${r.name}？`,
          content: "删除后不可恢复；被员工引用的技能需先在「员工分配」页解绑。",
          async onOk() { await remove(r); },
        })}>删除</Button>
      </Space>),
    },
  ];

  return <>
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>技能配置</Typography.Title>
          <Typography.Text type="secondary">管理技能（markdown 能力提示词），并分配给数字员工。技能 ≠ 工具授权。</Typography.Text>
        </div>
        <Button type="primary" shape="round" onClick={() => open("create")}>新建技能</Button>
      </div>
      <Table rowKey="name" loading={loading} columns={columns} dataSource={rows} pagination={false}
        tableLayout="fixed" scroll={{ x: 880 }} />
    </Space>
    <Drawer title={action === "create" ? "新建技能" : "编辑技能"} open={Boolean(action)} onClose={() => setAction(null)} width={respWidth(560)}
      extra={<Button type="primary" shape="round" onClick={() => form.submit()}>保存</Button>}>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item name="name" label="技能 ID" rules={[{ required: true, pattern: /^[a-z0-9][a-z0-9_-]*$/, message: "小写字母/数字/连字符/下划线，首字符须字母或数字" }]}>
          <Input disabled={action === "edit"} placeholder="如 hr-policy-qa" />
        </Form.Item>
        <Form.Item name="description" label="描述（路由提示词）" rules={[{ required: true, message: "description 不能为空" }]}>
          <Input.TextArea rows={2} maxLength={500} showCount placeholder="喂给 LLM 决定何时触发该技能" />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="requiredRole" label="角色要求">
              <Select allowClear placeholder="不限">
                <Select.Option value="employee">员工（employee）</Select.Option>
                <Select.Option value="admin">管理员（admin）</Select.Option>
              </Select>
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="requiresKnowledge" label="依赖知识库绑定" valuePropName="checked" tooltip="勾选后，分配给未绑定知识库的员工时会提示「依赖未满足」，但不阻断分配">
              <Switch />
            </Form.Item>
          </Col>
        </Row>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", background: "#e8f1fd", borderRadius: 10, padding: "12px 14px", marginBottom: 16, fontSize: 13, color: "#48484a" }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(135deg,#0a84ff,#0071e3)", flex: "none" }} />
          <div>用 AI 根据技能用途生成行为约定正文——描述触发场景与期望行为，AI 写成规范 Markdown（先检索 / 按来源引用 / 未命中不编造等）。生成内容只写入正文，可逐段再改，不改系统红线（AGENTS/TOOLS/MEMORY）。</div>
        </div>
        <Form.Item name="hints" label="一句话描述这个技能要做什么（可选）">
          <Input.TextArea rows={2} maxLength={400} placeholder="如：员工问考勤/假期/福利政策时触发，先检索知识库按来源引用，未命中不编造" />
        </Form.Item>
        <div style={{ marginBottom: 16 }}>
          <Button type="primary" shape="round" loading={aiBusy === "body"} onClick={aiGenerateBody}>AI 生成技能正文</Button>
          <Typography.Text type="secondary" style={{ marginLeft: 12 }}>会填入下方正文，可生成后再改</Typography.Text>
        </div>
        <Form.Item name="body" tooltip="frontmatter 之外的正文；name/description/requiredRole/requiresKnowledge 由上方表单维护，请勿在正文里重复写 frontmatter"
          label={<Space>技能正文（Markdown）<Button type="link" size="small" loading={aiBusy === "body"} onClick={aiGenerateBody}>AI 重新生成正文</Button></Space>}>
          <Input.TextArea rows={14} style={{ fontFamily: "monospace" }} placeholder="# 技能标题&#10;行为约定..." />
        </Form.Item>
      </Form>
    </Drawer>
  </>;
}

function SkillAssignment() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentId, setAgentId] = useState<string>();
  const [view, setView] = useState<SkillAssignment>();
  const [picked, setPicked] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { fetchAgents().then(setAgents).catch(() => {}); }, []);

  async function load(id: string) {
    setLoading(true);
    try {
      const v = await fetchAgentSkills(id);
      setView(v); setPicked(v.skills);
    } catch (err: any) { message.error(err?.response?.data?.error || "加载失败"); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (agentId) void load(agentId); else { setView(undefined); setPicked([]); } }, [agentId]);

  const currentAgent = agents.find((a) => a.id === agentId);
  const unmetSet = useMemo(() => new Set((view?.unmet ?? []).map((u) => u.skill)), [view]);

  async function save() {
    if (!agentId) return;
    setSaving(true);
    try {
      const data = await saveAgentSkills(agentId, picked);
      const jobId = jobIdOf(data);
      let mode: string | undefined;
      if (jobId) {
        const job = await awaitApplyJob(jobId);
        if (job.status !== "success") { message.error(`保存失败：${job.message || job.status}`); setSaving(false); return; }
        mode = (job.result as any)?.apply?.mode;
      }
      message.success(`技能分配已应用（${applyModeLabel(mode)}）`);
      await load(agentId);
    } catch (err: any) { message.error(err?.response?.data?.error || err.message || "保存失败"); }
    finally { setSaving(false); }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div>
        <Typography.Title level={3} style={{ margin: 0 }}>员工技能分配</Typography.Title>
        <Typography.Text type="secondary">选择数字员工 → 勾选技能 → 保存即应用。角色不兼容的技能不可选；依赖知识库的技能未绑库时仅提示。</Typography.Text>
      </div>
      <Card>
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Form layout="inline">
            <Form.Item label="数字员工" style={{ minWidth: 360 }}>
              <Select
                showSearch optionFilterProp="label"
                placeholder="选择数字员工"
                value={agentId}
                onChange={setAgentId}
                options={agents.map((a) => ({ label: `${a.name}（${a.profile?.jobTitle || a.id} · ${ROLE_LABEL[a.role]}）`, value: a.id }))}
              />
            </Form.Item>
          </Form>
          {!agentId ? (
            <Typography.Text type="secondary">请先选择数字员工。</Typography.Text>
          ) : loading ? (
            <Typography.Text>加载中…</Typography.Text>
          ) : view && (
            <>
              <Alert
                type="info" showIcon
                message={`当前员工角色：${ROLE_LABEL[currentAgent?.role ?? "employee"]}`}
                description="管理类技能（requiredRole=admin）仅 admin 角色员工可分配。分配技能不等于授予工具——knowledge_search 等由知识库绑定授予。"
              />
              {view.unmet.length > 0 && (
                <Alert
                  type="warning" showIcon
                  message="依赖未满足"
                  description={view.unmet.map((u) => `${u.skill}：${u.reason}`).join("；")}
                />
              )}
              {view.warnings?.map((w) => (
                <Alert
                  key={w.code}
                  type="warning" showIcon
                  message="技能与知识库绑定不匹配"
                  description={w.message}
                />
              ))}
              <Table
                rowKey="name" size="small" pagination={false} loading={loading}
                dataSource={view.available}
                columns={[
                  {
                    title: "分配", width: 64,
                    render: (_, r) => {
                      const incompat = r.requiredRole === "admin" && currentAgent?.role !== "admin";
                      if (incompat) {
                        return <Tooltip title={`仅 ${ROLE_LABEL[r.requiredRole!]} 角色可分配`}><Checkbox disabled /></Tooltip>;
                      }
                      return <Checkbox checked={picked.includes(r.name)} onChange={(e) => {
                        setPicked(e.target.checked ? [...picked, r.name] : picked.filter((s) => s !== r.name));
                      }} />;
                    },
                  },
                  { title: "技能", render: (_, r) => (<><b>{r.name}</b>{unmetSet.has(r.name) && <Tag color="orange" style={{ marginLeft: 8 }}>依赖未满足</Tag>}<br /><Typography.Text type="secondary">{r.description}</Typography.Text></>) },
                  { title: "角色要求", width: 110, render: (_, r) => r.requiredRole ? <Tag color="purple">{ROLE_LABEL[r.requiredRole]}</Tag> : <Tag>不限</Tag> },
                  { title: "依赖知识库", width: 110, render: (_, r) => r.requiresKnowledge ? <Tag color="orange">是</Tag> : <Tag>否</Tag> },
                ]}
                scroll={{ x: 700 }}
              />
              <div>
                <Space>
                  <Button type="primary" shape="round" loading={saving} onClick={save}>保存并应用</Button>
                  <Typography.Text type="secondary">已选 {picked.length} 项</Typography.Text>
                </Space>
              </div>
            </>
          )}
        </Space>
      </Card>
    </Space>
  );
}
