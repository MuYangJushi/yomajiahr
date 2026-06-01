# P0 执行级方案：配置平台地基

> 上游蓝图：`yomajiahr-kb/10-decisions/ADR-005`（HR 数字员工管理平台）。本文件是 ADR-005 路线图中 **P0 地基** 阶段的执行级方案。
> 分支：`feat/p0-config-platform`
> P0 目标：让 openclaw 配置由**结构化存储**驱动，`install.sh` 与未来的 web 平台**共用同一份配置真相**，并具备**校验 + 回滚 + 受控重启**能力。P0 不含 UI（UI 属 P1）。

---

## 一、现状（已核实）

| 事项 | 现状 |
|---|---|
| 配置源 | 单文件 `config/openclaw.jsonc`，手工维护，含注释 + `${VAR}` 占位符 |
| 编译 | `install.sh` 第 6 步：去 BOM/注释 → `vm.runInNewContext('('+text+')')` 解析（JS 对象字面量，容忍尾逗号）→ 注入 `gateway={mode:'local'}` → 写 `~/.openclaw/openclaw.json`（2 空格 + 尾换行）→ chmod 600 |
| 秘钥 | `${VAR}` **不替换**，原样留在 openclaw.json；openclaw 运行时从 `.env` 解析（systemd `EnvironmentFile`） |
| 进程 | gateway 与 admin-portal **同以 `ubuntu` 用户**运行（systemd 系统单元）；gateway = `openclaw gateway run --bind loopback --port 18789 --force`，`Restart=always` |
| 重启 | 无热重载；改配置须 `systemctl restart openclaw-gateway`（系统单元，需 root） |

---

## 二、P0 范围

**做**：TS 工具链（决策五对齐，新模块 TS-first）、基石 A（配置源切分 + 生成器）、基石 C（校验 + 回滚）、基石 B（特权重启通道）+ 一个**最小 apply 端点**打通端到端闭环。

**不做（留给 P1+）**：可视化 UI、向导、agent CRUD 表单、分析、技能管理。P0 只交付"配置可被结构化驱动 + 安全地应用"的承重墙。

---

## 三、基石 A：配置源切分 + 生成器

### 3.1 切分边界（static base vs dynamic store）

| 归属 | 内容 | 理由 |
|---|---|---|
| **静态基座**（工程师维护，`openclaw.base.jsonc`） | `web`、`plugins`、`agents.defaults`（含 `model` 默认、`heartbeat`、`memorySearch` 含 **`chunking{tokens:4000,overlap:0}` 锁定**）、`session`、`models.providers`、**渠道脚手架**（`channels.feishu.{enabled,domain,connectionMode,streaming}`、`channels.dingtalk-connector.{enabled,tools,groupReplyMode}`，即 channel 节点除 `accounts` 外的部分） | 不常变；含 ADR-004 锁定参数与渠道级开关，不开放给平台乱改 |
| **动态存储**（平台拥有，`config-store/*.json`） | `channels.*.accounts`、`agents.list[]`（每个 agent 的 `id/name/workspace/skills/tools.allow-deny/model 覆盖/role`）、`bindings[]` | HR/管理员通过 web 增改的部分 |

边界裁决：
- `agents.list[].tools.allow/deny` 属**动态**（按 agent 配权限，UI 编辑）；`agents.defaults` 属**静态**；`memorySearch` 的 per-agent 覆盖 P0 暂不开放（chunking 锁定）。
- **渠道节点是"脚手架 + accounts"两层**：`channels.<domain>` 的开关/streaming/tools 等留在基座，**只有 `accounts` 子键来自 store**。合并必须是**逐层合并**：`channels.<domain> = {...base.channels.<domain>, accounts: store.accounts}`，**不能在 channel 层整体替换**（否则会丢掉 `streaming`/`tools`/`groupReplyMode`）。"整体替换"只适用于 channel 内部的 `accounts`、以及 `agents.list`、`bindings` 这三处数组/字典本身。

### 3.2 目录与文件

```
config/
├── openclaw.base.jsonc          # 新：静态基座（从 openclaw.jsonc 切出）
├── config-store/                # 新：动态结构化存储（平台拥有）
│   ├── agents.json              #   agents.list[] 的数据（含每个 agent 的 role）
│   ├── channels.json            #   channels.*.accounts（秘钥用 ${VAR} 引用）
│   ├── bindings.json            #   bindings[]
│   └── versions/                #   每次 apply 前的快照（回滚/审计），运行时生成
├── package.json                 # 新：config 工具包（deps: zod, typescript, tsup）
├── tsconfig.json                # 新：TS 配置
├── src/                         # 新：TypeScript 源
│   ├── generate-config.ts       #   生成器（base + store → 运行时 JSON）
│   ├── validate-config.ts       #   Zod 校验 + schema/类型（基石 C）
│   ├── types.ts                 #   config-store 与运行时配置的类型/Zod schema
│   └── migrate-jsonc.ts         #   一次性迁移（openclaw.jsonc → base + store）
└── dist/                        # 新：构建产物（install.sh 调用；JS）
```

store 用**纯 JSON**（机器读写，无需注释）；base 保留 **JSONC**（人工维护，注释有价值）。

> **TS-first（决策五对齐）**：generate-config / validate-config 正是决策五点名"无类型即 bug 温床"的配置生成与校验代码，故 P0 直接用 **TypeScript** 写，并在 P0 内建好 TS 工具链（`tsconfig` + 构建）。**Zod schema 与 TS 类型在 `types.ts` 内同源**（schema 反推类型），同一套既校验 store/运行时配置、又给 portal 与未来日志插件复用。构建用 **tsup**（esbuild，打成单文件 JS 进 `dist/`，简化 install.sh 调用）或 `tsc`。这套工具链也是决策五 lib/ 迁移的第 1 步落点。

### 3.3 生成器 `src/generate-config.ts`（构建后 `dist/generate-config.js`）

被 **install.sh 和 portal 共用**的单一模块：

1. 读 `openclaw.base.jsonc`，复用现有 sanitize 逻辑（去 BOM/注释 + `vm.runInNewContext`）得到 base 对象
2. 读 `config-store/{agents,channels,bindings}.json`
3. 合并（见 3.1 的逐层规则）：`channels.<domain> = {...base.channels.<domain>, accounts: channels.json[domain]}`（保留脚手架）；`base.agents.list = agents.json`；`base.bindings = bindings.json`（后两者整体替换）
4. 注入 `gateway={mode:'local'}`（同现状）
5. 调 `validate-config.mjs`，**校验不过则抛错、不产出**
6. 返回运行时配置对象（由调用方写盘）

接口：`generateConfig({baseDir, storeDir}) -> {config, errors}`（TS，带类型）；CLI 包装调用**构建产物** `node config/dist/generate-config.js --out <path>`。**保持输出字节风格与现状一致**（2 空格 + 尾换行），便于与旧 `openclaw.json` 做语义/文本 diff 验证。

### 3.4 install.sh 第 6 步重构

先**构建 config 工具包**（TS→JS），再调用构建产物（内联 `node -e "..."` 移除）：

```bash
# 新增：构建 config 工具包（在 step 6 之前；幂等）
( cd "$REPO_DIR/config" && npm install --omit=dev=false && npm run build )

# 生成 + 校验（失败则非零退出，不写坏配置）
node "$REPO_DIR/config/dist/generate-config.js" --out "$STATE_DIR/openclaw.json" \
  --base "$REPO_DIR/config/openclaw.base.jsonc" \
  --store "$REPO_DIR/config/config-store"
chmod 600 "$STATE_DIR/openclaw.json"
```

注意 deploy 路径多了一个构建步骤：config 工具包需在生成前 `npm install + build`。为离线/受限环境可选**预构建 `dist/` 提交入仓**（兜底），优先在 install.sh 内构建以保持源与产物一致。校验失败时脚本非零退出。

### 3.5 迁移 `migrate-jsonc.mjs`

一次性：解析现有 `openclaw.jsonc` → 抽出 `channels.*.accounts / agents.list / bindings` 写入 `config-store/*.json`，其余写入 `openclaw.base.jsonc`。**验收：迁移后生成的 openclaw.json 与迁移前的产物语义等价（JSON 深度相等）。** 迁移确认后，`openclaw.jsonc` 归档/删除。

---

## 四、基石 C：校验 + 回滚

### 4.1 Zod 校验 `validate-config.mjs`

为以下对象建 Zod schema（决策五已定用 Zod）：

- `config-store/*.json` 各文件的结构
- **装配后的运行时配置的不变量**（结构 + ADR 红线）：

| 不变量 | 来源 |
|---|---|
| 每个 `binding` 的 `agentId` 必须存在于 agents.list；`accountId` 必须存在于对应 channel 的 accounts | 结构完整性 |
| 每个 agent 的 `workspace` 目录存在；`skills[]` 在 `skills/` 下存在 | 结构完整性 |
| **`role != admin` 的 agent 必须 `deny: memory_write/memory_delete/exec`**（见下方 role 字段） | ADR-003 硬隔离 |
| **没有 allowlist 的 agent 必须显式 `deny: sessions_spawn`；有 allowlist 的 agent，allowlist 不得包含 `sessions_spawn`** | ADR-001 排除 B |
| `agents.defaults.memorySearch.chunking = {tokens:4000, overlap:0}` 未被改动 | ADR-004 锁定 |
| store 中引用的每个 `${VAR}` 必须存在于 `.env`（或 `.env.example`） | 防未解析占位符导致 gateway 静默故障 |

不变量用 Zod `superRefine` 实现，输出**可读的中文错误**（供 P1 UI 直接展示）。

**agent `role` 字段（P0 即引入，UI 属 P1）**：当前"员工面 vs 管理面"是靠 id 隐式区分（hr-assistant vs hr-admin）。平台将来要铸造任意 HR 数字员工，校验器无法靠 id 猜出谁该只读。故在 `agents.json` 的 agent 定义上加显式 `role`（如 `employee` / `admin`），**默认最小权限**（缺省即 `employee` → 强制只读 deny）。只有显式 `role: admin` 才允许写工具。否则 ADR-003 红线无法落地。

**两条按真实架构修正/移除的校验**（advisor 核实）：
- *sessions_spawn*：现状 hr-assistant 用 **allowlist**（`memory_search, memory_get`，天然不含 spawn = 安全），并未显式 deny。校验必须按 openclaw 的 allow/deny 优先级建模（见上表"没有 allowlist 才要求显式 deny"），否则会对当前安全配置误报。
- *compensation 检索隔离*：现状是**回答层拦截**（hr-policy-qa skill 在回复层挡），且 `memorySearch.extraPaths` 指向整棵 `hr-chunks`，**检索层并未按类目隔离**。该约束在当前配置里不可表达 →**P0 不做此校验**，留作未来"per-agent 知识库路径隔离"特性再处理。

### 4.2 last-good 快照 + 回滚

apply 流程（由基石 B 的 helper 执行）：

```
1. 生成 + 校验 → 产出 staging 配置（如 openclaw.json.staging）
2. 快照：cp 现 openclaw.json → openclaw.json.last-good；cp config-store → versions/<ISO 时间戳>/
3. 应用：mv staging → openclaw.json（原子 rename）
4. systemctl restart openclaw-gateway
5. 健康探活（见 4.3）
6. 探活失败 → 恢复 last-good → restart → 标记失败
7. 写 apply-result.json（成功/失败 + 错误详情）
```

### 4.3 健康探活（回滚安全的核心，须先定判别器）

⚠️ gateway 是 `Restart=always` / `RestartSec=10`。坏配置会 crash-loop，在 activating↔active 间抖动，**`systemctl is-active` 可能在循环间隙读到 "active"** → "重启后 N 秒保持 active" 这种弱探活会**放行坏配置、击穿自动回滚**。且语义错（如绑定到 openclaw 容忍的账号）的配置能起来但路由错，只有功能性检查能抓到。

P0 必须先选定一个可靠判别器（建议组合）：

1. **apply 窗口内临时 `Restart=no`**（或用 `systemd-run --no-block` 单次拉起观测），避免抖动掩盖崩溃；
2. **`systemctl show -p NRestarts` 增量**：重启后观测窗内 NRestarts 不增长才算稳；
3. **功能性就绪信号**：端口 18789 可连 +（若 openclaw 提供）健康/版本端点，且该信号**持续 > RestartSec(10s)**。

三者择一或叠加，**"healthy" 的定义不能留空**。openclaw 是否有就绪端点见风险 #2。

---

## 五、基石 B：特权重启通道

### 5.1 约束

gateway 与 portal **同为 `ubuntu` 用户**，gateway 是 root 拥有的系统单元 → portal 直接 `systemctl restart` 需提权。要把这条特权路径收到最窄。

### 5.2 方案（主）：请求文件 + 特权 helper（web 不持 sudo）

```
portal(ubuntu)                  helper(root, systemd)
   │                                  │
   │ 原子写 control/apply-request.json│
   ├─────────────────────────────────►│  openclaw-apply.path 监听文件变化
   │                                  │  → 触发 openclaw-apply.service(oneshot)
   │                                  │    执行 §4.2 apply 流程(生成/校验/快照/重启/探活/回滚)
   │ 轮询/监听 control/apply-result   │    → 写 control/apply-result.json
   │◄─────────────────────────────────┤
```

- portal **只写请求文件**（`~/.openclaw/control/apply-request.json`，tmp+rename 原子写，含 request id + store 校验和），从不调 systemctl
- 新增两个 systemd 单元：`config/openclaw-apply.path`（监听）+ `config/openclaw-apply.service`（`Type=oneshot`，有 restart gateway 权限）
- 特权面收敛为"helper 这一个 oneshot 脚本"

### 5.3 方案（备）：sudo 白名单

`/etc/sudoers.d/`：`ubuntu ALL=(root) NOPASSWD: /bin/systemctl restart openclaw-gateway`，portal 直接 `sudo systemctl restart openclaw-gateway`。更简单但 web 进程获得了一条 sudo 路径。**P0 默认采用主方案；备方案作为环境受限时的回退。**

### 5.4 开发回退

非 systemd 的本地开发：portal 直接生成 + 校验 + 重启本地 gateway 进程（文档标注，仅 dev）。

---

## 六、新增 / 修改文件清单

**新增**：
- `config/openclaw.base.jsonc`（切分自 openclaw.jsonc）
- `config/config-store/{agents,channels,bindings}.json`
- `config/package.json`、`config/tsconfig.json`（TS 工具链）
- `config/src/{generate-config,validate-config,types,migrate-jsonc}.ts`（TypeScript 源）
- `config/dist/`（构建产物，install.sh 调用；视策略可 .gitignore 或预构建提交）
- `config/openclaw-apply.service`、`config/openclaw-apply.path`
- `admin-portal/` 下：配置 service 模块 + **最小 apply 端点**（`POST /api/config/apply`：写 apply-request、轮询 apply-result）

**修改**：
- `install.sh`：step 6 之前新增 config 工具包 `npm install + build`；step 6 改调 `dist/generate-config.js` + 校验；新增 apply helper 单元的安装（`--systemd` 路径）
- `config/openclaw.jsonc` → 迁移后归档删除
- `docs/deployment.md` → 更新配置编译/重启说明

---

## 七、P0 内部落地顺序

0. **TS 工具链**：建 `config/package.json` + `tsconfig.json` + 构建（tsup/tsc），`types.ts` 放 Zod schema/类型同源骨架。（决策五第 1 步落点，后续都依赖它）
1. **生成器 + 校验 + 迁移**：切分 openclaw.jsonc → base+store；写 generate/validate（TS）；refactor install.sh（build + 调 dist）；**验收：生成产物与现 openclaw.json 语义等价**。（最大块）
2. **快照 + 回滚**逻辑（apply 流程脚本）。
3. **特权重启通道**：apply helper + `.path`/`.service` 单元 + 健康探活。
4. **最小 apply 端点**：portal 写 apply-request → helper 全流程 → 端到端验证（无 UI）。

---

## 八、验证

- **生成器 parity**：base+store 生成 → 与迁移前 `~/.openclaw/openclaw.json` 做 JSON 深度相等 diff。
- **校验拦截**：构造坏 store（binding 指向不存在 agent；员工面 agent 缺 memory_write deny；改动 chunking）→ 校验各自报错且中文可读。
- **回滚**：apply 一份能通过校验但会导致健康探活失败的配置 → 确认自动恢复 last-good 且 gateway 重新 active。
- **端到端**：经最小端点改一个 agent 字段 → apply-request → helper 生成/校验/快照/重启/探活/写 result → 成功；gateway 反映变更。

---

## 九、风险 / 未决（承接 ADR-005 研究门控）

1. **openclaw 是否提供配置 dry-run / schema**：P0 先用自建 Zod；若 openclaw 有 `config validate` 类命令，叠加为第二道。（门控 #3）
2. **健康探活端点**：需核实 openclaw 是否暴露健康/就绪端点；否则用 §4.3 降级方案。
3. **`${VAR}` 占位符**：已确认生成产物保持占位符字面量、由 openclaw 运行时解析；生成器不得做替换（秘钥不落 store/产物）。
4. **base/store 合并语义**：channel 层**逐层合并**（保留脚手架，仅替换 `accounts`）；`accounts` 内部 / `agents.list` / `bindings` 三处**整体替换**（避免 base 残留旧账号）。两种粒度不能混用——见 3.1/3.3，需在生成器测试覆盖。
5. **apply 串行化**：apply 经 oneshot service 执行，systemd 天然串行（同一 oneshot 不并发），避免并发 apply 互相覆盖；portal 侧对 apply-request 也应做单飞（in-flight 时拒绝新请求）。
