# Yoma+HR 品牌命名指南

本文档记录项目从上游 `openclaw` 命名体系到 `Yoma+HR` / `ymjhr` 产品品牌的所有命名变更。

---

## 命名策略：三层命名

| 层级                   | 名称       | 用途                                     | 示例                                           |
| ---------------------- | ---------- | ---------------------------------------- | ---------------------------------------------- |
| **品牌显示名**         | `Yoma+HR`  | 文档标题、UI 界面、描述性文字            | "Yoma+HR 智能助手"                             |
| **技术命令名**         | `ymjhr`    | CLI 命令、目录路径、systemd 服务名、日志 | `ymjhr gateway run`、`~/.ymjhr/`               |
| **引擎层**（保持不变） | `openclaw` | 上游运行时，环境变量名                   | `OPENCLAW_STATE_DIR`、`OPENCLAW_GATEWAY_TOKEN` |

**核心原则**：环境变量的**名称**保持 `OPENCLAW_*` 不变，但它们的**值**使用 `ymjhr` 路径。

---

## CLI 命令改名

### 改动文件

**1. `src/cli/cli-name.ts`**

```diff
- export const DEFAULT_CLI_NAME = "openclaw";
- const KNOWN_CLI_NAMES = new Set([DEFAULT_CLI_NAME]);
- const CLI_PREFIX_RE = /^(?:((?:pnpm|npm|bunx|npx)\s+))?(openclaw)\b/;
+ export const DEFAULT_CLI_NAME = "ymjhr";
+ const KNOWN_CLI_NAMES = new Set([DEFAULT_CLI_NAME, "openclaw"]);
+ const CLI_PREFIX_RE = /^(?:((?:pnpm|npm|bunx|npx)\s+))?(openclaw|ymjhr)\b/;
```

**2. `package.json`**（bin 字段）

```diff
  "bin": {
+   "ymjhr": "openclaw.mjs",
    "openclaw": "openclaw.mjs"
  },
```

**3. `openclaw.mjs`**（错误提示文案）

```diff
- `openclaw: Node.js v${MIN_NODE_VERSION}+ is required ...`
+ `ymjhr: Node.js v${MIN_NODE_VERSION}+ is required ...`

- const lines = ["openclaw: missing dist/entry.(m)js (build output)."];
+ const lines = ["ymjhr: missing dist/entry.(m)js (build output)."];
```

### 效果

- `ymjhr gateway run ...` — 产品命令（推荐使用）
- `openclaw gateway run ...` — 上游命令，仍然兼容
- 所有子命令和参数保持不变

### 部署时注册 CLI 命令

构建完成后，通过 `npm link` 将 `ymjhr` 注册到系统 PATH：

```bash
cd /opt/yomajiahr
pnpm install
pnpm build
npm link    # 注册 ymjhr 和 openclaw 到全局 PATH
```

验证：

```bash
ymjhr --version
```

---

## 部署层命名对照表

### systemd 服务

| 旧名                                        | 新名                               |
| ------------------------------------------- | ---------------------------------- |
| `openclaw-hr-gateway.service`               | `ymjhr-gateway.service`            |
| `openclaw-hr-admin.service`                 | `ymjhr-admin.service`              |
| `Description=OpenClaw HR Assistant Gateway` | `Description=Yoma+HR Gateway`      |
| `Description=OpenClaw HR Admin Portal`      | `Description=Yoma+HR Admin Portal` |

### 系统用户

| 旧名                               | 新名                         |
| ---------------------------------- | ---------------------------- |
| `User=openclaw` / `Group=openclaw` | `User=ymjhr` / `Group=ymjhr` |
| `useradd ... openclaw`             | `useradd ... ymjhr`          |

### 运行时目录

| 旧路径                      | 新路径                | 配置方式                      |
| --------------------------- | --------------------- | ----------------------------- |
| `~/.openclaw/`              | `~/.ymjhr/`           | `OPENCLAW_STATE_DIR=~/.ymjhr` |
| `/home/openclaw/.openclaw/` | `/home/ymjhr/.ymjhr/` | systemd EnvironmentFile       |

### 日志路径

| 旧路径                         | 新路径                   |
| ------------------------------ | ------------------------ |
| `/tmp/openclaw-hr-gateway.log` | `/tmp/ymjhr-gateway.log` |
| `/tmp/openclaw-hr-admin.log`   | `/tmp/ymjhr-admin.log`   |

### CLI 命令

| 旧命令                                       | 新命令                          |
| -------------------------------------------- | ------------------------------- |
| `node dist/index.js gateway run ...`         | `ymjhr gateway run ...`         |
| `node dist/index.js channels status --probe` | `ymjhr channels status --probe` |
| `node dist/index.js skills list`             | `ymjhr skills list`             |

### 代码仓库部署路径

| 旧路径               | 新路径            |
| -------------------- | ----------------- |
| `/opt/hr-assistant/` | `/opt/yomajiahr/` |

---

## 配置文件重命名

| 旧文件名                             | 新文件名                    |
| ------------------------------------ | --------------------------- |
| `config/openclaw.hr-assistant.jsonc` | `config/ymjhr.jsonc`        |
| `config/.env.hr-assistant.example`   | `config/.env.ymjhr.example` |

---

## 文档标题更新

| 文件                                   | 旧标题                           | 新标题                       |
| -------------------------------------- | -------------------------------- | ---------------------------- |
| `docs/yomajiahr-architecture.md`       | OpenClaw HR 智能助手             | Yoma+HR 智能助手             |
| `docs/design/yomajiahr_review.md`      | OpenClaw HR 智能助手方案评审意见 | Yoma+HR 智能助手方案评审意见 |
| `docs/design/yomajiahr_fixed.html`     | OpenClaw HR 智能助手 v2.0        | Yoma+HR 智能助手 v2.0        |
| `docs/design/yomajiahr_optimized.html` | OpenClaw HR 智能助手             | Yoma+HR 智能助手             |

---

## 不改动的内容

| 项目                          | 原因                             |
| ----------------------------- | -------------------------------- |
| `OPENCLAW_*` 环境变量名称     | 源码硬编码，改动成本高且影响升级 |
| `openclaw` npm 包名           | 上游依赖                         |
| `openclaw` CLI 命令           | 保留兼容，与 `ymjhr` 双命令共存  |
| 飞书 Bot 中文名（HR小助手等） | 已经是独立品牌                   |
| `openclaw.mjs` 入口文件名     | 上游文件，ymjhr bin 指向同一文件 |
