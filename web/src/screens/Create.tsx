/**
 * 作る（SPEC §12.3 Create / design-v0.2 §3-4）。DECISIONS 2026-10-19（4回目）で「1画面1動作」の手順にした。
 *
 *   start      どう作りますか？ … 伸びた投稿の型で作る / 前の投稿をリライト / 自分で書く
 *   pick       見本（最大3本）・リライト元（1本）を選ぶ。行を押すと全文（PostViewer）→「この投稿を選ぶ」
 *              いちばん下の「他人の投稿を貼り付ける」で、一覧が貼り付け欄に替わる
 *   brief      誰に、何を伝えるか / どう変えるか（＋材料はシートで任意）→ [AIで3案つくる][Claude の空き枠]
 *   candidates 3案を左右にスライドして1つ選ぶ（根拠・分析は出さない）
 *   edit       仕上げる。[AIで直す][下書きに保存][予約・投稿する ▸ 今すぐ / 日時指定 / おすすめ枠]
 *
 * 手順は URL（`?step=&mode=`）で持ち、ブラウザの戻るで1つ前に戻る。入力・案・本文は画面の state に
 * 残すので、戻っても消えない。トークン切れ・AIキー未登録の案内は常駐させず、要る瞬間にシートで出す。
 * AI credentials are resolved server-side; never load keys from browser storage.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "motion/react";
import type { AiCandidate, AiGenerationContext, AiHistoryTurn, AiPickMode, PostSummary } from "@tap/shared";
import { useCreateQueue } from "../api/queue";
import { ApiError } from "../api/client";
import { useAiSettings, useGenerate, useRevise, withClientKey } from "../api/ai";
import { draftIssue, emptyDraft, trimComments, type PostDraft } from "../components/PostFields";
import PostPicker from "../components/PostPicker";
import PostViewer from "../components/PostViewer";
import ScheduleSheet, { type SchedulePick } from "../components/ScheduleSheet";
import Sheet from "../components/Sheet";
import SourceAdder from "../components/SourceAdder";
import { useShell } from "../components/Shell";
import { useToast } from "../components/Toast";
import PublishNotice, { publishBlock } from "../components/PublishNotice";
import Composer from "../components/Composer";
import StepHeader from "../components/StepHeader";
import CandidateCarousel from "../components/CandidateCarousel";
import ReviseSheet from "../components/ReviseSheet";
import { CROSSFADE, SPRING, useReducedMotion } from "../lib/motion";
import { fmtN, mdhm } from "../lib/format";
import type { CreatePreset } from "./Home";

/** 生成する案の数（SPEC §7.6）。 */
const N_CANDIDATES = 3;

/** 「直す」ですぐ押せる言い方（Buffer の Shorten / More Casual にあたる）。見せる言葉と、AI に渡す指示。 */
const QUICK_REVISES: Array<[string, string]> = [
  ["1行目を短く", "1行目をもっと短く、続きを読みたくなる形にしてください。"],
  ["数字を入れる", "具体的な数字を入れて、説得力を上げてください。"],
  ["もっとくだけて", "もっとくだけた、話しかけるような口調にしてください。"],
  ["もっと丁寧に", "もっと丁寧な口調にしてください。"],
];

type Step = "start" | "pick" | "brief" | "candidates" | "edit";
type Mode = "template" | "rewrite" | "write";

const STEPS: Step[] = ["start", "pick", "brief", "candidates", "edit"];
const isStep = (v: string | null): v is Step => STEPS.includes(v as Step);
const isMode = (v: string | null): v is Mode => v === "template" || v === "rewrite" || v === "write";

// 入口は2つ（DECISIONS 2026-10-20）。リライトはホーム・キューの「リライト」から preset で入る
const START_CHOICES: Array<{ mode: Mode; title: string; note: string }> = [
  { mode: "template", title: "型を選んで作る", note: "見本を1〜3本選ぶと、同じ書き方で AI が3案" },
  { mode: "write", title: "自分で書く", note: "白紙から。あとで AI に直させることもできます" },
];

/** 貼り付けの上限（SPEC §7.6 の referenceText）。 */
const MAX_REFERENCE = 20000;

type SheetKind = "aikey" | "sources" | "replace" | "revise" | "publish" | "schedule";

function draftOf(c: AiCandidate): PostDraft {
  const comments = [...c.comments, "", "", ""].slice(0, 3);
  return { body: c.body, comments };
}

/** React Router が history.state に持たせている通し番号（戻る先が作る画面の中かを見分ける）。 */
function historyIdx(): number | undefined {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" ? idx : undefined;
}

function urlFor(step: Step, mode: Mode): Record<string, string> {
  return step === "start" ? { step } : { step, mode };
}

export default function Create() {
  const { account } = useShell();
  const toast = useToast();
  const navigate = useNavigate();
  const reduced = useReducedMotion();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const location = useLocation();
  // ホーム・キューからの下敷き（SPEC §12.3 の `location.state.preset`）。URL を書き換えると state は消えるので、最初に取っておく
  const [initial] = useState(() => (location.state as { preset?: CreatePreset } | null)?.preset ?? null);
  const presetPending = useRef(Boolean(initial));
  const [params, setParams] = useSearchParams();
  const entryIdx = useRef(historyIdx());

  const settings = useAiSettings();
  const generate = useGenerate();
  const revise = useRevise();
  const create = useCreateQueue(account?.id ?? null);

  /** いま進めている作り方（start に戻っても覚えておき、同じ作り方なら入力を残す）。 */
  const [workMode, setWorkMode] = useState<Mode | null>(initial?.mode ?? null);
  const [picks, setPicks] = useState<string[]>(() => (initial?.postId ? [initial.postId] : []));
  /** 選んだ投稿の本文（brief の「見本」帯に出す）。 */
  const [pickedText, setPickedText] = useState<Record<string, string>>(() =>
    initial?.postId ? { [initial.postId]: initial.text } : {},
  );
  const [referenceOrigin, setReferenceOrigin] = useState<"own" | "paste">("own");
  const [referenceText, setReferenceText] = useState("");
  const [generationContext, setGenerationContext] = useState<AiGenerationContext>();
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("");

  const [candidates, setCandidates] = useState<AiCandidate[]>([]);
  /** カルーセルでいま見えている案。 */
  const [shown, setShown] = useState(0);
  /** エディタに入れた案（-1 = 入れていない。自分で書いた本文）。 */
  const [active, setActive] = useState(-1);
  // リライトの下敷きは本文に流し込んでおく（型の見本は本文に入れない）
  const [draft, setDraft] = useState<PostDraft>(() =>
    initial?.mode === "rewrite" ? { ...emptyDraft(), body: initial.text } : emptyDraft(),
  );
  const [reviseText, setReviseText] = useState("");
  /** 案ごとの会話履歴（SPEC §12.3「指示で直す（会話履歴保持）」）。自分で書いた本文は "own"。 */
  const [history, setHistory] = useState<Record<string, AiHistoryTurn[]>>({});
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  /** 全文を開いている投稿（pick）。閉じる動きの間も中身を残すため、開閉とは分けて持つ。 */
  const [viewerPost, setViewerPost] = useState<PostSummary | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  /** 最後に案や AI の直しで入れた本文。これと違えば、人が書き足した「書きかけ」とみなす。 */
  const appliedBody = useRef(initial?.mode === "rewrite" ? initial.text : "");

  /* ── いまの手順（URL → 足りない入力があれば手前に戻す） ── */
  const rawStep = params.get("step");
  const rawMode = params.get("mode");
  const fromPreset = presetPending.current && initial !== null && rawStep === null;
  let mode: Mode = isMode(rawMode) ? rawMode : fromPreset ? initial!.mode : "write";
  let step: Step = isStep(rawStep) ? rawStep : fromPreset ? "brief" : "start";
  const hasReference = referenceOrigin === "paste" ? referenceText.trim() !== "" : picks.length > 0;
  if (step !== "start" && step !== "edit" && mode === "write") step = "start";
  if (step === "candidates" && candidates.length === 0) step = "brief";
  if (step === "brief" && !hasReference) step = "pick";
  if (step === "start") mode = workMode ?? "write";
  const rewrite = mode === "rewrite";
  const pickMode: AiPickMode = rewrite ? "rewrite" : "template";

  // 足りない入力で開かれた手順や、ホームからの下敷きは URL を置き換えてそろえる（履歴は積まない）
  const needsUrl = rawStep !== null || fromPreset;
  useEffect(() => {
    if (!needsUrl) return;
    presetPending.current = false;
    const want = urlFor(step, mode);
    if (rawStep === want.step && rawMode === (want.mode ?? null)) return;
    setParams(want, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, mode, needsUrl, rawStep, rawMode]);

  // 手順が変わったら、新しい画面を上から見せる
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [step]);

  // 手順の向き（進む → 右から、戻る → 左から）。動かすのは transform と opacity だけ
  const order = STEPS.indexOf(step);
  const lastOrder = useRef(order);
  const dir = order >= lastOrder.current ? 1 : -1;
  useEffect(() => { lastOrder.current = order; }, [order]);

  const keyReady = useMemo(() => {
    const s = settings.data;
    if (!s || !s.provider) return false;
    return s.storeOnServer && s.hasKey;
  }, [settings.data]);
  const aiBlocked = !settings.isPending && !keyReady;

  // トークンを延長できたら、そのまま日時を選ぶシートへ進める
  useEffect(() => {
    if (sheet === "publish" && account?.canPublish) setSheet("schedule");
  }, [sheet, account?.canPublish]);

  if (!account) return <p className="muted">アカウントがありません。</p>;

  const tz = account.timezone ?? "Asia/Tokyo";
  const busy = generate.isPending || revise.isPending || create.isPending;
  const bodyEmpty = draft.body.trim() === "";

  function go(next: Step, nextMode: Mode = mode, replace = false) {
    setParams(urlFor(next, nextMode), { replace });
  }

  /** 戻る: 作る画面の中で進んできたならブラウザの戻ると同じ。そうでなければ1つ手前の手順に置き換える。 */
  function back() {
    const idx = historyIdx();
    if (idx !== undefined && entryIdx.current !== undefined && idx > entryIdx.current) {
      navigate(-1);
      return;
    }
    go(mode === "write" ? "start" : (STEPS[Math.max(0, order - 1)] ?? "start"), mode, true);
  }

  function fail(e: unknown, fallback: string) {
    toast.show(e instanceof ApiError ? e.message : fallback, "bad");
  }

  function choose(next: Mode) {
    if (next !== "write" && aiBlocked) {
      setSheet("aikey");
      return;
    }
    if (next === "write") {
      // 案を入れていた本文は白紙に戻す。自分で書いていた続きなら残す
      if (workMode !== "write") {
        setDraft(emptyDraft());
        setActive(-1);
        appliedBody.current = "";
      }
      setWorkMode("write");
      go("edit", "write");
      return;
    }
    if (workMode !== next) {
      setPicks([]);
      setInstruction("");
      setReferenceOrigin("own");
      setReferenceText("");
    }
    setWorkMode(next);
    go("pick", next);
  }

  function openPost(p: PostSummary) {
    setViewerPost(p);
    setViewerOpen(true);
  }

  function togglePick(p: PostSummary) {
    const has = picks.includes(p.id);
    const next = rewrite
      ? (has ? [] : [p.id])
      : has ? picks.filter((x) => x !== p.id) : [...picks, p.id].slice(0, 3);
    setPicks(next);
    setPickedText((t) => ({ ...t, [p.id]: p.text }));
    setViewerOpen(false);
  }

  function startGenerate() {
    if (aiBlocked) {
      setSheet("aikey");
      return;
    }
    runGenerate();
  }

  function runGenerate() {
    const context: AiGenerationContext = {
      pickMode, picks: referenceOrigin === "own" ? picks : [],
      referenceText: referenceOrigin === "paste" ? referenceText : undefined,
      sourceIds, instruction,
    };
    generate.mutate(
      withClientKey(settings.data, {
        accountId: account!.id,
        ...context,
        n: N_CANDIDATES,
      }),
      {
        onSuccess: (r) => {
          if (!mounted.current) return;
          if (!r.candidates.length) {
            // 0件のときだけ、サーバーの理由をトーストで出す（画面には常駐させない）
            toast.show(r.notes?.length ? r.notes.join(" ") : "案を作れませんでした。指示を変えて、もう一度試してください", "bad");
            return;
          }
          setGenerationContext(context);
          setCandidates(r.candidates);
          setHistory({});
          setActive(-1);
          setShown(0);
          go("candidates");
        },
        onError: (e) => fail(e, "生成できませんでした"),
      },
    );
  }

  function applyCandidate(index: number, force = false) {
    const c = candidates[index];
    if (!c) return;
    // 仕上げる画面で書き足した本文があれば、消す前に一度止める
    const dirty = !bodyEmpty && draft.body !== appliedBody.current;
    if (dirty && !force) {
      setSheet("replace");
      return;
    }
    setSheet(null);
    setActive(index);
    setDraft(draftOf(c));
    appliedBody.current = c.body;
    setReviseText("");
    toast.show(`案${c.key}を入れました`, "ok");
    go("edit");
  }

  function openRevise() {
    if (aiBlocked) { setSheet("aikey"); return; }
    if (bodyEmpty) { toast.show("直す本文がまだありません", "info"); return; }
    setSheet("revise");
  }

  function runRevise(text = reviseText) {
    if (bodyEmpty || text.trim() === "") return;
    // 画面で直した本文をそのまま渡す（AI に「いまの姿」を見せる）。案を入れていなければ自分の本文として渡す
    const current = active >= 0 ? candidates[active] : undefined;
    const key = current?.key ?? "own";
    const base: AiCandidate = {
      key,
      hook: current?.hook ?? "",
      basis: current?.basis ?? "",
      ...(current?.angle ? { angle: current.angle } : {}),
      body: draft.body,
      comments: trimComments(draft.comments),
    };
    const turns = history[key] ?? [];

    revise.mutate(
      withClientKey(settings.data, {
        accountId: account!.id,
        candidate: base,
        instruction: text,
        history: turns,
        ...(current ? { context: generationContext } : {}),
      }),
      {
        onSuccess: (r) => {
          if (!mounted.current) return;
          const next = r.candidate;
          if (current) setCandidates((list) => list.map((c, i) => (i === active ? next : c)));
          setDraft(draftOf(next));
          appliedBody.current = next.body;
          setHistory((h) => ({
            ...h,
            [key]: [
              ...turns,
              { role: "user", text },
              { role: "assistant", text: next.body },
            ],
          }));
          setReviseText("");
          setSheet(null);
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

  function openPublish() {
    if (!guard()) return;
    setSheet(account!.canPublish ? "schedule" : "publish");
  }

  function enqueue(pick: SchedulePick) {
    if (!account?.canPublish) { setSheet("publish"); return; }
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
          setSheet(null);
          toast.show(pick.kind === "now" ? "次の実行で出します" : "予約しました", "ok");
          navigate("/app/queue");
        },
        onError: (e) => fail(e, "予約・投稿できませんでした"),
      },
    );
  }

  const turns = history[active >= 0 ? (candidates[active]?.key ?? "own") : "own"] ?? [];

  /* ── 手順ごとの中身と下の帯 ── */
  let title = "投稿をつくる";
  let body: ReactNode = null;
  let footer: ReactNode = null;
  let footerClass = "wizard-footer";

  if (step === "start") {
    body = (
      <>
        <h1 className="wizard-title">どう作りますか？</h1>
        <p className="wizard-sub">あとから変えられます。</p>
        <div className="start-choices">
          {START_CHOICES.map((c) => (
            <button key={c.mode} type="button" className="start-choice" onClick={() => choose(c.mode)}>
              <strong>{c.title}</strong>
              <span>{c.note}</span>
            </button>
          ))}
        </div>
      </>
    );
  }

  if (step === "pick") {
    title = rewrite ? "リライト" : "型で作る";
    body = (
      <>
        <h1 className="wizard-title">{rewrite ? "リライトする投稿を選ぶ" : "見本にする投稿を選ぶ"}</h1>
        <p className="wizard-sub">{rewrite ? "1本だけ。" : "最大3本。表示回数の多い順です。"}</p>
        {/* 上で出どころを切り替え、下に中身（DECISIONS 2026-10-20） */}
        <div className="pick-source" role="tablist" aria-label="見本の出どころ">
          <button
            type="button"
            role="tab"
            aria-selected={referenceOrigin === "own"}
            onClick={() => setReferenceOrigin("own")}
          >
            自分の投稿
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={referenceOrigin === "paste"}
            onClick={() => setReferenceOrigin("paste")}
          >
            他人の投稿を貼る
            {referenceText.trim() !== "" && <span className="pick-source-dot" role="img" aria-label="貼り付け済み" />}
          </button>
        </div>
        {referenceOrigin === "own" ? (
          <PostPicker
            minimal
            accountId={account.id}
            tz={tz}
            picks={picks}
            pickMode={pickMode}
            onChange={(next) => setPicks(next.picks)}
            onOpen={openPost}
          />
        ) : (
          <label className="field wizard-field" htmlFor="reference-post">
            <span className="visually-hidden">貼り付ける投稿</span>
            <textarea
              id="reference-post"
              className="input wizard-textarea"
              rows={8}
              maxLength={MAX_REFERENCE}
              value={referenceText}
              autoFocus
              placeholder="他人の投稿を、続きまでそのまま貼り付け"
              onChange={(e) => setReferenceText(e.target.value)}
            />
            <span className="wizard-count num">{referenceText.length.toLocaleString("ja-JP")} / 20,000文字</span>
          </label>
        )}
      </>
    );
    footer = (
      <>
        {referenceOrigin === "own" && picks.length > 0 && (
          <span className="wizard-picked num">{rewrite ? "1本 選択中" : `${picks.length}/3本 選択中`}</span>
        )}
        <button type="button" className="btn" disabled={!hasReference} onClick={() => go("brief")}>
          次へ
        </button>
        {!hasReference && (
          <p className="btn-hint">
            {referenceOrigin === "paste" ? "投稿を貼り付けると押せます。" : rewrite ? "投稿を1本選ぶと押せます。" : "投稿を選ぶと押せます。"}
          </p>
        )}
      </>
    );
  }

  if (step === "brief") {
    title = rewrite ? "リライト" : "型で作る";
    const first = picks[0];
    const pickedLabel = referenceOrigin === "paste" ? "貼り付けた投稿" : rewrite ? "元の投稿" : "見本";
    const pickedBody = referenceOrigin === "paste" ? referenceText.trim() : (first && pickedText[first]) || "選んだ投稿";
    body = (
      <>
        <h1 className="wizard-title">{rewrite ? "どう変えますか？" : "誰に、何を伝えますか？"}</h1>
        <p className="wizard-sub">{rewrite ? "空のままでも大丈夫です。" : "1〜2行で十分です。"}</p>
        <div className="picked">
          <span>{pickedLabel}</span>
          <strong>{pickedBody}</strong>
          {referenceOrigin === "own" && picks.length > 1 && <span className="picked-more">ほか{picks.length - 1}本</span>}
        </div>
        <label className="field wizard-field" htmlFor="create-instruction">
          <span className="visually-hidden">{rewrite ? "どう変えたいか" : "誰に、何を伝えるか"}</span>
          <textarea
            id="create-instruction"
            className="input wizard-textarea"
            rows={5}
            value={instruction}
            placeholder={rewrite ? "例: 評価や数字はそのままに、説明を読みやすく。" : "例: 初めて講座を作る人向け。準備の順番を伝えたい。"}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </label>
        <p className="wizard-alt">
          <button type="button" className="btn-link" aria-haspopup="dialog" onClick={() => setSheet("sources")}>
            {sourceIds.length ? `記事や動画を材料に足す（${sourceIds.length}件）` : "記事や動画を材料に足す（任意）"}
          </button>
        </p>
      </>
    );
    footer = (
      <>
        <button aria-busy={generate.isPending} type="button" className="btn" disabled={busy} onClick={startGenerate}>
          {generate.isPending ? "3つの切り口で書いています…" : `AIで${N_CANDIDATES}案つくる`}
        </button>
        {/* 「Claude で作る」ボタンを後から置く場所（DECISIONS 2026-10-19）。AIキーの有無に関係なく
            生成ボタンの横に常にある。空のあいだは幅を取らない（workspace.css の .create-ai-slot:empty） */}
        <div className="create-ai-slot" data-slot="claude" />
      </>
    );
  }

  if (step === "candidates") {
    title = `${candidates.length}案`;
    body = (
      <>
        <h1 className="wizard-title">{candidates.length}案できました</h1>
        <p className="wizard-sub">左右にスライドして、1つ選びます。</p>
        <CandidateCarousel candidates={candidates} account={account} index={shown} onIndex={setShown} />
      </>
    );
    footer = (
      <button type="button" className="btn" disabled={busy} onClick={() => applyCandidate(shown)}>
        この案で進む
      </button>
    );
  }

  if (step === "edit") {
    title = "仕上げる";
    footerClass = "wizard-footer edit-bar";
    body = (
      <Composer account={account} draft={draft} onChange={setDraft} autoFocus={mode === "write" && bodyEmpty} />
    );
    footer = (
      <>
        <button type="button" className="btn btn-sub" disabled={busy} onClick={openRevise}>
          AIで直す
        </button>
        <button aria-busy={create.isPending} type="button" className="btn btn-sub" disabled={busy} onClick={saveDraft}>
          {create.isPending ? "保存しています…" : "下書きに保存"}
        </button>
        <button type="button" className="btn" disabled={busy || bodyEmpty} onClick={openPublish}>
          予約・投稿する
        </button>
        {bodyEmpty && <p className="btn-hint">本文を書くと予約・投稿できます。</p>}
      </>
    );
  }

  const progress = step !== "start" && mode !== "write" ? `${order}/4` : undefined;
  const viewerPicked = viewerPost ? picks.includes(viewerPost.id) : false;
  const viewerFull = !rewrite && picks.length >= 3 && !viewerPicked;

  return (
    <div className="wizard">
      <StepHeader title={title} onBack={step === "start" ? undefined : back} progress={progress} />
      <motion.section
        key={step}
        className={`wizard-body wizard-${step}`}
        aria-label={title}
        initial={reduced ? { opacity: 0 } : { opacity: 0, x: 16 * dir }}
        animate={reduced ? { opacity: 1 } : { opacity: 1, x: 0 }}
        transition={reduced ? CROSSFADE : SPRING}
      >
        {body}
      </motion.section>
      {footer && <div className={footerClass}>{footer}</div>}

      {viewerPost && (
        <PostViewer
          open={viewerOpen}
          onClose={() => setViewerOpen(false)}
          account={account}
          title={`${mdhm(viewerPost.postedAt, tz)} の投稿`}
          segments={[
            { text: viewerPost.text, views: viewerPost.views },
            ...viewerPost.children.map((c) => ({ text: c.text, views: c.views })),
          ]}
          stats={[
            { label: "表示", value: fmtN(viewerPost.views) },
            { label: "いいね", value: fmtN(viewerPost.likes) },
            { label: "返信", value: fmtN(viewerPost.replies) },
            { label: "リポスト", value: fmtN(viewerPost.reposts) },
            { label: "引用", value: fmtN(viewerPost.quotes) },
            { label: "クリック", value: fmtN(viewerPost.clicks) },
          ]}
          headerActions={
            viewerPost.permalink && (
              <a className="btn-link" href={viewerPost.permalink} target="_blank" rel="noreferrer noopener">
                Threads で開く
              </a>
            )
          }
          actions={
            <>
              <button
                type="button"
                className={viewerPicked ? "btn btn-sub" : "btn"}
                disabled={viewerFull}
                onClick={() => togglePick(viewerPost)}
              >
                {viewerPicked ? "選択を外す" : "この投稿を選ぶ"}
              </button>
              {viewerFull && <p className="btn-hint viewer-hint">選べるのは3本までです。先に1本外してください。</p>}
            </>
          }
        />
      )}

      <Sheet open={sheet === "aikey"} onClose={() => setSheet(null)} title="AIキーが必要です">
        <p className="muted sheet-text">AI で案を作ったり直したりするには、設定で AI キーを登録します。自分で書くだけなら、このままできます。</p>
        <div className="sheet-row">
          <button type="button" className="btn btn-sub" onClick={() => setSheet(null)}>あとで</button>
          <button type="button" className="btn" onClick={() => { setSheet(null); navigate("/app/settings"); }}>
            設定で登録する
          </button>
        </div>
      </Sheet>

      <Sheet open={sheet === "sources"} onClose={() => setSheet(null)} title="記事や動画を材料に足す">
        <div className="sources-sheet">
          <SourceAdder selected={sourceIds} onChange={setSourceIds} step={null} />
          <div className="sheet-row">
            <button type="button" className="btn" onClick={() => setSheet(null)}>
              {sourceIds.length ? `${sourceIds.length}件を使う` : "閉じる"}
            </button>
          </div>
        </div>
      </Sheet>

      <Sheet open={sheet === "replace"} onClose={() => setSheet(null)} title="いまの本文を置き換えます">
        <p className="muted sheet-text">仕上げる画面で書いた内容は消えます。</p>
        <div className="sheet-row">
          <button type="button" className="btn btn-sub" onClick={() => setSheet(null)}>やめる</button>
          <button type="button" className="btn" onClick={() => applyCandidate(shown, true)}>置き換える</button>
        </div>
      </Sheet>

      <ReviseSheet
        open={sheet === "revise"}
        onClose={() => setSheet(null)}
        quick={QUICK_REVISES}
        value={reviseText}
        onValue={setReviseText}
        onRun={(text) => runRevise(text)}
        busy={revise.isPending}
        rounds={turns.length / 2}
      />

      <Sheet open={sheet === "publish"} onClose={() => setSheet(null)} title={publishBlock(account).title}>
        <PublishNotice plain account={account} onLater={() => setSheet(null)} />
      </Sheet>

      <ScheduleSheet
        open={sheet === "schedule"}
        onClose={() => setSheet(null)}
        onPick={enqueue}
        accountId={account.id}
        tz={tz}
        confirmLabel="この日時で予約する"
        busy={create.isPending}
      />
    </div>
  );
}
