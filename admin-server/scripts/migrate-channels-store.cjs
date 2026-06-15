// ADR-013 一次性迁移：channels.json 旧对象 → 顶层数组 [{id, type, displayName, account, policy, envKeys}]。
// 跑一次：node migrate-channels-store.cjs /path/to/state-dir
//
// envKeys 不能简单从 id 派生（id="hr-employee" → envKey="FEISHU_HR_BOT_*"），
// 用 ENV_KEY_OVERRIDES 维护（与 .env 中实际 key 一致）。
const fs = require("node:fs");
const path = require("node:path");

const ENV_KEY_OVERRIDES = {
  feishu: {
    "hr-employee": ["FEISHU_HR_BOT_APP_ID", "FEISHU_HR_BOT_APP_SECRET"],
    "hr-admin": ["FEISHU_ADMIN_BOT_APP_ID", "FEISHU_ADMIN_BOT_APP_SECRET"],
    "hr-onboard": ["FEISHU_HR_ONBOARD_APP_ID", "FEISHU_HR_ONBOARD_APP_SECRET"],
  },
  dingtalk: {
    "hr-employee": ["DINGTALK_HR_BOT_CLIENT_ID", "DINGTALK_HR_BOT_CLIENT_SECRET"],
    "hr-admin": ["DINGTALK_ADMIN_BOT_CLIENT_ID", "DINGTALK_ADMIN_BOT_CLIENT_SECRET"],
    "hr-onboard": ["DINGTALK_HR_ONBOARD_CLIENT_ID", "DINGTALK_HR_ONBOARD_CLIENT_SECRET"],
  },
};

const stateDir = process.argv[2] || "/home/ubuntu/.openclaw";
const file = path.join(stateDir, "config-store", "channels.json");
if (!fs.existsSync(file)) {
  console.log(`[skip] ${file} 不存在`);
  process.exit(0);
}
const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
if (Array.isArray(raw)) {
  console.log(`[skip] ${file} 已是数组形态`);
  process.exit(0);
}

const DOMAIN_TO_TYPE = { feishu: "feishu", "dingtalk-connector": "dingtalk" };
const out = [];
for (const [domain, accountMap] of Object.entries(raw || {})) {
  const type = DOMAIN_TO_TYPE[domain];
  if (!type) {
    console.log(`[warn] 未知 domain: ${domain}，跳过其下账号`);
    continue;
  }
  for (const [id, acc] of Object.entries(accountMap || {})) {
    const { dmPolicy, groupPolicy, requireMention, name, ...rest } = acc;
    const account = { ...rest };
    if (name) account.name = name;
    out.push({
      id,
      type,
      displayName: name || id,
      enabled: rest.enabled !== false,
      account,
      policy: { dmPolicy, groupPolicy, requireMention },
      envKeys:
        ENV_KEY_OVERRIDES[type]?.[id] || [
          `${type.toUpperCase()}_${id.toUpperCase().replace(/-/g, "_")}_${type === "feishu" ? "APP_ID" : "CLIENT_ID"}`,
          `${type.toUpperCase()}_${id.toUpperCase().replace(/-/g, "_")}_${type === "feishu" ? "APP_SECRET" : "CLIENT_SECRET"}`,
        ],
    });
  }
}

const bak = `${file}.bak-pre-adr013`;
fs.copyFileSync(file, bak);
fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`[ok] ${file} → ${out.length} 条账号（备份 ${bak}）`);
