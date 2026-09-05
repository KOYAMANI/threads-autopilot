/**
 * アプリの外枠（SPEC §12.2）。TopBar / ApBar / 本文 / Tabs / Drawer。
 *
 * タブの切り替えは cross-fade ＋ 軽い transform。待ち時間を作らないため、
 * 前の画面の退場アニメーションは挟まない（apple-design §1「kill latency」）。
 */
import { useState } from "react";
import { Outlet, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { motion } from "motion/react";
import type { AccountSummary } from "@tap/shared";
import { useLogout, useMe } from "../api/auth";
import { useActiveAccount } from "../lib/active-account";
import { CROSSFADE, SPRING, useReducedMotion } from "../lib/motion";
import ApBar from "./ApBar";
import Drawer from "./Drawer";
import Tabs, { TABS } from "./Tabs";
import TopBar from "./TopBar";

export type ShellContext = {
  account: AccountSummary | null;
  accounts: AccountSummary[];
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

  const accounts = data?.accounts ?? [];
  const { active, setActiveId } = useActiveAccount(accounts);

  const context: ShellContext = { account: active, accounts };

  return (
    <>
      <TopBar
        account={active}
        onMenu={() => setDrawerOpen(true)}
        onAccountTap={() => setDrawerOpen(true)}
        onAdd={() => navigate("/connect?add=1")}
      />
      <ApBar enabled={Boolean(active?.autopilotEnabled)} />

      <motion.main
        key={pathname}
        className="screen"
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
        animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
        transition={reduced ? CROSSFADE : SPRING}
      >
        <Outlet context={context} />
      </motion.main>

      <Tabs />

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} labelledBy="drawer-title">
        <h2 id="drawer-title" style={{ padding: "var(--sp)" }}>
          アカウント
        </h2>

        {accounts.length === 0 && (
          <p className="muted" style={{ padding: "0 var(--sp)" }}>
            まだつながっていません。
          </p>
        )}

        {accounts.map((a) => (
          <button
            key={a.id}
            type="button"
            className="menu-item"
            aria-current={a.id === active?.id}
            onClick={() => {
              setActiveId(a.id);
              setDrawerOpen(false);
            }}
          >
            <span className="dot" style={{ background: a.color }} aria-hidden="true" />
            <span style={{ minWidth: 0, flex: "1 1 auto" }}>
              <span style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600 }}>
                @{a.username}
              </span>
              <span className="muted" style={{ fontSize: "0.6875rem" }}>
                {a.status === "needs_reauth" ? "要再接続" : (a.name ?? "　")}
              </span>
            </span>
          </button>
        ))}

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
    </>
  );
}
