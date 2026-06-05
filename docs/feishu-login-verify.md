# 飞书登录真实联调手册

> **适用范围**：ADR-005 决策六 ① — Admin Portal 平台登录（飞书单 IdP，全页跳转 OAuth 授权码流程）。
> **代码位置**：`admin-portal/src/auth/{feishu,session,users}.ts`、`admin-portal/src/routes/auth.ts`。
> **结论**：登录代码已完整并通过本地冒烟（17/17）。真实联调的卡点全在**飞书开放平台配置**与**首个管理员引导**，本手册逐步打通。

---

## 0. 前提速览

完整一次真实登录会经历：

```
浏览器 → /api/auth/feishu/login (302)
       → accounts.feishu.cn 授权页（用户扫码/确认）
       → 回跳 /api/auth/feishu/callback?code=&state=
       → 服务端 POST open.feishu.cn 换 user_access_token
       → 服务端 GET open.feishu.cn 取 user_info（union_id/姓名）
       → resolveUser 角色映射 → 颁发 session cookie → 跳 /console
```

要打通，需满足三类前提：**飞书侧能力 + 环境变量 + 首个管理员在名单**。任一缺失会在对应环节失败。

---

## 1. 飞书开放平台配置（阻塞前置）

登录 [open.feishu.cn](https://open.feishu.cn) → 进入你的企业自建应用：

### 1.1 配置重定向 URL（必做）

「开发配置」→「安全设置」→「重定向 URL」，**加入回调地址**。该地址必须与服务端拼出来的 `redirect_uri` **逐字符一致**：

| 场景 | 回调地址 |
|---|---|
| 本机联调 | `http://localhost:18790/api/auth/feishu/callback` |
| 生产/远程 | `https://<你的域名>/api/auth/feishu/callback` |

> ⚠️ 飞书对**非 localhost** 的回调要求 **https**；纯 `http://IP` 通常被拒。本机用 `localhost` 可走 http。

### 1.2 获取应用凭证（必做）

「开发配置」→「凭证与基础信息」记下：
- **App ID**（形如 `cli_xxxxxxxx`）
- **App Secret**

### 1.3 申请用户字段权限（可选，②归一化才需要）

「开发配置」→「权限管理」申请并**发版**：
- `contact:user.phone:readonly`（取手机号）
- `contact:user.email:readonly`（取邮箱）

不申请则 `user_info` 不返回手机号/邮箱，只能用 `union_id` 认人——本手册的"两遍法引导"正是不依赖这些字段，所以**首次联调可跳过本步**。

---

## 2. 环境变量配置（`config/.env`）

```bash
# —— 平台 session（缺它登录直接 503）——
SESSION_SECRET=<用 `openssl rand -hex 32` 生成的随机串>

# —— 飞书登录凭证 ——
FEISHU_LOGIN_APP_ID=cli_xxxxxxxx
FEISHU_LOGIN_APP_SECRET=xxxxxxxx

# —— 回调基址：host 必须与飞书后台配的回调、实际访问地址一致 ——
ADMIN_PORTAL_PUBLIC_URL=http://localhost:18790

# —— 可选：申请了手机号/邮箱 scope 才填（空格分隔）——
# FEISHU_LOGIN_SCOPE=contact:user.phone:readonly contact:user.email:readonly
```

**自检**：三个必填项任缺其一，`GET /api/auth/providers` 会返回 `feishu:false`，登录按钮置灰。

---

## 3. 首个管理员引导（解决"鸡生蛋"）

`resolveUser` 角色映射优先级：

```
① users.json 命中（先同 IdP union_id，再手机号/邮箱连接键）→ 用其角色
② BOOTSTRAP_ADMINS（env）命中 union_id 或手机号 → admin
③ 都不命中 → 拒绝（跳 login?error=unauthorized）
```

首次没有任何记录，必须先注入一个管理员。两条路任选：

### 路 A — 已知手机号（需手机号 scope）

`.env` 加：
```bash
PLATFORM_BOOTSTRAP_ADMINS=13800138000     # 你的飞书手机号，逗号分隔可多个
```
> 依赖 §1.3 的手机号 scope，否则 `user_info` 取不到手机号，命不中。

### 路 B — 两遍法（不需任何 scope，**推荐首次联调**）

利用代码已内置的拒绝日志拿到 `union_id`：

1. 先**不配**任何名单，直接走一遍登录 → 被拒，跳到 `/console/login?error=unauthorized`。
2. 看服务端日志，会打印：
   ```
   [WARN] 飞书登录被拒（不在授权名单）：张三 union_id=ou_xxxxxxxx
   ```
3. 拿到 `ou_xxxxxxxx`，二选一注入：

   **方式 1（env，最快）**：
   ```bash
   PLATFORM_BOOTSTRAP_ADMINS=ou_xxxxxxxx
   ```

   **方式 2（用户表，可控角色）** — 写 `~/.openclaw/config-store/users.json`：
   ```json
   [
     {
       "platformUserId": "feishu:ou_xxxxxxxx",
       "name": "张三",
       "platformRole": "admin",
       "feishuUnionId": "ou_xxxxxxxx",
       "source": "allowlist"
     }
   ]
   ```
   > `users.json` 放在 `config-store/` 是安全的：配置生成器/校验器只读 `channels/agents/bindings` 三个具名文件，不会扫到它。`platformRole` 只能是 `admin` / `ops` / `audit`，拼错会在登录时即被拒（fail-loud）。

4. 重启服务，再登录一次 → 成功进入。

---

## 4. 执行联调

```bash
cd yomajiahr/admin-portal

# 构建前后端
npx tsup                       # 后端 → dist/server.js
(cd web && npm run build)      # 前端 → public/console/

# 启动：必须用 --env-file 加载 config/.env（代码直接读 process.env，无 dotenv，
# 裸 node dist/server.js 不会读 .env，会报"未配置 SESSION_SECRET"）。Node 20.6+ 原生支持。
node --env-file=../config/.env dist/server.js
```

浏览器打开 `http://localhost:18790/console`：

1. 未登录 → 渲染登录页，「飞书登录」按钮可点。
2. 点击 → 整页跳转 `accounts.feishu.cn` 授权页。
3. 扫码/确认授权 → 自动回跳。
4. 命中名单 → 进入 ProLayout，左下角显示你的真名 + 角色 Tag。
5. 不在名单 → 跳回登录页顶部红色提示「账号不在授权名单，请联系管理员」（此时走 §3 路 B）。

**成功判据**：服务端日志出现 `[INFO] 飞书登录成功：张三（admin）`，浏览器停在 `/console` 且 `GET /api/auth/me` 返回你的身份。

---

## 5. 常见坑速查

| 现象 | 原因 | 解 |
|---|---|---|
| 登录按钮置灰 | `SESSION_SECRET` / `FEISHU_LOGIN_APP_ID` / `FEISHU_LOGIN_APP_SECRET` 缺失 | 补齐 §2 三必填项 |
| 授权后报 `redirect_uri 不匹配` | 飞书后台回调、`ADMIN_PORTAL_PUBLIC_URL`、实际访问 host 三者不一致 | 三者**逐字符相同**（注意端口、http/https、结尾斜杠） |
| 飞书拒绝回调（非 localhost） | 非 localhost 用了 http | 远程必须 https（反代+证书）；本机用 `localhost` 直连 |
| 浏览器跳不回来（远程） | 服务器无公网回调入口 | 公网域名 + 证书；临时联调用内网穿透（cpolar/frp/ngrok） |
| `state 校验失败` | state cookie 过期（>10min）或被 CSRF | 重新点登录；检查反代是否透传 Cookie |
| 一直 `error=unauthorized` | 名单未命中 | 走 §3 路 B 拿 union_id 注入；确认重启已生效 |
| ②归一化用不了手机号 | 未申请手机号 scope | §1.3 申请 `contact:user.phone:readonly` 并发版 |
| `飞书 oauth/token 失败` | App Secret 错 / code 过期复用 / 回调不一致 | 核对 Secret；code 一次性，勿刷新回调页 |

---

## 6. 最快路径（推荐）

**本机 localhost 直连 + 两遍法引导（§3 路 B 方式 1）**：
- 不需要 https、不需要公网、不需要任何 scope。
- 只配 §2 三个必填项 + 飞书后台加 `http://localhost:18790/api/auth/feishu/callback` 回调。
- 第一遍登录拿 union_id → 填 `PLATFORM_BOOTSTRAP_ADMINS` → 重启 → 第二遍登录成功。

整个闭环可在单机 10 分钟内验完。

---

## 附：相关代码索引

| 环节 | 文件 |
|---|---|
| 授权 URL / 换 token / 取 user_info | `admin-portal/src/auth/feishu.ts` |
| 登录入口 / 回调 / me / logout | `admin-portal/src/routes/auth.ts` |
| 签名 cookie session + state 防 CSRF | `admin-portal/src/auth/session.ts` |
| 角色映射 / 名单 / 引导管理员 | `admin-portal/src/auth/users.ts` |
| 环境变量定义 | `admin-portal/src/config.ts` |
| 登录页 / 鉴权门 | `admin-portal/web/src/{Login,App}.tsx` |
