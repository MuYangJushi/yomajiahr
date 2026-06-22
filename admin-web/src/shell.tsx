// 脱离 ProComponents 的纯净外壳，对齐 design tokens v0.2 mockup。
// ProLayout → AppShell（自研侧边栏 + main 容器）；
// ProTable 工具栏 → PageTopbar（标题/副标题/右侧操作）+ TableCard（白卡包裹原生 Table）。
// 移动端适配（≤ 768px）：侧边栏收起为 Drawer，main 顶部出现 hamburger；padding 减小。
import React, { useEffect, useState, type ReactNode } from "react";
import { Drawer, Dropdown, Tag } from "antd";
import { LogoutOutlined, MenuOutlined } from "@ant-design/icons";
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

const MOBILE_BREAKPOINT = "(max-width: 768px)";
/** 监听媒体查询，SSR 安全；用于决定是否切到移动版布局。 */
function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState<boolean>(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatch(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [query]);
  return match;
}

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
    <div style={{ marginTop: "auto", flexShrink: 0, padding: "12px 8px", borderTop: "1px solid #f0f0f2" }}>
      <Dropdown
        menu={{
          items: [
            { key: "role", disabled: true, label: <Tag color="blue">{ROLE_LABEL[role]}</Tag> },
            { key: "logout", icon: <LogoutOutlined />, label: "退出登录", onClick: onLogout },
          ],
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 6px", borderRadius: 8, cursor: "pointer", minWidth: 0 }}>
          <div style={{
            width: 32, height: 32, borderRadius: "50%", flex: "none",
            background: "linear-gradient(135deg, #0a84ff, #0071e3)", color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600,
          }}>
            {name.slice(0, 1)}
          </div>
          <span style={{ fontSize: 14, lineHeight: 1.4, color: "#1d1d1f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
        </div>
      </Dropdown>
    </div>
  );
}

/** 侧边栏内容（导航 + 用户区），宽屏直接 render、窄屏放进 Drawer 复用。 */
function SidebarContent({ sections, current, onNavigate, user, onLogout }: {
  sections: NavSection[]; current: string; onNavigate: (path: string) => void;
  user: { name: string; platformRole: PlatformRole }; onLogout: () => void;
}) {
  return (
    <>
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
    </>
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
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 切回宽屏时关掉抽屉，避免遗留打开状态。
  useEffect(() => { if (!isMobile) setDrawerOpen(false); }, [isMobile]);
  const handleNavigate = (p: string) => { onNavigate(p); setDrawerOpen(false); };

  const shellStyle: React.CSSProperties = { display: "flex", height: "100vh", overflow: "hidden", background: "#f5f5f7" };
  const sidebarStyle: React.CSSProperties = {
    width: 240, flex: "none", background: "#fff", borderRight: "1px solid #e3e3e6",
    padding: "20px 12px", display: "flex", flexDirection: "column", height: "100%", overflowY: "auto",
  };
  // 内边距放到内层 div，不放在滚动容器 MAIN 本身：Chrome 下「flex 子项 + 自身 overflow 滚动」
  // 时容器自己的 padding-bottom 不计入可滚动区域，会把最后一行/最后一个元素裁在视口底。
  const mainStyle: React.CSSProperties = { flex: 1, minWidth: 0, height: "100%", overflowY: "auto" };
  const mainInnerStyle: React.CSSProperties = { padding: isMobile ? "16px" : "32px 40px" };

  return (
    <div style={shellStyle}>
      {!isMobile && (
        <aside style={sidebarStyle}>
          <SidebarContent sections={sections} current={current} onNavigate={handleNavigate} user={user} onLogout={onLogout} />
        </aside>
      )}
      {isMobile && (
        <Drawer
          placement="left"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          width={Math.min(280, typeof window !== "undefined" ? window.innerWidth - 60 : 280)}
          styles={{ body: { padding: "20px 12px", display: "flex", flexDirection: "column", height: "100%" } }}
          closable={false}
        >
          <SidebarContent sections={sections} current={current} onNavigate={handleNavigate} user={user} onLogout={onLogout} />
        </Drawer>
      )}
      <main style={mainStyle}>
        {isMobile && (
          <div style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "12px 16px", background: "#fff", borderBottom: "1px solid #e3e3e6",
            position: "sticky", top: 0, zIndex: 10,
          }}>
            <button
              onClick={() => setDrawerOpen(true)}
              aria-label="打开导航"
              style={{
                background: "transparent", border: "none", padding: 4, cursor: "pointer",
                fontSize: 20, color: "#1d1d1f", display: "flex",
              }}
            >
              <MenuOutlined />
            </button>
            <span style={{ fontSize: 15, fontWeight: 600, color: "#1d1d1f" }}>Yoma+HR</span>
          </div>
        )}
        <div style={mainInnerStyle}>{children}</div>
      </main>
    </div>
  );
}

// 页面顶栏：左侧标题（+可选副标题），右侧操作区。对齐 mockup .topbar。
// 窄屏自动换行：避免标题与右侧按钮挤成一坨。
export function PageTopbar({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, gap: 12, flexWrap: "wrap" }}>
      <div style={{ minWidth: 0, flex: "1 1 240px" }}>
        <div style={{ fontSize: 20, fontWeight: 600, color: "#1d1d1f" }}>{title}</div>
        {sub && <div style={{ fontSize: 13, color: "#86868b", marginTop: 4, maxWidth: 640, lineHeight: 1.6 }}>{sub}</div>}
      </div>
      {right && <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{right}</div>}
    </div>
  );
}

// 白卡包裹：对齐 mockup .card（白底 + n200 描边 + 12 圆角 + 裁剪）。
export function TableCard({ children }: { children: ReactNode }) {
  return <div style={{ background: "#fff", border: "1px solid #e3e3e6", borderRadius: 12, overflow: "hidden" }}>{children}</div>;
}
