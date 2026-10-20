/**
 * 「Claude で作る」ボタンと待機表示（DECISIONS「Claude 連携」）。Create 画面には差し込むだけ。
 *
 *   押す → 材料を `create_sessions` に保存 → claude.ai を新しいタブで開く
 *   → claude.ai で「作って」→ Claude が save_candidates で書き戻す → ポーリングで取り込む
 *
 * 取り込んだあとも見張り続け、claude.ai で「Bを短く」のように直した案が届いたら、その案だけ差し替える。
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AiCandidate, AiGenerationContext, ClaudeSessionCreateRequest } from "@tap/shared";
import { ApiError } from "../api/client";
import { CLAUDE_NEW_CHAT, CLAUDE_PROMPT, useClaudeConnection, useClaudeSession, useCreateClaudeSession } from "../api/claude";
import { useToast } from "./Toast";
import "../styles/claude.css";

/** これより長く待たせたら見張りをやめる（タブを開きっぱなしにしても叩き続けない） */
const WATCH_MS = 30 * 60_000;

type Props = {
  /** 押した瞬間の材料。`accountId` を含む */
  request: () => ClaudeSessionCreateRequest;
  disabled?: boolean;
  /** `changed` が無ければ全案を新しく、あればその key の案だけ差し替える */
  onCandidates: (candidates: AiCandidate[], context: AiGenerationContext, changed?: string[]) => void;
};

const fingerprint = (c: AiCandidate) => JSON.stringify([c.hook, c.body, c.comments, c.basis, c.angle ?? ""]);

export default function ClaudeCreate({ request, disabled, onCandidates }: Props) {
  const toast = useToast();
  const connection = useClaudeConnection();
  const create = useCreateClaudeSession();
  const [session, setSession] = useState<{ id: string; context: AiGenerationContext; startedAt: number } | null>(null);
  const watching = session !== null && Date.now() - session.startedAt < WATCH_MS;
  const poll = useClaudeSession(watching ? session.id : null);
  const seen = useRef<Map<string, string>>(new Map());
  const deliver = useRef(onCandidates);
  deliver.current = onCandidates;

  useEffect(() => {
    const data = poll.data;
    if (!session || !data || data.id !== session.id || data.candidates.length === 0) return;
    const first = seen.current.size === 0;
    const changed = data.candidates.filter(c => seen.current.get(c.key) !== fingerprint(c)).map(c => c.key);
    if (!first && changed.length === 0) return;
    seen.current = new Map(data.candidates.map(c => [c.key, fingerprint(c)]));
    if (first) {
      deliver.current(data.candidates, session.context);
      toast.show(`Claude から${data.candidates.length}案が届きました`, "ok");
    } else {
      deliver.current(data.candidates, session.context, changed);
      toast.show(`Claude が直した案${changed.join("・")}に差し替えました`, "ok");
    }
  }, [poll.data, session, toast]);

  if (connection.data && !connection.data.configured) return null;

  function start() {
    // ポップアップブロックを避けるため、押した同じ手番でタブだけ先に開く
    const tab = window.open("about:blank", "_blank");
    void connection.refetch();
    const body = request();
    create.mutate(body, {
      onSuccess: (s) => {
        const { accountId: _accountId, ...context } = body;
        seen.current = new Map();
        setSession({ id: s.id, context, startedAt: Date.now() });
        const url = `${CLAUDE_NEW_CHAT}?q=${encodeURIComponent(CLAUDE_PROMPT)}`;
        if (tab) {
          tab.opener = null;
          tab.location.href = url;
        } else {
          window.open(url, "_blank", "noopener");
        }
      },
      onError: (e) => {
        tab?.close();
        toast.show(e instanceof ApiError ? e.message : "Claude に渡す準備ができませんでした", "bad");
      },
    });
  }

  const ready = poll.data?.status === "ready";
  // 案が届いた時点で連携は済んでいる（接続状態の読み込みが古くても警告を出さない）
  const notConnected = !ready && connection.data && !connection.data.connected;

  return (
    <div className="claude-create section">
      <button type="button" className="btn btn-sub" disabled={disabled || create.isPending} onClick={start}>
        {create.isPending ? "Claude に渡しています…" : "Claude で作る"}
      </button>
      {session && watching && (
        <div className="claude-wait" role="status" aria-live="polite">
          {ready ? (
            <p>
              <strong>案が届きました。</strong> claude.ai で「案Bを短く」のように頼むと、直した案もここに届きます。
            </p>
          ) : (
            <>
              <p className="claude-wait-line">
                <span className="claude-wait-dot" aria-hidden="true" />
                claude.ai で「作って」と送ってください。案が届くとここに出ます。
              </p>
              <p className="muted">入力欄が空なら「{CLAUDE_PROMPT}」と送ってください。</p>
            </>
          )}
          {notConnected && (
            <p className="msg msg-warn">
              まだ claude.ai と連携していません。<Link to="/app/settings">設定の「Claude と連携」</Link>で先にコネクタを追加してください。
            </p>
          )}
          <button type="button" className="btn-quiet" onClick={() => setSession(null)}>
            {ready ? "見張りをやめる" : "待つのをやめる"}
          </button>
        </div>
      )}
    </div>
  );
}
