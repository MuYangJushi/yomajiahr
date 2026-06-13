// 入口：装配并监听（迁自 server.mjs 启动段，行为不变）。
import { createApp } from "./app.js";
import { startFastgptProxy } from "./fastgpt-proxy.js";
import { supportedFormats } from "./middleware.js";
import {
  AUDIT_LOG_PATH,
  AUTH_TOKEN,
  BIND_HOST,
  DEMO_ACCESS_ENABLED,
  DEMO_ACCESS_ROLE,
  DEMO_OPEN_LOGIN_ROLE,
  MAX_UPLOAD_FILE_MB,
  PORT,
  ensureDirs,
} from "./config.js";
import { log } from "./util.js";

if (!AUTH_TOKEN) {
  log(
    "WARN",
    "OPENCLAW_WEB_AUTH_TOKEN is not set — Admin Portal will only accept requests from localhost.",
  );
}

ensureDirs();

const app = createApp();

// 未配置 token 时仅绑定 localhost
const bindHost = BIND_HOST || (AUTH_TOKEN ? "0.0.0.0" : "127.0.0.1");

app.listen(PORT, bindHost, () => {
  log("INFO", `HR Admin Portal running at http://${bindHost}:${PORT}`);
  log("INFO", `  Knowledge base: FastGPT (原生解析导入，无本地归档 — ADR-010)`);
  log("INFO", `  Audit log: ${AUDIT_LOG_PATH}`);
  log(
    "INFO",
    `  Auth: ${AUTH_TOKEN ? "enabled (token)" : "localhost-only (no OPENCLAW_WEB_AUTH_TOKEN)"}`,
  );
  if (DEMO_OPEN_LOGIN_ROLE) {
    log("WARN", `  Demo open login: enabled for every authenticated Feishu/DingTalk account as ${DEMO_OPEN_LOGIN_ROLE}`);
  }
  if (DEMO_ACCESS_ENABLED) {
    log("WARN", `  Demo access code login: enabled as ${DEMO_ACCESS_ROLE}`);
  }
  log("INFO", `  Max upload size: ${MAX_UPLOAD_FILE_MB}MB`);
  log("INFO", `  Supported formats: ${supportedFormats().join(", ")}`);
});

// #46 FastGPT 反向代理（独立端口，默认关；FASTGPT_PROXY_ENABLED=1 才起）。
startFastgptProxy();
