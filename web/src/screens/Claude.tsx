/**
 * Claude 連携（DECISIONS「Claude 連携」2026-10-20 / 2026-11-01）。設定の「接続とAI」のカードから開く。
 *
 * 1画面だけ。つながる前は claude.ai の「カスタムコネクタを追加」画面を絵で見せ、
 * ①名前 ②MCPサーバーURL をコピーして入れ、③「続ける」→ このアプリの許可画面で「許可する」。
 * claude.ai から initialize が届いたら（`verifiedAt`）つながった表示に切り替わる。
 * つながったあとは、できること・最後に使った日時・[連携を解除] だけ。
 */
import { useState } from "react";
import { motion } from "motion/react";
import { ApiError } from "../api/client";
import { CLAUDE_ADD_CONNECTOR, CLAUDE_CONNECTOR_NAME, useClaudeConnection, useDisconnectClaude } from "../api/claude";
import Sheet from "../components/Sheet";
import { useShell } from "../components/Shell";
import { useToast } from "../components/Toast";
import { CROSSFADE, SPRING, useReducedMotion } from "../lib/motion";
import { mdhm } from "../lib/format";
import "../styles/claude.css";

/** 連携するとできること（実際に動くことだけを書く） */
function CanDo() {
  return (
    <div className="claude-can">
      <ul className="claude-can-list">
        <li>
          <strong>Claude と話しながら投稿を書いて、下書きに入れる</strong>
          <span>文字数・リンクの置き場所・使わない言葉は、このアプリの設定どおりに確かめてから保存します。</span>
        </li>
        <li>
          <strong>まとめて予約する</strong>
          <span>「空いている投稿枠に順に入れて」でも「11/3 の 21:00 に」でも予約できます。予約する前に、Claude が内容と日時を確認します。</span>
        </li>
        <li>
          <strong>直す・取り消す・今すぐ投稿する</strong>
          <span>予約の本文や日時の変更、下書きへの取り消し、失敗した投稿のやり直しもできます。</span>
        </li>
        <li>
          <strong>分析を読んで次の投稿に活かす</strong>
          <span>伸びた投稿や期間の数字を Claude が読み、次に書く投稿の参考にします。</span>
        </li>
      </ul>
      <p className="claude-can-not">
        claude.ai で「来週の投稿を5本書いて、空き枠に予約して」のように頼みます。Claude からはアカウントの接続・設定の変更・退会はできません。ご自身の claude.ai のプランで動くので、AI キーは要りません。
      </p>
    </div>
  );
}

/** claude.ai の「カスタムコネクタを追加」画面の絵（2026-10-20 の実画面に合わせた）。①②③ の印を付ける */
function ClaudeAddMock({ url }: { url: string }) {
  const badge = (n: number) => <span className="claude-badge" aria-hidden="true">{n}</span>;
  return (
    <figure className="claude-figure">
      <div className="claude-mock" aria-hidden="true">
        <div className="claude-mock-bar"><i /><i /><i /><span>claude.ai/customize/connectors</span></div>
        <strong className="claude-mock-title">カスタムコネクタを追加</strong>
        <p className="claude-mock-desc">Claudeをデータやツールに接続します。</p>
        <div className="claude-mock-field is-marked is-filled">
          {badge(1)}
          {CLAUDE_CONNECTOR_NAME}
        </div>
        <p className="claude-mock-help">コネクタの一覧に表示されます。</p>
        <div className="claude-mock-field is-marked is-filled">
          {badge(2)}
          {url}
        </div>
        <p className="claude-mock-help">サーバーがMCPリクエストを受け付けるHTTPSアドレスです</p>
        <div className="claude-mock-actions">
          <span>キャンセル</span>
          <span className="claude-mock-go is-marked">{badge(3)}続ける</span>
        </div>
      </div>
      <figcaption>claude.ai の画面（イメージ）</figcaption>
    </figure>
  );
}

/** つないだあとの「話しかけ方の例」。どれもアカウント名を省けば、Claude が一覧から聞き返す */
const CLAUDE_EXAMPLES = [
  "スレメイトで、朝のルーティンについての投稿を3本作って、空いている枠に予約して",
  "スレメイトで、明日の21時に1本予約したい。テーマは最近読んだ本",
  "スレメイトで、予約中の投稿を一覧で見せて",
  "スレメイトで、先週いちばん伸びた投稿と、その理由を教えて",
];

function CopyRow({ n, label, value, copied, onCopy }: { n: number; label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <li>
      <span className="claude-n" aria-hidden="true">{n}</span>
      <div className="claude-todo-what">
        {label}
        <div className={copied ? "claude-val is-done" : "claude-val"}>
          <code>{value}</code>
          <button type="button" className="btn btn-sub btn-fit" onClick={onCopy}>
            {copied ? "✓ コピー済み" : "コピー"}
          </button>
        </div>
      </div>
    </li>
  );
}

export default function Claude() {
  const { account } = useShell();
  const tz = account?.timezone ?? "Asia/Tokyo";
  const toast = useToast();
  const reduced = useReducedMotion();
  // つながるまでは見張る（claude.ai で「許可する」を押して戻ってきたら、すぐ表示が変わる）
  const conn = useClaudeConnection(true);
  const disconnect = useDisconnectClaude();
  const data = conn.data;
  const [copied, setCopied] = useState<Record<string, boolean>>({});
  const [confirmOff, setConfirmOff] = useState(false);

  async function copy(kind: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied((c) => ({ ...c, [kind]: true }));
      toast.show("コピーしました", "ok");
    } catch {
      toast.show("コピーできませんでした。長押しして選んでください", "bad");
    }
  }

  function runDisconnect() {
    disconnect.mutate(undefined, {
      onSuccess: () => {
        setConfirmOff(false);
        setCopied({ name: false, url: false });
        toast.show("連携を解除しました", "ok");
      },
      onError: (e) => toast.show(e instanceof ApiError ? e.message : "解除できませんでした", "bad"),
    });
  }

  const heading = (
    <div className="page-heading">
      <div>
        <h1>Claude 連携</h1>
        <p className="muted">claude.ai から、このアプリの下書き・予約・投稿と分析を使えるようにします。</p>
      </div>
    </div>
  );

  if (conn.isPending) return <>{heading}<p className="muted">連携の状態を確かめています…</p></>;
  if (conn.isError || !data) {
    return (
      <>
        {heading}
        <p className="msg msg-bad" role="alert">連携の状態を読み込めませんでした。</p>
        <button type="button" className="btn btn-sub btn-fit" onClick={() => void conn.refetch()}>もう一度読み込む</button>
      </>
    );
  }
  if (!data.configured) {
    return (
      <>
        {heading}
        <p className="msg msg-warn">Claude 連携は、管理者による設定待ちです。設定が済むと、ここから連携できるようになります。</p>
        <CanDo />
      </>
    );
  }

  const url = data.mcpUrl;
  const isVerified = Boolean(data.connected && data.verifiedAt);
  const authorized = Boolean(data.connected && data.authorizedAt);

  return (
    <>
      {heading}
      <motion.div
        key={isVerified ? "on" : "off"}
        className="claude-page"
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
        animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
        transition={reduced ? CROSSFADE : SPRING}
      >
        {isVerified ? (
          <section className="card section">
            <div className="claude-connected">
              <span className="claude-check" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9" /></svg>
              </span>
              <div>
                <h2>Claude とつながっています</h2>
                <p className="muted">最後に使った日時: {mdhm(data.verifiedAt!, tz)}</p>
              </div>
            </div>
          </section>
        ) : (
          <section className="card section">
            <div className="section-head">
              <h2>つなぎ方</h2>
              <span className="muted">{authorized ? "あと少し" : "未連携"}</span>
            </div>
            <p className="muted">
              claude.ai の「カスタムコネクタを追加」で、①②に入れて ③「続ける」を押します。続けて開くこのアプリの画面で「許可する」を押すと完了です。
            </p>
            <ClaudeAddMock url={url} />
            <ol className="claude-todo">
              <CopyRow n={1} label="「名前」に入れる" value={CLAUDE_CONNECTOR_NAME} copied={Boolean(copied.name)} onCopy={() => void copy("name", CLAUDE_CONNECTOR_NAME)} />
              <CopyRow n={2} label="「MCPサーバーURL」に入れる" value={url} copied={Boolean(copied.url)} onCopy={() => void copy("url", url)} />
              <li>
                <span className="claude-n" aria-hidden="true">3</span>
                <div className="claude-todo-what">
                  「続ける」を押す
                  <small>このアプリの許可画面が開きます。「許可する」を押してください。</small>
                </div>
              </li>
            </ol>
            <div className="claude-wait" role="status" aria-live="polite">
              <span className="claude-wait-dot" aria-hidden="true" />
              <span>
                {authorized
                  ? "許可を確認しました。claude.ai のタブに戻ると完了します。"
                  : "つながるのを待っています。この画面は開いたままで大丈夫です。"}
              </span>
            </div>
            <a className="btn section" href={CLAUDE_ADD_CONNECTOR} target="_blank" rel="noopener noreferrer">claude.ai を開く</a>
            <p className="claude-note">
              入力画面が開かないとき: claude.ai の左のメニュー「カスタマイズ」→「コネクタ」→「＋ 追加」→「カスタムコネクタを追加」。Free プランで追加できるカスタムコネクタは1つまでです。
              <br />
              許可画面で「ログインしていません」と出たら、同じブラウザでこのアプリにログインしてから、もう一度「許可する」を押してください。
            </p>
          </section>
        )}

        {isVerified && (
          <section className="card section">
            <div className="section-head"><h2>使い方</h2></div>
            <ol className="claude-todo">
              <li>
                <span className="claude-n" aria-hidden="true">1</span>
                <div className="claude-todo-what">
                  Claude で新しいチャットを開く
                  <small>PC の claude.ai でも、スマホの Claude アプリでも使えます。アプリを開いておく必要はありません。</small>
                </div>
              </li>
              <li>
                <span className="claude-n" aria-hidden="true">2</span>
                <div className="claude-todo-what">
                  「スレメイトで」から話しかける
                  <small>入力欄の「＋」→ コネクタで「{CLAUDE_CONNECTOR_NAME}」がオンになっているか確かめてください。</small>
                </div>
              </li>
              <li>
                <span className="claude-n" aria-hidden="true">3</span>
                <div className="claude-todo-what">
                  予約や投稿の前に、Claude が確認してきます
                  <small>「OK」と返すと、このアプリの下書き・予約に入ります（「Claude」の印が付きます）。</small>
                </div>
              </li>
            </ol>
            <h3 className="claude-sub">話しかけ方の例</h3>
            <ul className="claude-examples">
              {CLAUDE_EXAMPLES.map((text, i) => (
                <li key={text}>
                  <div className={copied[`ex${i}`] ? "claude-val is-done" : "claude-val"}>
                    <code>{text}</code>
                    <button type="button" className="btn btn-sub btn-fit" onClick={() => void copy(`ex${i}`, text)}>
                      {copied[`ex${i}`] ? "✓ コピー済み" : "コピー"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <a className="btn section" href="https://claude.ai/new" target="_blank" rel="noopener noreferrer">Claude を開く</a>
          </section>
        )}

        <section className="card section">
          <div className="section-head"><h2>できること</h2></div>
          <CanDo />
        </section>

        {data.connected && (
          <section className="card section">
            <div className="section-head"><h2>連携を解除</h2></div>
            <p className="muted">claude.ai からこのアプリを使えなくなります。予約済みの投稿はそのまま残ります。</p>
            <button type="button" className="btn btn-sub btn-fit section" onClick={() => setConfirmOff(true)}>連携を解除</button>
          </section>
        )}
      </motion.div>

      <Sheet open={confirmOff} onClose={() => setConfirmOff(false)} title="Claude との連携を解除しますか？">
        <p className="muted sheet-text">claude.ai からこのアプリを使えなくなります。claude.ai のコネクタ一覧に残った「{CLAUDE_CONNECTOR_NAME}」は、claude.ai 側で削除してください。</p>
        <div className="sheet-row">
          <button type="button" className="btn btn-sub" onClick={() => setConfirmOff(false)}>やめる</button>
          <button type="button" className="btn" aria-busy={disconnect.isPending} disabled={disconnect.isPending} onClick={runDisconnect}>
            {disconnect.isPending ? "解除しています…" : "解除する"}
          </button>
        </div>
      </Sheet>
    </>
  );
}
