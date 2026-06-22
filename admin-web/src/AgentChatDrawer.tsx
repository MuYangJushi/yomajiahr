// Web 内置对话抽屉（ADR-016 §2）：平台内直接与数字员工对话，零重启验证。
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Drawer, Input, List, message, Select, Space, Tag, Typography } from "antd";
import { DeleteOutlined, SendOutlined } from "@ant-design/icons";
import {
  chatWithAgent,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  type AgentRow,
  type ChatMessage,
  type ChatSessionMeta,
} from "./api";

interface Props {
  agent: AgentRow | null;
  open: boolean;
  onClose: () => void;
}

const { Text } = Typography;

export default function AgentChatDrawer({ agent, open, onClose }: Props) {
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([]);
  const [activeSid, setActiveSid] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const listEndRef = useRef<HTMLDivElement>(null);

  const reloadSessions = useCallback(async () => {
    if (!agent) return;
    try {
      const list = await listChatSessions(agent.id);
      setSessions(list);
    } catch (err: any) {
      // 静默：会话列表加载失败不阻塞新对话
    }
  }, [agent]);

  useEffect(() => {
    if (open && agent) {
      setMessages([]);
      setActiveSid(undefined);
      void reloadSessions();
    }
  }, [open, agent, reloadSessions]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const openSession = async (sid: string) => {
    if (!agent) return;
    setLoadingSession(true);
    try {
      const { messages: msgs } = await getChatSession(agent.id, sid);
      setMessages(msgs);
      setActiveSid(sid);
    } catch (err: any) {
      message.error(err?.response?.data?.error || "加载会话失败");
    } finally {
      setLoadingSession(false);
    }
  };

  const send = async () => {
    if (!agent) return;
    const text = input.trim();
    if (!text) return;
    setSending(true);
    const next: ChatMessage[] = [...messages, { role: "user", text }];
    setMessages(next);
    setInput("");
    try {
      const result = await chatWithAgent(agent.id, text, activeSid);
      setActiveSid(result.sessionId);
      setMessages((m) => [...m, { role: "assistant", text: result.reply }]);
      void reloadSessions();
    } catch (err: any) {
      message.error(err?.response?.data?.error || err?.message || "对话失败");
      // 回滚刚才的用户消息占位
      setMessages((m) => m.filter((_, i) => i !== m.length - 1));
    } finally {
      setSending(false);
    }
  };

  const removeSession = async (sid: string) => {
    if (!agent) return;
    try {
      await deleteChatSession(agent.id, sid);
      if (activeSid === sid) {
        setActiveSid(undefined);
        setMessages([]);
      }
      void reloadSessions();
      message.success("会话已删除");
    } catch (err: any) {
      message.error(err?.response?.data?.error || "删除失败");
    }
  };

  const startNew = () => {
    setActiveSid(undefined);
    setMessages([]);
  };

  return (
    <Drawer
      title={
        <Space>
          <span>对话 — {agent?.name}</span>
          {agent && <Tag>{agent.id}</Tag>}
        </Space>
      }
      open={open}
      onClose={onClose}
      width={560}
      destroyOnClose
      footer={null}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="在线试聊"
        description="在这里直接和该员工对话，体验它配置后的实际效果。"
      />
      <Space style={{ marginBottom: 12, width: "100%", justifyContent: "space-between" }}>
        <Select
          style={{ minWidth: 260 }}
          placeholder="选择历史会话"
          value={activeSid}
          loading={loadingSession}
          onChange={(v) => v && openSession(v)}
          options={sessions.map((s) => ({
            value: s.sessionId,
            label: s.lastUserMessage ? `${s.sessionId.slice(0, 16)}… ｜ ${s.lastUserMessage}` : s.sessionId,
          }))}
          allowClear
          onClear={startNew}
        />
        <Space>
          <Button size="small" onClick={startNew}>新会话</Button>
          {activeSid && (
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => activeSid && removeSession(activeSid)}>
              删除
            </Button>
          )}
        </Space>
      </Space>

      <div
        style={{
          height: "calc(100vh - 320px)",
          minHeight: 240,
          overflowY: "auto",
          background: "#f7f7fa",
          borderRadius: 8,
          padding: 12,
        }}
      >
        {messages.length === 0 && (
          <Text type="secondary" style={{ display: "block", textAlign: "center", marginTop: 40 }}>
            还没有消息，发送一条试试
          </Text>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: m.role === "user" ? "flex-end" : "flex-start",
              marginBottom: 8,
            }}
          >
            <div
              style={{
                maxWidth: "80%",
                padding: "8px 12px",
                borderRadius: 10,
                background: m.role === "user" ? "#0a84ff" : "#fff",
                color: m.role === "user" ? "#fff" : "#1d1d1f",
                border: m.role === "user" ? "none" : "1px solid #e5e5ea",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: 14,
              }}
            >
              {m.text}
            </div>
          </div>
        ))}
        <div ref={listEndRef} />
      </div>

      <Space.Compact style={{ width: "100%", marginTop: 12 }}>
        <Input
          placeholder="输入消息（Shift+Enter 换行）"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={sending}
          maxLength={8000}
        />
        <Button type="primary" icon={<SendOutlined />} onClick={() => void send()} loading={sending}>
          发送
        </Button>
      </Space.Compact>
    </Drawer>
  );
}
