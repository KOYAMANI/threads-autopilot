import AccountAvatar from "./AccountAvatar";
/**
 * 下部5タブ（SPEC §12.1 / design-v0.2 §3-2）。投稿ヒントは B 系統から（DECISIONS 2026-10-20）。
 * ラベルは中身の名前にする（apple-design §16「Direct, specific labels」）。
 */
import type { AccountSummary } from "@tap/shared";
import { useLocation, useNavigate } from "react-router-dom";
import { GearIcon, HomeIcon, LightbulbIcon, PenIcon, StackIcon } from "./Icons";

/**
 * オートパイロットは開発中のため入口を外している（DECISIONS 2026-10-19）。
 * 戻すときはここに `/app/autopilot` を足し、App.tsx のリダイレクトを外す。
 * `desktop` は PC のサイドバーとパンくずに出す名前。
 */
export const TABS = [
  { path: "/app/home", label: "ホーム", desktop: "アナリティクス", Icon: HomeIcon },
  { path: "/app/create", label: "作る", desktop: "投稿をつくる", Icon: PenIcon },
  { path: "/app/queue", label: "キュー", desktop: "下書き・予約", Icon: StackIcon },
  { path: "/app/tips", label: "ヒント", desktop: "投稿ヒント", Icon: LightbulbIcon },
  { path: "/app/settings", label: "設定", desktop: "設定", Icon: GearIcon },
] as const;

export default function Tabs({ account, onAccount, email, onLogout }: { account: AccountSummary | null; accountLimit?: number; onAccount: () => void; email?: string; onLogout: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const pending = account?.pendingApprovalCount ?? 0;

  return (
    <nav className="chrome tabs" aria-label="画面の切り替え">
      <div className="sidebar-top"><div className="brand"><span className="brand-symbol">a</span><span>autopilot<span className="brand-sub">for Threads</span></span></div>
        <button className="sidebar-account" onClick={onAccount}><AccountAvatar account={account} /><span><strong>{account ? `@${account.username}` : "アカウントを接続"}</strong><small>Threads ワークスペース</small></span><span aria-hidden="true">⌄</span></button>
        <button className="btn sidebar-compose" onClick={() => navigate("/app/create")}><PenIcon size={16} />投稿をつくる</button>
        <p className="nav-caption">メニュー</p>
      </div>
      {TABS.map(({ path, label, desktop, Icon }) => {
        const current = pathname === path || pathname.startsWith(`${path}/`);
        return (
          <button
            key={path}
            type="button"
            className="tab"
            aria-current={current ? "page" : undefined}
            onClick={() => navigate(path)}
          >
            <span className="tab-icon"><Icon size={20} />{path === "/app/queue" && pending > 0 && <span className="nav-badge" aria-label={`承認待ち${pending}件`}>{Math.min(pending, 9)}</span>}</span>
            <span className="nav-mobile-label">{label}</span><span className="nav-desktop-label">{desktop}</span>
          </button>
        );
      })}
      <div className="sidebar-bottom"><div className="sidebar-user"><span className="account-avatar">{email?.slice(0,1).toUpperCase() ?? "U"}</span><span>{email}</span><button className="icon-btn" title="ログアウト" aria-label="ログアウト" onClick={onLogout}>↪</button></div></div>
    </nav>
  );
}
