// 知识库页（ADR-006 / FastGPT 集成）。MVP 单库形态：顶部平台健康条 + 四 Tab。
// #37 + 页面壳阶段：健康条与「文档管理」(本地回退列表)、「绑定」可用；
// 「召回测试」「导入」依赖 FastGPT 实例（Gate-B），未就绪时优雅提示。
import { useEffect, useState } from "react";
import { Alert, Button, Card, Descriptions, Empty, Input, List, Space, Spin, Tabs, Tag, message } from "antd";
import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import {
  fetchKnowledgeBindings,
  fetchKnowledgeCollections,
  fetchKnowledgeHealth,
  saveKnowledgeBindings,
  searchTest,
  type KbChunk,
  type KbCollection,
  type KnowledgeHealth,
  type KnowledgeStore,
} from "./api";

const INDEX_TAG: Record<string, { color: string; label: string }> = {
  ready: { color: "green", label: "✔ ready" },
  indexing: { color: "blue", label: "⟳ 索引中" },
  error: { color: "red", label: "✖ error" },
  unknown: { color: "default", label: "未知" },
  "local-archive": { color: "default", label: "本地归档" },
};

function HealthBanner({ health, onRefresh }: { health: KnowledgeHealth | null; onRefresh: () => void }) {
  if (!health) return <Spin />;
  const ok = health.platform === "fastgpt" && health.configured && health.reachable;
  const type = ok ? "success" : health.platform === "local" ? "info" : "warning";
  const title = ok
    ? `● FastGPT 已连接 · KB ${health.kbId ?? "—"} · 索引 ${health.indexStatus}`
    : health.platform === "local"
      ? "● 当前使用本地知识库（memory_search / hr-chunks）"
      : "● FastGPT 不可用 · 已回退本地检索";
  return (
    <Alert
      type={type}
      showIcon
      message={title}
      description={
        <Space size="large" wrap>
          <span>地址 {health.baseUrlHint ?? "（未配置）"}</span>
          <span>embedding {health.embeddingModel ?? "—"}</span>
          <span>回退 本地 memory_search</span>
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

function DocsTab() {
  const columns: ProColumns<KbCollection>[] = [
    { title: "标题", dataIndex: "title" },
    { title: "分类", dataIndex: "category", render: (_, r) => r.category && <Tag>{r.category}</Tag> },
    { title: "文档编号", dataIndex: "doc_id", copyable: true },
    { title: "版本", dataIndex: "version" },
    { title: "切片", dataIndex: "chunkCount", render: (_, r) => r.chunkCount ?? "—" },
    {
      title: "索引状态",
      dataIndex: "indexStatus",
      render: (_, r) => <Tag color={INDEX_TAG[r.indexStatus]?.color}>{INDEX_TAG[r.indexStatus]?.label}</Tag>,
    },
  ];
  return (
    <ProTable<KbCollection>
      rowKey="externalDocId"
      search={false}
      pagination={false}
      columns={columns}
      toolBarRender={() => [
        // FastGPT 导入（#38）接通前，上传走现有本地链路（vanilla /upload 页）。
        <Button key="import" type="primary" onClick={() => (window.location.href = "/upload")}>
          ⬆ 导入文档
        </Button>,
      ]}
      request={async () => {
        const { collections, source, notice } = await fetchKnowledgeCollections();
        if (source === "local" && notice) message.info(`文档列表来自本地归档：${notice}`, 3);
        return { data: collections, success: true };
      }}
    />
  );
}

function SearchTestTab() {
  const [query, setQuery] = useState("");
  const [chunks, setChunks] = useState<KbChunk[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");

  const run = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setErr("");
    try {
      setChunks(await searchTest(query.trim(), 5));
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
        {!err && chunks === null && <Empty description="输入查询后测试召回（需 FastGPT 实例就绪）" />}
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

function BindingsTab() {
  const [store, setStore] = useState<KnowledgeStore | null>(null);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchKnowledgeBindings()
      .then(({ store, agents }) => {
        setStore(store);
        setAgents(agents.map((a) => ({ id: a.id, name: a.name })));
      })
      .catch(() => {});
  }, []);

  const toggle = (kbId: string, agentId: string) => {
    if (!store) return;
    setStore({
      ...store,
      knowledgeBases: store.knowledgeBases.map((kb) =>
        kb.id !== kbId
          ? kb
          : {
              ...kb,
              boundAgents: kb.boundAgents.includes(agentId)
                ? kb.boundAgents.filter((a) => a !== agentId)
                : [...kb.boundAgents, agentId],
            },
      ),
    });
  };

  const save = async () => {
    if (!store) return;
    setSaving(true);
    try {
      setStore(await saveKnowledgeBindings(store));
      message.success("绑定已保存");
    } catch {
      message.error("保存失败（需 admin 权限）");
    } finally {
      setSaving(false);
    }
  };

  if (!store) return <Spin />;
  return (
    <Card
      title="哪些数字员工可检索本知识库（存自有平台 config-store）"
      extra={
        <Button type="primary" loading={saving} onClick={save}>
          保存绑定
        </Button>
      }
    >
      {store.knowledgeBases.map((kb) => (
        <div key={kb.id} style={{ marginBottom: 16 }}>
          <strong>{kb.name}</strong>
          <div style={{ marginTop: 8 }}>
            <Space wrap>
              {agents.map((a) => {
                const on = kb.boundAgents.includes(a.id);
                return (
                  <Tag.CheckableTag key={a.id} checked={on} onChange={() => toggle(kb.id, a.id)}>
                    {a.name} ({a.id})
                  </Tag.CheckableTag>
                );
              })}
            </Space>
          </div>
        </div>
      ))}
      <Alert
        type="info"
        showIcon
        message="受限分类（compensation/performance）即使绑定，员工侧仍在回答层拦截（hr-policy-qa 数据分级）"
      />
    </Card>
  );
}

function PlatformTab({ health }: { health: KnowledgeHealth | null }) {
  if (!health) return <Spin />;
  return (
    <Card>
      <Descriptions column={1} bordered size="small">
        <Descriptions.Item label="平台类型">{health.platform}</Descriptions.Item>
        <Descriptions.Item label="状态">
          {health.platform === "fastgpt" && health.reachable ? (
            <Tag color="green">● 已连接</Tag>
          ) : (
            <Tag color="orange">● 回退本地</Tag>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="基础地址">
          {health.baseUrlHint ?? "（未配置）"}（内网/loopback，浏览器不直连）
        </Descriptions.Item>
        <Descriptions.Item label="KB ID">{health.kbId ?? "—"}</Descriptions.Item>
        <Descriptions.Item label="Embedding">{health.embeddingModel ?? "—"}</Descriptions.Item>
        <Descriptions.Item label="API Key">
          {health.configured ? <Tag>已配置（不回显）</Tag> : <Tag color="default">未配置</Tag>}
        </Descriptions.Item>
        <Descriptions.Item label="回退">本地 memory_search（hr-chunks）✔ 可用</Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

export default function Knowledge() {
  const [health, setHealth] = useState<KnowledgeHealth | null>(null);

  const load = () => {
    fetchKnowledgeHealth().then(setHealth).catch(() => setHealth(null));
  };
  useEffect(load, []);

  return (
    <div>
      <HealthBanner health={health} onRefresh={load} />
      <Tabs
        items={[
          { key: "docs", label: "文档管理", children: <DocsTab /> },
          { key: "search", label: "召回测试", children: <SearchTestTab /> },
          { key: "bindings", label: "绑定数字员工", children: <BindingsTab /> },
          { key: "platform", label: "平台", children: <PlatformTab health={health} /> },
        ]}
      />
    </div>
  );
}
