import AccountAvatar from "./AccountAvatar";
/**
 * TopBar（SPEC §12.2 / design-v0.2 §3-2）。
 * 左上ハンバーガー → ドロワー、中央にアカウントチップ、右上「＋」でアカウント追加。
 * 半透明レイヤーで、本文はこの下に潜る（apple-design §12）。
 */
import { useLocation } from "react-router-dom";
import { TABS } from "./Tabs";
import type { AccountSummary } from "@tap/shared";
import { MenuIcon, PlusIcon } from "./Icons";

export default function TopBar({
  account,
  onMenu,
  onAdd,
  onAccountTap,
}: {
  account: AccountSummary | null;
  onMenu: () => void;
  onAdd: () => void;
  onAccountTap: () => void;
}) {
  const { pathname } = useLocation();
  const current = TABS.find(t => t.path === pathname);
  return (
    <header className="chrome topbar"><span className="topbar-breadcrumb">ワークスペース <span>/</span> <strong>{current?.label === "ホーム" ? "アナリティクス" : current?.label === "作る" ? "投稿をつくる" : current?.label === "キュー" ? "下書き・予約" : current?.label}</strong></span>
      <button className="icon-btn" type="button" onClick={onMenu} aria-label="メニューを開く">
        <MenuIcon />
      </button>

      <button
        className="account-chip"
        type="button"
        onClick={onAccountTap}
        aria-label="アカウントを切り替える"
      >
        <AccountAvatar account={account} />
        <span className="name">{account ? `@${account.username}` : "アカウント未接続"}</span>
        {account?.status === "needs_reauth" && (
          <span className="tag" style={{ background: "var(--bad-soft)", color: "var(--bad)" }}>
            要再接続
          </span>
        )}
      </button>

      <button className="icon-btn" type="button" onClick={onAdd} aria-label="アカウントを追加">
        <PlusIcon />
      </button>
    </header>
  );
}
