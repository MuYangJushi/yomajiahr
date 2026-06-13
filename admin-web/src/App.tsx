// 平台外壳（ProLayout）+ 鉴权门（决策六）。步骤2 聚焦「数字员工」；文档/上传/审计指向现有页面（步骤4 迁入）。
import { useEffect, useState } from "react";
import { ProLayout } from "@ant-design/pro-components";
import { Dropdown, Spin, Tag } from "antd";
import { RobotOutlined, BookOutlined, AuditOutlined, LogoutOutlined } from "@ant-design/icons";
import Agents from "./Agents";
import Knowledge from "./Knowledge";
import Audit from "./Audit";
import Login from "./Login";
import { fetchMe, logout, type Me, type PlatformRole } from "./api";

const MENU = [
  { path: "/agents", name: "数字员工", icon: <RobotOutlined /> },
  { path: "/knowledge", name: "知识库", icon: <BookOutlined /> },
  { path: "/audit-log", name: "审计", icon: <AuditOutlined /> },
];

// 在 ProLayout 壳内渲染的页面；不在此表的菜单项跳旧 vanilla 页。
const SHELL_PAGES = new Set(["/agents", "/knowledge", "/audit-log"]);

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
      title="HR 数字员工管理平台"
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
      menuItemRender={(item, dom) => (
        <a
          onClick={() => {
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
      )}
    >
      {path === "/agents" && <Agents />}
      {path === "/knowledge" && <Knowledge />}
      {path === "/audit-log" && <Audit />}
    </ProLayout>
  );
}
