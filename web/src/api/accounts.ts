/**
 * アカウント・ダッシュボードの React Query フック（SPEC §7.1 / §7.2 / §12.2）。
 * キーは `[accountId, resource, params]`。変更系の後は `[accountId]` を invalidate する。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AccountSummary,
  LinkSummary,
  ConnectAccountRequest,
  ConnectAccountResponse,
  DashboardPeriod,
  DashboardResponse,
  SyncStatus,
} from "@tap/shared";
import { api } from "./client";
import { meKey } from "./auth";

export const accountKey = (accountId: string, resource: string, params?: unknown) =>
  [accountId, resource, params ?? null] as const;

export function useDashboard(accountId: string | null, period: DashboardPeriod) {
  return useQuery({
    queryKey: accountKey(accountId ?? "-", "dashboard", { period }),
    enabled: Boolean(accountId),
    queryFn: () =>
      api.get<DashboardResponse>(`/accounts/${accountId}/dashboard?period=${period}`),
  });
}

/**
 * 初回同期の進捗（SPEC §7.1）。`running` の間だけ 1.5 秒ごとに聞き直す。
 * `enabled=false` で止められる（Connect 画面が接続後にだけ回す）。
 */
export function useSyncStatus(accountId: string | null, enabled = true) {
  return useQuery({
    queryKey: accountKey(accountId ?? "-", "sync"),
    enabled: Boolean(accountId) && enabled,
    refetchInterval: (query) => (query.state.data?.running === false ? false : 1500),
    queryFn: () => api.get<SyncStatus>(`/accounts/${accountId}/sync`),
  });
}

export function useConnectAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ConnectAccountRequest) =>
      api.post<ConnectAccountResponse>("/accounts", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: meKey }),
  });
}

export function useRepost(accountId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (postId: string) =>
      api.post<{ id: string }>(`/accounts/${accountId}/posts/${postId}/repost`),
    onSuccess: () => {
      if (accountId) qc.invalidateQueries({ queryKey: [accountId] });
    },
  });
}

/** `GET /accounts` の一覧。ドロワーの切替は `/auth/me` の accounts でも足りるが、
 *  状態（needs_reauth・トークン残日数）を最新にしたい画面はこちらを使う。 */
export function useAccounts(enabled = true) {
  return useQuery({
    queryKey: ["accounts", "list", null] as const,
    enabled,
    queryFn: async () => (await api.get<{ accounts: AccountSummary[] }>("/accounts")).accounts,
  });
}

/** アカウントのリンク一覧（SPEC §7.5）。オートパイロットの「リンク」設定で本数を出す。 */
export function useLinks(accountId: string | null) {
  return useQuery({
    queryKey: accountKey(accountId ?? "-", "links"),
    enabled: Boolean(accountId),
    queryFn: async () =>
      (await api.get<{ links: LinkSummary[] }>(`/accounts/${accountId}/links`)).links,
  });
}
