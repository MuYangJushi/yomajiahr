# 钉钉登录真实联调手册

> **适用范围**：ADR-005 决策六 ② — Admin Portal 平台登录（钉钉 IdP，新版 OAuth2 授权码流程）+ 跨家身份归一化。
> **代码位置**：`admin-server/src/auth/{dingtalk,session,users}.ts`、`admin-server/src/routes/auth.ts`。
> **状态**：钉钉登录与手动跨家归一化已于 2026-06-06 完成真机全链路验证；`exchangeCode` 使用的端点、参数与响应字段均已验证。自动连接键归一化仍需飞书/钉钉两侧开放手机号或邮箱权限。
> **配套**：飞书侧见 `docs/feishu-login-verify.md`；二者共用同一套 session/RBAC/归一化框架。

---

## 0. 前提速览

完整一次真实登录会经历：

```
浏览器 → /api/auth/dingtalk/login (302)
       → login.dingtalk.com 授权页（用户扫码/确认）
       → 回跳 /api/auth/dingtalk/callback?authCode=&state=   ⚠️ 参数名 authCode（非 code）
       → 服务端 POST api.dingtalk.com/v1.0/oauth2/userAccessToken 换 accessToken
       → 服务端 GET api.dingtalk.com/v1.0/contact/users/me 取 unionId/nick
       → resolveUser 角色映射（含跨家归一化）→ 颁发 session cookie → 跳 /console
```

要打通，需满足三类前提：**钉钉侧能力 + 环境变量 + 首个管理员在名单**。任一缺失会在对应环节失败。

---

## 1. 钉钉开放平台配置（阻塞前置）

登录 [open.dingtalk.com](https://open.dingtalk.com) → 进入你的企业内部应用（可复用 HR管理 Bot 应用，或单开一个登录应用）：

### 1.1 开通网页登录 + 配置回调域名（必做）

应用「登录」/「安全设置」里**加入回调地址**（钉钉称"登录回调域名"或"重定向 URL"）。该地址必须与服务端拼出来的 `redirect_uri` **逐字符一致**：

| 场景 | 回调地址 |
|---|---|
| 本机联调 | `http://localhost:18790/api/auth/dingtalk/callback` |
| 生产/远程 | `https://<你的域名>/api/auth/dingtalk/callback` |

> ⚠️ 钉钉对回调域名校验较严，部分配置项只接受**域名**（不含协议/路径）或要求 https。若本机 localhost 被拒，用内网穿透（cpolar/frp）拿一个 https 域名联调。

### 1.2 获取应用凭证（必做）

应用「凭证与基础信息」记下：
- **Client ID**（即 AppKey，形如 `dingxxxxxxxx`）
- **Client Secret**（即 AppSecret）

### 1.3 申请接口权限（⚠️ `Contact.User.Read` 必做）

钉钉的接口权限不是 OAuth scope，而是**应用权限**，在「权限管理」申请。

**必做**：`Contact.User.Read`（控制台显示「**个人信息读权限**」）——`contact/users/me` 接口本身就需要它，否则换到 token 后取用户信息会报：
```
code=Forbidden.AccessDenied.AccessTokenPermissionDenied 没有调用该接口的权限
```
这是**基础权限，企业内部应用可自助开通、即时生效**（无需审核）。开通后重新登录即可，不用改代码/重启。

**可选（②自动归一化才需要）**：手机号/邮箱同样是应用权限，在「权限管理」申请并发布：
- 「个人手机号信息」（`contact/users/me` 才返回 `mobile`）
- 「邮箱等个人信息」（才返回 `email`）

不申请则只能拿到 `unionId`/`nick`，跨家自动归一化（手机号/邮箱连接键）**无法触发**——见 §6。首次联调可跳过本步。

---

## 2. 环境变量配置（`config/.env`）

```bash
# —— 平台 session（飞书联调时已配，复用即可）——
SESSION_SECRET=<已有则不动>

# —— 钉钉登录凭证 ——
DINGTALK_LOGIN_CLIENT_ID=dingxxxxxxxx
DINGTALK_LOGIN_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# —— 回调基址：host 必须与钉钉后台配的回调、实际访问地址一致（飞书联调已配，复用）——
ADMIN_PORTAL_PUBLIC_URL=http://localhost:18790

# —— 可选，默认即官方域名，一般不用填 ——
# DINGTALK_LOGIN_BASE=https://login.dingtalk.com
# DINGTALK_API_BASE=https://api.dingtalk.com
# DINGTALK_LOGIN_SCOPE=openid
```

> 缺省行为：`DINGTALK_LOGIN_CLIENT_ID/SECRET` 未填时会回落 `DINGTALK_ADMIN_BOT_CLIENT_ID/SECRET`（若已为钉钉管理 Bot 配过）。

**自检**：`GET /api/auth/providers` 应返回 `"dingtalk": true`（需 `SESSION_SECRET` + 钉钉凭据齐全），登录页钉钉按钮变蓝可点。

---

## 3. 首个管理员引导（与飞书一致，复用 users.json）

`resolveUser` 角色映射优先级（飞书/钉钉共用）：

```
① users.json 命中（先同 IdP unionId，再手机号/邮箱连接键）→ 用其角色
② BOOTSTRAP_ADMINS（env）命中 unionId 或手机号 → admin
③ 都不命中 → 拒绝（跳 login?error=unauthorized）
```

钉钉用户的 unionId 与飞书是**两个不同命名空间**。两条路：

### 路 A — 已有飞书 users.json 记录的人，补钉钉 unionId（推荐，验证归一化）

若你（杨沐）飞书联调时已写入 `~/.openclaw/config-store/users.json`，**给同一条记录补上 `dingtalkUnionId`**，即可验证"同一人两边登录认成同一账号"：

```json
[
  {
    "platformUserId": "feishu:on_xxx",
    "name": "杨沐",
    "platformRole": "admin",
    "feishuUnionId": "on_xxx",
    "dingtalkUnionId": "<两遍法拿到的钉钉 unionId>",
    "source": "allowlist"
  }
]
```

### 路 B — 两遍法（首次拿钉钉 unionId）

1. 先**不配** `dingtalkUnionId`，钉钉登录一遍 → 被拒，跳 `/console/login?error=unauthorized`。
2. 看服务端日志：
   ```
   [WARN] 钉钉登录被拒（不在授权名单）：杨沐 union_id=<钉钉 unionId>
   ```
3. 把这个 unionId 填进上面 users.json 记录的 `dingtalkUnionId`，或新建一条记录 / 加进 `PLATFORM_BOOTSTRAP_ADMINS`。
4. `users.json` 运行时读盘，**不用重启**；改 `.env` 才需重启。再登录一次 → 进入。

---

## 4. 执行联调

```bash
cd yomajiahr/admin-server

# 构建前后端（如已构建可跳过）
npx tsup
(cd ../admin-web && npm run build)

# 启动：必须用 --env-file 加载 config/.env（代码直接读 process.env，无 dotenv）
node --env-file=../config/.env dist/server.js 2>&1 | tee /tmp/portal.log
```

浏览器打开 `http://localhost:18790/console`：

1. 未登录 → 登录页，「使用钉钉登录」按钮变蓝可点。
2. 点击 → 整页跳转 `login.dingtalk.com` 授权页。
3. 扫码/确认授权 → 自动回跳。
4. 命中名单 → 进入 ProLayout，左下角显示姓名 + 角色（`idp: dingtalk`）。
5. 不在名单 → 跳回登录页提示「账号不在授权名单」（走 §3 拿 unionId）。

**成功判据**：日志出现 `[INFO] 钉钉登录成功：杨沐（admin）`，浏览器停在 `/console`。

---

## 5. 真机联调复核表（✅ 已于 2026-06-06 全部验证为真）

下表 7 项端点/参数/字段在杨沐真机登录中**全部跑通**，代码无需改动。保留此表供换环境/钉钉改版时回归核对：

| 项 | 代码当前假设 | 复核点 |
|---|---|---|
| 回调参数名 | `authCode`（兼容 `code`） | 地址栏/日志看实际回跳带的是 `authCode` 还是 `code` |
| 换 token 端点 | `POST {API_BASE}/v1.0/oauth2/userAccessToken` | 路径、方法 |
| 换 token body | `{clientId, clientSecret, code, grantType:"authorization_code"}` | 字段名是否驼峰、`grantType` 取值 |
| token 响应 | 顶层 `accessToken` | 是否在顶层（非 `data.accessToken`） |
| user_info 端点 | `GET {API_BASE}/v1.0/contact/users/me` | 路径、方法 |
| user_info 鉴权头 | `x-acs-dingtalk-access-token: <accessToken>` | 头名是否完全一致（非 Bearer） |
| user_info 字段 | `unionId` / `nick` / `mobile` / `email` | 字段名拼写 |

复核方法：`node --env-file=...` 前台跑，登录走一遍，看 `/tmp/portal.log` 里 `[ERROR] 钉钉回调失败：...` 的具体 message（代码已把钉钉返回的 `code`/`message` 透传到异常）。

---

## 6. ⚠️ 跨家自动归一化：当前触发不了（重要）

#28 的"同一人两边登录认成同一账号"有**两种实现**：

- **手动合并（今天可用）**：管理员在 users.json 一条记录里同时填 `feishuUnionId` + `dingtalkUnionId`（§3 路 A）。验证已通过。
- **自动归一（连接键，当前不可用）**：靠手机号/邮箱把两个命名空间自动连起来——**需要飞书和钉钉两侧都返回手机号/邮箱**。现状：飞书以 union_id-only 联调（未申 `contact:user.phone:readonly`）、钉钉手机号需「个人手机号信息」权限。**两侧都没开，连接键归一不会触发。**

要启用自动归一：飞书申手机号 scope（见 feishu 手册 §1.3）+ 钉钉申「个人手机号信息」权限（本手册 §1.3），两侧 `IdpIdentity.phone` 都有值后，`matchByConnKey` 才生效。已记入 Backlog。

---

## 7. 常见坑速查

| 现象 | 原因 | 解 |
|---|---|---|
| 钉钉按钮置灰/未配置 | `DINGTALK_LOGIN_CLIENT_ID/SECRET` 或 `SESSION_SECRET` 缺失 | 补齐 §2 |
| 授权后 `redirect_uri 不匹配` | 钉钉后台回调、`ADMIN_PORTAL_PUBLIC_URL`、访问 host 不一致 | 三者逐字符相同 |
| 钉钉拒绝回调域名 | localhost 不被接受 / 要 https | 内网穿透拿 https 域名 |
| `缺少授权 authCode` | 回调参数名实际不是 authCode | 看日志/地址栏确认参数名，改 dingtalk.ts |
| `钉钉 userAccessToken 失败` | Client Secret 错 / authCode 过期复用 / 端点不符 | 核对 Secret；authCode 一次性；按 §5 复核端点 |
| `钉钉 contact/users/me 失败` | accessToken 头名不符 / 端点不符 | 按 §5 复核鉴权头与端点 |
| `state 校验失败` | state cookie 过期（>10min）/反代未透传 Cookie | 重新登录；查反代 Cookie 透传 |
| 一直 `unauthorized` | 钉钉 unionId 不在名单 | 走 §3 拿 unionId 注入；users.json 改完无需重启 |
| 同一人两边被认成两个账号 | 只填了一个 unionId | §3 路 A 在一条记录补齐两个 unionId |

---

## 8. 最快路径（推荐）

1. 复用飞书联调已配的 `SESSION_SECRET` + `ADMIN_PORTAL_PUBLIC_URL`。
2. 钉钉后台配回调 `http://localhost:18790/api/auth/dingtalk/callback`（localhost 不行就内网穿透）。
3. 填 `DINGTALK_LOGIN_CLIENT_ID/SECRET`，重启服务。
4. 两遍法拿钉钉 unionId → 补进飞书那条 users.json 记录的 `dingtalkUnionId` → 再登录。
5. **登录成功后,务必按 §5 核对一遍端点/字段**——这是本手册唯一不能省的一步。

---

## 附：相关代码索引

| 环节 | 文件 |
|---|---|
| 授权 URL / 换 token / 取 user_info | `admin-server/src/auth/dingtalk.ts` |
| 登录入口 / 回调 / providers | `admin-server/src/routes/auth.ts` |
| 签名 cookie session + state 防 CSRF | `admin-server/src/auth/session.ts` |
| 角色映射 / 跨家归一化 / 名单 | `admin-server/src/auth/users.ts` |
| 环境变量定义 | `admin-server/src/config.ts` |
| 登录页（双 IdP 按钮） | `admin-web/src/Login.tsx` |
