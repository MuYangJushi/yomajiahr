# 比赛展示临时开放登录

## 当前比赛环境

> 本节包含临时访问凭据，仅用于当前比赛展示。比赛结束后必须删除访问码、轮转
> `SESSION_SECRET`，并从本文移除访问码。

- 登录地址：<https://hr.yomakit.com:19443/console/login>
- 比赛访问码：从 `yomakit:/home/ubuntu/.openclaw/.env` 的 `PLATFORM_DEMO_ACCESS_CODE` 获取
- 临时角色：`ops`
- 当前状态：访问码登录已启用；飞书/钉钉企业 IdP 登录保留；IdP 全员放宽已关闭

## 目标

比赛展示期间，通过访问码允许企业外部评委或体验用户进入平台；企业内部用户仍可通过飞书或
钉钉 OAuth 登录。临时通道无需预先写入 `users.json` 或 `PLATFORM_BOOTSTRAP_ADMINS`，
默认关闭，并且不能授予 `admin`。

## 开启

### 方案 A：访问码登录（外部账号推荐）

飞书/钉钉企业自建应用无法认证企业外部账号。为比赛评委或外部体验用户生成一个强随机访问码：

```bash
PLATFORM_DEMO_ACCESS_CODE=<至少16字符的强随机访问码>
PLATFORM_DEMO_ACCESS_ROLE=ops
```

登录页会显示访问码输入框。正确访问码会签发 `demo` 身份的临时平台 session，不经过飞书或钉钉。
访问码不会出现在 providers 接口、页面源码或服务日志中；登录端点每分钟最多接受 10 次尝试。

### 方案 B：放宽企业 IdP 内部账号

在演示环境的 `~/.openclaw/.env` 增加：

```bash
PLATFORM_DEMO_OPEN_LOGIN_ROLE=ops
```

这只允许能够通过企业自建应用 OAuth 的飞书/钉钉内部账号，无法覆盖外部个人账号。
重启 Admin Portal 后生效。登录页会显示“比赛展示期间临时开放”，服务端启动日志也会输出
`Demo open login` 警告。

角色选择：

| 值 | 能力 | 适用场景 |
|---|---|---|
| `ops` | 可查看平台主体内容，也能创建/修改/删除非内置数字员工及执行部分上传、删除等操作 | 隔离的比赛演示环境 |
| `audit` | 只能访问低权限审计能力，不能完整展示平台 | 仅验证登录链路 |
| 未设置、空值、`admin` 或其他值 | 临时开放关闭 | 正常环境 |

已有 `users.json` 用户和 `PLATFORM_BOOTSTRAP_ADMINS` 仍按原角色进入，优先级高于临时角色。

## 风险与收口

- `ops` 不等于只读，现有 RBAC 下包含创建/修改/删除非内置数字员工、上传和删除文档等操作。演示环境应使用可恢复的数据副本。
- 临时开放账号会看到 `ops` 可访问的内容；演示环境不得放置真实薪酬、员工个人信息等敏感数据。
- OAuth 应用本身的可用范围仍由飞书/钉钉开放平台配置决定；“任意账号”指能完成对应 OAuth
  授权的账号。
- 比赛结束后删除 `PLATFORM_DEMO_ACCESS_CODE`、`PLATFORM_DEMO_ACCESS_ROLE` 和
  `PLATFORM_DEMO_OPEN_LOGIN_ROLE`，重启 Admin Portal，并轮转
  `SESSION_SECRET` 使已颁发的临时 session 立即失效。
