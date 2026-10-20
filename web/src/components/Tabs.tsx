import AccountAvatar from "./AccountAvatar";
import type { AccountSummary } from "@tap/shared";
import { useLocation, useNavigate } from "react-router-dom";
import { GearIcon, HomeIcon, LightbulbIcon, PenIcon, PlaneIcon, StackIcon } from "./Icons";

function ChartIcon({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20V7" /></svg>;
}

export const TABS = [
  { path: "/app/home", label: "ホーム", Icon: HomeIcon, primary: true, disabled: false },
  { path: "/app/queue", label: "キュー", Icon: StackIcon, primary: true, disabled: false },
  { path: "/app/analytics", label: "分析", Icon: ChartIcon, primary: true, disabled: false },
  { path: "/app/tips", label: "投稿ヒント", Icon: LightbulbIcon, primary: true, disabled: false },
  { path: "/app/autopilot", label: "オートパイロット", Icon: PlaneIcon, primary: false, disabled: true },
  { path: "/app/settings", label: "設定", Icon: GearIcon, primary: false, disabled: false },
] as const;

export default function Tabs({ account, accountLimit, onAccount, email, onLogout }: { account: AccountSummary | null; accountLimit: number; onAccount: () => void; email?: string; onLogout: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const pending = account?.pendingApprovalCount ?? 0;

  return <nav className="chrome tabs" aria-label="画面の切り替え">
    <div className="sidebar-top">
      <div className="brand"><span className="brand-symbol">a</span><span>autopilot<span className="brand-sub">for Threads</span></span></div>
      <button className="sidebar-account" onClick={onAccount}><AccountAvatar account={account} /><span><strong>{account ? `@${account.username}` : "アカウントを接続"}</strong><small>{account ? `${accountLimit}アカウントまで` : "Threads"}</small></span><span aria-hidden="true">⌄</span></button>
      <button className={`btn sidebar-compose${pathname === "/app/create" ? " is-current" : ""}`} onClick={() => navigate("/app/create")}><PenIcon size={16} />投稿を作る<span className="shortcut" aria-hidden="true">N</span></button>
      <p className="nav-caption">ワークスペース</p>
    </div>

    {TABS.map(({ path, label, Icon, primary, disabled }) => {
      const current = pathname === path || pathname.startsWith(`${path}/`);
      return <button key={path} type="button" disabled={disabled} className={`tab ${primary ? "tab-primary" : "tab-secondary"}`} aria-current={current ? "page" : undefined} onClick={() => navigate(path)}>
        <span className="tab-icon"><Icon size={20} />{path === "/app/queue" && pending > 0 && <span className="nav-badge" aria-label={`承認待ち${pending}件`}>{Math.min(pending, 9)}</span>}</span>
        <span>{label}{disabled && <small className="nav-dev-badge">開発中</small>}</span>
      </button>;
    })}

    <button type="button" className="tab-compose-fab" aria-label="投稿を作る" onClick={() => navigate("/app/create")}><PenIcon size={23} /><span>作る</span></button>

    <div className="sidebar-bottom">
      <button className="sidebar-auto-state" disabled><span className="status-dot" />オートパイロットは開発中</button>
      <div className="sidebar-user"><span className="account-avatar">{email?.slice(0,1).toUpperCase() ?? "U"}</span><span>{email}</span><button className="icon-btn" title="ログアウト" aria-label="ログアウト" onClick={onLogout}>↪</button></div>
    </div>
  </nav>;
}
