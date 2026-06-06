# P1 执行级方案：数字员工配置（支柱一）

> 上游：`yomajiahr-kb/10-decisions/ADR-005` + `docs/p0-config-platform-plan.md`（P0 地基已完成并入 `feat/p0-config-platform`）。
> 分支：续用 `feat/p0-config-platform`（或新开 `feat/p1-agent-config`，落地时定）。
> 目标：**统一 React+antd SPA**（迁移现有上传/文档/审计三页 + 新增数字员工配置）+ **完整 agent CRUD**（列表/新建/编辑/删除）+ 渠道账号 + binding + 秘钥录入 + **原子编排** + **一键上线**（复用 P0 apply）。

---

## 一、依赖与现状

- **P0 已交付**：config-store 结构化配置、`generate-config`/`validate-config`（TS，含 ADR 红线校验 + `role` 字段）、`apply-config.sh`（快照/重启/探活/回滚）、`POST /api/config/apply` + `triggerApply`。
- **现有 portal**：单文件 `server.mjs`（Express 5）+ vanilla JS 三页（上传/文档/审计，~1100 行）+ `lib/*.mjs`（doc-converter/chunker/frontmatter/metadata-inference/categories）。
- **workspace 模板**：`workspaces/hr-assistant|hr-admin/` 各 5 个 .md（IDENTITY/SOUL/AGENTS/TOOLS/MEMORY）+ CLAUDE.md 软链。

---

## 二、P1 关键决策

| # | 决策 | 说明 |
|---|---|---|
| 0 | **配置源位置：运行时 store 移到 `$STATE_DIR`，仓库只留 seed** ⚠️改 P0 代码 | 现 `config/config-store/*.json` 是 git 跟踪的活配置；UI 运行时改它会让部署机 git 树变脏，下次 `git pull`/`install.sh` 冲突或覆盖线上配置。**修正**：仓库保留 `config/config-store.seed/`(模板，committed)；运行时真相在 `$STATE_DIR/config-store/`(平台拥有)。`install.sh` **首装时** seed→$STATE_DIR(已存在则不覆盖)；`generate-config`/`apply-config.sh`/portal CRUD 全部读写 `$STATE_DIR/config-store`。这是 P1 第 0 步，先于 CRUD。 |
| 1 | **前端：Vite + React + TS + Ant Design + ProComponents** | 决策五既定。`admin-portal/web/`(Vite 工程) → 构建产物输出到 `admin-portal/public/`，由现有 Express `express.static` 托管，保持单部署。**注意**：迁移会删除 `public/` 下 vanilla 文件，需同步更新 server.mjs 的 SPA catch-all 路由。`@ant-design/charts` 属 P3，不进 P1 依赖。 |
| 2 | **后端：portal 引入 TS + 结构化**（TS-first 对齐决策五） | 新建 `admin-portal/src/`(TS：routes/services/middleware)，用 **tsup** 构建到 `admin-portal/dist/`；`server.mjs` 瘦身为装配入口（或迁为 `src/server.ts`）。**现有 upload/docs/audit 逻辑迁入新结构，行为不变**（统一迁移要求）。复用 P0 的 `config/` TS 包做 generate/validate/apply。 |
| 3 | **秘钥（基石 D）：.env 键级 upsert** | secret 服务：UI 表单收 appId/appSecret/clientId/clientSecret → **键级 upsert 写 `$STATE_DIR/.env`**（保留既有键/注释/非 bot 秘钥如 `MINIMAX_API_KEY`/`DASHSCOPE_API_KEY`，**绝不整体重写**；原子 tmp+rename + chmod 600）；config-store 只存 `${VAR}` 引用。**.env 值不回传前端**（只回传"已设置/未设置"）。 |
| 4 | **原子编排** | "新建一个数字员工 = 一次事务"：内存装配所有变更 → 校验 → 快照 → 逐项落盘 → apply → **失败整体回滚**。详见 §四。 |
| 5 | **认证沿用 token** | 复用现有 `OPENCLAW_WEB_AUTH_TOKEN`；前端 axios 拦截器注入 Bearer。**平台级 RBAC 仍是遗留缺口**（承接 P0），P1 至少在写操作审计里记录操作者占位。 |

---

## 三、后端 API（新增，全部在 `/api` 受 token 守卫）

| 方法/路径 | 作用 |
|---|---|
| `GET /api/config/agents` | 列出 agents（来自 config-store/agents.json，含 role/skills/tools/绑定渠道汇总） |
| `POST /api/config/agents` | 新建 agent（触发原子编排，§四） |
| `PUT /api/config/agents/:id` | 编辑 agent（身份/技能/权限/渠道/binding 变更，事务化） |
| `DELETE /api/config/agents/:id` | 删除 agent（连带其 bindings + 可选 workspace 归档） |
| `GET /api/config/channels` | 列出渠道与账号（秘钥字段以 `${VAR}` + "已设置?"呈现，不回明文） |
| `POST /api/config/secrets` | 批量写 .env 键值（原子 + 600） |
| `GET /api/config/skills` | 列出可分配技能（扫描 `skills/`，读 SKILL.md frontmatter description） |
| `GET /api/config/preview` | 预览将写入的变更（store diff + workspace 文件清单 + 受影响 binding），供 UI 上线前确认 |
| `POST /api/config/apply` | **P0 已存在**——校验→快照→重启→探活→回滚 |

写操作统一流程：**装配 → 复用 config 包 Zod 校验（含 ADR 红线）→ 写盘**；是否立即 apply 由 UI 决定（新建向导末尾"上线"按钮触发 apply；零散编辑可暂存后统一上线）。

---

## 四、原子编排（新建/编辑 agent 的事务性）

一次"上岗"涉及多处写：`$STATE_DIR/config-store/{agents,channels,bindings}.json` + `$STATE_DIR/workspaces/<id>/` 5 文件 + `$STATE_DIR/.env` 秘钥。需"全做或全不做"，且**整段串行**：

```
0. 单飞锁：portal 进程级互斥锁包裹「装配→落盘→apply」整段（P0 只串行化了 oneshot apply；
   §四的多处写发生在 portal 进程内、apply 之前，并发创建会交错写入/中途 apply → 必须加锁）
1. 内存装配：表单 → agent 条目(role→tools 默认)、channel account、bindings、workspace 文件内容、.env 增量
2. 预校验（写盘前）：在内存 store 上跑 validateConfig（ADR 红线）。
   ⚠️ P0 的 generateConfig 是基于文件的 → 需扩展为接受「内存 store」入参（或生成到临时 store 目录再校验）。落地时按"内存入参"实现。
3. 快照：备份 store/*.json + .env + 现有 workspace 目录（apply 自身另会快照 runtime last-good）
4. 落盘：写 workspace 文件 → 写 .env(键级 upsert) → 写 store（顺序固定，便于回滚）
5. apply：触发 P0 流水线（生成→校验→重启→探活）。
   ⚠️ 此处校验必须开 checkFilesystem=true（传 skillsDir + resolveWorkspace 做 ~ 展开），
   否则新 agent 漏写 workspace 文件/错填 skill 能过校验却让 gateway 运行时起不来。需给 apply-config.sh 加 --check-fs。
6. 失败：回滚 store/.env/workspace 到步骤 3 快照（apply 内部已回滚 runtime）
```

- **role → tools 默认**：`employee` 套用只读（deny `memory_write/memory_delete/exec`）；`admin` 放行写工具。UI 选岗位即套用，落 `tools.deny`（ADR-003 硬隔离，不可在 UI 关闭）。
- **workspace 生成**：从 `workspaces/_templates/`（P1 新建：抽取自现有 hr-assistant 的通用骨架）按表单注入 name/role/persona/技能说明，生成 5 文件 + CLAUDE.md 软链。
- **sub-agent 防线**：UI 不提供 sessions_spawn 选项；校验器兜底（ADR-001）。
- **不变量**：agent `id` **创建后不可改**（它是 bindings 外键 + workspace 目录名，改名要级联）——编辑只能改其余字段。删除/取消默认 agent 时，**不得使系统无 `default:true` agent**（删最后一个或当前默认前须先改派默认）。

---

## 五、前端结构（`admin-portal/web/`）

- Vite + React + TS + antd + `@ant-design/pro-components` + `@ant-design/charts`(P3 备用)
- **ProLayout 外壳**，菜单：**数字员工** / 文档 / 上传 / 审计
- **数字员工**：
  - `ProTable` 列表（名称/岗位 role/技能/渠道/状态/上次上线）
  - `StepsForm` 新建/编辑向导：① 身份与岗位(name/role/persona) → ② 技能(多选 `GET /skills`) → ③ 渠道接入(飞书/钉钉 + 账号) → ④ 秘钥录入 → ⑤ 权限(按 role 预置 tools，只读项锁定) → ⑥ 预览(`/preview`) + 上线(`/apply`)
- **迁移三页**（行为不变，复用现有 API）：上传(`ProForm`+`Upload`+拖拽)、文档(`ProTable`+查看/删除)、审计(`ProTable`+筛选+CSV 导出)
- **认证**：axios 拦截器读 localStorage token 注 Bearer；401 弹输入框（沿用现逻辑）

---

## 六、文件清单

**新增**：
- `admin-portal/web/`（Vite 工程：`package.json`/`vite.config.ts`/`tsconfig.json`/`src/**`）
- `admin-portal/src/`（后端 TS：`routes/config.ts`、`services/{agents,channels,secrets,orchestrator}.ts`、`middleware/auth.ts`、`server.ts`）
- `admin-portal/tsup.config.ts`、后端 `tsconfig.json`
- `workspaces/_templates/`（agent workspace 模板：5 个 .md + 占位符）

**新增（P0 调整）**：
- `config/config-store.seed/{agents,channels,bindings}.json`（仓库 seed 模板；现 `config/config-store/` 退役为 seed 或改名）

**修改（P0 调整）**：
- `config/src/generate-config.ts`（store 默认路径 → `$STATE_DIR/config-store`；新增内存 store 入参；CLI 加 `--resolve-home`/`~` 展开）
- `config/scripts/apply-config.sh`（store 路径 → `$STATE_DIR/config-store`；generate 调用加 `--check-fs --skills-dir`）
- `install.sh`（首装 seed config-store → `$STATE_DIR`，已存在不覆盖；generate `--store $STATE_DIR/config-store`）

**修改**：
- `admin-portal/package.json`（加 React/antd/pro-components/vite/tsup/typescript；scripts: `build:web`/`build:server`/`build`/`dev`）
- 现有 `lib/*.mjs`→按需 TS 化（沿用决策五迁移顺序；P1 至少把 config CRUD 依赖的部分纳入）
- `install.sh`（admin-portal 安装步骤加 `npm run build`：构建后端 + 前端）
- `config/openclaw-admin.service`（ExecStart 指向构建产物 `dist/server.js`）
- `docs/deployment.md`（portal 构建/目录说明）

---

## 七、落地顺序

> 排序原则（advisor）：P1 捆绑了三件独立的风险事项——后端 TS 重构(动部署路径)、三页重写、全新 agent-config。让**新价值早落地**、**不与框架迁移同时调试**：先隔离做后端重构(带回归)，再在 React 壳里做新功能,最后迁三页。

0. **P0 调整(前置)**：config-store 迁 `$STATE_DIR`（仓库留 `config-store.seed/`；install.sh 首装 seed；改 generate/apply/install 路径）；`generateConfig` 加内存 store 入参；`apply-config.sh` 加 `--check-fs`。**带回归：P0 的 parity/负例测试重跑通过**。
1. **后端 TS 结构（隔离 + 回归）**：`admin-portal/src/` + tsup 构建 + service ExecStart 改 `dist/server.js`；现有三页 API **逐字迁入**新结构，行为不变；对拍迁移前后请求。（动部署路径，单独成步，先稳住）
2. **数字员工核心（新价值）**：React+antd ProLayout 壳 + `GET/POST /api/config/agents` + 列表 + 新建向导（原子编排 + 上线）。先让支柱一可用。
3. **编辑 / 删除**（事务化，含 id 不可改 / 默认 agent 守卫）。
4. **迁移三页**（上传/文档/审计 → React+antd，复用已迁后端 API）——放最后，框架迁移与新功能不并行调试。
5. 收尾：install.sh/service/deploy 文档同步。

---

## 八、验证

- **后端回归**：迁移后三页 API（上传/文档/审计）行为与迁移前一致（对拍若干请求）。
- **CRUD + 校验**：新建一个 employee agent → 校验通过 → store/workspace/.env 正确落盘；构造越权（employee 配写工具）→ 被 Zod 拦截。
- **原子回滚**：编排中途强制失败（apply 探活失败）→ store/.env/workspace 全部回滚到操作前。
- **端到端**（测试服务器 systemd）：向导新建 agent + 接入测试 bot → 上线 → 飞书/钉钉对该 bot 发消息能应答。
- **前端**：webapp-testing/Playwright 跑向导主流程 + 三页基本操作。

---

## 九、风险 / 遗留

1. **平台 RBAC**（承接 P0）：写操作 + 上线特权目前仅共享 token。P1 先加"操作者标识 + 写操作审计"，完整 RBAC 另立。
2. **原子编排事务边界**：workspace/.env 非数据库，回滚靠快照补偿；需覆盖"部分写入后崩溃"的恢复测试。
3. **探活功能性检查**（承接 P0 门控 #2）：仍是 is-active + NRestarts；上线后"能应答"目前靠人工 e2e，未自动化。
4. **后端 TS 迁移范围**：P1 引入 portal TS 构建，现有 lib 渐进迁移；需避免 .mjs/.ts 混用导致的构建/路径问题。
