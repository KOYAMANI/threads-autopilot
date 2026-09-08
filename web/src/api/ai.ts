/** AI settings and content API. Credentials are stored only on the server. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AiCandidate,
  AiGenerateRequest,
  AiGenerateResponse,
  AiHistoryTurn,
  AiGenerationContext,
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

/** Compatibility helper: no credentials are ever loaded from browser storage. */
export function withClientKey<T extends object>(_settings: AiSettingsResponse | undefined, body: T): T { return body; }

export function useDeleteAiKey() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => api.del("/ai/settings/key"), onSuccess: () => qc.invalidateQueries() });
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
      acceptDataPolicy: true;
      geminiBillingConfirmed?: boolean;
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
  params: { q: string; sort: PostSort; cursor?: string },
) {
  return useQuery({
    queryKey: accountKey(accountId ?? "-", "post-picker", params),
    enabled: Boolean(accountId),
    queryFn: () =>
      api.get<PostListResponse>(
        `/accounts/${accountId}/posts?q=${encodeURIComponent(params.q)}&sort=${params.sort}&limit=5&cursor=${encodeURIComponent(params.cursor ?? "")}`,
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
      context?: AiGenerationContext;
      clientKey?: string;
    }) => api.post<AiReviseResponse>("/ai/revise", body),
  });
}
