// 知识库页（ADR-008：B + 多库层）。结构：顶部平台健康条 + [库列表 ⇄ 单库详情]。
// 库列表：GET /knowledge/bases + [新建知识库]（原生，走 #45，审计 CREATE_KB）。
// 单库详情：① 平台视图（项目原生 UI，经 admin-server 调 FastGPT API，做导入/切片/向量化管理）；
//          ② 召回测试（原生，按本库 datasetId）；③ 绑定数字员工。
import { useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Card, Checkbox, Drawer, Empty, Form, Input, List, Modal, Popconfirm, Select, Space, Spin, Switch,
  Table, Tabs, Tag, Typography, Upload, message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  ArrowLeftOutlined, DeleteOutlined, EyeOutlined, InboxOutlined, PlusOutlined, ReloadOutlined, SearchOutlined,
} from "@ant-design/icons";
import {
  awaitApplyJob,
  createKnowledgeBase,
  deleteKnowledgeCollection,
  fetchCollectionChunks,
  fetchKnowledgeBases,
  fetchKnowledgeBindings,
  fetchKnowledgeCollections,
  fetchKnowledgeHealth,
  fetchSkills,
  saveKnowledgeBindings,
  searchTest,
  uploadKnowledgeDocument,
  type AgentRow,
  type KbChunk,
  type KbChunkPreview,
  type KbCollection,
  type KnowledgeBinding,
  type KnowledgeHealth,
  type SkillMeta,
} from "./api";
import { PageTopbar, TableCard } from "./shell";

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
        <Button size="small" shape="round" icon={<ReloadOutlined />} onClick={onRefresh}>
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

  const columns: ColumnsType<KnowledgeBinding> = [
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
    {
      title: "外部 KB ID",
      dataIndex: "externalKbId",
      render: (_, r) => r.externalKbId
        ? <Typography.Text copyable style={{ color: "#48484a" }}>{r.externalKbId}</Typography.Text>
        : "—",
    },
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
      <PageTopbar
        title="知识库列表"
        right={
          <>
            <Button shape="round" icon={<ReloadOutlined />} onClick={load} />
            <Button type="primary" shape="round" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
              新建知识库
            </Button>
          </>
        }
      />
      <TableCard>
        <Table<KnowledgeBinding>
          rowKey="id"
          loading={loading}
          dataSource={bases}
          columns={columns}
          pagination={false}
        />
      </TableCard>
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

const BIND_ROLE_TAG: Record<AgentRow["role"], { color: string; label: string }> = {
  employee: { color: "purple", label: "员工" },
  admin: { color: "blue", label: "管理员" },
};

// 绑定数字员工 tab（design 重做：表格版）。每行直观呈现角色、知识问答技能配套、受限分类处理。
// 数据派生：知识问答技能 = agent.skills ∩ {requiresKnowledge 技能}；受限分类 = kb.restricted + agent.role。
function KbBindingTab({ kb }: { kb: KnowledgeBinding }) {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [skillsMeta, setSkillsMeta] = useState<SkillMeta[]>([]);
  const [bound, setBound] = useState<string[]>(kb.boundAgents);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([fetchKnowledgeBindings(), fetchSkills()])
      .then(([{ agents }, skills]) => { setAgents(agents); setSkillsMeta(skills); })
      .catch(() => {});
  }, []);

  // 知识问答类技能名集合（requiresKnowledge=true），用于判断员工是否具备问答行为规范。
  const kbSkillNames = useMemo(
    () => new Set(skillsMeta.filter((s) => s.requiresKnowledge).map((s) => s.name)),
    [skillsMeta],
  );
  const qaSkillsOf = (a: AgentRow) => a.skills.filter((s) => kbSkillNames.has(s));

  const toggle = (agentId: string) =>
    setBound((b) => (b.includes(agentId) ? b.filter((a) => a !== agentId) : [...b, agentId]));

  // 已勾选绑定但无知识问答技能 → 依赖未满足提示（ADR-016 §5.1，只提示不自动修复）。
  const unmet = useMemo(
    () => agents.filter((a) => bound.includes(a.id) && qaSkillsOf(a).length === 0),
    [agents, bound, kbSkillNames],
  );

  const save = async () => {
    setSaving(true);
    try {
      // 取全量 store，替换本库的 boundAgents 后整体保存（saveKnowledgeBindings 收全量）。
      const { store } = await fetchKnowledgeBindings();
      store.knowledgeBases = store.knowledgeBases.map((b) =>
        b.id === kb.id ? { ...b, boundAgents: bound } : b,
      );
      const result = await saveKnowledgeBindings(store);
      if (result.jobId) {
        // 异步 apply：立即解除按钮 loading + 提示"应用中"，后台轮询完成后替换提示。
        const key = `apply-${result.jobId}`;
        message.loading({ content: "绑定提交，配置应用中…", key, duration: 0 });
        setSaving(false);
        const job = await awaitApplyJob(result.jobId);
        if (job.status === "success") message.success({ content: "绑定已保存并应用", key });
        else message.error({ content: `绑定保存失败：${job.message || job.status}`, key, duration: 6 });
        return;
      }
      message.success("绑定已保存");
    } catch {
      message.error("保存失败（需 admin 权限）");
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<AgentRow> = [
    {
      title: "绑定", width: 64,
      render: (_, a) => <Checkbox checked={bound.includes(a.id)} onChange={() => toggle(a.id)} />,
    },
    {
      title: "数字员工",
      render: (_, a) => (
        <Space direction="vertical" size={2}>
          <Space>
            <b>{a.name}</b>
            <Typography.Text type="secondary" style={{ fontFamily: "'SF Mono', Menlo, monospace", fontSize: 13 }}>{a.id}</Typography.Text>
            {bound.includes(a.id) && qaSkillsOf(a).length === 0 && <Tag color="orange">依赖未满足</Tag>}
          </Space>
          <Typography.Text type="secondary">{a.profile?.jobTitle || "未填写岗位"}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "角色", width: 110,
      render: (_, a) => <Tag color={BIND_ROLE_TAG[a.role].color}>{BIND_ROLE_TAG[a.role].label}</Tag>,
    },
    {
      title: "知识问答技能", width: 200,
      render: (_, a) => {
        const qa = qaSkillsOf(a);
        if (qa.length) return <Tag color="success">已配 {qa.join("、")}</Tag>;
        return <Tag color={bound.includes(a.id) ? "orange" : "default"}>未分配</Tag>;
      },
    },
    {
      title: "受限分类", width: 130,
      render: (_, a) => {
        if (!kb.restricted) return <Tag>无</Tag>;
        return a.role === "admin" ? <Tag>不限</Tag> : <Tag color="error">回答层拦截</Tag>;
      },
    },
  ];

  return (
    <div>
      <PageTopbar
        title="绑定数字员工"
        sub="勾选可检索本知识库的数字员工 → 保存即生效。绑定授予 knowledge_search 检索工具；是否能正确问答还取决于该员工是否分配了知识问答类技能。"
      />
      <div style={{ maxWidth: 420, marginBottom: 16 }}>
        <Typography.Text type="secondary" style={{ display: "block", marginBottom: 6 }}>知识库</Typography.Text>
        <div style={{ border: "1px solid #d9d9d9", borderRadius: 8, padding: "8px 11px", color: "#1d1d1f" }}>
          {kb.name}（{kb.provider}{kb.externalKbId ? ` · KB ${kb.externalKbId}` : ""}）
        </div>
      </div>
      <Alert
        type="info" showIcon style={{ marginBottom: 16 }}
        message="绑定 ≠ 授予问答能力"
        description="绑定仅授予 knowledge_search 检索工具。受限分类（compensation/performance）即使绑定，员工侧仍在回答层拦截（hr-policy-qa 数据分级）。"
      />
      {unmet.length > 0 && (
        <Alert
          type="warning" showIcon style={{ marginBottom: 16 }}
          message="依赖未满足"
          description={`${unmet.map((a) => `「${a.name}」`).join("、")}已勾选本库，但未分配 hr-policy-qa 等知识问答类技能，运行时可访问检索工具但缺问答规范（ADR-016 §5.1）。`}
        />
      )}
      <TableCard>
        <Table<AgentRow> rowKey="id" dataSource={agents} columns={columns} pagination={false} />
      </TableCard>
      <div style={{ marginTop: 16 }}>
        <Button type="primary" shape="round" loading={saving} onClick={save}>保存绑定</Button>
        <Typography.Text type="secondary" style={{ marginLeft: 12 }}>已绑定 {bound.length} 个员工</Typography.Text>
      </div>
    </div>
  );
}

function PlatformViewTab({ kb }: { kb: KnowledgeBinding }) {
  type PlatformCollection = KbCollection & { pendingStatus?: "uploading" | "processing" };
  const datasetId = kb.externalKbId || "";
  const [collections, setCollections] = useState<KbCollection[]>([]);
  const [pending, setPending] = useState<PlatformCollection[]>([]);
  const [loading, setLoading] = useState(false);
  const [chunkOpen, setChunkOpen] = useState(false);
  const [chunkTitle, setChunkTitle] = useState("");
  const [chunks, setChunks] = useState<KbChunkPreview[]>([]);
  const [chunkLoading, setChunkLoading] = useState(false);

  const load = async (silent = false) => {
    if (!datasetId) return;
    if (!silent) setLoading(true);
    try {
      const next = (await fetchKnowledgeCollections(datasetId)).collections;
      setCollections(next);
      const visibleIds = new Set(next.map((item) => item.externalDocId));
      setPending((items) => items.filter((item) => !visibleIds.has(item.externalDocId)));
    } catch (e: any) {
      if (!silent) message.error(e?.response?.data?.error || "加载文档列表失败");
    } finally {
      if (!silent) setLoading(false);
    }
  };
  useEffect(() => {
    if (kb.provider === "fastgpt" && datasetId) void load();
  }, [datasetId]);
  useEffect(() => {
    if (pending.length === 0 && !collections.some((item) => item.indexStatus === "indexing")) return;
    const timer = window.setInterval(() => void load(true), 3000);
    return () => window.clearInterval(timer);
  }, [datasetId, pending.length, collections]);

  if (kb.provider !== "fastgpt" || !datasetId) {
    return <Empty description="本库非 FastGPT 库，无平台视图" />;
  }

  const showChunks = async (collection: KbCollection) => {
    setChunkTitle(collection.title);
    setChunkOpen(true);
    setChunkLoading(true);
    try {
      setChunks((await fetchCollectionChunks(collection.externalDocId, 0, 100)).chunks);
    } catch (e: any) {
      setChunks([]);
      message.error(e?.response?.data?.error || "加载切片失败");
    } finally {
      setChunkLoading(false);
    }
  };

  const remove = async (collection: KbCollection) => {
    try {
      await deleteKnowledgeCollection(collection.externalDocId, datasetId);
      message.success(`已删除「${collection.title}」`);
      await load();
    } catch (e: any) {
      message.error(e?.response?.data?.error || "删除失败");
    }
  };

  const status = (row: PlatformCollection) => {
    if (row.pendingStatus === "uploading") return <Tag color="processing">上传中</Tag>;
    if (row.pendingStatus === "processing") return <Tag color="processing">已上传，等待 FastGPT 处理</Tag>;
    const map = {
      ready: { color: "success", label: "向量化完成" },
      indexing: { color: "processing", label: "向量化中" },
      error: { color: "error", label: "处理失败" },
      unknown: { color: "default", label: "等待处理" },
      "local-archive": { color: "default", label: "本地归档" },
    } as const;
    const item = map[row.indexStatus];
    return <Tag color={item.color}>{item.label}</Tag>;
  };

  const columns: ColumnsType<PlatformCollection> = [
    { title: "文档", dataIndex: "title", ellipsis: true },
    { title: "切片数", dataIndex: "chunkCount", width: 100, render: (_, row) => row.chunkCount ?? "—" },
    { title: "状态", dataIndex: "indexStatus", width: 220, render: (_, row) => status(row) },
    {
      title: "操作",
      width: 180,
      render: (_, row) => (
        <Space>
          <Button type="link" size="small" icon={<EyeOutlined />} disabled={Boolean(row.pendingStatus)} onClick={() => void showChunks(row)}>
            查看切片
          </Button>
          <Popconfirm title={`确认删除「${row.title}」？`} disabled={Boolean(row.pendingStatus)} onConfirm={() => void remove(row)}>
            <Button type="link" danger size="small" disabled={Boolean(row.pendingStatus)} icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Upload.Dragger
        accept=".pdf,.docx,.doc,.txt,.md,.markdown,.html,.csv,.pptx,.xlsx"
        multiple
        showUploadList={false}
        customRequest={async ({ file, onSuccess, onError }) => {
          const uploadFile = file as File;
          const temporaryId = `uploading-${crypto.randomUUID()}`;
          setPending((items) => [
            { externalDocId: temporaryId, title: uploadFile.name, source: "fastgpt", indexStatus: "unknown", pendingStatus: "uploading" },
            ...items,
          ]);
          try {
            const result = await uploadKnowledgeDocument(uploadFile, datasetId);
            setPending((items) => items.map((item) => item.externalDocId === temporaryId
              ? { ...item, externalDocId: result.collectionId, title: result.file, pendingStatus: "processing" }
              : item));
            message.success(`已上传「${result.file}」，FastGPT 正在解析和向量化`);
            onSuccess?.({});
            await load(true);
          } catch (e: any) {
            setPending((items) => items.filter((item) => item.externalDocId !== temporaryId));
            message.error(e?.response?.data?.error || `导入「${uploadFile.name}」失败`);
            onError?.(e);
          }
        }}
        style={{ marginBottom: 16 }}
      >
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">点击或拖拽文档到此处导入</p>
        <p className="ant-upload-hint">原始文件由 FastGPT 解析、切片并向量化，完成状态可在下方查看。</p>
      </Upload.Dragger>
      <PageTopbar
        title={<span style={{ fontSize: 16 }}>文档与向量化状态</span>}
        right={<Button shape="round" icon={<ReloadOutlined />} onClick={() => void load()} />}
      />
      <TableCard>
        <Table<PlatformCollection>
          rowKey="externalDocId"
          loading={loading}
          dataSource={[...pending, ...collections]}
          columns={columns}
          pagination={false}
        />
      </TableCard>
      <Drawer title={`切片预览 · ${chunkTitle}`} width={720} open={chunkOpen} onClose={() => setChunkOpen(false)}>
        {chunkLoading ? <Spin /> : (
          <List
            locale={{ emptyText: "暂无切片" }}
            dataSource={chunks}
            renderItem={(chunk) => (
              <List.Item>
                <List.Item.Meta
                  title={<Tag>#{chunk.chunkIndex + 1}</Tag>}
                  description={
                    <Space direction="vertical" style={{ width: "100%" }}>
                      <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
                        {chunk.q || "（空切片）"}
                      </Typography.Paragraph>
                      {chunk.a && <Typography.Text type="secondary">{chunk.a}</Typography.Text>}
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Drawer>
    </>
  );
}

type KnowledgeTab = "platform" | "search" | "bindings";

function KbDetail({
  kb,
  activeTab,
  onTabChange,
  onBack,
}: {
  kb: KnowledgeBinding;
  activeTab: KnowledgeTab;
  onTabChange: (tab: KnowledgeTab) => void;
  onBack: () => void;
}) {
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
        activeKey={activeTab}
        onChange={(key) => onTabChange(key as KnowledgeTab)}
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
  const [activeTab, setActiveTab] = useState<KnowledgeTab>("platform");

  const load = () => {
    fetchKnowledgeHealth().then(setHealth).catch(() => setHealth(null));
  };
  useEffect(load, []);
  const syncFromUrl = async () => {
    const params = new URLSearchParams(window.location.search);
    const kbId = params.get("kb");
    const tab = params.get("tab");
    setActiveTab(tab === "search" || tab === "bindings" ? tab : "platform");
    if (!kbId) {
      setSelected(null);
      return;
    }
    try {
      const { bases } = await fetchKnowledgeBases();
      setSelected(bases.find((base) => base.id === kbId) || null);
    } catch {
      setSelected(null);
    }
  };
  useEffect(() => {
    void syncFromUrl();
    const onPopState = () => void syncFromUrl();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const writeUrl = (kb?: KnowledgeBinding, tab: KnowledgeTab = "platform") => {
    const url = new URL(window.location.href);
    if (kb) {
      url.searchParams.set("kb", kb.id);
      url.searchParams.set("tab", tab);
    } else {
      url.searchParams.delete("kb");
      url.searchParams.delete("tab");
    }
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
  };

  const selectKb = (kb: KnowledgeBinding) => {
    setSelected(kb);
    setActiveTab("platform");
    writeUrl(kb);
  };

  const changeTab = (tab: KnowledgeTab) => {
    setActiveTab(tab);
    if (selected) writeUrl(selected, tab);
  };

  const back = () => {
    setSelected(null);
    setActiveTab("platform");
    writeUrl();
  };

  return (
    <div>
      <HealthBanner health={health} onRefresh={load} />
      {selected ? (
        <KbDetail kb={selected} activeTab={activeTab} onTabChange={changeTab} onBack={back} />
      ) : (
        <KbList onSelect={selectKb} />
      )}
    </div>
  );
}
