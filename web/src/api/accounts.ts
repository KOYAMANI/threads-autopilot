/**
 * アカウント・ダッシュボードの React Query フック（SPEC §7.1 / §7.2 / §12.2）。
 * キーは `[accountId, resource, params]`。変更系の後は `[accountId]` を invalidate する。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AccountSummary,
  DeleteUserRequest,
  DeleteUserResponse,
  DiagnoseResponse,
  LicenseResponse,
  LinkSummary,
  RefreshTokenResponse,
  ConnectAccountRequest,
  ConnectAccountResponse,
  DashboardPeriod,
  DashboardResponse,
  SyncStatus,
} from "@tap/shared";
import { ApiError, api } from "./client";
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

/* ── M7: アカウント管理・診断・書き出し・ライセンス・退会 ─── */

/** 診断（SPEC §7.1 `GET /accounts/:id/diagnose`）。押したときだけ走らせる。 */
export function useDiagnose(accountId: string | null) {
  return useMutation({
    mutationFn: async () =>
      (await api.get<DiagnoseResponse>(`/accounts/${accountId}/diagnose`)).steps,
  });
}

/** トークンの手動延長（SPEC §7.1）。 */
export function useRefreshToken(accountId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<RefreshTokenResponse>(`/accounts/${accountId}/refresh-token`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["accounts", "list", null] });
      void qc.invalidateQueries({ queryKey: meKey });
    },
  });
}

/**
 * アカウントを外す（SPEC §7.1）。関連データも全部消える。
 * 消えたあとの選択中アカウントの寄せ直しは `useActiveAccount` が面倒を見る。
 */
export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => api.del<{ deleted: true }>(`/accounts/${accountId}`),
    onSuccess: (_data, accountId) => {
      qc.removeQueries({ queryKey: [accountId] });
      void qc.invalidateQueries({ queryKey: ["accounts", "list", null] });
      void qc.invalidateQueries({ queryKey: meKey });
    },
  });
}

/** ライセンス（末尾4桁と状態。SPEC §1「設定 … ライセンス」）。 */
export function useLicense() {
  return useQuery({
    queryKey: ["license", null] as const,
    queryFn: async () => (await api.get<LicenseResponse>("/users/me/license")).license,
  });
}

/**
 * CSV の書き出し（SPEC §7.8）。`fetch` でバイト列を取り、Blob にして保存する。
 * `<a href>` で直接踏ませないのは、Cookie 付きの GET でも
 * `Content-Disposition` の名前を iOS Safari が拾い損ねることがあるため。
 */
export async function downloadCsv(accountId: string, username: string): Promise<void> {
  const res = await fetch(`/api/export/${accountId}?format=csv`, {
    headers: { "X-Requested-With": "fetch" },
    credentials: "include",
  });
  if (!res.ok) throw new ApiError("EXPORT_FAILED", "書き出しに失敗しました", res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `threads-${username}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 少し待ってから開放する（Safari がダウンロードを始める前に消すと落ちる）
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 退会（SPEC §7.8）。成功したらログイン画面へ戻す（呼び出し側で遷移）。 */
export function useDeleteUser() {
  return useMutation({
    mutationFn: (password: string) =>
      api.del<DeleteUserResponse>("/users/me", { password } satisfies DeleteUserRequest),
  });
}
