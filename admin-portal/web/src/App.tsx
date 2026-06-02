// 平台外壳（ProLayout）。步骤2 聚焦「数字员工」；文档/上传/审计指向现有页面（步骤4 迁入）。
import { useState } from "react";
import { ProLayout } from "@ant-design/pro-components";
import { RobotOutlined, FileTextOutlined, UploadOutlined, AuditOutlined } from "@ant-design/icons";
import Agents from "./Agents";

const MENU = [
  { path: "/agents", name: "数字员工", icon: <RobotOutlined /> },
  { path: "/documents", name: "文档（迁移中）", icon: <FileTextOutlined /> },
  { path: "/upload", name: "上传（迁移中）", icon: <UploadOutlined /> },
  { path: "/audit-log", name: "审计（迁移中）", icon: <AuditOutlined /> },
];

export default function App() {
  const [path, setPath] = useState("/agents");

  return (
    <ProLayout
      title="HR 数字员工管理平台"
      logo={false}
      layout="side"
      location={{ pathname: path }}
      route={{ routes: MENU }}
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
