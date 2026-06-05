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
          colorPrimary: "#0ea5a0",
          colorLink: "#0ea5a0",
          colorLinkHover: "#0d8f8a",
          borderRadius: 8,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        },
        components: {
          Button: { borderRadius: 8 },
          Table: { borderRadius: 10 },
          Card: { borderRadius: 10 },
          Modal: { borderRadius: 14 },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);
