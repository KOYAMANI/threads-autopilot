/**
 * 選択中のアカウント（SPEC §12.1「選択中アカウントは localStorage.activeAccountId」）。
 * 保存された ID が今のアカウント一覧に無ければ先頭に落とす。
 */
import { useCallback, useEffect, useState } from "react";
import type { AccountSummary } from "@tap/shared";

const KEY = "activeAccountId";

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function write(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch {
    /* プライベートブラウズなど。保存できなくても画面は動く */
  }
}

export function useActiveAccount(accounts: AccountSummary[]): {
  active: AccountSummary | null;
  activeId: string | null;
  setActiveId: (id: string) => void;
} {
  const [stored, setStored] = useState<string | null>(() => read());

  const active =
    accounts.find((a) => a.id === stored) ?? (accounts.length > 0 ? accounts[0]! : null);

  // 保存値が一覧に無い（消したアカウント等）なら、実際に選ばれたものへ寄せる
  useEffect(() => {
    if (active && stored !== active.id) {
      write(active.id);
      setStored(active.id);
    }
    if (!active && stored !== null) {
      write(null);
      setStored(null);
    }
  }, [active, stored]);

  const setActiveId = useCallback((id: string) => {
    write(id);
    setStored(id);
  }, []);

  return { active, activeId: active?.id ?? null, setActiveId };
}

export const activeAccountStorageKey = KEY;
