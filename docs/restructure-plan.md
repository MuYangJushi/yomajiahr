# Yoma+HR 项目重构：剥离 openclaw 源码，保留 Agent 配置层

## Context

当前仓库是 openclaw 的完整 fork，包含所有源码（src/、extensions/、dist/ 等）。实际的 HR 定制只有少量配置文件、3 个 Skills、2 个 workspace 和 admin-portal。目标是剥离 openclaw 源码，只保留 HR 定制层，openclaw 通过官方 `npm install -g openclaw` 安装，新服务器通过 `git clone` + `install.sh` 一键部署。

## 重构后目录结构

```
yomajiahr/
  README.md
  install.sh                          # 一键部署脚本
  .gitignore                          # 新的，极简

  config/
    openclaw.jsonc                    # 重命名自 ymjhr.jsonc，路径改为 ~/.openclaw/
    .env.example                      # 重命名自 .env.ymjhr.example
    openclaw-gateway.service          # systemd，命令改为 openclaw
    openclaw-admin.service            # systemd，路径更新

  workspaces/
    hr-assistant/                     # 原 workspace-hr-assistant/
      AGENTS.md, CLAUDE.md, IDENTITY.md, MEMORY.md, SOUL.md, TOOLS.md
    hr-admin/                         # 原 workspace-hr-admin/
      AGENTS.md, CLAUDE.md, IDENTITY.md, MEMORY.md, SOUL.md, TOOLS.md

  skills/
    hr-policy-qa/                     # 仅保留 3 个 HR skills
    hr-admin/
    hr-general/

  admin-portal/                       # 独立 Express 应用，不变
    server.mjs, package.json, lib/, public/

  docs/
    architecture.md
    branding.md
    deployment.md
    restructure-plan.md               # 本文档
```

## 实施步骤

### Step 1: 移动 HR 文件到新结构

- `workspace-hr-assistant/` -> `workspaces/hr-assistant/`
- `workspace-hr-admin/` -> `workspaces/hr-admin/`
- `config/ymjhr.jsonc` -> `config/openclaw.jsonc`
- `config/.env.ymjhr.example` -> `config/.env.example`
- `config/ymjhr-gateway.service` -> `config/openclaw-gateway.service`
- `config/ymjhr-admin.service` -> `config/openclaw-admin.service`
- `docs/yomajiahr-*.md` -> `docs/` (去掉 yomajiahr- 前缀)

### Step 2: 删除所有 openclaw 源码文件

删除以下目录/文件（`git rm -r`）：

**目录：** `src/`, `extensions/`, `dist/`, `dist-runtime/`, `apps/`, `Swabble/`, `ui/`, `packages/`, `vendor/`, `test/`, `test-fixtures/`, `node_modules/`, `.github/`, `.agent/`, `.agents/`, `.pi/`, `.vscode/`, `git-hooks/`, `assets/`, `patches/`, `scripts/`（整个 openclaw 脚本目录）

**根目录文件：** `openclaw.mjs`, `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `AGENTS.md`, `CLAUDE.md`（根目录的 symlink）, `CHANGELOG.md`, `appcast.xml`, `CONTRIBUTING.md`, `SECURITY.md`, `VISION.md`, `README.md`（重写）, `Dockerfile*`, `docker-*`, `fly*.toml`, `vitest.*`, `tsconfig*`, `tsdown*`, `knip*`, `render.yaml`, `zizmor.yml`, `docs.acp.md`, `pyproject.toml`, `setup-podman.sh`, `docker-setup.sh`, `openclaw.podman.env`

**点文件：** `.oxlintrc.json`, `.oxfmtrc.jsonc`, `.pre-commit-config.yaml`, `.detect-secrets.cfg`, `.secrets.baseline`, `.shellcheckrc`, `.swiftformat`, `.swiftlint.yml`, `.markdownlint-cli2.jsonc`, `.prettierignore`, `.npmrc`, `.npmignore`, `.mailmap`, `.jscpd.json`, `.gitattributes`, `.dockerignore`, `.env.example`（根目录的）

### Step 3: 删除非 HR 的 skills

删除 `skills/` 下除 `hr-policy-qa/`、`hr-admin/`、`hr-general/` 以外的所有目录（约 50 个 openclaw 内置 skills）。

### Step 4: 编辑配置文件，更新路径

**`config/openclaw.jsonc`**：
- 注释中 `~/.ymjhr/ymjhr.json` -> `~/.openclaw/openclaw.json`
- `"workspace": "~/.ymjhr/workspace-hr-assistant"` -> `"~/.openclaw/workspaces/hr-assistant"`
- `"workspace": "~/.ymjhr/workspace-hr-admin"` -> `"~/.openclaw/workspaces/hr-admin"`
- 删除 `store.path` 配置块，使用 openclaw 默认路径 `~/.openclaw/memory/{agentId}.sqlite`
- `extraPaths` 中 `"../data/hr-policies"` 改为 `"../../data/hr-policies"`（从 `~/.openclaw/workspaces/hr-assistant/` 向上两级到 `~/.openclaw/data/hr-policies`）

**`config/openclaw-gateway.service`**：
- `ExecStart` 改为 `openclaw gateway run ...`（不再用 `ymjhr`）
- 所有 `~/.ymjhr` -> `~/.openclaw`
- `WorkingDirectory` 更新

**`config/openclaw-admin.service`**：
- 所有 `~/.ymjhr` -> `~/.openclaw`

**`admin-portal/server.mjs`**：
- 默认 STATE_DIR fallback 从 `.ymjhr` 改为 `.openclaw`

### Step 5: 编写 `install.sh`

一键部署脚本，逻辑：

1. **检查 Node.js** >= 22
2. **安装 openclaw**：`npm install -g openclaw@latest`，验证 `openclaw --version`
3. **创建目录结构**：`~/.openclaw/`、`workspaces/hr-assistant/`、`workspaces/hr-admin/`、`memory/`（openclaw 默认索引目录）、`skills/`、`data/hr-policies/{leave,onboarding,attendance,compensation,training,general}`、`data/hr-admin/`
4. **复制 workspace 文件**：从 `workspaces/` 到 `~/.openclaw/workspaces/*/`
5. **复制 skills**：从 `skills/` 到 `~/.openclaw/skills/`
6. **编译配置**：JSONC -> JSON 写入 `~/.openclaw/openclaw.json`
7. **复制 .env 模板**：若不存在则复制
8. **安装 admin-portal 依赖**：`cd admin-portal && npm install --omit=dev`
9. **（Linux）安装 systemd 服务**：可选，提示用户确认

### Step 6: 编写新 `.gitignore`

```
node_modules/
.env
*.sqlite
.DS_Store
admin-portal/uploads/
```

### Step 7: 重写 `README.md`

简介 Yoma+HR 项目、前置条件（Node.js 22+）、一键部署方法（`git clone` + `./install.sh`）、配置说明、启动命令。

### Step 8: 更新 docs/deployment.md

更新部署文档，反映新的目录结构和 `install.sh` 流程。

## 关键文件清单

| 操作 | 文件 |
|------|------|
| 重命名+编辑 | `config/ymjhr.jsonc` -> `config/openclaw.jsonc`（路径 + 删除 store 块） |
| 重命名+编辑 | `config/ymjhr-gateway.service` -> `config/openclaw-gateway.service` |
| 重命名+编辑 | `config/ymjhr-admin.service` -> `config/openclaw-admin.service` |
| 重命名 | `config/.env.ymjhr.example` -> `config/.env.example` |
| 移动 | `workspace-hr-assistant/` -> `workspaces/hr-assistant/` |
| 移动 | `workspace-hr-admin/` -> `workspaces/hr-admin/` |
| 编辑 | `admin-portal/server.mjs`（STATE_DIR 默认值 `.ymjhr` -> `.openclaw`） |
| 新建 | `install.sh` |
| 新建 | `.gitignore` |
| 重写 | `README.md` |
| 更新 | `docs/deployment.md` |

## 验证方式

1. `git status` 确认只剩 HR 相关文件，无 openclaw 源码
2. 在干净环境运行 `./install.sh`，验证：
   - openclaw 安装成功（`openclaw --version`）
   - `~/.openclaw/` 目录结构正确
   - `~/.openclaw/openclaw.json` 内容正确
   - `~/.openclaw/skills/` 下有 3 个 HR skills
   - `~/.openclaw/workspaces/hr-assistant/` 和 `workspaces/hr-admin/` 文件完整
   - `admin-portal/node_modules/` 安装成功
3. `openclaw gateway run --bind loopback --port 18789` 能正常启动并加载 agents
