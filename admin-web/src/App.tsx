// 平台外壳（ProLayout）+ 鉴权门（决策六）。步骤2 聚焦「数字员工」；文档/上传/审计指向现有页面（步骤4 迁入）。
import { useEffect, useState } from "react";
import { ProLayout } from "@ant-design/pro-components";
import { Dropdown, Spin, Tag } from "antd";
import { RobotOutlined, FileTextOutlined, UploadOutlined, AuditOutlined, LogoutOutlined } from "@ant-design/icons";
import Agents from "./Agents";
import Login from "./Login";
import { fetchMe, logout, type Me, type PlatformRole } from "./api";

const MENU = [
  { path: "/agents", name: "数字员工", icon: <RobotOutlined /> },
  { path: "/documents", name: "文档（迁移中）", icon: <FileTextOutlined /> },
  { path: "/upload", name: "上传（迁移中）", icon: <UploadOutlined /> },
  { path: "/audit-log", name: "审计（迁移中）", icon: <AuditOutlined /> },
];

const ROLE_LABEL: Record<PlatformRole, string> = { admin: "管理员", ops: "运营", audit: "审计只读" };

export default function App() {
  const [path, setPath] = useState("/agents");
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMe()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
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
            // 旧三页仍由 vanilla 前端服务于根路径；步骤4 迁入本壳。
            if (item.path && item.path !== "/agents") {
              window.location.href = item.path!;
            } else {
              setPath(item.path!);
            }
          }}
        >
          {dom}
        </a>
      )}
    >
      {path === "/agents" && <Agents />}
    </ProLayout>
  );
}
