# 认证/RBAC 子系统执行级方案（ADR-005 决策六）

> 上游蓝图：`yomajiahr-kb/10-decisions/ADR-005` **决策六**（平台认证与 RBAC → 飞书/钉钉双 IdP）。本文件是该子系统的执行级方案，对齐 `docs/p0-config-platform-plan.md` / `docs/p1-agent-config-plan.md` 体例。
> 分支：建议新开 `feat/auth-rbac`（基于已落地的 `feat/p0-config-platform`）。
> 目标：平台从**单共享 token** 升级为「**飞书 + 钉钉双 IdP 登录 + 平台自有 RBAC**」——IdP 解决"你是谁"（认证），平台角色解决"你能做什么"（授权）；保留一条**机器/服务 token 路径**供自动化调用；高危操作（铸 agent、apply 重启网关）按角色守卫，审计落操作人。
> 对应 Sprint 5 任务：#23（本文）/ #24（修正 ADR）/ #25（飞书登录后端 ①）/ #26（RBAC + 双路径中间件 ①）/ #27（登录前端）/ #28（钉钉 + 身份归一化 ②）/ #29（审计落人 + 角色自动判定 ③）。

---

## 一、现状（已核实）

> ⚠️ ADR-005 决策六"现状"段曾称已实现"双 token 角色分级（`OPENCLAW_WEB_ADMIN_TOKEN` + `requireAdmin`）"。**代码核实为不存在**，本节为真实状态（修正动作见 #24）。

| 事项 | 现状（代码核实） | 位置 |
|---|---|---|
| 认证机制 | **单共享 token** `OPENCLAW_WEB_AUTH_TOKEN`；未配置时**仅放行 localhost** | `src/middleware.ts` `authMiddleware` |
| token 取值 | `Authorization: Bearer <token>` 或 `?token=` query | `src/middleware.ts:24` |
| 角色/RBAC | **无**。所有 `/api`（除 `/api/health`）一视同仁，无分级 | `src/app.ts:32` 全量挂 `authMiddleware` |
| 人身份 | **无**。认不出"谁"，审计记不到操作人 | — |
| 唯一消费方 | **仅浏览器前端**：`web/src/api.ts` 把 token 存 `localStorage`，401 时 `window.prompt` 兜底 | `web/src/api.ts` |
| 机器调用方 | **当前无**。`apply` 由进程内 `triggerApply` 触发（`configRouter` / `orchestrator`）；`apply-config.sh` 探的是**网关** `:18789/health`，不打 portal `/api` | `routes/config.ts`、`config/scripts/apply-config.sh` |
| 命名占用 ⚠️ | `orchestrator.ts` 已用 `role: "employee" \| "admin"` 表示**被创建的数字员工 agent** 的角色（→ tools 隔离 / workspace `ROLE` / `AgentEntry.role`），**与平台登录人角色是两个概念** | `src/services/orchestrator.ts`、`src/services/store.ts` |

**结论**：迁移面比预想小——portal API 当前唯一真实消费方是浏览器。引入 IdP 登录主要改造前端 + 中间件，不存在"会被打断的机器调用链"。机器 token 路径属**前瞻保留 + 应急/本地运维**，非现有依赖。

---

## 二、范围（做 / 不做）

**做（本子系统 = ADR-005 决策六 ①②③）**：

- **①** 飞书 IdP 登录（网页应用免登）→ 平台 session → `platformRole` 守卫高危操作（先单 IdP 跑通）
- **②** 钉钉 IdP 登录（OAuth2）+ 飞书/钉钉**跨命名空间身份归一化**
- **③** 审计落操作人 + `platformRole` 按组织架构（部门/用户组）自动判定
- 双路径鉴权中间件（人 session / 机器 token 共存）；localhost 兜底收口

**不做（属本 Sprint 其它工作流或后续）**：

- 交互分析 hooks / 技能配置 / 分析 dashboard（Sprint 5 工作流 B/C/D，另文）
- 多租户 / SaaS（ADR-005 既定非目标，单组织自用）
- 细粒度到"按 agent / 按知识库类目"的数据级授权（受限类目仍由 bindings + 路径隔离强制，见 ADR-005 支柱一；本子系统只到**平台操作级** RBAC）

---

## 三、关键决策

| # | 决策 | 说明 |
|---|---|---|
| 1 | **`platformRole` 命名与既有 `role` 严格隔离** ⚠️ | 平台登录人角色一律命名 `platformRole`（值 `admin`/`ops`/`audit`）；`req.user.platformRole`。**绝不复用** `orchestrator`/`store` 的 `role`（那是数字员工 agent 的 employee/admin）。文档与代码注释都点明二者区别 |
| 2 | **认证与授权分离** | IdP（飞书/钉钉）只回答"你是谁"（企业身份）；"你能做什么"由平台自有 `platformRole` 映射决定，不依赖 IdP |
| 3 | **平台 session 用签名 cookie** | 回调成功后颁发 **HttpOnly + SameSite=Lax + Secure（生产）签名 cookie**；服务端 session（签名 JWT 或服务端 store）。优于把 token 放 localStorage（防 XSS 窃取）。`SESSION_SECRET` 进 `.env` |
| 4 | **双路径鉴权中间件** | `authMiddleware` 改造：①带平台 session cookie → 取 `platformRole`（人）；②`Authorization: Bearer <SERVICE_TOKEN>` → 服务身份（机器）；③都没有 → 401/跳登录。`OPENCLAW_WEB_AUTH_TOKEN` 语义从"唯一口令"收窄为"机器/应急通道" |
| 4b | **service token 默认不存在、按需签发受限档** ⚠️ | 实测当前**零机器调用方**。本子系统正是要堵"token 泄漏=全盘失守、无归属"。因此**默认不配 service token**（不配则该路径关闭）；真出现机器调用方时才签发，且默认**受限能力档**（非 admin），并以 `actor.type=service` 与人身份审计区分。**不设默认 admin 的常驻 token**——那等于把要堵的洞原样保留 |
| 5 | **localhost 兜底收口** | 现状"未配置 token 则 localhost 放行"= 隐式最高权限，危险。收口为：localhost 兜底**仅在显式开关** `ADMIN_PORTAL_DEV_LOCALHOST_ADMIN=1` 时给 `admin`（开发用）；生产默认关闭，无 session/无 service token 一律 401 |
| 6 | **身份归一化用连接键** | 飞书 `union_id` 与钉钉 `unionid` 是不同命名空间。用**手机号/邮箱**作连接键归一到平台账号 `platformUserId`；维护 `users.json` 账号表。退路：约定"一人固定一家登录"则免归一化（②落地时按企业实际定） |
| 7 | **角色来源分层** | `platformRole` 来源优先级：① 显式**允许名单**（`users.json` 手工指定）→ ② 组织架构**组自动映射**（如"HR 管理组→admin"，③ 阶段接入）→ ③ 默认最小权（`audit` 或拒绝，落地定） |

---

## 四、认证流程

### 4.1 飞书登录（①，先跑通）

严格对齐官方「网页应用 SSO」文档（<https://open.feishu.cn/document/sso/web-application-sso/login-overview>）。
**注意授权域名 `accounts.feishu.cn` 与 API 域名 `open.feishu.cn` 不同；token 用 v2 端点、参数是 `client_id`/`client_secret`、无需先取 app_access_token。**

```
浏览器 → GET /api/auth/feishu/login
          后端生成 state（签名短期 cookie），302 跳授权页：
          GET https://accounts.feishu.cn/open-apis/authen/v1/authorize
              ?client_id=&redirect_uri=&response_type=code&state=[&scope=]
飞书   → 用户同意 → 302 回 /api/auth/feishu/callback?code=&state=
          （拒绝时回 ?error=access_denied&state=）
后端   → 校验 state（防 CSRF）
        → POST https://open.feishu.cn/open-apis/authen/v2/oauth/token
            body {grant_type:"authorization_code", client_id, client_secret, code, redirect_uri}
            （仅 Content-Type 头，无 Authorization）→ 顶层 access_token
        → GET https://open.feishu.cn/open-apis/authen/v1/user_info（Bearer access_token）
            → {code,msg,data:{union_id, open_id, name, mobile, email, ...}}
        → resolveUser 映射 platformRole（§三决策7）→ 颁 session cookie → 302 /console
```

- `redirect_uri` 在授权与换 token 两步必须**完全一致**
- **scope**：`union_id`/`open_id`/`name` 默认返回；`mobile`/`email` 需申请 `contact:user.phone:readonly` / `contact:user.email:readonly`（② 用连接键归一化时必需，① 可不申请）
- app id/secret 走 `.env`（`FEISHU_LOGIN_APP_ID/SECRET`，缺省复用管理 Bot 应用），不硬编码、不回前端
- 需在飞书开放平台「安全设置」配置回调 URL；可复用现有自建应用或单开"平台登录"应用——记入 §待澄清

### 4.2 钉钉登录（②）

钉钉 OAuth2 扫码/免登，流程同构（`/api/auth/dingtalk/login` → `/callback`），取 `unionid`/`userid`/name/手机号/部门。复用 §4.1 的 state/session/角色映射框架，只换 IdP 适配器。

### 4.3 身份归一化（②，关键难点）

```
飞书 union_id ─┐
               ├─→ 连接键（手机号/邮箱）─→ platformUserId（平台账号）─→ platformRole
钉钉 unionid ─┘
```

- `users.json`：`{ platformUserId, name, feishuUnionId?, dingtalkUnionId?, phone?, email?, platformRole, source }`
- 同一人两边登录 → 经连接键命中同一 `platformUserId` → 同一角色
- 冲突/找不到连接键的兜底策略在 §待澄清 记录后定

---

## 五、RBAC 模型

### 5.1 角色定义（沿用 ADR-005 决策六语义）

| `platformRole` | 能力 | 典型操作 |
|---|---|---|
| `admin` | 全部，含**配置变更 / 上线** | `POST /config/agents`、`POST /config/apply`、所有 ops/audit 能力 |
| `ops` | 知识库读写 + 配置只读 | 上传/删文档、改类目、读 agent/技能/渠道列表、读审计 |
| `audit` | **只读** | 读审计日志、只读列表视图 |

能力关系：`admin ⊇ ops ⊇ audit`（admin 含 ops，ops 含 audit 的只读）。

### 5.2 路由 → 最低角色映射

| 路由 | 方法 | 最低角色 |
|---|---|---|
| `/config/apply`、`/config/agents` | POST | **admin** |
| `/config/agents`、`/config/skills`、`/config/channels`、`/config/apply/result` | GET | ops |
| `/upload` | POST | ops |
| `/documents/:category/:file` | DELETE | ops |
| `/categories` | POST | ops |
| `/documents`、`/documents/:category/:file`、`/categories` | GET | ops（读 KB） |
| `/audit-log`、`/audit-log/export` | GET | audit |
| `/api/health` | GET | 公开（鉴权前，现状保留） |
| `/api/auth/*` | — | 公开（登录入口/回调） |

> 注：`/config/secrets`（P1 计划中的批量写 .env，若已/将落地）= **admin**。

### 5.3 守卫实现

- `requireRole(min: PlatformRole)`：中间件，比较 `req.user.platformRole` 是否 ≥ `min`（按 admin>ops>audit 序），否则 403
- 在各 router 上按 §5.2 挂 `requireRole(...)`；写操作路由额外保留现有 `rateLimit`
- service token 路径：**默认不配置即关闭**；如需机器调用，签发**受限能力档**（按需最小授权，非 admin），`actor.type=service`，落地时在 §待澄清 确认具体能力

---

## 六、会话与秘钥

- **session**：签名 cookie（HttpOnly/SameSite=Lax/Secure-prod）。载荷含 `platformUserId / name / platformRole / idp / exp`。`SESSION_SECRET`（强随机）进 `.env`
- **CSRF**：登录回调校验 `state`；写操作若改用 cookie 鉴权，需补 CSRF 防护（SameSite=Lax 已挡大部分跨站 POST；表单可加 CSRF token，落地定）
- **秘钥清单**（均进 `.env`，复用 `secrets` 键级 upsert，chmod 600，不回前端）：
  - `FEISHU_*_APP_ID/SECRET`（可复用现有 Bot 应用或单开）
  - `DINGTALK_*_CLIENT_ID/SECRET`
  - `SESSION_SECRET`
  - `OPENCLAW_WEB_AUTH_TOKEN`（语义改为 service token）
  - 回调 URL（`*_OAUTH_REDIRECT_URI`，或由 `ADMIN_PORTAL_PUBLIC_URL` 推导）

---

## 七、审计落操作人（③）

- 现有审计写 `~/.openclaw/data/hr-admin/audit-log.jsonl`。每条审计 + 每次 agent 创建 / apply，追加 `actor: { platformUserId, name, platformRole, idp }`（service token 调用记 `actor: { type: "service" }`）
- `req.user` 由双路径中间件统一填充，审计写点从 `req.user` 取，避免散落
- 角色按组织架构自动判定（③）：登录时读飞书/钉钉**部门/用户组**，按规则（如"HR 管理组→admin"）映射 `platformRole`，写回 `users.json`；允许名单可覆盖自动判定

---

## 八、迁移与兼容

1. **前端改造**（#27）：删除 `web/src/api.ts` 的 localStorage token + `window.prompt`；改为依赖 cookie 会话；401 → 跳 `/console/login`；登录页双按钮「飞书登录 / 钉钉登录」（②前钉钉按钮可灰显）；顶栏展示当前用户 + 角色
2. **中间件改造**（#26）：`authMiddleware` → 双路径；新增 `requireRole`；按 §5.2 挂载
3. **service token 不破**：`OPENCLAW_WEB_AUTH_TOKEN` 继续被 Bearer 路径接受（当前无机器调用方，属前瞻保留）
4. **localhost 兜底收口**（§三决策5）：默认关闭隐式 admin，开发用显式开关
5. **灰度**：先上 ① 飞书（单 IdP）跑通登录→角色→守卫；再上 ② 钉钉 + 归一化；最后 ③ 审计落人 + 自动判定。每步可独立交付（对齐 Sprint 5"建议降级路径"批 1→2）

---

## 九、数据结构

```
$STATE_DIR/config-store/users.json        # 平台账号表（归一化 + 角色）
[
  {
    "platformUserId": "u-0001",
    "name": "张三",
    "platformRole": "admin",
    "feishuUnionId": "on_xxx",
    "dingtalkUnionId": "ding_xxx",
    "phone": "138...", "email": "...",
    "source": "allowlist | org-auto"
  }
]
```

- 放 `config-store/`（平台拥有、带版本历史，与 agents/channels/bindings 同处），但**不进生成的 `openclaw.json`**（纯平台侧数据）
  - ✅ 已核实安全：`generate-config.ts` / `validate-config.ts` 只显式读 `channels.json`/`agents.json`/`bindings.json` 三个具名文件，**不 glob** `config-store/*.json`，新增 `users.json` 不会被生成器/校验器绊到
- 秘钥仍在 `.env`，`users.json` 不存任何 secret

---

## 十、分步落地（对齐 #25~#29）

| 步 | 任务 | 交付 |
|---|---|---|
| 1 | #24 | 修正 ADR-005 决策六"现状"段 + p1-plan §二.5 措辞 |
| 2 | #25 | 飞书 `/api/auth/feishu/{login,callback}` + state + 取身份 + 颁 session |
| 3 | #26 | `platformRole` + `requireRole` + 双路径 `authMiddleware` + localhost 收口 + 按 §5.2 挂载 |
| 4 | #27 | 登录页 + 会话态 + `api.ts` 改造 |
| 5 | #28 | 钉钉 `/api/auth/dingtalk/*` + `users.json` 归一化 |
| 6 | #29 | 审计 `actor` + 组织架构角色自动判定 |

---

## 十一、验证流程

- **单元**：`requireRole` 角色序判定；state 校验；连接键归一化命中/未命中
- **集成（① 出口）**：飞书登录跑通 → cookie 会话 → `audit` 角色访问 `POST /config/apply` 得 **403**、`admin` 得 **200/202**；service token Bearer 仍可访问
- **集成（② 出口）**：同一人飞书 + 钉钉两边登录归一到同一 `platformUserId` + 同一角色
- **集成（③ 出口）**：审计日志含正确 `actor`；HR 管理组成员登录自动得 `admin`
- **回归**：未登录访问受保护 `/api/*` → 401/跳登录；`/api/health` 仍公开

---

## 十二、安全考量

- session cookie：HttpOnly + Secure（生产）+ SameSite=Lax；`SESSION_SECRET` 强随机、可轮转
- OAuth：强制校验 `state`；回调 URL 白名单；secret 仅服务端、不回前端
- service token：长随机；建议可与人身份审计区分（`actor.type=service`）；评估是否限来源 IP
- 最小权限：默认拒绝/最小角色；localhost 隐式 admin 默认关闭
- 审计完整性：所有写操作 + 配置变更必须带 `actor`，无 actor 不放行写
- **授权 fail-closed**：`requireRole` 对未知/非法 `platformRole` 一律拒绝（不能让 `ROLE_RANK[未知]=undefined` 漏过比较）；service token 能力档、users.json 角色均按显式白名单 `PLATFORM_ROLES` 校验（不用 `in` 以防原型链键）。已被冒烟用例覆盖（未知角色→403、签名翻转/错密钥/过期→401）
- **已知权衡（无状态 session）**：`platformRole` 在登录时烘焙进签名 cookie，users.json 里的角色降级最长需 `SESSION_MAX_AGE_SEC`（默认 12h）才生效。本期不做主动吊销；如需即时收回，后续可加服务端 session 版本号/黑名单（②③ 或独立项再评估）

---

## 待澄清（落地前确认）

1. **复用现有飞书自建应用 vs 单开"平台登录"应用**（影响回调 URL/能力开通范围）
2. **企业是否需要"一人两端登录"** —— 若否，②身份归一化可大幅简化为"一人固定一家"
3. **service token 能力档** —— 确认默认不配置（关闭）；真接机器调用方时签发的最小能力范围（绝不默认 admin 常驻）
4. **组织架构 → 角色映射规则** —— 哪些飞书/钉钉部门/用户组对应 `admin`/`ops`/`audit`（③需要）
5. **cookie 鉴权下写操作的 CSRF 防护强度** —— SameSite=Lax 是否足够，是否加 CSRF token
6. **生产回调所需的公网/反代与 HTTPS** —— OAuth 回调要求可达的回调 URL + Secure cookie 需 HTTPS
