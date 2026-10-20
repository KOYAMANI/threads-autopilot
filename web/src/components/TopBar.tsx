import AccountAvatar from "./AccountAvatar";
import { useLocation } from "react-router-dom";
import { TABS } from "./Tabs";
import type { AccountSummary } from "@tap/shared";
import { PlusIcon } from "./Icons";

export default function TopBar({ account, onAdd, onAccountTap }: { account: AccountSummary | null; onMenu: () => void; onAdd: () => void; onAccountTap: () => void }) {
  const { pathname } = useLocation();
  const current = pathname === "/app/create" ? "投稿を作る" : TABS.find(t => pathname === t.path || pathname.startsWith(`${t.path}/`))?.label ?? "ワークスペース";
  return <header className="chrome topbar">
    <span className="topbar-breadcrumb"><strong>{current}</strong><span>・</span><span>{account ? `@${account.username} ・ ${account.timezone ?? "Asia/Tokyo"}` : "アカウント未接続"}</span></span>
    <button className="account-chip" type="button" onClick={onAccountTap} aria-label="アカウントを切り替える"><AccountAvatar account={account} /><span className="name">{account ? `@${account.username}` : "アカウント未接続"}</span><span aria-hidden="true">⌄</span></button>
    <button className="icon-btn" type="button" onClick={onAdd} aria-label="アカウントを追加"><PlusIcon /></button>
  </header>;
}
