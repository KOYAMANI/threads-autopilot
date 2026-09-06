/**
 * オートパイロットと通知の React Query フック（SPEC §7.7 / §7.8 / §12.3）。
 * キーは `[accountId, resource, params]`。変更系の後は `[accountId]` を invalidate する。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApLogResponse,
  ApNextResponse,
  AutopilotResponse,
  LearningResponse,
  NotificationsResponse,
  PutAutopilotRequest,
  PutNotificationsRequest,
} from "@tap/shared";
import { api } from "./client";
import { accountKey } from "./accounts";
import { meKey } from "./auth";

export function useAutopilot(accountId: string | null) {
  return useQuery({
    queryKey: accountKey(accountId ?? "-", "autopilot"),
    enabled: Boolean(accountId),
    queryFn: () => api.get<AutopilotResponse>(`/accounts/${accountId}/autopilot`),
  });
}

export function usePutAutopilot(accountId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PutAutopilotRequest) =>
      api.put<AutopilotResponse>(`/accounts/${accountId}/autopilot`, body),
    onSuccess: (data) => {
      if (!accountId) return;
      // 設定そのものは応答で置き換え、帯（next）とアカウント一覧の enabled を引き直す
      qc.setQueryData(accountKey(accountId, "autopilot"), data);
      void qc.invalidateQueries({ queryKey: accountKey(accountId, "autopilot-next") });
      void qc.invalidateQueries({ queryKey: meKey });
    },
  });
}

export function useLearning(accountId: string | null) {
  return useQuery({
    queryKey: accountKey(accountId ?? "-", "learning"),
    enabled: Boolean(accountId),
    queryFn: async () =>
      (await api.get<LearningResponse>(`/accounts/${accountId}/autopilot/learning`)).rows,
  });
}

export function useApLog(accountId: string | null, limit = 50) {
  return useQuery({
    queryKey: accountKey(accountId ?? "-", "ap-log", { limit }),
    enabled: Boolean(accountId),
    queryFn: async () =>
      (await api.get<ApLogResponse>(`/accounts/${accountId}/autopilot/log?limit=${limit}`)).entries,
  });
}

/** ApBar が読む次の自動投稿（SPEC §7.7）。画面を開いている間は1分ごとに見直す。 */
export function useApNext(accountId: string | null) {
  return useQuery({
    queryKey: accountKey(accountId ?? "-", "autopilot-next"),
    enabled: Boolean(accountId),
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: () => api.get<ApNextResponse>(`/accounts/${accountId}/autopilot/next`),
  });
}

/* ── 通知（SPEC §7.8） ──────────────────────────────── */

export const notificationsKey = ["notifications"] as const;

export function useNotifications() {
  return useQuery({
    queryKey: notificationsKey,
    queryFn: () => api.get<NotificationsResponse>("/notifications"),
  });
}

export function usePutNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PutNotificationsRequest) =>
      api.put<NotificationsResponse>("/notifications", body),
    onSuccess: (data) => {
      qc.setQueryData(notificationsKey, data);
      void qc.invalidateQueries({ queryKey: meKey });
    },
  });
}
