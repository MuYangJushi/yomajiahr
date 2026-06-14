# 企业开放登录（放开本企业飞书/钉钉成员）

> Owner: Dennis ｜ 分支 `feat/login-open-enterprise-members`

放开 Admin Portal 登录到**本企业全体飞书/钉钉成员**：通过企业 IdP 认证、且过「企业成员闸门」的用户，
即获得一个基线角色（`ops` 或 `audit`），无需逐个加进 `users.json` 白名单。`admin` 仍由
`users.json` / `PLATFORM_BOOTSTRAP_ADMINS` 单独提权，不受开放登录影响。

## 1. 工作机制

登录回调里 `resolveUser(identity)` 的角色映射优先级（`admin-server/src/auth/users.ts`）：

| 步 | 条件 | 结果 |
|---|---|---|
| ① | `users.json` 命中 | 用其 `platformRole` |
| ② | `PLATFORM_BOOTSTRAP_ADMINS` 命中 | `admin` |
| ④ | **开放登录开启 且 过企业成员闸门** | 基线角色（`ops`/`audit`） |
| ⑤ | 否则 | 拒登（`/console/login?error=unauthorized`） |

## 2. 企业成员闸门（`isEnterpriseMember`）

「企业内成员」必须真正校验，否则等于对全网开放：

- **飞书**：登录应用为**自建应用**（租户内），外部用户无法授权换 code，故 `feishuExchangeCode`
  成功本身即证明本租户成员 —— 直接放行。
- **钉钉**：`login.dingtalk.com/oauth2/auth`「统一登录」**可放进任意钉钉用户**，必须用 token 响应里的
  `corpId` 比对本企业 `DINGTALK_LOGIN_CORP_ID`。**未配置该 env 时钉钉开放登录 fail-closed**（只有飞书成员可开放登录）。
  ⚠️ 钉钉**仅当授权 scope 含 `corpid`** 时才让用户在登录页选择组织并回传 corpId；配了 `DINGTALK_LOGIN_CORP_ID`
  后代码会自动把 `corpid` 并入 scope（`dingtalk.ts:effectiveScope`），无需手动改 `DINGTALK_LOGIN_SCOPE`。

> ⚠️ **待实测核验**：`token.corpId` 在 `openid corpid` scope 下的实际返回位置/值，需在配齐钉钉凭据的主机上
> 真机登录一次、抓 `/v1.0/oauth2/userAccessToken` 原始 JSON 确认；单测用的是构造身份，覆盖不到这一段。

## 3. 配置

```bash
# 开放登录基线角色（ops 可上传/删除等操作；audit 仅只读）。未设/admin/非法值=关闭。
PLATFORM_OPEN_ENTERPRISE_LOGIN_ROLE=ops
# 本企业钉钉 corpId（钉钉开放登录的成员闸门，强烈建议配置）
DINGTALK_LOGIN_CORP_ID=dingxxxxxxxxxxxxxxxx
```

> 旧名 `PLATFORM_DEMO_OPEN_LOGIN_ROLE` 仍兼容（比赛展示期遗留），新部署用新名。

重启 Admin Portal 后生效。登录页会显示「企业开放登录已启用」，启动日志输出
`Open enterprise login: enabled`；若开了开放登录但缺 `DINGTALK_LOGIN_CORP_ID`，日志会 WARN 提示钉钉将 fail-closed。

## 4. 验证要点

- 本企业飞书成员（不在白名单）→ 能登录，角色 = 配置值。
- 本企业钉钉成员（corpId 匹配）→ 能登录；外部钉钉用户（corpId 不匹配/缺失）→ 被拒。
- 白名单/引导管理员 → 仍按其原角色（admin 不被降级）。
- 单测：`admin-server/src/auth/users.test.ts`（5 例覆盖上述路径）。
