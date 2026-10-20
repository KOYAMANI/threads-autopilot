import { useCallback, useRef, useSyncExternalStore, type SetStateAction } from "react";
import { onPrivateStateClear } from "./session-boundary";

// Completed drafts live only in this tab's memory. No browser storage or new API.
let account: string | null = null;
let epoch = 0;
export const createSessionEpoch = () => epoch;
const values = new Map<string, unknown>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const notify = () => { for (const listener of listeners) listener(); };

export function clearCreateSession() {
  epoch++;
  const media = values.get("media") as Array<{ previewUrl: string }> | undefined;
  media?.forEach(item => URL.revokeObjectURL(item.previewUrl));
  values.clear();
  notify();
}

export function selectCreateAccount(next: string | null) {
  if (next === account) return;
  clearCreateSession();
  account = next;
  notify();
}

export function readCreateValue<T>(owner: string | null, key: string, fallback: T): T {
  return owner !== null && owner === account && values.has(key) ? values.get(key) as T : fallback;
}

export function writeCreateValue<T>(owner: string | null, key: string, next: T, expectedEpoch = epoch) {
  if (expectedEpoch !== epoch || owner === null || owner !== account || Object.is(values.get(key), next)) return;
  values.set(key, next);
  notify();
}

export function useSelectedCreateAccount() {
  return useSyncExternalStore(subscribe, () => account, () => account);
}

export function useCreateSessionState<T>(owner: string | null, key: string, initial: T | (() => T)) {
  const expectedEpoch = useSyncExternalStore(subscribe, createSessionEpoch, createSessionEpoch);
  const fallback = useRef<{ value: T }>();
  if (!fallback.current) fallback.current = { value: typeof initial === "function" ? (initial as () => T)() : initial };
  const get = useCallback(() => readCreateValue(owner, key, fallback.current!.value), [owner, key]);
  const value = useSyncExternalStore(subscribe, get, get);
  const set = useCallback((next: SetStateAction<T>) => {
    if (expectedEpoch !== epoch) return;
    const result = typeof next === "function" ? (next as (previous: T) => T)(get()) : next;
    writeCreateValue(owner, key, result, expectedEpoch);
  }, [owner, key, get, expectedEpoch]);
  return [value, set] as const;
}

onPrivateStateClear(() => selectCreateAccount(null));
