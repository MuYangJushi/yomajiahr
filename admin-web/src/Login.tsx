import { useEffect, useRef, useState } from "react";
import { fetchProviders, loginWithDemoAccessCode, type Providers } from "./api";

const ERROR_MSG: Record<string, string> = {
  unauthorized: "账号未获授权或不属于本企业，请联系管理员",
  access_denied: "已取消授权",
  login_failed: "登录失败，请重试",
};

const STYLES = `
  .login-root {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #eef3fb;
    position: relative;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .blob {
    position: absolute;
    border-radius: 50%;
    pointer-events: none;
    filter: blur(90px);
  }
  .blob-1 {
    width: 520px; height: 520px;
    top: -140px; right: -80px;
    background: radial-gradient(circle, rgba(10,132,255,0.18) 0%, transparent 70%);
    animation: blobFloat1 9s ease-in-out infinite alternate;
  }
  .blob-2 {
    width: 440px; height: 440px;
    bottom: -130px; left: -100px;
    background: radial-gradient(circle, rgba(0,113,227,0.12) 0%, transparent 70%);
    animation: blobFloat2 11s ease-in-out infinite alternate;
  }

  .login-card {
    position: relative;
    width: min(420px, calc(100% - 32px));
    background: #ffffff;
    border-radius: 20px;
    padding: 48px 44px 40px;
    box-shadow:
      0 1px 2px rgba(0,0,0,0.04),
      0 4px 12px rgba(0,0,0,0.06),
      0 24px 56px rgba(0,0,0,0.1);
    animation: cardIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
    box-sizing: border-box;
  }
  /* 窄屏（≤ 480px）：卡片内边距收紧，避免在 360 视口被挤压 */
  @media (max-width: 480px) {
    .login-card { padding: 36px 24px 32px; }
    .card-top-bar { left: 24px; right: 24px; }
  }

  .card-top-bar {
    position: absolute;
    top: 0; left: 44px; right: 44px;
    height: 2.5px;
    background: linear-gradient(120deg, #00c6fb 0%, #0a84ff 45%, #0040dd 100%);
    border-radius: 0 0 3px 3px;
  }

  .brand-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-bottom: 40px;
  }

  .brand-icon {
    width: 60px; height: 60px;
    border-radius: 16px;
    background: linear-gradient(135deg, #00c6fb 0%, #0a84ff 45%, #0040dd 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 20px;
    box-shadow: 0 6px 24px rgba(0,113,227,0.28);
  }

  .brand-title {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
    font-size: 22px;
    font-weight: 700;
    color: #1a2a3a;
    letter-spacing: 0.03em;
    text-align: center;
    margin: 0;
    line-height: 1.3;
  }

  .brand-sub {
    margin-top: 6px;
    font-size: 11px;
    color: #94a3b8;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    font-weight: 500;
  }

  .alert {
    margin-bottom: 20px;
    padding: 11px 14px;
    border-radius: 10px;
    font-size: 13px;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    line-height: 1.5;
    animation: alertIn 0.25s ease-out;
  }
  .alert-error {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #b91c1c;
  }
  .alert-warn {
    background: #fffbeb;
    border: 1px solid #fde68a;
    color: #92400e;
  }
  .alert-info {
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    color: #1d4ed8;
  }

  .btn-group { display: flex; flex-direction: column; gap: 10px; }

  .btn {
    width: 100%;
    padding: 14px 20px;
    border-radius: 12px;
    border: none;
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    transition: transform 0.15s, box-shadow 0.15s;
    letter-spacing: 0.02em;
  }

  .btn-feishu {
    background: linear-gradient(130deg, #00c6fb 0%, #0a84ff 45%, #0040dd 100%);
    color: white;
    box-shadow: 0 3px 14px rgba(0,113,227,0.28);
  }
  .btn-feishu:hover:not(:disabled) {
    box-shadow: 0 7px 22px rgba(0,113,227,0.38);
    transform: translateY(-1px);
  }
  .btn-feishu:active:not(:disabled) { transform: translateY(0); }
  .btn-feishu:disabled {
    background: #e8edf3;
    color: #94a3b8;
    box-shadow: none;
    cursor: not-allowed;
  }

  .btn-ding {
    background: linear-gradient(135deg, #eaf3fe, #d6e7fc);
    border: 1px solid #bcd6f5;
    color: #0071e3;
    font-weight: 600;
    font-size: 14px;
  }
  .btn-ding:hover:not(:disabled) {
    box-shadow: 0 6px 18px rgba(0,113,227,0.18);
    transform: translateY(-1px);
  }
  .btn-ding:active:not(:disabled) { transform: translateY(0); }
  .btn-ding:disabled {
    background: transparent;
    border: 1.5px solid #dde3ec;
    color: #94a3b8;
    cursor: not-allowed;
  }
  .demo-access {
    margin-top: 18px;
    padding-top: 18px;
    border-top: 1px solid #e8edf3;
  }
  .demo-access-label {
    display: block;
    margin-bottom: 8px;
    color: #64748b;
    font-size: 12px;
  }
  .demo-access-row { display: flex; gap: 8px; }
  .demo-access-input {
    min-width: 0;
    flex: 1;
    border: 1px solid #cbd5e1;
    border-radius: 10px;
    padding: 11px 12px;
    font-size: 14px;
    outline: none;
  }
  .demo-access-input:focus { border-color: #0071e3; box-shadow: 0 0 0 3px rgba(0,113,227,0.12); }
  .demo-access-submit {
    border: none;
    border-radius: 10px;
    padding: 0 16px;
    background: #1a2a3a;
    color: white;
    cursor: pointer;
  }
  .demo-access-submit:disabled { opacity: 0.55; cursor: not-allowed; }
  .demo-access-error { margin-top: 7px; color: #b91c1c; font-size: 12px; }

  .btn-tag {
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 4px;
    letter-spacing: 0.04em;
  }
  .btn-feishu .btn-tag {
    background: rgba(255,255,255,0.2);
    color: rgba(255,255,255,0.8);
  }
  .btn-feishu:disabled .btn-tag {
    background: rgba(0,0,0,0.05);
    color: #94a3b8;
  }
  .btn-ding .btn-tag {
    background: #f1f5f9;
    color: #94a3b8;
  }

  .spinner-wrap { text-align: center; padding: 24px 0; }
  .spinner {
    width: 26px; height: 26px;
    border: 2.5px solid #dde3ec;
    border-top-color: #0071e3;
    border-radius: 50%;
    animation: spin 0.65s linear infinite;
    display: inline-block;
  }

  .login-footer {
    margin-top: 30px;
    text-align: center;
    font-size: 11.5px;
    color: #b0bec5;
    letter-spacing: 0.04em;
  }
  .footer-dot { margin: 0 6px; }

  @keyframes cardIn {
    from { opacity: 0; transform: translateY(18px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes alertIn {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes blobFloat1 {
    from { transform: translate(0, 0) scale(1); }
    to   { transform: translate(-50px, 40px) scale(1.1); }
  }
  @keyframes blobFloat2 {
    from { transform: translate(0, 0) scale(1); }
    to   { transform: translate(40px, -50px) scale(1.08); }
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
`;

function BrandIcon() {
  return (
    <div className="brand-icon">
      <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true">
        <circle cx="11" cy="10" r="5" fill="rgba(255,255,255,0.95)" />
        <path d="M4 26v-1.5A7 7 0 0118 24.5V26" stroke="rgba(255,255,255,0.95)" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="23" cy="9" r="3" fill="rgba(255,255,255,0.55)" />
        <path d="M27 15.5v-.5a4 4 0 00-8 0v.5" stroke="rgba(255,255,255,0.55)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function FeishuIcon({ disabled }: { disabled: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle cx="24" cy="24" r="20" fill={disabled ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.18)"} />
      <path d="M20 16l14 8-14 8V16z" fill={disabled ? "#94a3b8" : "white"} />
      <circle cx="33" cy="13" r="4" fill={disabled ? "#94a3b8" : "rgba(255,255,255,0.6)"} />
      <path d="M31 19v-1a2 2 0 014 0v1" stroke={disabled ? "#94a3b8" : "rgba(255,255,255,0.6)"} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function DingIcon({ disabled }: { disabled: boolean }) {
  const fg = disabled ? "#b0bec5" : "#3296fa";
  return (
    <svg width="19" height="19" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <rect x="6" y="6" width="36" height="36" rx="8" fill={disabled ? "#dde3ec" : "rgba(50,150,250,0.1)"} />
      <circle cx="24" cy="24" r="8" stroke={fg} strokeWidth="2" />
      <path d="M24 19v5l3 3" stroke={fg} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Login() {
  const [providers, setProviders] = useState<Providers | null>(null);
  const [loading, setLoading] = useState(true);
  const [demoCode, setDemoCode] = useState("");
  const [demoSubmitting, setDemoSubmitting] = useState(false);
  const [demoError, setDemoError] = useState("");
  const styleRef = useRef<HTMLStyleElement | null>(null);

  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = STYLES;
    document.head.appendChild(el);
    styleRef.current = el;
    return () => { el.remove(); };
  }, []);

  useEffect(() => {
    fetchProviders()
      .then(setProviders)
      .catch(() => setProviders(null))
      .finally(() => setLoading(false));
  }, []);

  const errCode = new URLSearchParams(window.location.search).get("error") || "";
  const errText = errCode ? ERROR_MSG[errCode] || "登录异常" : "";
  const sessionDisabled = providers != null && !providers.session_enabled;
  const feishuOn = Boolean(providers?.providers.feishu);
  const feishuDisabled = !feishuOn || sessionDisabled;
  const dingtalkOn = Boolean(providers?.providers.dingtalk);
  const dingtalkDisabled = !dingtalkOn || sessionDisabled;
  const openEnterpriseLogin = Boolean(providers?.open_enterprise_login.enabled);
  const openEnterpriseRole = providers?.open_enterprise_login.role;
  const demoAccessEnabled = Boolean(providers?.demo_access_code.enabled);
  const demoAccessRole = providers?.demo_access_code.role;

  async function submitDemoAccess() {
    if (!demoCode || demoSubmitting) return;
    setDemoSubmitting(true);
    setDemoError("");
    try {
      await loginWithDemoAccessCode(demoCode);
      window.location.href = "/";
    } catch (err: any) {
      setDemoError(err?.response?.data?.error || "访问码登录失败");
    } finally {
      setDemoSubmitting(false);
    }
  }

  return (
    <div className="login-root">
      <div className="blob blob-1" />
      <div className="blob blob-2" />

      <main className="login-card" role="main">
        <div className="card-top-bar" />

        <div className="brand-wrap">
          <BrandIcon />
          <h1 className="brand-title">HR 数字员工</h1>
          <p className="brand-sub">Management Platform</p>
        </div>

        {errText && (
          <div className="alert alert-error" role="alert">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true">
              <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 3.5h1.5v5h-1.5v-5zm0 6h1.5v1.5h-1.5V10.5z" />
            </svg>
            {errText}
          </div>
        )}

        {sessionDisabled && (
          <div className="alert alert-warn" role="alert">
            <span aria-hidden="true">⚠</span>
            平台未配置 SESSION_SECRET，登录不可用
          </div>
        )}

        {openEnterpriseLogin && (
          <div className="alert alert-info" role="alert">
            企业开放登录已启用：本企业飞书 / 钉钉成员均可登录访问平台（默认角色：{openEnterpriseRole}）
          </div>
        )}

        {loading ? (
          <div className="spinner-wrap">
            <span className="spinner" aria-label="加载中" />
          </div>
        ) : (
          <div className="btn-group">
            <button
              className="btn btn-feishu"
              disabled={feishuDisabled}
              onClick={() => { window.location.href = "/api/auth/feishu/login"; }}
              aria-label="使用飞书账号登录"
            >
              <FeishuIcon disabled={feishuDisabled} />
              使用飞书登录
              {!feishuOn && <span className="btn-tag">未配置</span>}
            </button>

            <button
              className="btn btn-ding"
              disabled={dingtalkDisabled}
              onClick={() => { window.location.href = "/api/auth/dingtalk/login"; }}
              title={dingtalkOn ? "使用钉钉账号登录" : "钉钉登录未配置"}
              aria-label="使用钉钉账号登录"
            >
              <DingIcon disabled={dingtalkDisabled} />
              使用钉钉登录
              {!dingtalkOn && <span className="btn-tag">未配置</span>}
            </button>

            {demoAccessEnabled && (
              <div className="demo-access">
                <label className="demo-access-label" htmlFor="demo-access-code">
                  比赛访客可使用临时访问码进入（角色：{demoAccessRole}）
                </label>
                <div className="demo-access-row">
                  <input
                    id="demo-access-code"
                    className="demo-access-input"
                    type="password"
                    autoComplete="one-time-code"
                    placeholder="输入比赛访问码"
                    value={demoCode}
                    onChange={(e) => setDemoCode(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void submitDemoAccess(); }}
                  />
                  <button
                    className="demo-access-submit"
                    disabled={!demoCode || demoSubmitting}
                    onClick={() => void submitDemoAccess()}
                  >
                    {demoSubmitting ? "验证中" : "进入"}
                  </button>
                </div>
                {demoError && <div className="demo-access-error" role="alert">{demoError}</div>}
              </div>
            )}
          </div>
        )}

        <footer className="login-footer">
          <span>{openEnterpriseLogin ? "本企业成员开放登录" : demoAccessEnabled ? "比赛展示临时开放" : "仅限授权员工访问"}</span>
          <span className="footer-dot">·</span>
          <span>如需帮助请联系管理员</span>
        </footer>
      </main>
    </div>
  );
}
