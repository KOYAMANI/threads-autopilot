import AccountAvatar from "./AccountAvatar";
/**
 * 下部5タブ（SPEC §12.1 / design-v0.2 §3-2）。
 * ラベルは中身の名前にする（apple-design §16「Direct, specific labels」）。
 */
import type { AccountSummary } from "@tap/shared";
import { useLocation, useNavigate } from "react-router-dom";
import { GearIcon, HomeIcon, NoteIcon, PenIcon, StackIcon } from "./Icons";

/**
 * オートパイロットは開発中のため入口を外している（DECISIONS 2026-10-19）。
 * 戻すときはここに `/app/autopilot` を足し、App.tsx のリダイレクトを外す。
 * `desktop` は PC のサイドバーとパンくずに出す名前。
 */
export const TABS = [
  { path: "/app/home", label: "ホーム", desktop: "アナリティクス", Icon: HomeIcon, phone: true },
  { path: "/app/create", label: "作る", desktop: "投稿をつくる", Icon: PenIcon, phone: true },
  { path: "/app/queue", label: "キュー", desktop: "下書き・予約", Icon: StackIcon, phone: true },
  // note はスマホの下タブには出さず、≡ メニューと PC のサイドバーから開く（DECISIONS 2026-10-21）
  { path: "/app/note", label: "note", desktop: "note", Icon: NoteIcon, phone: false },
  { path: "/app/settings", label: "設定", desktop: "設定", Icon: GearIcon, phone: true },
] as const;

export default function Tabs({ account, onAccount, email, onLogout }: { account: AccountSummary | null; onAccount: () => void; email?: string; onLogout: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <nav className="chrome tabs" aria-label="画面の切り替え">
      <div className="sidebar-top"><div className="brand"><span className="brand-symbol">a</span><span>autopilot<span className="brand-sub">for Threads</span></span></div>
        <button className="sidebar-account" onClick={onAccount}><AccountAvatar account={account} /><span><strong>{account ? `@${account.username}` : "アカウントを接続"}</strong><small>Threads ワークスペース</small></span><span aria-hidden="true">⌄</span></button>
        <button className="btn sidebar-compose" onClick={() => navigate("/app/create")}><PenIcon size={16} />投稿をつくる</button>
        <p className="nav-caption">メニュー</p>
      </div>
      {TABS.map(({ path, label, desktop, Icon, phone }) => {
        const current = pathname === path || pathname.startsWith(`${path}/`);
        return (
          <button
            key={path}
            type="button"
            className={phone ? "tab" : "tab tab-desktop-only"}
            aria-current={current ? "page" : undefined}
            onClick={() => navigate(path)}
          >
            <Icon size={20} />
            <span className="nav-mobile-label">{label}</span><span className="nav-desktop-label">{desktop}</span>
          </button>
        );
      })}
      <div className="sidebar-bottom"><div className="sidebar-user"><span className="account-avatar">{email?.slice(0,1).toUpperCase() ?? "U"}</span><span>{email}</span><button className="icon-btn" title="ログアウト" aria-label="ログアウト" onClick={onLogout}>↪</button></div></div>
    </nav>
  );
}
