/** Claude 連携（MCP。DECISIONS「Claude 連携」）。AI は利用者の claude.ai が動かし、アプリは呼ばれる側。 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClaudeConnectionResponse } from "@tap/shared";
import { api } from "./client";

/**
 * claude.ai の「カスタムコネクタを追加」の入力画面（2026-10-20 に実画面で確認）。
 * 公開された仕様ではないので変わりうる。変わってもコネクタの一覧が開くだけで済む
 */
export const CLAUDE_ADD_CONNECTOR = "https://claude.ai/customize/connectors?modal=add-custom-connector";
/** claude.ai のコネクタ一覧に出る名前（買い手が入れる値） */
export const CLAUDE_CONNECTOR_NAME = "スレメイト";

export const claudeConnectionKey = ["claude", "connection"] as const;

/**
 * `pollUntilConnected` のとき（Claude 連携の画面）は、つながるまで2.5秒ごとに読む。
 * タブが裏にある間（claude.ai を見ている間）は止まり、戻ってきた瞬間に1回読む。
 */
export function useClaudeConnection(pollUntilConnected = false) {
  return useQuery({
    queryKey: claudeConnectionKey,
    queryFn: () => api.get<ClaudeConnectionResponse>("/claude/connection"),
    refetchInterval: (q) => {
      const d = q.state.data;
      return pollUntilConnected && d?.configured && !(d.connected && d.verifiedAt) ? 2500 : false;
    },
    refetchOnWindowFocus: pollUntilConnected ? "always" : true,
  });
}

export function useDisconnectClaude() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del<{ revoked: number }>("/claude/connection"),
    onSuccess: () => qc.invalidateQueries({ queryKey: claudeConnectionKey }),
  });
}
