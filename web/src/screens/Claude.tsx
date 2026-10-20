/**
 * Claude 連携（DECISIONS「Claude 連携」2026-10-20）。設定の下の独立したメニュー。
 *
 *   intro  連携するとできること → [連携をはじめる]
 *   open   claude.ai の「カスタムコネクタを追加」画面を開く（絵で見せる）
 *   fill   ①名前 ②MCPサーバーURL をコピーして入れ、③「続ける」
 *   allow  このアプリの許可画面で「許可する」。許可・接続を2.5秒ごとに見張る
 *   done   claude.ai から initialize が届いたら自動でここへ（`verifiedAt`）
 *
 * つながったあとは、できること・最後に使った日時・[作る画面で試す][連携を解除] だけの画面。
 * 手順は URL の `?step=` で持ち、ブラウザの戻るで1つ前に戻る（作る画面と同じ）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "motion/react";
import { ApiError } from "../api/client";
import { CLAUDE_ADD_CONNECTOR, CLAUDE_CONNECTOR_NAME, useClaudeConnection, useDisconnectClaude } from "../api/claude";
import Sheet from "../components/Sheet";
import StepHeader from "../components/StepHeader";
import { useShell } from "../components/Shell";
import { useToast } from "../components/Toast";
import { CROSSFADE, SPRING, useReducedMotion } from "../lib/motion";
import { mdhm } from "../lib/format";
import "../styles/claude.css";

type Step = "intro" | "open" | "fill" | "allow" | "done";
const STEPS: Step[] = ["intro", "open", "fill", "allow", "done"];
const isStep = (v: string | null): v is Step => STEPS.includes(v as Step);

/** 連携するとできること・できないこと（実際に動くことだけを書く） */
function CanDo() {
  return (
    <div className="claude-can">
      <ul className="claude-can-list">
        <li>
          <strong>投稿の3案を Claude が作る</strong>
          <span>「作る」画面で見本やリライト元を選んで「Claude で作る」を押すと、claude.ai が3案を作り、この画面に届けます。</span>
        </li>
        <li>
          <strong>claude.ai との会話で案を直す</strong>
          <span>claude.ai で「案Bを短く」のように頼むと、直した案がこの画面で差し替わります。</span>
        </li>
        <li>
          <strong>Claude がバズ診断する</strong>
          <span>claude.ai で「バズ診断して」と頼むと、1行目・本文・締めを100点で採点し、1行目の言い換えを3つ出します。基準はこのアプリの「バズ診断」と同じです。</span>
        </li>
        <li>
          <strong>AI キーが要らない</strong>
          <span>ご自身の claude.ai のプラン（Free・Pro・Max など）で動きます。</span>
        </li>
      </ul>
      <p className="claude-can-not">
        Claude からは投稿・予約・削除・設定の変更はできません。投稿するかどうかは、必ずこのアプリで決めます。オートパイロットは今までどおり、設定で登録した AI キーで動きます。
      </p>
    </div>
  );
}

/** claude.ai の「カスタムコネクタを追加」画面の絵（2026-10-20 の実画面に合わせた）。`marked` で ①②③ を付ける */
function ClaudeAddMock({ marked, url }: { marked: boolean; url: string }) {
  const badge = (n: number) => (marked ? <span className="claude-badge" aria-hidden="true">{n}</span> : null);
  return (
    <figure className="claude-figure">
      <div className="claude-mock" aria-hidden="true">
        <div className="claude-mock-bar"><i /><i /><i /><span>claude.ai/customize/connectors</span></div>
        <strong className="claude-mock-title">カスタムコネクタを追加</strong>
        <p className="claude-mock-desc">Claudeをデータやツールに接続します。</p>
        <div className={marked ? "claude-mock-field is-marked is-filled" : "claude-mock-field"}>
          {badge(1)}
          {marked ? CLAUDE_CONNECTOR_NAME : "名前"}
        </div>
        <p className="claude-mock-help">コネクタの一覧に表示されます。</p>
        <div className={marked ? "claude-mock-field is-marked is-filled" : "claude-mock-field"}>
          {badge(2)}
          {marked ? url : "MCPサーバーURL"}
        </div>
        <p className="claude-mock-help">サーバーがMCPリクエストを受け付けるHTTPSアドレスです</p>
        <div className="claude-mock-actions">
          <span>キャンセル</span>
          <span className={marked ? "claude-mock-go is-marked" : "claude-mock-go"}>{badge(3)}続ける</span>
        </div>
      </div>
      <figcaption>claude.ai の画面（イメージ）</figcaption>
    </figure>
  );
}

/** このアプリの許可画面の絵（worker/src/mcp/consent.ts と同じ文言） */
function ConsentMock({ approved }: { approved: boolean }) {
  return (
    <figure className="claude-figure">
      <div className="claude-consent" aria-hidden="true">
        <strong>Claude と連携しますか？</strong>
        <p>許可すると、Claude がこのアプリの「作る」画面の材料を読み、案を書き戻せるようになります。</p>
        <span className={approved ? "claude-consent-btn" : "claude-consent-btn is-marked"}>
          {!approved && <span className="claude-badge">!</span>}許可する
        </span>
        <span className="claude-consent-btn is-sub">許可しない</span>
      </div>
      <figcaption>このアプリの許可画面（イメージ）</figcaption>
    </figure>
  );
}

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
  const navigate = useNavigate();
  const toast = useToast();
  const reduced = useReducedMotion();
  const [params, setParams] = useSearchParams();
  const rawStep = params.get("step");
  const wizard = isStep(rawStep) && rawStep !== "intro" && rawStep !== "done";

  // 手順の途中（特に許可待ち）だけ見張る
  const conn = useClaudeConnection(wizard);
  const disconnect = useDisconnectClaude();
  const data = conn.data;
  const authorized = Boolean(data?.connected && data.authorizedAt);
  const verified = Boolean(data?.connected && data.verifiedAt);

  const [copied, setCopied] = useState<{ name: boolean; url: boolean }>({ name: false, url: false });
  const [opened, setOpened] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  // いまの手順。URL に無ければ、状態から決める（つながっていれば一覧、そうでなければ「できること」から）
  let step: Step | "status" = isStep(rawStep) ? rawStep : verified ? "status" : "intro";
  if (step === "done" && !verified) step = authorized ? "allow" : "intro";

  // 手順の途中で claude.ai から届いたら、完了の画面へ（履歴は積まない）
  useEffect(() => {
    if (verified && wizard) setParams({ step: "done" }, { replace: true });
  }, [verified, wizard, setParams]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [step]);

  // 進む → 右から、戻る → 左から（作る画面と同じ）
  const order = step === "status" ? 0 : STEPS.indexOf(step);
  const lastOrder = useRef(order);
  const dir = order >= lastOrder.current ? 1 : -1;
  useEffect(() => { lastOrder.current = order; }, [order]);

  function go(next: Step) {
    setParams({ step: next });
  }

  /** 1つ前の手順へ（open の前は「できること」）。履歴は置き換える */
  function back() {
    const i = STEPS.indexOf(step as Step);
    const prev = STEPS[Math.max(0, i - 1)] ?? "intro";
    setParams(prev === "intro" ? {} : { step: prev }, { replace: true });
  }

  async function copy(kind: "name" | "url", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied((c) => ({ ...c, [kind]: true }));
      toast.show("コピーしました", "ok");
    } catch {
      toast.show("コピーできませんでした。長押しして選んでください", "bad");
    }
  }

  function openClaude() {
    window.open(CLAUDE_ADD_CONNECTOR, "_blank", "noopener");
    setOpened(true);
  }

  function runDisconnect() {
    disconnect.mutate(undefined, {
      onSuccess: () => {
        setConfirmOff(false);
        setCopied({ name: false, url: false });
        setOpened(false);
        toast.show("連携を解除しました", "ok");
        setParams({}, { replace: true });
      },
      onError: (e) => toast.show(e instanceof ApiError ? e.message : "解除できませんでした", "bad"),
    });
  }

  if (conn.isPending) return <p className="muted">連携の状態を確かめています…</p>;
  if (conn.isError || !data) {
    return (
      <div className="wizard">
        <h1 className="wizard-title">Claude 連携</h1>
        <p className="msg msg-bad" role="alert">連携の状態を読み込めませんでした。</p>
        <button type="button" className="btn btn-sub btn-fit" onClick={() => void conn.refetch()}>もう一度読み込む</button>
      </div>
    );
  }
  if (!data.configured) {
    return (
      <div className="wizard">
        <h1 className="wizard-title">Claude 連携</h1>
        <p className="wizard-sub">Claude 連携は、管理者による設定待ちです。設定が済むと、ここから連携できるようになります。</p>
        <CanDo />
      </div>
    );
  }

  const url = data.mcpUrl;
  let title = "Claude 連携";
  let body: ReactNode = null;
  let footer: ReactNode = null;
  let progress: string | undefined;

  if (step === "status") {
    body = (
      <>
        <div className="claude-connected">
          <span className="claude-check" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9" /></svg>
          </span>
          <div>
            <h1 className="wizard-title">Claude とつながっています</h1>
            <p className="wizard-sub">最後に使った日時: {mdhm(data.verifiedAt!, tz)}</p>
          </div>
        </div>
        <h2 className="claude-h2">できること</h2>
        <CanDo />
        <p className="wizard-alt">
          <button type="button" className="btn-link" onClick={() => go("open")}>つなぎ直す手順を見る</button>
        </p>
      </>
    );
    footer = (
      <>
        <button type="button" className="btn btn-sub" onClick={() => setConfirmOff(true)}>連携を解除</button>
        <button type="button" className="btn" onClick={() => navigate("/app/create")}>作る画面で試す</button>
      </>
    );
  }

  if (step === "intro") {
    // 許可までは済んで、claude.ai 側がまだ（タブを閉じた等）なら「続きから」
    const pending = authorized && !verified;
    body = (
      <>
        <h1 className="wizard-title">Claude と連携すると、できること</h1>
        <p className="wizard-sub">
          {pending
            ? "あと少しです。許可は済みました。claude.ai のタブに戻ると接続が完了します。"
            : "設定は claude.ai の画面で2か所に入力するだけです。3分ほどで終わります。"}
        </p>
        <CanDo />
      </>
    );
    footer = pending ? (
      <>
        <button type="button" className="btn btn-sub" onClick={() => go("open")}>最初からやり直す</button>
        <button type="button" className="btn" onClick={() => go("allow")}>続きから</button>
      </>
    ) : (
      <button type="button" className="btn" onClick={() => go("open")}>連携をはじめる</button>
    );
  }

  if (step === "open") {
    title = "Claude と連携する";
    progress = "1/3";
    body = (
      <>
        <h1 className="wizard-title">claude.ai の入力画面を開きます</h1>
        <p className="wizard-sub">下のボタンを押すと、claude.ai が新しいタブで開いて、こういう画面が出ます。</p>
        <ClaudeAddMock marked={false} url={url} />
        <p className="claude-note">開いたら、このタブに戻ってきてください。次の画面で、どこに何を入れるかを案内します。</p>
      </>
    );
    footer = opened ? (
      <>
        <button type="button" className="btn btn-sub" onClick={openClaude}>もう一度開く</button>
        <button type="button" className="btn" onClick={() => go("fill")}>開けた</button>
      </>
    ) : (
      <button type="button" className="btn" onClick={openClaude}>claude.ai を開く</button>
    );
  }

  if (step === "fill") {
    title = "Claude と連携する";
    progress = "2/3";
    body = (
      <>
        <h1 className="wizard-title">2か所に入れて「続ける」を押します</h1>
        <p className="wizard-sub">コピーして、claude.ai の画面の同じ番号の場所に貼り付けます。</p>
        <ClaudeAddMock marked url={url} />
        <ol className="claude-todo">
          <CopyRow n={1} label="「名前」に入れる" value={CLAUDE_CONNECTOR_NAME} copied={copied.name} onCopy={() => void copy("name", CLAUDE_CONNECTOR_NAME)} />
          <CopyRow n={2} label="「MCPサーバーURL」に入れる" value={url} copied={copied.url} onCopy={() => void copy("url", url)} />
          <li>
            <span className="claude-n" aria-hidden="true">3</span>
            <div className="claude-todo-what">
              「続ける」を押す
              <small>押すと、このアプリの許可画面が開きます。</small>
            </div>
          </li>
        </ol>
        <p className="claude-note">
          claude.ai の入力画面が開かないとき: claude.ai の左のメニュー「カスタマイズ」→ 上の「コネクタ」→ 右上の「＋ 追加」→「カスタムコネクタを追加」。
          <br />
          Free プランで追加できるカスタムコネクタは1つまでです。
        </p>
      </>
    );
    footer = (
      <button type="button" className="btn" onClick={() => go("allow")}>「続ける」を押した</button>
    );
  }

  if (step === "allow") {
    title = "Claude と連携する";
    progress = "3/3";
    body = (
      <>
        <h1 className="wizard-title">「許可する」を押します</h1>
        <p className="wizard-sub">「続ける」のあとに、このアプリのこういう画面が開きます。「許可する」を押してください。</p>
        <ConsentMock approved={authorized} />
        <ul className="claude-checklist">
          <li className={authorized ? "is-on" : "is-now"}><i aria-hidden="true">{authorized ? "✓" : ""}</i>「許可する」を押す</li>
          <li className={verified ? "is-on" : authorized ? "is-now" : ""}><i aria-hidden="true">{verified ? "✓" : ""}</i>claude.ai に戻る</li>
        </ul>
        <div className="claude-wait claude-wait-line" role="status" aria-live="polite">
          <span className="claude-wait-dot" aria-hidden="true" />
          <span>
            {authorized
              ? "許可を確認しました。claude.ai のタブに戻ると完了します。"
              : "許可されるのを待っています。この画面は開いたままで大丈夫です。"}
          </span>
        </div>
        <p className="claude-note">「ログインしていません」と出たら、同じブラウザでこのアプリにログインしてから、もう一度「許可する」を押してください。</p>
      </>
    );
    footer = (
      <button type="button" className="btn btn-sub" onClick={() => setParams({})}>あとで続ける</button>
    );
  }

  if (step === "done") {
    title = "Claude と連携する";
    body = (
      <div className="claude-done">
        <motion.span
          className="claude-check is-big"
          aria-hidden="true"
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1 }}
          transition={reduced ? CROSSFADE : { type: "spring", bounce: 0.25, duration: 0.45 }}
        >
          <svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9" /></svg>
        </motion.span>
        <h1 className="wizard-title">Claude とつながりました</h1>
        <p className="wizard-sub">「作る」画面で材料を選んで「Claude で作る」を押すと、claude.ai が3案を作って、この画面に届けます。</p>
      </div>
    );
    footer = (
      <>
        <button type="button" className="btn btn-sub" onClick={() => setParams({}, { replace: true })}>閉じる</button>
        <button type="button" className="btn" onClick={() => navigate("/app/create")}>作る画面で試す</button>
      </>
    );
  }

  const inSteps = step === "open" || step === "fill" || step === "allow";

  return (
    <div className="wizard">
      {inSteps && <StepHeader title={title} onBack={back} progress={progress} />}
      <motion.section
        key={step}
        className={`wizard-body claude-${step}`}
        aria-label={title}
        initial={reduced ? { opacity: 0 } : { opacity: 0, x: 16 * dir }}
        animate={reduced ? { opacity: 1 } : { opacity: 1, x: 0 }}
        transition={reduced ? CROSSFADE : SPRING}
      >
        {body}
      </motion.section>
      {footer && <div className="wizard-footer">{footer}</div>}

      <Sheet open={confirmOff} onClose={() => setConfirmOff(false)} title="Claude との連携を解除しますか？">
        <p className="muted sheet-text">claude.ai からこのアプリを使えなくなります。claude.ai のコネクタ一覧に残った「{CLAUDE_CONNECTOR_NAME}」は、claude.ai 側で削除してください。</p>
        <div className="sheet-row">
          <button type="button" className="btn btn-sub" onClick={() => setConfirmOff(false)}>やめる</button>
          <button type="button" className="btn" aria-busy={disconnect.isPending} disabled={disconnect.isPending} onClick={runDisconnect}>
            {disconnect.isPending ? "解除しています…" : "解除する"}
          </button>
        </div>
      </Sheet>
    </div>
  );
}
