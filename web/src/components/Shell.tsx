import EnvironmentNotice from "./EnvironmentNotice";
import AccountAvatar from "./AccountAvatar";
/**
 * アプリの外枠（SPEC §12.2）。TopBar / ApBar / 本文 / Tabs / Drawer。
 *
 * タブの切り替えは cross-fade ＋ 軽い transform。待ち時間を作らないため、
 * 前の画面の退場アニメーションは挟まない（apple-design §1「kill latency」）。
 */
import { useEffect, useLayoutEffect, useState } from "react";
import { Outlet, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { motion } from "motion/react";
import type { AccountSummary } from "@tap/shared";
import { useLogout, useMe } from "../api/auth";
import { useActiveAccount } from "../lib/active-account";
import { CROSSFADE, SPRING, useReducedMotion } from "../lib/motion";
import AccountList from "./AccountList";
import Drawer from "./Drawer";
import Tabs, { TABS } from "./Tabs";
import TopBar from "./TopBar";
import { selectCreateAccount, useSelectedCreateAccount } from "../lib/create-session";
import { resumeGenerationTask } from "../lib/generation-task";

export type ShellContext = {
  account: AccountSummary | null;
  accounts: AccountSummary[];
  setAccountId: (id: string) => void;
};

export function useShell(): ShellContext {
  return useOutletContext<ShellContext>();
}

export default function Shell() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data } = useMe();
  const logout = useLogout();
  const reduced = useReducedMotion();
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => { void resumeGenerationTask(); }, []);

  const accounts = data?.accounts ?? [];
  const { active, setActiveId } = useActiveAccount(accounts);

  const createSessionAccount = useSelectedCreateAccount();
  useLayoutEffect(() => selectCreateAccount(active?.id ?? null), [active?.id]);

  const context: ShellContext = { account: active, accounts, setAccountId: setActiveId };

  return (
    <div className="app-shell">
      <TopBar
        account={active}
        onMenu={() => setDrawerOpen(true)}
        onAccountTap={() => setDrawerOpen(true)}
        onAdd={() => navigate("/connect?add=1")}
      />
      {/* ApBar（オートパイロット帯）は機能の公開まで出さない。--apbar-h は workspace.css で 0 */}

      <motion.main
        key={`${data?.user.id}:${active?.id}:${pathname}`}
        className="screen"
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
        animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
        transition={reduced ? CROSSFADE : SPRING}
      >
        <EnvironmentNotice />
        {createSessionAccount === (active?.id ?? null) && <Outlet context={context} />}
      </motion.main>

      <Tabs account={active} accountLimit={data?.entitlement.accountLimit ?? 1} onAccount={() => setDrawerOpen(true)} email={data?.user.email} onLogout={() => logout.mutate()} />

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} labelledBy="drawer-title">
        <h2 id="drawer-title" style={{ padding: "var(--sp)" }}>
          アカウント
        </h2>

        {accounts.length === 0 && (
          <p className="muted" style={{ padding: "0 var(--sp)" }}>
            まだつながっていません。
          </p>
        )}

        <AccountList
          accounts={accounts}
          activeId={active?.id ?? null}
          onSelect={(id) => {
            setActiveId(id);
            setDrawerOpen(false);
          }}
        />

        <button
          type="button"
          className="menu-item"
          onClick={() => {
            setDrawerOpen(false);
            navigate("/connect?add=1");
          }}
        >
          ＋ アカウントを追加
        </button>

        <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "var(--sp) 0" }} />

        <h2 style={{ padding: "var(--sp)" }}>画面</h2>
        {TABS.map(({ path, label }) => (
          <button
            key={path}
            type="button"
            className="menu-item"
            aria-current={pathname === path}
            onClick={() => {
              setDrawerOpen(false);
              navigate(path);
            }}
          >
            {label}
          </button>
        ))}

        <div style={{ marginTop: "auto", paddingTop: "calc(var(--sp) * 2)" }}>
          <p className="muted" style={{ padding: "0 var(--sp)" }}>
            {data?.user.email}
          </p>
          <button
            type="button"
            className="menu-item"
            style={{ color: "var(--bad)" }}
            onClick={() => {
              setDrawerOpen(false);
              logout.mutate();
            }}
          >
            ログアウト
          </button>
        </div>
      </Drawer>
    </div>
  );
}
