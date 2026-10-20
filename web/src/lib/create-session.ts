/**
 * 作る画面の途中経過（作り方・選んだ見本・指示・案・本文・手順）を、別の画面へ行って戻っても
 * 覚えておく置き場（DECISIONS 2026-10-21）。
 *
 * このタブのメモリにだけ持つ。ブラウザの保存領域には書かない（投稿の本文を残さない）ので、
 * 読み込み直すと消える。アカウントを切り替えたとき・ログアウトしたとき・投稿を保存/予約したときにも消す。
 */
import { useCallback, useRef, useSyncExternalStore, type SetStateAction } from "react";

let account: string | null = null;
let epoch = 0;
const values = new Map<string, unknown>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const notify = () => {
  for (const listener of listeners) listener();
};
const currentEpoch = () => epoch;

export function clearCreateSession() {
  epoch++;
  values.clear();
  notify();
}

/** 見ているアカウントが変わったら、前のアカウントの途中経過は捨てる */
export function selectCreateAccount(next: string | null) {
  if (next === account) return;
  clearCreateSession();
  account = next;
  notify();
}

function read<T>(owner: string | null, key: string, fallback: T): T {
  return owner !== null && owner === account && values.has(key) ? (values.get(key) as T) : fallback;
}

function write<T>(owner: string | null, key: string, next: T, expectedEpoch: number) {
  if (expectedEpoch !== epoch || owner === null || owner !== account || Object.is(values.get(key), next)) return;
  values.set(key, next);
  notify();
}

/** `useState` と同じ形。`owner`（アカウント ID）が合うあいだだけ値を覚えておく */
export function useCreateSessionState<T>(owner: string | null, key: string, initial: T | (() => T)) {
  const expectedEpoch = useSyncExternalStore(subscribe, currentEpoch, currentEpoch);
  const fallback = useRef<{ value: T }>();
  if (!fallback.current) fallback.current = { value: typeof initial === "function" ? (initial as () => T)() : initial };
  const get = useCallback(() => read(owner, key, fallback.current!.value), [owner, key]);
  const value = useSyncExternalStore(subscribe, get, get);
  const set = useCallback(
    (next: SetStateAction<T>) => {
      if (expectedEpoch !== epoch) return;
      const result = typeof next === "function" ? (next as (previous: T) => T)(get()) : next;
      write(owner, key, result, expectedEpoch);
    },
    [owner, key, get, expectedEpoch],
  );
  return [value, set] as const;
}
