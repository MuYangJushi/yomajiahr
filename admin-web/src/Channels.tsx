import { useEffect, useMemo, useState } from "react";
import { Button, Card, Col, Drawer, Form, Input, Modal, QRCode, Row, Select, Space, Statistic, Switch, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  awaitApplyJob, bindChannelAsset, cancelChannelAssetOnboarding, createChannelAsset, deleteChannelAsset, fetchAgents, fetchChannelAssets, fetchChannelOnboarding,
  jobIdOf, probeChannelAsset, probeChannels, unbindChannelAsset, updateChannelAsset,
  type AgentRow, type ChannelAsset,
} from "./api";

const TYPE_LABEL = { feishu: "飞书", dingtalk: "钉钉" };
type Action = "create" | "edit" | "bind" | null;

export default function Channels() {
  const [rows, setRows] = useState<ChannelAsset[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<Action>(null);
  const [selected, setSelected] = useState<ChannelAsset>();
  const [form] = Form.useForm();
  const [mode, setMode] = useState<"manual" | "qrcode">("manual");
  const [onboarding, setOnboarding] = useState<any>();
  async function reload(silent = false) {
    if (!silent) setLoading(true);
    try {
      const [{ channels }, agentRows] = await Promise.all([fetchChannelAssets(), fetchAgents()]);
      setRows(channels); setAgents(agentRows);
    } catch (err: any) { if (!silent) message.error(err?.response?.data?.error || "加载失败"); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => {
    void reload();
    // mount 后异步触发一次集中探活（不阻塞列表渲染）；下一轮静默 reload 会捎带最新 health。
    void probeChannels().catch(() => {});
    // 列表轻量轮询（仅读 store cache，无 spawn）。
    const listTimer = window.setInterval(() => void reload(true), 5000);
    // 后台集中探活（30s 一次；spawn openclaw channels status，未配置账号已被短路）。
    const probeTimer = window.setInterval(() => void probeChannels().catch(() => {}), 30_000);
    return () => {
      window.clearInterval(listTimer);
      window.clearInterval(probeTimer);
    };
  }, []);
  const summary = useMemo(() => ({
    total: rows.length, healthy: rows.filter((r) => r.health?.configured && r.health.running && r.health.connected).length,
    occupied: rows.filter((r) => r.occupiedBy).length, errors: rows.filter((r) => r.health?.lastError).length,
  }), [rows]);
  function open(next: Action, asset?: ChannelAsset) {
    setAction(next); setSelected(asset);
    form.resetFields();
    if (asset) form.setFieldsValue({ ...asset, ...asset.policy });
    else form.setFieldsValue({ type: "feishu", dmPolicy: "open", groupPolicy: "open", requireMention: true });
  }
  /** 写操作的统一处理：拿到响应里可能的 jobId，立刻关弹窗 + reload；
   *  挂全局 message.loading 直到任务终态，最后 reload 一次让 store 真实状态浮上来。 */
  async function trackApplyJob(data: unknown, label: string) {
    const jobId = jobIdOf(data);
    if (!jobId) {
      // 800ms 内同步完成（含失败已 throw），无需轮询。
      return { ok: true };
    }
    const key = `apply-${jobId}`;
    message.loading({ content: `${label}进行中…`, key, duration: 0 });
    const job = await awaitApplyJob(jobId);
    if (job.status === "success") {
      message.success({ content: `${label}已应用`, key });
      return { ok: true };
    }
    message.error({ content: `${label}失败：${job.message || job.status}`, key, duration: 6 });
    return { ok: false };
  }
  async function submit(values: any) {
    try {
      if (action === "create") {
        const session = await createChannelAsset({
        id: values.id, type: values.type, displayName: values.displayName, mode,
        ...(mode === "manual" ? { clientId: values.clientId, secret: values.secret } : {}),
        policy: { dmPolicy: values.dmPolicy, groupPolicy: values.groupPolicy, requireMention: values.requireMention },
        } as any);
        if (session) { setOnboarding(session); setAction(null); return; }
        await trackApplyJob(session, "创建账号");
      }
      if (action === "edit" && selected) {
        const data = await updateChannelAsset(selected.type, selected.id, {
          displayName: values.displayName, clientId: values.clientId, secret: values.secret,
          policy: { dmPolicy: values.dmPolicy, groupPolicy: values.groupPolicy, requireMention: values.requireMention },
        });
        setAction(null); await reload();
        await trackApplyJob(data, "保存渠道");
        return;
      }
      if (action === "bind" && selected) {
        const data = await bindChannelAsset(selected.type, selected.id, values.agentId);
        setAction(null); await reload();
        await trackApplyJob(data, "绑定数字员工");
        return;
      }
      message.success("操作已应用"); setAction(null); await reload();
    } catch (err: any) { message.error(err?.response?.data?.error || err.message || "操作失败"); }
  }
  useEffect(() => {
    if (!onboarding?.id || ["success", "failed", "cancelled"].includes(onboarding.status)) return;
    const timer = window.setInterval(async () => {
      const next = await fetchChannelOnboarding(onboarding.id);
      setOnboarding(next);
      if (next.status === "success") await reload();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [onboarding?.id, onboarding?.status]);
  const columns: ColumnsType<ChannelAsset> = [
    { title: "账号", render: (_, r) => <><b>{r.displayName}</b><br/><Typography.Text type="secondary">{r.id}（创建后不可改）</Typography.Text></> },
    { title: "渠道", dataIndex: "type", render: (v) => <Tag color="blue">{TYPE_LABEL[v as keyof typeof TYPE_LABEL]}</Tag> },
    { title: "配置", render: (_, r) => <Tag color={r.credentialsConfigured ? "success" : "warning"}>{r.credentialsConfigured ? "完整" : "缺少凭证"}</Tag> },
    { title: "运行状态", render: (_, r) => <Space wrap>
      {r.health?.configured === false
        ? <Tag>凭证未配置</Tag>
        : <>
          <Tag color={r.health?.running ? "success" : "default"}>{r.health?.running ? "运行中" : "未运行"}</Tag>
          <Tag color={r.health?.connected ? "success" : "error"}>{r.health?.connected ? "连接正常" : "未连接"}</Tag>
        </>}
      {r.health?.lastError && <Typography.Text type="danger">{r.health.lastError}</Typography.Text>}
    </Space> },
    { title: "占用", render: (_, r) => r.occupiedBy ? <Tag color="processing">{r.occupiedBy.agentName}</Tag> : <Tag>空闲</Tag> },
    { title: "最近检测", render: (_, r) => r.health?.checkedAt ? new Date(r.health.checkedAt).toLocaleString() : "未检测" },
    { title: "操作", render: (_, r) => <Space wrap>
      <Button size="small" onClick={() => open("edit", r)}>编辑</Button>
      <Button size="small" onClick={async () => { await probeChannelAsset(r.type, r.id); await reload(); }}>探活</Button>
      {r.occupiedBy
        ? <Button size="small" onClick={async () => {
            const data = await unbindChannelAsset(r.type, r.id);
            await reload();
            await trackApplyJob(data, "解绑数字员工");
          }}>解绑</Button>
        : <Button size="small" onClick={() => open("bind", r)}>绑定</Button>}
      <Button danger size="small" disabled={Boolean(r.occupiedBy)} onClick={() => Modal.confirm({
        title: `删除空闲账号 ${r.displayName}？`,
        async onOk() {
          try {
            await deleteChannelAsset(r.type, r.id);
            message.success("渠道账号已删除");
            await reload();
          } catch (err: any) {
            message.error(err?.response?.data?.error || err.message || "删除失败");
            throw err;
          }
        },
      })}>删除</Button>
    </Space> },
  ];
  return <>
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div><Typography.Title level={3} style={{ margin: 0 }}>渠道管理</Typography.Title><Typography.Text type="secondary">独立管理飞书与钉钉账号资产、绑定和连接状态</Typography.Text></div>
        <Space><Button onClick={async () => {
          message.loading({ content: "正在探活…", key: "probe-all", duration: 0 });
          try { await probeChannels(); message.success({ content: "探活完成", key: "probe-all" }); await reload(true); }
          catch (err: any) { message.error({ content: err?.response?.data?.error || "探活失败", key: "probe-all" }); }
        }} shape="round">全部探活</Button><Button type="primary" shape="round" onClick={() => { setMode("manual"); open("create"); }}>新增账号</Button></Space>
      </div>
      <Row gutter={12}><Col span={6}><Card><Statistic title="账号总数" value={summary.total}/></Card></Col><Col span={6}><Card><Statistic title="连接正常" value={summary.healthy}/></Card></Col><Col span={6}><Card><Statistic title="已占用" value={summary.occupied}/></Card></Col><Col span={6}><Card><Statistic title="异常" value={summary.errors}/></Card></Col></Row>
      <Table rowKey={(r) => `${r.type}/${r.id}`} loading={loading} columns={columns} dataSource={rows} pagination={false} />
    </Space>
    <Drawer title={action === "create" ? "手工新增渠道账号" : action === "edit" ? "编辑渠道账号" : "绑定数字员工"} open={Boolean(action)} onClose={() => setAction(null)} width={480}
      extra={<Button type="primary" shape="round" onClick={() => form.submit()}>保存并应用</Button>}>
      <Form form={form} layout="vertical" onFinish={submit}>
        {action === "bind" ? <Form.Item name="agentId" label="数字员工" rules={[{ required: true }]}><Select options={agents.map((a) => ({ label: `${a.name}（${a.profile?.jobTitle || a.id}）`, value: a.id }))}/></Form.Item> : <>
          <Form.Item name="type" label="渠道" rules={[{ required: true }]}><Select disabled={action === "edit"} options={[{ label: "飞书", value: "feishu" }, { label: "钉钉", value: "dingtalk" }]}/></Form.Item>
          <Form.Item name="id" label="账号 ID" rules={[{ required: true, pattern: /^[a-zA-Z0-9_-]+$/ }]}><Input disabled={action === "edit"}/></Form.Item>
          <Form.Item name="displayName" label="显示名称" rules={[{ required: true }]}><Input/></Form.Item>
          {action === "create" && <Form.Item label="创建方式"><Select value={mode} onChange={setMode} options={[{ label: "手工录入已有应用", value: "manual" }, { label: "扫码创建应用", value: "qrcode" }]}/></Form.Item>}
          {(action === "edit" || mode === "manual") && <>
            <Form.Item name="clientId" label="App / Client ID" rules={action === "create" ? [{ required: true }] : []}><Input placeholder={action === "edit" ? "留空表示保持原值" : ""}/></Form.Item>
            <Form.Item name="secret" label="Secret" rules={action === "create" ? [{ required: true }] : []}><Input.Password placeholder={action === "edit" ? "留空表示保持原值" : ""}/></Form.Item>
          </>}
          <Form.Item name="dmPolicy" label="私聊策略"><Select options={[{ label: "开放", value: "open" }, { label: "受限", value: "restricted" }]}/></Form.Item>
          <Form.Item name="groupPolicy" label="群聊策略"><Select options={[{ label: "开放", value: "open" }, { label: "禁用", value: "disabled" }]}/></Form.Item>
          <Form.Item name="requireMention" label="群聊必须 @" valuePropName="checked"><Switch/></Form.Item>
        </>}
      </Form>
    </Drawer>
    <Modal title="扫码创建渠道账号" open={Boolean(onboarding)} footer={null} onCancel={async () => {
      if (onboarding?.id && !["success", "failed", "cancelled"].includes(onboarding.status)) await cancelChannelAssetOnboarding(onboarding.id);
      setOnboarding(undefined);
    }}>
      <Space direction="vertical" align="center" style={{ width: "100%" }}>
        {onboarding?.qr_url ? <QRCode value={onboarding.qr_url} size={240}/> : <Typography.Text>正在准备二维码...</Typography.Text>}
        <Tag color={onboarding?.status === "success" ? "success" : onboarding?.status === "failed" ? "error" : "processing"}>{onboarding?.message || onboarding?.status}</Tag>
      </Space>
    </Modal>
  </>;
}
