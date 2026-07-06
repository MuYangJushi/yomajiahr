// 平台外壳（自研 AppShell，脱离 ProLayout）+ 鉴权门。对齐 design tokens v0.2 mockup。
import { useEffect, useState } from "react";
import { Spin } from "antd";
import { RobotOutlined, BookOutlined, AuditOutlined, ApiOutlined, ToolOutlined, IdcardOutlined, PartitionOutlined, LineChartOutlined } from "@ant-design/icons";
import { AppShell, type NavSection } from "./shell";
import Agents from "./Agents";
import Templates from "./Templates";
import Knowledge from "./Knowledge";
import Audit from "./Audit";
import Interactions from "./Interactions";
import Channels from "./Channels";
import Skills from "./Skills";
import Login from "./Login";
import { fetchMe, logout, type Me } from "./api";

const SECTIONS: NavSection[] = [
  {
    items: [
      { path: "/agents", name: "数字员工", icon: <RobotOutlined /> },
      { path: "/templates", name: "员工模板", icon: <IdcardOutlined /> },
      { path: "/skills", name: "技能配置", icon: <ToolOutlined /> },
      { path: "/knowledge", name: "知识库", icon: <BookOutlined /> },
      { path: "/channels", name: "渠道管理", icon: <ApiOutlined /> },
      { path: "/interactions", name: "交互分析", icon: <LineChartOutlined /> },
      { path: "/audit-log", name: "审计", icon: <AuditOutlined /> },
    ],
  },
  {
    label: "规划中",
    items: [
      { path: "/workflows", name: "流程编排", icon: <PartitionOutlined />, disabled: true },
    ],
  },
];

const SHELL_PAGES = new Set(["/agents", "/templates", "/skills", "/channels", "/knowledge", "/interactions", "/audit-log"]);

function currentShellPath(): string {
  const path = window.location.pathname;
  return SHELL_PAGES.has(path) ? path : "/agents";
}

function navigate(path: string): void {
  window.history.pushState({}, "", path);
}

export default function App() {
  const [path, setPath] = useState(currentShellPath);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMe()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    const onPopState = () => setPath(currentShellPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Spin size="large" />
      </div>
    );
  }
  if (!me) return <Login />;

  return (
    <AppShell
      current={path}
      sections={SECTIONS}
      onNavigate={(p) => { navigate(p); setPath(p); }}
      user={me}
      onLogout={async () => {
        try { await logout(); } finally { window.location.href = "/console/login"; }
      }}
    >
      {path === "/agents" && <Agents />}
      {path === "/templates" && <Templates />}
      {path === "/skills" && <Skills />}
      {path === "/channels" && <Channels />}
      {path === "/knowledge" && <Knowledge />}
      {path === "/interactions" && <Interactions />}
      {path === "/audit-log" && <Audit />}
    </AppShell>
  );
}
