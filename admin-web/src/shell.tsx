// 脱离 ProComponents 的纯净外壳，对齐 design tokens v0.2 mockup。
// ProLayout → AppShell（自研侧边栏 + main 容器）；
// ProTable 工具栏 → PageTopbar（标题/副标题/右侧操作）+ TableCard（白卡包裹原生 Table）。
import React, { type ReactNode } from "react";
import { Dropdown, Tag } from "antd";
import { LogoutOutlined } from "@ant-design/icons";
import type { PlatformRole } from "./api";

export interface NavItem {
  path: string;
  name: string;
  icon?: ReactNode;
  disabled?: boolean;
}
export interface NavSection {
  label?: string;
  items: NavItem[];
}

const ROLE_LABEL: Record<PlatformRole, string> = { admin: "管理员", ops: "运营", audit: "审计只读" };

const SHELL_STYLE: React.CSSProperties = { display: "flex", height: "100vh", overflow: "hidden", background: "#f5f5f7" };
const SIDEBAR_STYLE: React.CSSProperties = {
  width: 240, flex: "none", background: "#fff", borderRight: "1px solid #e3e3e6",
  padding: "20px 12px", display: "flex", flexDirection: "column", height: "100%", overflowY: "auto",
};
const MAIN_STYLE: React.CSSProperties = { flex: 1, minWidth: 0, height: "100%", overflowY: "auto", padding: "32px 40px" };

function BrandTitle() {
  return <div style={{ fontSize: 16, fontWeight: 600, padding: "8px 12px 20px", color: "#1d1d1f" }}>Yoma+HR 数字员工平台</div>;
}

function NavRow({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  const base: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8,
    fontSize: 14, marginBottom: 2, cursor: item.disabled ? "not-allowed" : "pointer",
    color: item.disabled ? "#aeaeb2" : active ? "#0071e3" : "#6e6e73",
    background: active ? "#e8f1fd" : "transparent",
    fontWeight: active ? 600 : 400,
  };
  return (
    <div style={base} onClick={item.disabled ? undefined : onClick}>
      {item.icon}
      <span>{item.name}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 11, color: "#aeaeb2", textTransform: "uppercase", padding: "16px 12px 6px", letterSpacing: ".05em" }}>{children}</div>;
}

function UserBlock({ name, role, onLogout }: { name: string; role: PlatformRole; onLogout: () => void }) {
  return (
    <div style={{ marginTop: "auto", padding: "12px 8px 4px", borderTop: "1px solid #f0f0f2" }}>
      <Dropdown
        menu={{
          items: [
            { key: "role", disabled: true, label: <Tag color="blue">{ROLE_LABEL[role]}</Tag> },
            { key: "logout", icon: <LogoutOutlined />, label: "退出登录", onClick: onLogout },
          ],
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 6px", borderRadius: 8, cursor: "pointer" }}>
          <div style={{
            width: 32, height: 32, borderRadius: "50%", flex: "none",
            background: "linear-gradient(135deg, #0a84ff, #0071e3)", color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600,
          }}>
            {name.slice(0, 1)}
          </div>
          <span style={{ fontSize: 14, color: "#1d1d1f" }}>{name}</span>
        </div>
      </Dropdown>
    </div>
  );
}

export function AppShell({
  current, sections, onNavigate, user, onLogout, children,
}: {
  current: string;
  sections: NavSection[];
  onNavigate: (path: string) => void;
  user: { name: string; platformRole: PlatformRole };
  onLogout: () => void;
  children: ReactNode;
}) {
  return (
    <div style={SHELL_STYLE}>
      <aside style={SIDEBAR_STYLE}>
        <BrandTitle />
        {sections.map((sec, i) => (
          <div key={i}>
            {sec.label && <SectionLabel>{sec.label}</SectionLabel>}
            {sec.items.map((item) => (
              <NavRow
                key={item.path}
                item={item}
                active={current === item.path}
                onClick={() => onNavigate(item.path)}
              />
            ))}
          </div>
        ))}
        <UserBlock name={user.name} role={user.platformRole} onLogout={onLogout} />
      </aside>
      <main style={MAIN_STYLE}>{children}</main>
    </div>
  );
}

// 页面顶栏：左侧标题（+可选副标题），右侧操作区。对齐 mockup .topbar。
export function PageTopbar({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 20, fontWeight: 600, color: "#1d1d1f" }}>{title}</div>
        {sub && <div style={{ fontSize: 13, color: "#86868b", marginTop: 4, maxWidth: 640, lineHeight: 1.6 }}>{sub}</div>}
      </div>
      {right && <div style={{ display: "flex", gap: 8, alignItems: "center", flex: "none" }}>{right}</div>}
    </div>
  );
}

// 白卡包裹：对齐 mockup .card（白底 + n200 描边 + 12 圆角 + 裁剪）。
export function TableCard({ children }: { children: ReactNode }) {
  return <div style={{ background: "#fff", border: "1px solid #e3e3e6", borderRadius: 12, overflow: "hidden" }}>{children}</div>;
}
