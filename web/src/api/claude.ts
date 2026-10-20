/** Claude 連携（MCP。DECISIONS「Claude 連携」）。AI は利用者の claude.ai が動かし、アプリは材料と結果を置くだけ。 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClaudeConnectionResponse, ClaudeSessionCreateRequest, ClaudeSessionResponse } from "@tap/shared";
import { api } from "./client";

/** 新しいタブで開く先。`q` は入力欄の下書き（効かない環境でも、ただ開くだけになる） */
export const CLAUDE_NEW_CHAT = "https://claude.ai/new";
export const CLAUDE_PROMPT = "Threads オートパイロットの作成セッションを読んで、3案作って保存して";

export const claudeConnectionKey = ["claude", "connection"] as const;

export function useClaudeConnection() {
  return useQuery({
    queryKey: claudeConnectionKey,
    queryFn: () => api.get<ClaudeConnectionResponse>("/claude/connection"),
  });
}

export function useDisconnectClaude() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del<{ revoked: number }>("/claude/connection"),
    onSuccess: () => qc.invalidateQueries({ queryKey: claudeConnectionKey }),
  });
}

export function useCreateClaudeSession() {
  return useMutation({
    mutationFn: (body: ClaudeSessionCreateRequest) => api.post<ClaudeSessionResponse>("/claude/sessions", body),
  });
}

/**
 * 待機中のポーリング。タブが裏にある間（claude.ai を見ている間）は止まり、
 * 戻ってきた瞬間に1回読む（react-query の既定: `refetchIntervalInBackground=false` と focus 時の再取得）。
 */
export function useClaudeSession(id: string | null) {
  return useQuery({
    queryKey: ["claude", "session", id],
    queryFn: () => api.get<ClaudeSessionResponse>(`/claude/sessions/${encodeURIComponent(id!)}`),
    enabled: id !== null,
    refetchInterval: (q) => (q.state.data?.status === "ready" ? 5000 : 2500),
    refetchOnWindowFocus: "always",
  });
}
