# 企业开放登录 — 真机核验 Checklist

> Owner: Dennis ｜ 分支 `feat/login-open-enterprise-members` ｜ 配套 [enterprise-open-login.md](enterprise-open-login.md)
>
> 目的：单测覆盖不到 IdP 真实回包（测试是构造 `IdpIdentity` 直接塞值）。本清单在**配齐凭据的主机**上真机走一遍，
> 重点确认钉钉 `token.corpId` 的实际返回，避免钉钉成员被静默 fail-closed 拒登。

## 0. 前置

- [ ] 在配齐飞书/钉钉登录凭据 + `SESSION_SECRET` 的主机（通常 yomakit，经隧道/公网回调）上操作。
- [ ] `~/.openclaw/.env` 已设：
  ```bash
  PLATFORM_OPEN_ENTERPRISE_LOGIN_ROLE=ops
  DINGTALK_LOGIN_CORP_ID=ding<本企业 corpId>      # 先留空跑 A1，再填值跑 B 段
  ```
- [ ] 重启 Admin Portal：`sudo systemctl restart openclaw-admin`。
- [ ] 启动日志确认：`journalctl -u openclaw-admin` 出现 `Open enterprise login: enabled — ... ops`；
      未填 corpId 时应同时出现 `⚠ DINGTALK_LOGIN_CORP_ID 未配置 ... fail-closed`。

## A. 飞书半边（自建应用 ⇒ 本租户成员）

- [ ] **A0 应用类型确认**：飞书开放平台后台确认登录应用是**自建应用**（非 ISV/应用商店）。
      这是飞书侧"登录成功⟺本租户成员"的全部安全前提；若是 ISV 必须另加 tenant_key 校验。
- [ ] **A1 本企业飞书成员（不在 users.json 白名单）**：登录页点"使用飞书登录" → 应成功进 `/console`，
      `/api/auth/me` 返回 `platformRole: "ops"`、`idp: "feishu"`。
- [ ] **A2 日志**：`飞书登录成功：<名字>（ops）`。

## B. 钉钉半边（corpId 闸门 — 本清单核心）

> 已填 `DINGTALK_LOGIN_CORP_ID` 并重启。

- [ ] **B0 scope 自检**：浏览器点"使用钉钉登录"，看跳转 URL 的 `scope` 参数 = `openid corpid`
      （代码 `effectiveScope()` 在配了 corpId 时自动并入；若只剩 `openid` 说明配置/构建没生效）。
- [ ] **B1 抓原始 token 回包（关键一步）**：本企业钉钉成员走一次登录，在 admin-server 临时加一行
      `log("INFO", JSON.stringify(token))`（或 `journalctl` + 临时 debug）抓 `/v1.0/oauth2/userAccessToken` 的**原始 JSON**，确认：
  - [ ] 顶层确有 `corpId` 字段；
  - [ ] 其值 = 本企业 corpId（与 env 一致）。
  - ⚠️ 若 `corpId` 不在顶层 / 字段名不同 / 恒空 → 见下「失败分支」，**不要合并**。
- [ ] **B2 本企业钉钉成员**：登录页选本企业组织 → 成功进 `/console`，`/api/auth/me` 返回 `ops`、`idp: "dingtalk"`。
- [ ] **B3 外部/他企业钉钉账号**：用非本企业钉钉账号（或登录时选别的组织）→ 应被拒，
      跳 `/console/login?error=unauthorized`，日志 `钉钉登录被拒（未获授权/未过企业成员闸门）... corp_id=<非本企业>`。
- [ ] **B4 corpId 留空回归**：临时清空 `DINGTALK_LOGIN_CORP_ID` 重启 → 任意钉钉登录都应被拒（fail-closed）。验毕填回。

## C. 白名单/管理员不被降级

- [ ] **C1** `users.json` 里 `platformRole: admin` 的成员登录 → 仍是 `admin`（开放登录不覆盖）。
- [ ] **C2** `PLATFORM_BOOTSTRAP_ADMINS` 命中者登录 → `admin`。

## 失败分支：B1 发现 corpId 不可靠

若钉钉 `userAccessToken` 回包不稳定返回 corpId：
- 「统一登录」(`login.dingtalk.com/oauth2/auth`) 不是合适的成员闸门原语；
- 改用**钉钉企业内应用免登**（H5/工作台，结构上即本企业作用域，类比飞书自建），或改从
  `contact/users/me` 之外的企业级接口反查成员归属。
- 记录结论到 [enterprise-open-login.md](enterprise-open-login.md) §2 并回写本清单。

## 收尾

- [ ] 移除 B1 的临时 debug 日志（勿把 token 打进生产日志）。
- [ ] 三段（A/B/C）全绿 → 在 PR 描述勾上"真机核验通过"，署名 Dennis + 日期。

---

## 附录：rsync 直上生产核验（`/opt/yomajiahr` 非 git）

> 部署模型：`/opt/yomajiahr` = install.sh 的 `REPO_DIR`（非 git），本地代码 rsync 过去后跑
> `./install.sh` 从中 build admin-server/web 并重启。`.env` 有 `if [ -f ]` 守卫（install.sh:388），
> 已存在则跳过，**不会冲掉生产凭据**。config-store/base 本分支未改，配置重生成≈no-op。
> 所有命令以 **ubuntu** 用户（CLAUDE.md §3，绝不 root）。corpId 信号无需改代码——拒登日志已带 `corp_id=`。

### 0. 先备份（回滚用）
```bash
sudo -u ubuntu tar -C /opt -czf /home/ubuntu/yomajiahr-pre-openlogin.tgz yomajiahr
```

### 1. 本地 rsync 分支代码到 /opt（排除 .git/node_modules/dist）
```bash
# 在 worktree 根目录执行
rsync -az --exclude '.git' --exclude 'node_modules' --exclude 'dist' \
  /Users/yangmu/Projects/yomajia/.worktrees/feat-login-open-enterprise-members/ \
  yomakit:/opt/yomajiahr/
```
> 若 /opt 属主非 ssh 用户，加 `--rsync-path="sudo rsync"`。

### 2. 加两个新 env（生产 .env 末尾追加）
```bash
sudo -u ubuntu bash -lc '
  cat >> /home/ubuntu/.openclaw/.env <<ENV

# 企业开放登录（feat/login-open-enterprise-members）
PLATFORM_OPEN_ENTERPRISE_LOGIN_ROLE=ops
DINGTALK_LOGIN_CORP_ID=<本企业 corpId>
ENV
'
```

### 3. 重新 build + 重启
```bash
sudo -u ubuntu bash -lc 'cd /opt/yomajiahr && ./install.sh --systemd'
sudo systemctl restart openclaw-admin
```
> 启动日志确认：`journalctl -u openclaw-admin | grep -i "open enterprise"` 出现
> `Open enterprise login: enabled ... ops`（缺 corpId 时还会有 fail-closed WARN）。

### 4. 验证（A/B/C 段）+ 读 corpId 信号
- 浏览器走生产登录页，按上文 A/B/C 段试登。
- 钉钉若被拒，看日志即知 corpId 有没有正确回传：
  ```bash
  journalctl -u openclaw-admin -n 50 | grep "钉钉登录被拒"
  ```
  - `corp_id=-` → corpId 没回来（scope/返回形态问题，需排查授权 scope 是否含 corpid）
  - `corp_id=<某值>` → 值与 env 不匹配，核对 `DINGTALK_LOGIN_CORP_ID`
  - 钉钉能登进 → corpId 闸门 OK

### 5. 回滚（核验不过时）
```bash
sudo -u ubuntu bash -lc '
  rm -rf /opt/yomajiahr && tar -C /opt -xzf /home/ubuntu/yomajiahr-pre-openlogin.tgz
  cd /opt/yomajiahr && ./install.sh --systemd
'
# 并从 /home/ubuntu/.openclaw/.env 删掉第 2 步追加的两行
sudo systemctl restart openclaw-admin
```

> 核验通过后：合并 PR #30 到 main（让 GitHub main 与 /opt 一致，避免日后 install.sh 回退——CLAUDE.md §7 硬约束）。
