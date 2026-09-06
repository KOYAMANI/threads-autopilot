/**
 * AI と参考情報の React Query フック（SPEC §7.5 / §7.6 / §12.3）。
 * キーは `[accountId, resource, params]`（アカウントに紐づかないものは `["ai"|"sources", …]`）。
 *
 * キーの置き場所（SPEC §12.3 Settings）:
 * - サーバー保存（既定）… `PUT /ai/settings` に `key` を送る。以後 `clientKey` は付けない
 * - この端末にだけ保存  … `localStorage.aiKey` に置き、生成のたびに `clientKey` で送る。
 *   サーバーは保存しないので、オートパイロット（自動生成）は使えない
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AiCandidate,
  AiGenerateRequest,
  AiGenerateResponse,
  AiHistoryTurn,
  AiReviseResponse,
  AiSettingsResponse,
  AiTestResponse,
  CreateSourceRequest,
  PatchSourceRequest,
  PostListResponse,
  SourceListResponse,
  SourceSummary,
} from "@tap/shared";
import { api } from "./client";
import { accountKey } from "./accounts";
import { meKey } from "./auth";

/* ── 端末に置くキー（SPEC §12.3 Settings） ───────────── */

const CLIENT_KEY_STORAGE = "aiKey";

export function readClientKey(): string | null {
  try {
    const v = localStorage.getItem(CLIENT_KEY_STORAGE);
    return v && v.trim() !== "" ? v : null;
  } catch {
    return null;
  }
}

export function writeClientKey(key: string | null): void {
  try {
    if (key === null || key.trim() === "") localStorage.removeItem(CLIENT_KEY_STORAGE);
    else localStorage.setItem(CLIENT_KEY_STORAGE, key.trim());
  } catch {
    // プライベートブラウズ等。保存できなくても画面は動く
  }
}

/** 端末保存モードのときだけ `clientKey` を足す。 */
export function withClientKey<T extends object>(
  settings: AiSettingsResponse | undefined,
  body: T,
): T & { clientKey?: string } {
  if (!settings || settings.storeOnServer) return body;
  const key = readClientKey();
  return key ? { ...body, clientKey: key } : body;
}

/* ── AI 設定（SPEC §7.6） ───────────────────────────── */

export const aiSettingsKey = ["ai", "settings", null] as const;

export function useAiSettings() {
  return useQuery({
    queryKey: aiSettingsKey,
    queryFn: () => api.get<AiSettingsResponse>("/ai/settings"),
  });
}

export function useSaveAiSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      provider: "gemini" | "openrouter";
      key?: string;
      model?: string;
      storeOnServer: boolean;
    }) => api.put<AiSettingsResponse>("/ai/settings", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: aiSettingsKey });
      qc.invalidateQueries({ queryKey: meKey });
    },
  });
}

export function useTestAi() {
  return useMutation({
    mutationFn: (body: { clientKey?: string }) => api.post<AiTestResponse>("/ai/test", body),
  });
}

/* ── 参考情報（SPEC §7.5） ──────────────────────────── */

export const sourcesKey = ["sources", "list", null] as const;

export function useSources() {
  return useQuery({
    queryKey: sourcesKey,
    queryFn: async () => (await api.get<SourceListResponse>("/sources")).sources,
  });
}

export function useCreateSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSourceRequest) =>
      api.post<{ source: SourceSummary }>("/sources", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: sourcesKey }),
  });
}

export function usePatchSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: PatchSourceRequest & { id: string }) =>
      api.patch<{ source: SourceSummary }>(`/sources/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: sourcesKey }),
  });
}

export function useDeleteSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ deleted: true }>(`/sources/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: sourcesKey }),
  });
}

/* ── 過去投稿（箱1の picker。SPEC §7.3） ─────────────── */

export type PostSort = "new" | "views" | "likes" | "clicks";

export function usePostPicker(
  accountId: string | null,
  params: { q: string; sort: PostSort },
) {
  return useQuery({
    queryKey: accountKey(accountId ?? "-", "post-picker", params),
    enabled: Boolean(accountId),
    queryFn: () =>
      api.get<PostListResponse>(
        `/accounts/${accountId}/posts?q=${encodeURIComponent(params.q)}&sort=${params.sort}&limit=30`,
      ),
  });
}

/* ── 生成・修正（SPEC §7.6） ────────────────────────── */

export function useGenerate() {
  return useMutation({
    mutationFn: (body: AiGenerateRequest) => api.post<AiGenerateResponse>("/ai/generate", body),
  });
}

export function useRevise() {
  return useMutation({
    mutationFn: (body: {
      accountId: string;
      candidate: AiCandidate;
      instruction: string;
      history?: AiHistoryTurn[];
      clientKey?: string;
    }) => api.post<AiReviseResponse>("/ai/revise", body),
  });
}
