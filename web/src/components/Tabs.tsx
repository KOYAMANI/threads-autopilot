import AccountAvatar from "./AccountAvatar";
/**
 * 下部5タブ（SPEC §12.1 / design-v0.2 §3-2）。
 * ラベルは中身の名前にする（apple-design §16「Direct, specific labels」）。
 */
import type { AccountSummary } from "@tap/shared";
import { useLocation, useNavigate } from "react-router-dom";
import { GearIcon, HomeIcon, PenIcon, PlaneIcon, StackIcon } from "./Icons";

export const TABS = [
  { path: "/app/home", label: "ホーム", Icon: HomeIcon },
  { path: "/app/create", label: "作る", Icon: PenIcon },
  { path: "/app/queue", label: "キュー", Icon: StackIcon },
  { path: "/app/autopilot", label: "オートパイロット", Icon: PlaneIcon },
  { path: "/app/settings", label: "設定", Icon: GearIcon },
] as const;

export default function Tabs({ account, onAccount, email, onLogout }: { account: AccountSummary | null; onAccount: () => void; email?: string; onLogout: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <nav className="chrome tabs" aria-label="画面の切り替え">
      <div className="sidebar-top"><div className="brand"><span className="brand-symbol">a</span><span>autopilot<span className="brand-sub">for Threads</span></span></div>
        <button className="sidebar-account" onClick={onAccount}><AccountAvatar account={account} /><span><strong>{account ? `@${account.username}` : "アカウントを接続"}</strong><small>Threads ワークスペース</small></span><span aria-hidden="true">⌄</span></button>
        <button className="btn sidebar-compose" onClick={() => navigate("/app/create")}><PenIcon size={16} />投稿をつくる<span aria-hidden="true">＋</span></button>
        <p className="nav-caption">ワークスペース</p>
      </div>
      {TABS.map(({ path, label, Icon }) => {
        const current = pathname === path || pathname.startsWith(`${path}/`);
        return (
          <button
            key={path}
            type="button"
            className="tab"
            aria-current={current ? "page" : undefined}
            onClick={() => navigate(path)}
          >
            <Icon size={20} />
            <span className="nav-mobile-label">{label === "オートパイロット" ? "自動" : label}</span><span className="nav-desktop-label">{label === "ホーム" ? "アナリティクス" : label === "作る" ? "投稿をつくる" : label === "キュー" ? "下書き・予約" : label}</span>
          </button>
        );
      })}
      <div className="sidebar-bottom"><div className="workspace-note"><span className="status-dot" />あなたのペースで、続けよう。<p>数字からヒントを見つけて、<br />次の投稿につなげましょう。</p></div><div className="sidebar-user"><span className="account-avatar">{email?.slice(0,1).toUpperCase() ?? "U"}</span><span>{email}</span><button className="icon-btn" title="ログアウト" aria-label="ログアウト" onClick={onLogout}>↪</button></div></div>
    </nav>
  );
}
