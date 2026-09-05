/**
 * TopBar（SPEC §12.2 / design-v0.2 §3-2）。
 * 左上ハンバーガー → ドロワー、中央にアカウントチップ、右上「＋」でアカウント追加。
 * 半透明レイヤーで、本文はこの下に潜る（apple-design §12）。
 */
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
  return (
    <header className="chrome topbar">
      <button className="icon-btn" type="button" onClick={onMenu} aria-label="メニューを開く">
        <MenuIcon />
      </button>

      <button
        className="account-chip"
        type="button"
        onClick={onAccountTap}
        aria-label="アカウントを切り替える"
      >
        <span
          className="dot"
          style={{ background: account?.color ?? "var(--ink3)" }}
          aria-hidden="true"
        />
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
