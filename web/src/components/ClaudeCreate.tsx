/**
 * 「Claude で作る」（DECISIONS「Claude 連携」）。作る画面（手順式）に差し込む3つの部品。
 *
 *   useClaudeCreate  セッションの作成と見張り（ポーリング）。手順が変わっても消えないよう、画面の先頭で1回呼ぶ
 *   ClaudeButton     brief 画面の空き枠（.create-ai-slot[data-slot="claude"]）に置くボタン
 *   ClaudeNotice     待っている間・届いたあとの1行（下の帯の上に出す）
 *
 *   押す → 材料を `create_sessions` に保存 → claude.ai を新しいタブで開く
 *   → claude.ai で「作って」→ Claude が save_candidates で書き戻す → ポーリングで取り込む
 *
 * 取り込んだあとも見張り続け、claude.ai で「案Bを短く」のように直した案が届いたら、その案だけ差し替える。
 * まだ届いていないセッションは sessionStorage に持ち、別の画面から戻ってきても見張りを続ける。
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

type Session = { id: string; context: AiGenerationContext; startedAt: number };

type Options = {
  /** いま選んでいるアカウント。無ければボタンは押せない */
  accountId: string | null;
  /** 押した瞬間の材料。`accountId` を含む */
  request: () => ClaudeSessionCreateRequest;
  /** `changed` が無ければ全案を新しく、あればその key の案だけ差し替える */
  onCandidates: (candidates: AiCandidate[], context: AiGenerationContext, changed?: string[]) => void;
};

export type ClaudeCreateState = {
  /** サーバー側の準備（OAUTH_KV）ができているか。できていなければ何も出さない */
  configured: boolean;
  /** claude.ai から許可済みの接続があるか */
  connected: boolean;
  pending: boolean;
  /** 見張っている最中（30分まで） */
  watching: boolean;
  /** 案が届いたあと */
  ready: boolean;
  start: () => void;
  stop: () => void;
};

const fingerprint = (c: AiCandidate) => JSON.stringify([c.hook, c.body, c.comments, c.basis, c.angle ?? ""]);

const storageKey = (accountId: string) => `claude-session:${accountId}`;

function loadSession(accountId: string | null): Session | null {
  if (!accountId) return null;
  try {
    const raw = sessionStorage.getItem(storageKey(accountId));
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (typeof s.id !== "string" || typeof s.startedAt !== "number" || Date.now() - s.startedAt >= WATCH_MS) return null;
    return s;
  } catch {
    return null;
  }
}

function storeSession(accountId: string, s: Session | null) {
  try {
    if (s) sessionStorage.setItem(storageKey(accountId), JSON.stringify(s));
    else sessionStorage.removeItem(storageKey(accountId));
  } catch {
    /* 保存できなくても、この画面にいる間の見張りは動く */
  }
}

export function useClaudeCreate({ accountId, request, onCandidates }: Options): ClaudeCreateState {
  const toast = useToast();
  const connection = useClaudeConnection();
  const create = useCreateClaudeSession();
  const [session, setSession] = useState<Session | null>(() => loadSession(accountId));
  const watching = session !== null && Date.now() - session.startedAt < WATCH_MS;
  const poll = useClaudeSession(watching ? session.id : null);
  const seen = useRef<Map<string, string>>(new Map());
  const deliver = useRef(onCandidates);
  deliver.current = onCandidates;

  // アカウントを切り替えたら、そのアカウントの待ちに乗り換える
  const lastAccount = useRef(accountId);
  useEffect(() => {
    if (lastAccount.current === accountId) return;
    lastAccount.current = accountId;
    seen.current = new Map();
    setSession(loadSession(accountId));
  }, [accountId]);

  useEffect(() => {
    const data = poll.data;
    if (!session || !data || data.id !== session.id || data.candidates.length === 0) return;
    const first = seen.current.size === 0;
    const changed = data.candidates.filter((c) => seen.current.get(c.key) !== fingerprint(c)).map((c) => c.key);
    if (!first && changed.length === 0) return;
    seen.current = new Map(data.candidates.map((c) => [c.key, fingerprint(c)]));
    if (first) {
      // 届いたら保存は要らない（画面を離れたら、直しの見張りはやめる）
      if (accountId) storeSession(accountId, null);
      deliver.current(data.candidates, session.context);
      toast.show(`Claude から${data.candidates.length}案が届きました`, "ok");
    } else {
      deliver.current(data.candidates, session.context, changed);
      toast.show(`Claude が直した案${changed.join("・")}が届きました`, "ok");
    }
  }, [poll.data, session, toast, accountId]);

  function start() {
    if (!accountId) return;
    // ポップアップブロックを避けるため、押した同じ手番でタブだけ先に開く
    const tab = window.open("about:blank", "_blank");
    void connection.refetch();
    const body = request();
    create.mutate(body, {
      onSuccess: (s) => {
        const { accountId: _accountId, ...context } = body;
        seen.current = new Map();
        const next: Session = { id: s.id, context, startedAt: Date.now() };
        setSession(next);
        storeSession(accountId, next);
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

  function stop() {
    setSession(null);
    seen.current = new Map();
    if (accountId) storeSession(accountId, null);
  }

  return {
    configured: !(connection.data && !connection.data.configured),
    connected: Boolean(connection.data?.connected),
    pending: create.isPending,
    watching,
    ready: watching && poll.data?.status === "ready",
    start,
    stop,
  };
}

/** brief 画面の空き枠に置くボタン。サーバー側の準備ができていなければ何も出さない（枠は :empty で畳まれる） */
export function ClaudeButton({ claude, disabled }: { claude: ClaudeCreateState; disabled?: boolean }) {
  if (!claude.configured) return null;
  return (
    <button
      type="button"
      className="btn btn-sub"
      aria-busy={claude.pending}
      disabled={disabled || claude.pending}
      onClick={claude.start}
    >
      {claude.pending ? "Claude に渡しています…" : "Claude で作る"}
    </button>
  );
}

/** 待っている間・届いたあとの1行。見張っていないときは何も出さない */
export function ClaudeNotice({ claude }: { claude: ClaudeCreateState }) {
  if (!claude.configured || !claude.watching) return null;
  // 案が届いた時点で連携は済んでいる（接続状態の読み込みが古くても警告を出さない）
  const notConnected = !claude.ready && !claude.connected;
  return (
    <div className="claude-wait" role="status" aria-live="polite">
      {claude.ready ? (
        <p>
          <strong>Claude の案が届いています。</strong> claude.ai で「案Bを短く」のように頼むと、直した案もここに届きます。
        </p>
      ) : (
        <>
          <p className="claude-wait-line">
            <span className="claude-wait-dot" aria-hidden="true" />
            <span>claude.ai で「作って」と送ってください。案が届くとここに出ます。</span>
          </p>
          <p className="muted">入力欄が空なら「{CLAUDE_PROMPT}」と送ってください。</p>
        </>
      )}
      {notConnected && (
        <p className="msg msg-warn">
          まだ claude.ai と連携していません。<Link to="/app/claude">「Claude 連携」</Link>で先につないでください。
        </p>
      )}
      <button type="button" className="btn-link claude-wait-stop" onClick={claude.stop}>
        {claude.ready ? "見張りをやめる" : "待つのをやめる"}
      </button>
    </div>
  );
}
