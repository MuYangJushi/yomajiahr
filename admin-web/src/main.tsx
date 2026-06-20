import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider } from "antd";
import "./index.css";
import zhCN from "antd/locale/zh_CN";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#0071e3",
          colorLink: "#0071e3",
          colorLinkHover: "#0077ed",
          colorSuccess: "#34c759",
          colorWarning: "#ff9500",
          colorError: "#ff3b30",
          colorInfo: "#0071e3",
          colorBgLayout: "#f5f5f7",
          borderRadius: 8,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif',
        },
        components: {
          Button: { borderRadius: 8 },
          // 对齐 design tokens v0.2：表头 n50 底 + 12px 说明文(n500)、行分隔 n100、单元格里外距 16/20。
          Table: {
            borderRadius: 12,
            headerBg: "#f5f5f7",
            headerColor: "#86868b",
            headerSplitColor: "transparent",
            rowHoverBg: "#fafafa",
            borderColor: "#f0f0f2",
            cellPaddingBlock: 16,
            cellPaddingInline: 20,
            fontSize: 14,
          },
          Card: { borderRadius: 12 },
          Modal: { borderRadius: 16 },
          Tag: { borderRadiusSM: 6 },
          Layout: { headerBg: "#fff", bodyBg: "#f5f5f7", siderBg: "#fff" },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);
