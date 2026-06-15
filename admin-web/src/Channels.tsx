import { useEffect, useMemo, useState } from "react";
import { Button, Card, Col, Drawer, Form, Input, Modal, QRCode, Row, Select, Space, Statistic, Switch, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  bindChannelAsset, cancelChannelAssetOnboarding, createChannelAsset, deleteChannelAsset, fetchAgents, fetchChannelAssets, fetchChannelOnboarding,
  probeChannelAsset, probeChannels, unbindChannelAsset, updateChannelAsset,
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
    const timer = window.setInterval(() => void reload(true), 5000);
    return () => window.clearInterval(timer);
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
  async function submit(values: any) {
    try {
      if (action === "create") {
        const session = await createChannelAsset({
        id: values.id, type: values.type, displayName: values.displayName, mode,
        ...(mode === "manual" ? { clientId: values.clientId, secret: values.secret } : {}),
        policy: { dmPolicy: values.dmPolicy, groupPolicy: values.groupPolicy, requireMention: values.requireMention },
        } as any);
        if (session) { setOnboarding(session); setAction(null); return; }
      }
      if (action === "edit" && selected) await updateChannelAsset(selected.type, selected.id, {
        displayName: values.displayName, clientId: values.clientId, secret: values.secret,
        policy: { dmPolicy: values.dmPolicy, groupPolicy: values.groupPolicy, requireMention: values.requireMention },
      });
      if (action === "bind" && selected) await bindChannelAsset(selected.type, selected.id, values.agentId);
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
      <Tag color={r.health?.running ? "success" : "default"}>{r.health?.running ? "运行中" : "未运行"}</Tag>
      <Tag color={r.health?.connected ? "success" : "error"}>{r.health?.connected ? "连接正常" : "未连接"}</Tag>
      {r.health?.lastError && <Typography.Text type="danger">{r.health.lastError}</Typography.Text>}
    </Space> },
    { title: "占用", render: (_, r) => r.occupiedBy ? <Tag color="processing">{r.occupiedBy.agentName}</Tag> : <Tag>空闲</Tag> },
    { title: "最近检测", render: (_, r) => r.health?.checkedAt ? new Date(r.health.checkedAt).toLocaleString() : "未检测" },
    { title: "操作", render: (_, r) => <Space wrap>
      <Button size="small" onClick={() => open("edit", r)}>编辑</Button>
      <Button size="small" onClick={async () => { await probeChannelAsset(r.type, r.id); await reload(); }}>探活</Button>
      {r.occupiedBy
        ? <Button size="small" onClick={async () => { await unbindChannelAsset(r.type, r.id); await reload(); }}>解绑</Button>
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
        <Space><Button onClick={async () => { await probeChannels(); await reload(); }}>全部探活</Button><Button type="primary" onClick={() => { setMode("manual"); open("create"); }}>新增账号</Button></Space>
      </div>
      <Row gutter={12}><Col span={6}><Card><Statistic title="账号总数" value={summary.total}/></Card></Col><Col span={6}><Card><Statistic title="连接正常" value={summary.healthy}/></Card></Col><Col span={6}><Card><Statistic title="已占用" value={summary.occupied}/></Card></Col><Col span={6}><Card><Statistic title="异常" value={summary.errors}/></Card></Col></Row>
      <Table rowKey={(r) => `${r.type}/${r.id}`} loading={loading} columns={columns} dataSource={rows} pagination={false} />
    </Space>
    <Drawer title={action === "create" ? "手工新增渠道账号" : action === "edit" ? "编辑渠道账号" : "绑定数字员工"} open={Boolean(action)} onClose={() => setAction(null)} width={480}
      extra={<Button type="primary" onClick={() => form.submit()}>保存并应用</Button>}>
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
