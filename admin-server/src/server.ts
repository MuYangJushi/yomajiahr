// 入口：装配并监听（迁自 server.mjs 启动段，行为不变）。
import { supportedFormats } from "../lib/doc-converter.mjs";
import { createApp } from "./app.js";
import { startFastgptProxy } from "./fastgpt-proxy.js";
import {
  AUDIT_LOG_PATH,
  AUTH_TOKEN,
  BIND_HOST,
  MAX_UPLOAD_FILE_MB,
  POLICIES_DIR,
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
  log("INFO", `  Knowledge base: ${POLICIES_DIR}`);
  log("INFO", `  Audit log: ${AUDIT_LOG_PATH}`);
  log(
    "INFO",
    `  Auth: ${AUTH_TOKEN ? "enabled (token)" : "localhost-only (no OPENCLAW_WEB_AUTH_TOKEN)"}`,
  );
  log("INFO", `  Max upload size: ${MAX_UPLOAD_FILE_MB}MB`);
  log("INFO", `  Supported formats: ${supportedFormats().join(", ")}`);
});

// #46 FastGPT 反向代理（独立端口，默认关；FASTGPT_PROXY_ENABLED=1 才起）。
startFastgptProxy();
