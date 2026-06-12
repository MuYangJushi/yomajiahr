// 知识库页（ADR-008：B + 多库层）。结构：顶部平台健康条 + [库列表 ⇄ 单库详情]。
// 库列表：GET /knowledge/bases + [新建知识库]（原生，走 #45，审计 CREATE_KB）。
// 单库详情：① 平台视图（#46 反代 iframe 嵌 FastGPT 整套 UI，按 datasetId 限定，做文档/切片/向量化）；
//          ② 召回测试（原生，按本库 datasetId）；③ 绑定数字员工。
import { useEffect, useState } from "react";
import {
  Alert, Button, Card, Empty, Form, Input, List, Modal, Select, Space, Spin, Switch, Tabs, Tag, message,
} from "antd";
import { ArrowLeftOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import {
  createKnowledgeBase,
  fastgptConsoleUrl,
  fetchKnowledgeBases,
  fetchKnowledgeBindings,
  fetchKnowledgeHealth,
  saveKnowledgeBindings,
  searchTest,
  type AgentRow,
  type KbChunk,
  type KnowledgeBinding,
  type KnowledgeHealth,
} from "./api";

function HealthBanner({ health, onRefresh }: { health: KnowledgeHealth | null; onRefresh: () => void }) {
  if (!health) return <Spin />;
  const ok = health.platform === "fastgpt" && health.configured && health.reachable;
  const type = ok ? "success" : health.platform === "local" ? "info" : "warning";
  const title = ok
    ? `● FastGPT 已连接 · 默认 KB ${health.kbId ?? "—"} · 索引 ${health.indexStatus}`
    : health.platform === "local"
      ? "● 知识库平台未启用 FastGPT"
      : "● FastGPT 不可用 · 知识库暂时不可用（无本地回退）";
  return (
    <Alert
      type={type}
      showIcon
      message={title}
      description={
        <Space size="large" wrap>
          <span>地址 {health.baseUrlHint ?? "（未配置）"}</span>
          <span>embedding {health.embeddingModel ?? "—"}</span>
          <span>回退 无（FastGPT 唯一知识源）</span>
          {health.message && <span style={{ color: "#888" }}>{health.message}</span>}
        </Space>
      }
      action={
        <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh}>
          刷新
        </Button>
      }
      style={{ marginBottom: 16 }}
    />
  );
}

function NewKbModal({
  open, agents, onClose, onCreated,
}: {
  open: boolean;
  agents: AgentRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await createKnowledgeBase(values);
      message.success("知识库已创建");
      form.resetFields();
      onCreated();
      onClose();
    } catch (e: any) {
      message.error(e?.response?.data?.error || "创建失败（需 admin 权限）");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Modal
      title="新建知识库"
      open={open}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={submitting}
      okText="创建"
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入知识库名称" }]}>
          <Input placeholder="如：HR 制度知识库" />
        </Form.Item>
        <Form.Item name="intro" label="简介">
          <Input.TextArea rows={2} placeholder="（可选）" />
        </Form.Item>
        <Form.Item name="boundAgents" label="绑定数字员工" tooltip="哪些数字员工可检索本库">
          <Select
            mode="multiple"
            allowClear
            placeholder="（可稍后在详情页绑定）"
            options={agents.map((a) => ({ value: a.id, label: `${a.name} (${a.id})` }))}
          />
        </Form.Item>
        <Form.Item
          name="restricted"
          label="受限库"
          valuePropName="checked"
          tooltip="受限库（薪酬/绩效等）的文档列表与切片预览仅管理员可见"
        >
          <Switch />
        </Form.Item>
      </Form>
      <Alert
        type="info"
        showIcon
        message="新建库会在 FastGPT 创建数据集并登记到平台（审计 CREATE_KB）。创建后到详情页「平台视图」导入文档与切片向量化。"
      />
    </Modal>
  );
}

function KbList({ onSelect }: { onSelect: (kb: KnowledgeBinding) => void }) {
  const [bases, setBases] = useState<KnowledgeBinding[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  const load = () => {
    setLoading(true);
    fetchKnowledgeBases()
      .then(({ bases, agents }) => {
        setBases(bases);
        setAgents(agents);
      })
      .catch(() => message.error("加载知识库列表失败"))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const columns: ProColumns<KnowledgeBinding>[] = [
    {
      title: "名称",
      dataIndex: "name",
      render: (_, r) => (
        <Space>
          <a onClick={() => onSelect(r)}>{r.name}</a>
          {r.restricted && <Tag color="volcano">受限</Tag>}
        </Space>
      ),
    },
    {
      title: "平台",
      dataIndex: "provider",
      width: 110,
      render: (_, r) => <Tag color={r.provider === "fastgpt" ? "blue" : "default"}>{r.provider}</Tag>,
    },
    { title: "外部 KB ID", dataIndex: "externalKbId", copyable: true, render: (_, r) => r.externalKbId || "—" },
    {
      title: "绑定数字员工",
      render: (_, r) => (r.boundAgents.length ? r.boundAgents.map((a) => <Tag key={a}>{a}</Tag>) : "—"),
    },
    {
      title: "操作",
      width: 100,
      render: (_, r) => (
        <a onClick={() => onSelect(r)}>进入</a>
      ),
    },
  ];

  return (
    <>
      <ProTable<KnowledgeBinding>
        headerTitle="知识库列表"
        rowKey="id"
        loading={loading}
        search={false}
        pagination={false}
        options={{ reload: () => load(), density: false, setting: false }}
        columns={columns}
        dataSource={bases}
        toolBarRender={() => [
          <Button key="new" type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
            新建知识库
          </Button>,
        ]}
      />
      <NewKbModal open={modalOpen} agents={agents} onClose={() => setModalOpen(false)} onCreated={load} />
    </>
  );
}

function SearchTestTab({ datasetId }: { datasetId?: string }) {
  const [query, setQuery] = useState("");
  const [chunks, setChunks] = useState<KbChunk[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");

  const run = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setErr("");
    try {
      setChunks(await searchTest(query.trim(), 5, datasetId));
    } catch (e: any) {
      setChunks(null);
      setErr(e?.response?.data?.error || "召回测试失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <Space.Compact style={{ width: "100%", maxWidth: 720 }}>
        <Input
          placeholder="输入员工问题，如：年假怎么申请？"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onPressEnter={run}
        />
        <Button type="primary" icon={<SearchOutlined />} loading={loading} onClick={run}>
          测试
        </Button>
      </Space.Compact>
      <div style={{ marginTop: 16 }}>
        {err && <Alert type="warning" showIcon message={err} />}
        {!err && chunks === null && <Empty description="输入查询后测试本库召回" />}
        {chunks && (
          <List
            dataSource={chunks}
            renderItem={(c, i) => (
              <List.Item>
                <List.Item.Meta
                  title={
                    <Space>
                      <Tag color="blue">#{i + 1}</Tag>
                      <span>score {c.score.toFixed(2)}</span>
                      <span>
                        {c.source.filename}
                        {c.source.doc_id && ` · ${c.source.doc_id}`}
                        {c.source.version && ` v${c.source.version}`}
                      </span>
                    </Space>
                  }
                  description={c.text}
                />
              </List.Item>
            )}
          />
        )}
      </div>
    </Card>
  );
}

function KbBindingTab({ kb }: { kb: KnowledgeBinding }) {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [bound, setBound] = useState<string[]>(kb.boundAgents);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchKnowledgeBindings().then(({ agents }) => setAgents(agents)).catch(() => {});
  }, []);

  const toggle = (agentId: string) =>
    setBound((b) => (b.includes(agentId) ? b.filter((a) => a !== agentId) : [...b, agentId]));

  const save = async () => {
    setSaving(true);
    try {
      // 取全量 store，替换本库的 boundAgents 后整体保存（saveKnowledgeBindings 收全量）。
      const { store } = await fetchKnowledgeBindings();
      store.knowledgeBases = store.knowledgeBases.map((b) =>
        b.id === kb.id ? { ...b, boundAgents: bound } : b,
      );
      await saveKnowledgeBindings(store);
      message.success("绑定已保存");
    } catch {
      message.error("保存失败（需 admin 权限）");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="哪些数字员工可检索本知识库"
      extra={<Button type="primary" loading={saving} onClick={save}>保存绑定</Button>}
    >
      <Space wrap>
        {agents.map((a) => (
          <Tag.CheckableTag key={a.id} checked={bound.includes(a.id)} onChange={() => toggle(a.id)}>
            {a.name} ({a.id})
          </Tag.CheckableTag>
        ))}
      </Space>
      <Alert
        style={{ marginTop: 16 }}
        type="info"
        showIcon
        message="受限分类（compensation/performance）即使绑定，员工侧仍在回答层拦截（hr-policy-qa 数据分级）"
      />
    </Card>
  );
}

function PlatformViewTab({ kb }: { kb: KnowledgeBinding }) {
  if (kb.provider !== "fastgpt" || !kb.externalKbId) {
    return <Empty description="本库非 FastGPT 库，无平台视图" />;
  }
  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="下方为嵌入的 FastGPT 平台（经 :19450 反代）——在此导入文档、查看分段切片与向量化/训练进度。"
        description="若显示空白或登录页：需先放行 19450 端口，且（未配 SSO 时）在此登录一次 FastGPT。"
      />
      <iframe
        title="FastGPT 平台视图"
        src={fastgptConsoleUrl(kb.externalKbId)}
        style={{ width: "100%", height: "72vh", border: "1px solid #f0f0f0", borderRadius: 6 }}
      />
    </div>
  );
}

function KbDetail({ kb, onBack }: { kb: KnowledgeBinding; onBack: () => void }) {
  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={onBack}>
          返回列表
        </Button>
        <strong style={{ fontSize: 16 }}>{kb.name}</strong>
        <Tag color={kb.provider === "fastgpt" ? "blue" : "default"}>{kb.provider}</Tag>
        {kb.restricted && <Tag color="volcano">受限（仅管理员可见内容）</Tag>}
        {kb.externalKbId && <span style={{ color: "#888" }}>KB ID: {kb.externalKbId}</span>}
      </Space>
      <Tabs
        items={[
          { key: "platform", label: "平台视图（导入/切片/向量化）", children: <PlatformViewTab kb={kb} /> },
          { key: "search", label: "召回测试", children: <SearchTestTab datasetId={kb.externalKbId} /> },
          { key: "bindings", label: "绑定数字员工", children: <KbBindingTab kb={kb} /> },
        ]}
      />
    </div>
  );
}

export default function Knowledge() {
  const [health, setHealth] = useState<KnowledgeHealth | null>(null);
  const [selected, setSelected] = useState<KnowledgeBinding | null>(null);

  const load = () => {
    fetchKnowledgeHealth().then(setHealth).catch(() => setHealth(null));
  };
  useEffect(load, []);

  return (
    <div>
      <HealthBanner health={health} onRefresh={load} />
      {selected ? (
        <KbDetail kb={selected} onBack={() => setSelected(null)} />
      ) : (
        <KbList onSelect={setSelected} />
      )}
    </div>
  );
}
