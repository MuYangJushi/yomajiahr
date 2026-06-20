// 平台外壳（ProLayout）+ 鉴权门（决策六）。步骤2 聚焦「数字员工」；文档/上传/审计指向现有页面（步骤4 迁入）。
import { useEffect, useState } from "react";
import { ProLayout } from "@ant-design/pro-components";
import { Dropdown, Spin, Tag } from "antd";
import { RobotOutlined, LogoutOutlined } from "@ant-design/icons";
import Agents from "./Agents";
import Templates from "./Templates";
import Knowledge from "./Knowledge";
import Audit from "./Audit";
import Channels from "./Channels";
import Login from "./Login";
import { fetchMe, logout, type Me, type PlatformRole } from "./api";

const MENU = [
  { path: "/agents", name: "数字员工", icon: "📋" },
  { path: "/templates", name: "员工模板", icon: "🪪" },
  { path: "/knowledge", name: "知识库", icon: "📖" },
  { path: "/channels", name: "渠道管理", icon: "🔗" },
  { path: "/audit-log", name: "审计", icon: "📝" },
  { path: "/planned-divider", name: "规划中", isGroupLabel: true, disabled: true },
  { path: "/skills", name: "技能配置", icon: "🛠️", disabled: true },
  { path: "/workflows", name: "流程编排", icon: "🧩", disabled: true },
];

// 在 ProLayout 壳内渲染的页面；不在此表的菜单项跳旧 vanilla 页。
const SHELL_PAGES = new Set(["/agents", "/templates", "/channels", "/knowledge", "/audit-log"]);

const ROLE_LABEL: Record<PlatformRole, string> = { admin: "管理员", ops: "运营", audit: "审计只读" };

function currentShellPath(): string {
  const path = window.location.pathname.replace(/^\/console\/?/, "/");
  return SHELL_PAGES.has(path) ? path : "/agents";
}

function navigate(path: string): void {
  window.history.pushState({}, "", `/console${path}`);
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
    <ProLayout
      title="Yoma+HR 数字员工平台"
      logo={false}
      layout="side"
      location={{ pathname: path }}
      route={{ routes: MENU }}
      avatarProps={{
        icon: <RobotOutlined />,
        title: `${me.name}`,
        render: (_props, dom) => (
          <Dropdown
            menu={{
              items: [
                { key: "role", disabled: true, label: <Tag color="blue">{ROLE_LABEL[me.platformRole]}</Tag> },
                {
                  key: "logout",
                  icon: <LogoutOutlined />,
                  label: "退出登录",
                  onClick: async () => {
                    try {
                      await logout();
                    } finally {
                      window.location.href = "/console/login";
                    }
                  },
                },
              ],
            }}
          >
            {dom}
          </Dropdown>
        ),
      }}
      menuItemRender={(item, dom) => {
        // 分组标题（如「规划中」）：纯文案，不可点击，不渲染为链接。
        if ((item as { isGroupLabel?: boolean }).isGroupLabel) {
          return (
            <span style={{ color: "rgba(0, 0, 0, 0.35)", fontSize: 12, cursor: "default" }}>
              {item.name}
            </span>
          );
        }
        return (
          <a
            onClick={() => {
              // 「规划中」禁用项不跳转，避免落到死链。
              if ((item as { disabled?: boolean }).disabled) return;
              // 壳内页直接切换；其余（审计等迁移中）仍跳旧 vanilla 页。
              if (item.path && SHELL_PAGES.has(item.path)) {
                navigate(item.path);
                setPath(item.path);
              } else {
                window.location.href = item.path!;
              }
            }}
          >
            {dom}
          </a>
        );
      }}
    >
      {path === "/agents" && <Agents />}
      {path === "/templates" && <Templates />}
      {path === "/channels" && <Channels />}
      {path === "/knowledge" && <Knowledge />}
      {path === "/audit-log" && <Audit />}
    </ProLayout>
  );
}
