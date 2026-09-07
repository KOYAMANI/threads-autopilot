/**
 * キューの React Query フック（SPEC §7.4 / §12.3）。
 * キーは `[accountId, resource, params]`。変更系の後は `[accountId]` を invalidate する
 * （キューの一覧・ホームの数字・おすすめ枠がまとめて古くなるため）。
 */
import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateQueueRequest,
  PatchQueueRequest,
  QueueItem,
  QueueItemResponse,
  QueueListResponse,
  QueueStatus,
  QueueSlotsResponse,
  PostingSchedule,
  PutPostingScheduleRequest,
  SuggestSlotResponse,
} from "@tap/shared";
import { api } from "./client";
import { accountKey } from "./accounts";

/** 画面のタブ（SPEC §12.3「予約 / 下書き / 投稿済 / 失敗」）と `queue.status` の対応。 */
export const QUEUE_TABS = [
  { key: "scheduled", label: "予約", statuses: ["scheduled", "pending_approval", "publishing"] },
  { key: "draft", label: "下書き", statuses: ["draft"] },
  { key: "done", label: "投稿済", statuses: ["done"] },
  { key: "failed", label: "失敗", statuses: ["failed", "cancelled"] },
] as const;

export type QueueTabKey = (typeof QUEUE_TABS)[number]["key"];

export function statusesFor(tab: QueueTabKey): QueueStatus[] {
  const found = QUEUE_TABS.find((t) => t.key === tab);
  return [...(found?.statuses ?? [])] as QueueStatus[];
}

export function useQueue(accountId: string | null, tab: QueueTabKey) {
  const statuses = statusesFor(tab);
  return useQuery({
    queryKey: accountKey(accountId ?? "-", "queue", { tab }),
    enabled: Boolean(accountId),
    queryFn: async () =>
      (
        await api.get<QueueListResponse>(
          `/accounts/${accountId}/queue?status=${statuses.join(",")}`,
        )
      ).items,
  });
}

/**
 * おすすめ枠（SPEC §7.4 / §9.3）。押したときにだけ取りに行きたいので `enabled` で制御する。
 * 枠は「今から見た空き」なので、キャッシュは短くする。
 */
export function useSuggestSlot(accountId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: accountKey(accountId ?? "-", "suggest-slot"),
    enabled: Boolean(accountId) && enabled,
    staleTime: 30_000,
    queryFn: () => api.get<SuggestSlotResponse>(`/accounts/${accountId}/queue/suggest-slot`),
  });
}

/** 変更系の後に、そのアカウントのキャッシュをまとめて捨てる。 */
function useInvalidate(accountId: string | null) {
  const qc = useQueryClient();
  return () => {
    if (accountId) void qc.invalidateQueries({ queryKey: [accountId] });
  };
}

export function useCreateQueue(accountId: string | null) {
  const invalidate = useInvalidate(accountId);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  return useMutation({
    mutationFn: async (body: CreateQueueRequest): Promise<QueueItem> => {
      const signature = JSON.stringify([accountId, body]);
      if (attempt.current?.signature !== signature) {
        attempt.current = { signature, key: crypto.randomUUID() };
      }
      return (await api.post<QueueItemResponse>(`/accounts/${accountId}/queue`, {
        ...body, idempotencyKey: body.idempotencyKey ?? attempt.current.key,
      })).item;
    },
    onSuccess: () => { attempt.current = null; invalidate(); },
  });
}

export function usePatchQueue(accountId: string | null) {
  const invalidate = useInvalidate(accountId);
  return useMutation({
    mutationFn: async (input: { id: string; patch: PatchQueueRequest }): Promise<QueueItem> =>
      (
        await api.patch<QueueItemResponse>(
          `/accounts/${accountId}/queue/${input.id}`,
          input.patch,
        )
      ).item,
    onSuccess: invalidate,
  });
}

/** `publish-now` / `duplicate` / `approve` / `cancel` の共通形。 */
export function useQueueAction(
  accountId: string | null,
  action: "publish-now" | "duplicate" | "approve" | "cancel",
) {
  const invalidate = useInvalidate(accountId);
  return useMutation({
    mutationFn: async (id: string): Promise<QueueItem> =>
      (await api.post<QueueItemResponse>(`/accounts/${accountId}/queue/${id}/${action}`)).item,
    onSuccess: invalidate,
  });
}

export function useDeleteQueue(accountId: string | null) {
  const invalidate = useInvalidate(accountId);
  return useMutation({
    mutationFn: (id: string) => api.del<{ deleted: boolean }>(`/accounts/${accountId}/queue/${id}`),
    onSuccess: invalidate,
  });
}

/** 手動予約とオートパイロットが共用する、毎日の投稿時刻。 */
export function usePostingSchedule(accountId: string | null) {
  return useQuery({
    queryKey: accountKey(accountId ?? "-", "posting-schedule"),
    enabled: Boolean(accountId),
    queryFn: () => api.get<PostingSchedule>(`/accounts/${accountId}/posting-schedule`),
  });
}

export function usePutPostingSchedule(accountId: string | null) {
  const invalidate = useInvalidate(accountId);
  return useMutation({
    mutationFn: (body: PutPostingScheduleRequest) =>
      api.put<PostingSchedule>(`/accounts/${accountId}/posting-schedule`, body),
    onSuccess: invalidate,
  });
}

export function useQueueSlots(accountId: string | null, date: string | null) {
  return useQuery({
    queryKey: accountKey(accountId ?? "-", "queue-slots", { date }),
    enabled: Boolean(accountId && date),
    staleTime: 15_000,
    refetchInterval: 60_000,
    queryFn: () => api.get<QueueSlotsResponse>(
      `/accounts/${accountId}/queue/slots?date=${encodeURIComponent(date ?? "")}`,
    ),
  });
}
