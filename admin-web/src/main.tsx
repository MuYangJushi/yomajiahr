import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider } from "antd";
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
          borderRadius: 8,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif',
        },
        components: {
          Button: { borderRadius: 8 },
          Table: { borderRadius: 12 },
          Card: { borderRadius: 12 },
          Modal: { borderRadius: 16 },
          Tag: { borderRadiusSM: 6 },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);
