/**
 * 作る（SPEC §12.3 Create / design-v0.2 §3-4）。
 *
 *   箱1  自分の投稿から（型として使う / リライト元にする）   … components/PostPicker
 *   箱2  参考情報（テキスト / YouTube / ファイル / 記事URL） … components/SourceAdder
 *   指示 → [生成する（3案）] → 結果タブ 案A/B/C
 *   1投稿目とコメントを編集 →「指示で直す」（会話履歴を保持）
 *   [下書き保存] [予約・キューに追加] [今すぐ投稿 ▸ 確認]
 *
 * キー未設定なら生成ボタンの代わりに設定への誘導を出す（design-v0.2 §3-4）。
 * AI credentials are resolved server-side; never load keys from browser storage.
 */
import { useEffect, useMemo, useState, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { AiCandidate, AiHistoryTurn, AiPickMode, AiGenerationContext } from "@tap/shared";
import { useCreateQueue } from "../api/queue";
import { ApiError } from "../api/client";
import { useAiSettings, useGenerate, useRevise, withClientKey } from "../api/ai";
import PostFields, {
  draftIssue,
  emptyDraft,
  trimComments,
  type PostDraft,
} from "../components/PostFields";
import GenerationChat from "../components/GenerationChat";
import PostPicker from "../components/PostPicker";
import ScheduleSheet, { type SchedulePick } from "../components/ScheduleSheet";
import PublishNowSheet from "../components/PublishNowSheet";
import SourceAdder from "../components/SourceAdder";
import { useShell } from "../components/Shell";
import { useToast } from "../components/Toast";
import type { CreatePreset } from "./Home";

/** 生成する案の数（SPEC §7.6）。 */
const N_CANDIDATES = 3;

function draftOf(c: AiCandidate): PostDraft {
  const comments = [...c.comments, "", "", ""].slice(0, 3);
  return { body: c.body, comments };
}

export default function Create() {
  const { account } = useShell();
  const toast = useToast();
  const navigate = useNavigate();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const location = useLocation();
  const preset = (location.state as { preset?: CreatePreset } | null)?.preset ?? null;

  const settings = useAiSettings();
  const generate = useGenerate();
  const revise = useRevise();
  const create = useCreateQueue(account?.id ?? null);

  const [picks, setPicks] = useState<string[]>([]);
  const [pickMode, setPickMode] = useState<AiPickMode>("template");
  const [referenceOrigin, setReferenceOrigin] = useState<"own" | "paste">("own");
  const [referenceText, setReferenceText] = useState("");
  const [analysis, setAnalysis] = useState("");
  const [generationContext, setGenerationContext] = useState<AiGenerationContext>();
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("");

  const [candidates, setCandidates] = useState<AiCandidate[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [conversation, setConversation] = useState<AiHistoryTurn[]>([]);
  const [question, setQuestion] = useState("");
  const generationSequence = useRef(0);
  useEffect(() => {
    generationSequence.current++;
    setConversation([]); setQuestion(""); setNotes([]);
  }, [account?.id, pickMode, referenceOrigin, referenceText, instruction, picks.join("|"), sourceIds.join("|")]);
  const [active, setActive] = useState(0);
  const [draft, setDraft] = useState<PostDraft>(emptyDraft);
  const [reviseText, setReviseText] = useState("");
  /** 案ごとの会話履歴（SPEC §12.3「指示で直す（会話履歴保持）」）。 */
  const [history, setHistory] = useState<Record<string, AiHistoryTurn[]>>({});
  const [sheet, setSheet] = useState(false);
  const [showPublishNow, setShowPublishNow] = useState(false);

  /**
   * ホーム・キューからの下敷き（SPEC §12.3 の `location.state.preset`）。
   * `rewrite` は本文に流し込み、picker のモードと選択にもそのまま反映する。
   * `template` は文体の見本として picker に渡す（本文には入れない）。
   */
  useEffect(() => {
    if (!preset) return;
    setPickMode(preset.mode);
    if (preset.postId) setPicks([preset.postId]);
    if (preset.mode === "rewrite") {
      setDraft((d) => (d.body === "" ? { ...d, body: preset.text } : d));
    }
  }, [preset]);

  const keyReady = useMemo(() => {
    const s = settings.data;
    if (!s || !s.provider) return false;
    return s.storeOnServer && s.hasKey && s.dataPolicyAccepted;
  }, [settings.data]);

  if (!account) return <p className="muted">アカウントがありません。</p>;

  const tz = account.timezone ?? "Asia/Tokyo";
  const busy = generate.isPending || revise.isPending || create.isPending;

  function fail(e: unknown, fallback: string) {
    toast.show(e instanceof ApiError ? e.message : fallback, "bad");
  }

  function pickCandidate(index: number) {
    if (index === active) return;
    const c = candidates[index];
    if (!c) return;
    setCandidates(list => list.map((item, i) => i === active ? { ...item, body: draft.body, comments: trimComments(draft.comments) } : item));
    setActive(index);
    setDraft(draftOf(c));
    setReviseText("");
  }

  function runGenerate(followup?: {answer:string; delegate:boolean}) {
    const sequence = ++generationSequence.current;
    const nextConversation: AiHistoryTurn[] = followup ? [...conversation, {role:"user" as const, text: followup.answer || "残りは全部任せます"}].slice(-8) : [];
    setConversation(nextConversation);
    if (!followup) {setQuestion("");setNotes([]);}
    const context: AiGenerationContext = {
      pickMode, picks: pickMode !== "information" && referenceOrigin === "own" ? picks : [],
      referenceText: referenceOrigin === "paste" ? referenceText : undefined,
      sourceIds, instruction, conversation: nextConversation, clarificationMode: followup?.delegate ? "delegate" : "ask",
    };
    generate.mutate(
      withClientKey(settings.data, {
        accountId: account!.id,
        ...context,
        n: N_CANDIDATES,
      }),
      {
        onSuccess: (r) => {
          if (!mounted.current || sequence !== generationSequence.current) return;
          if (!r.candidates.length) {
            const nextQuestion = r.clarification?.question ?? r.notes?.[0] ?? "どんな投稿にしたいですか？";
            setQuestion(nextQuestion);
            setConversation([...nextConversation, {role:"assistant" as const,text:nextQuestion}].slice(-8));
            setNotes((r.notes ?? []).filter(note => note !== nextQuestion));
            return;
          }
          setQuestion("");
          setGenerationContext(context);
          setAnalysis(r.analysis ?? "");
          setCandidates(r.candidates);
          setNotes(r.notes ?? []);
          setHistory({});
          setActive(0);
          if (r.candidates[0]) setDraft(draftOf(r.candidates[0]));
          if (r.candidates.length) toast.show(`${r.candidates.length}案できました`, "ok");
        },
        onError: (e) => { if (sequence === generationSequence.current) { if (followup) setConversation(conversation); fail(e, "生成できませんでした"); } },
      },
    );
  }

  function runRevise() {
    const current = candidates[active];
    if (!current || reviseText.trim() === "") return;
    // 画面で直した本文をそのまま渡す（AI に「いまの姿」を見せる）
    const base: AiCandidate = {
      ...current,
      body: draft.body,
      comments: trimComments(draft.comments),
    };
    const turns = history[current.key] ?? [];

    revise.mutate(
      withClientKey(settings.data, {
        accountId: account!.id,
        candidate: base,
        instruction: reviseText,
        history: turns,
        context: generationContext,
      }),
      {
        onSuccess: (r) => {
          if (!mounted.current) return;
          const next = r.candidate;
          setCandidates((list) => list.map((c, i) => (i === active ? next : c)));
          setDraft(draftOf(next));
          setHistory((h) => ({
            ...h,
            [current.key]: [
              ...turns,
              { role: "user", text: reviseText },
              { role: "assistant", text: next.body },
            ],
          }));
          setReviseText("");
          toast.show("直しました", "ok");
        },
        onError: (e) => fail(e, "直せませんでした"),
      },
    );
  }

  function guard(): boolean {
    const issue = draftIssue(draft);
    if (issue) {
      toast.show(issue, "bad");
      return false;
    }
    return true;
  }

  /**
   * 生成に使った材料を、あとで辿れるようにキューへ持たせる（SPEC §7.4）。
   * `originPostId` は選んだ投稿の先頭（オートパイロットの §9.4-5「文体見本の先頭」と同じ）。
   * 型・リライトのどちらでも同じ意味で入れる。
   */
  function provenance() {
    return { originPostId: generationContext?.picks?.[0] ?? null, sourceIds: generationContext?.sourceIds ?? sourceIds };
  }

  function saveDraft() {
    if (!guard()) return;
    create.mutate(
      {
        status: "draft",
        body: draft.body,
        comments: trimComments(draft.comments),
        ...provenance(),
      },
      {
        onSuccess: () => {
          if (!mounted.current) return;
          toast.show("下書きに保存しました", "ok");
          navigate("/app/queue");
        },
        onError: (e) => fail(e, "保存できませんでした"),
      },
    );
  }

  function enqueue(pick: SchedulePick | { kind: "now" }) {
    if (!account?.canPublish) { toast.show("設定でThreads APIを連携してください", "bad"); return; }
    if (!guard()) return;
    const common = {
      body: draft.body,
      comments: trimComments(draft.comments),
      ...provenance(),
    };
    create.mutate(
      pick.kind === "now"
        ? { status: "now", ...common }
        : pick.kind === "next_slot"
          ? { status: "next_slot", ...common }
          : { status: "scheduled", scheduledAt: pick.at ?? undefined, ...common },
      {
        onSuccess: () => {
          if (!mounted.current) return;
          setSheet(false);
          setShowPublishNow(false);
          toast.show(pick.kind === "now" ? "投稿を受け付けました。下書き・予約で進行状況を確認できます" : "予約しました", "ok");
          navigate("/app/queue");
        },
        onError: (e) => fail(e, "キューに入れられませんでした"),
      },
    );
  }

  const turns = candidates[active] ? (history[candidates[active]!.key] ?? []) : [];

  return (
    <>
      <div className="create-heading"><div><p className="eyebrow">POST STUDIO</p><h1>投稿を作る</h1><p className="muted">型と情報を分けて、選べる3案に。</p></div><span className="studio-account">@{account.username}</span></div>
      <section className="creation-modes" role="radiogroup" aria-label="投稿の作り方">
        {([
          ["template", "型を参考に作る", "自分・他人の投稿を分析し、新しい内容に転用"],
          ["rewrite", "リライト", "内容・数字・評価を残して、見せ方を変える"],
        ] as const).map(([mode, title, note]) => <button key={mode} type="button" className="choice" role="radio" aria-checked={pickMode === mode} disabled={busy} onClick={() => { setPickMode(mode); if (mode === "rewrite") { setPicks(picks.slice(0, 1)); } }}><span className="choice-title">{title}</span><span className="choice-note">{note}</span></button>)}
      </section>
      <div className="create-workspace">
      <div className="create-inputs">
      {pickMode !== "information" && <section className="card section">
        <div className="section-head"><h2>{pickMode === "rewrite" ? "リライトする投稿" : "型・文体の参考"}</h2><span className="step-label">01</span></div>
        {<><p className="muted section">{pickMode === "template" ? "導入・順位や対比・続きへの引き・文体を分析します。内容は下の参考情報から入れます。" : "自分の投稿を選ぶか、他人の投稿を続きまで貼り付けてください。追加する情報は下で指定できます。"}</p><div className="chips section" role="group" aria-label="参考投稿の入力方法"><button type="button" className="chip" aria-pressed={referenceOrigin === "own"} onClick={() => setReferenceOrigin("own")}>自分の投稿</button><button type="button" className="chip" aria-pressed={referenceOrigin === "paste"} onClick={() => setReferenceOrigin("paste")}>他人の投稿・貼り付け</button></div></>}
        <div className="section">{referenceOrigin === "own" ? <PostPicker accountId={account.id} tz={tz} picks={picks} pickMode={pickMode} onChange={next => setPicks(next.picks)} /> : <label className="field" htmlFor="reference-post"><span>参考投稿のツリー全体</span><textarea id="reference-post" className="input reference-input" rows={8} maxLength={20000} value={referenceText} onChange={e => setReferenceText(e.target.value)} placeholder={"1投稿目から本人の続きまで、そのまま貼り付けてOK。\n\n【1投稿目】\n…\n【続き】\n…"} /><span className="muted">本文と続きの境目がわかる形がおすすめです。{referenceText.length.toLocaleString()} / 20,000文字</span></label>}</div>
      </section>}
      <SourceAdder selected={sourceIds} onChange={setSourceIds} />
      <section className="card section">
        <h2>テーマ・伝えたいこと</h2>
        <label className="field" htmlFor="create-instruction">
          <span>{pickMode === "rewrite" ? "どう変えたいか（任意）" : "誰に、何を伝えるか"}</span>
          <textarea
            id="create-instruction"
            className="input"
            rows={3}
            value={instruction}
            placeholder={pickMode === "rewrite" ? "例: 評価や数字はそのままに、説明を読みやすく。" : "例: 初めて講座を作る人向け。参考情報の優先順位を、選んだ投稿の型で紹介したい。"}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </label>

        {settings.isPending ? (
          <p className="muted section">読み込んでいます…</p>
        ) : keyReady ? (
          <button
            type="button"
            className="btn section"
            disabled={busy || (referenceOrigin === "own" ? (pickMode === "rewrite" ? picks.length !== 1 : !picks.length) : !referenceText.trim())}
            onClick={() => runGenerate()}
          >
            {generate.isPending ? "構成を分析して、3つの切り口で書いています…" : `生成する（${N_CANDIDATES}案）`}
          </button>
        ) : (
          <div className="msg msg-warn section" role="status">
            <p>{settings.data?.hasKey ? "AIの送信先と利用条件の確認が必要です。設定で確認して保存してください。" : "AIキーがまだ設定されていません。"}</p>
            <button
              type="button"
              className="btn section"
              onClick={() => navigate("/app/settings")}
            >
              AI設定を確認する
            </button>
          </div>
        )}

        {question && <GenerationChat messages={conversation} busy={busy} onContinue={(answer, delegate) => runGenerate({answer,delegate})} />}
        {notes.map((n) => (
          <p className="msg msg-warn section" key={n} role="status">
            {n}
          </p>
        ))}
      </section>

      </div>
      <div className="create-output">
      {analysis && <details className="card section analysis-card"><summary>参考の分析・使い方</summary><p className="section" style={{ whiteSpace: "pre-wrap" }}>{analysis}</p></details>}
      {candidates.length > 0 && (
        <section className="card section">
          <div className="section-head">
            <h2>候補を選んで仕上げる</h2>
            <span className="muted">{candidates[active]?.hook}</span>
          </div>

          <div
            className="candidate-options"
            role="group"
            aria-label="見る案"
            style={{ marginTop: "var(--sp)" }}
          >
            {candidates.map((c, i) => (
              <button
                key={c.key}
                type="button"
                className="candidate-option"
                aria-pressed={i === active}
                onClick={() => pickCandidate(i)}
              >
                <strong>案{c.key} · {c.angle ?? c.hook}</strong><span>{c.body.split("\n")[0]}</span>
              </button>
            ))}
          </div>

          {candidates[active]?.basis && (
            <p className="muted section">根拠: {candidates[active]!.basis}</p>
          )}

          <PostFields draft={draft} onChange={setDraft} idPrefix="create" compact />

          <label className="field" htmlFor="create-revise">
            <span>指示で直す{turns.length > 0 ? `（${turns.length / 2}回目）` : ""}</span>
            <textarea
              id="create-revise"
              className="input"
              rows={2}
              value={reviseText}
              placeholder="例: 1行目をもっと短く。数字を入れる"
              onChange={(e) => setReviseText(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-sub section"
            disabled={busy || reviseText.trim() === ""}
            onClick={runRevise}
          >
            {revise.isPending ? "直しています…" : "この指示で直す"}
          </button>
        </section>
      )}

      {candidates.length === 0 && (
        <section className="card section">
          <h2>下書き・プレビュー</h2>
          <p className="muted" style={{ marginTop: "0.25rem" }}>
            生成した3案をここで比較・編集できます。直接書き始めてもOKです。
          </p>
          <PostFields draft={draft} onChange={setDraft} idPrefix="create" compact />
        </section>
      )}

      <div className="section">
        <div className="create-publish-actions">
          <button type="button" className="btn btn-sub" disabled={busy} onClick={saveDraft}>下書き保存</button>
          <button type="button" className="btn" disabled={busy || !account.canPublish} onClick={() => { if (guard()) setSheet(true); }}>予約・キューに追加</button>
          <button type="button" className="btn btn-sub" disabled={busy || !account.canPublish} onClick={() => { if (guard()) setShowPublishNow(true); }}>今すぐ投稿</button>
        </div>
        {!account.canPublish && <p className="msg msg-warn section">予約・投稿するには設定でThreads APIを連携してください。下書きは保存できます。</p>}
      </div>

      </div>
      </div>
      <PublishNowSheet
        open={showPublishNow}
        onClose={() => setShowPublishNow(false)}
        onConfirm={() => enqueue({ kind: "now" })}
        username={account.username}
        body={draft.body}
        comments={trimComments(draft.comments)}
        canPublish={account.canPublish === true}
        busy={create.isPending}
      />
      <ScheduleSheet
        open={sheet}
        onClose={() => setSheet(false)}
        onPick={enqueue}
        accountId={account.id}
        tz={tz}
        confirmLabel="この日時で予約する"
        busy={create.isPending}
      />
    </>
  );
}
