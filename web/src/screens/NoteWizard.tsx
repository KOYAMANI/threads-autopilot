/**
 * note を書く手順（SPEC §12.3 note。試作 proto/note-flow.html に合わせる）。
 *
 *   memo → sources → style → (question ×最大3) → outline → engine → 原稿（/app/note/:id）
 *
 * 入力は各手順で `PATCH /notes/:id` に保存する（リロードしても残る）。手順は `?step=`、
 * note は `?id=`。作る画面（Create.tsx）と同じく、戻るはブラウザの戻ると同じ。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "motion/react";
import { NOTE_MAX_QUESTIONS } from "@tap/shared";
import type { NoteDetail, NoteOutline, NoteStyle, NoteVolume } from "@tap/shared";
import { useAiSettings } from "../api/ai";
import { ApiError } from "../api/client";
import { useCreateNote, useNote, useNoteOutline, usePatchNote, useStartNote } from "../api/notes";
import GrowingText from "../components/GrowingText";
import { useShell } from "../components/Shell";
import Sheet from "../components/Sheet";
import SourceAdder from "../components/SourceAdder";
import StepHeader from "../components/StepHeader";
import { useToast } from "../components/Toast";
import { CROSSFADE, SPRING, useReducedMotion } from "../lib/motion";
import { fmtN } from "../lib/format";

type Step = "memo" | "sources" | "style" | "question" | "outline" | "engine";
const STEPS: Step[] = ["memo", "sources", "style", "question", "outline", "engine"];
const isStep = (v: string | null): v is Step => STEPS.includes(v as Step);
/** 右上の「n/5」。question は数えない */
const PROGRESS: Partial<Record<Step, string>> = { memo: "1/5", sources: "2/5", style: "3/5", outline: "4/5", engine: "5/5" };
const PREV: Record<Step, Step> = { memo: "memo", sources: "memo", style: "sources", question: "style", outline: "style", engine: "outline" };

const STYLES: Array<{ id: NoteStyle; title: string; note: string }> = [
  { id: "story", title: "体験談型", note: "自分の経験として語る。「うちの子はこうだった」が入る" },
  { id: "general", title: "一般論型", note: "一般的な知識として書く。ただし読者には語りかけ、他人事にしない" },
];
const VOLUMES: Array<{ id: NoteVolume; label: string }> = [
  { id: "short", label: "短め · 約1万字" },
  { id: "standard", label: "標準 · 2〜3万字" },
  { id: "same", label: "前回と同じ" },
];

const MEMO_PLACEHOLDER = "・ご飯がなんで大切か\nリスク（病気とか）\n・基準\n高ければいい訳ではない\n・選び方（子犬／成犬／老犬）";

function historyIdx(): number | undefined {
  const s = window.history.state as { idx?: number } | null;
  return typeof s?.idx === "number" ? s.idx : undefined;
}

export default function NoteWizard() {
  const navigate = useNavigate();
  const toast = useToast();
  const reduced = useReducedMotion();
  const { account } = useShell();
  const [params, setParams] = useSearchParams();
  const entryIdx = useRef(historyIdx());

  const id = params.get("id");
  const note = useNote(id);
  const settings = useAiSettings();
  const create = useCreateNote();
  const patch = usePatchNote();
  const outline = useNoteOutline();
  const start = useStartNote();

  // 画面の入力。note を読んだら一度だけ流し込む
  const [title, setTitle] = useState("");
  const [memo, setMemo] = useState("");
  const [style, setStyle] = useState<NoteStyle>("general");
  const [volume, setVolume] = useState<NoteVolume>("standard");
  const [refNote, setRefNote] = useState("");
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [answer, setAnswer] = useState("");
  /** 直近に返ってきた質問（note の読み直しを待たずに出す） */
  const [asked, setAsked] = useState<{ question: string; round: number } | null>(null);
  const [draftOutline, setDraftOutline] = useState<NoteOutline | null>(null);
  const [paywall, setPaywall] = useState<number | null>(null);
  const [titleIdx, setTitleIdx] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [caution, setCaution] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"aikey" | null>(null);
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    const n = note.data;
    if (!n || loadedFor.current === n.id) return;
    loadedFor.current = n.id;
    setTitle(n.title); setMemo(n.memo); setStyle(n.style); setVolume(n.volume); setRefNote(n.refNote); setSourceIds(n.sourceIds);
    setDraftOutline(n.outline); setPaywall(n.paywallAfter);
    setTitleIdx(Math.max(0, n.titleOptions.indexOf(n.title)));
  }, [note.data]);

  // いまの手順。note が無いのに先の手順にいたら memo に戻す
  const rawStep = params.get("step");
  let step: Step = isStep(rawStep) ? rawStep : "memo";
  if (!id && step !== "memo") step = "memo";
  if (note.data && note.data.status === "writing") step = "engine";
  useEffect(() => { window.scrollTo({ top: 0, behavior: "auto" }); }, [step]);
  const order = STEPS.indexOf(step);
  const lastOrder = useRef(order);
  const dir = order >= lastOrder.current ? 1 : -1;
  useEffect(() => { lastOrder.current = order; }, [order]);

  const keyReady = useMemo(() => Boolean(settings.data?.provider && settings.data.storeOnServer && settings.data.hasKey), [settings.data]);

  if (!account) return <p className="muted">アカウントがありません。</p>;

  function go(next: Step, replace = false) {
    const p = new URLSearchParams(params);
    p.set("step", next);
    if (id) p.set("id", id);
    setParams(p, { replace });
  }
  function back() {
    if (step === "memo") { navigate("/app/note"); return; }
    const idx = historyIdx();
    if (idx !== undefined && entryIdx.current !== undefined && idx > entryIdx.current) { navigate(-1); return; }
    go(PREV[step], true);
  }
  function fail(e: unknown, fallback: string) {
    toast.show(e instanceof ApiError ? e.message : fallback, "bad");
  }

  /** memo の「次へ」: 初回は作る、以後は保存 */
  function saveMemo() {
    if (!id) {
      create.mutate({ accountId: account!.id, title, memo }, {
        onSuccess: (n) => { loadedFor.current = n.id; setParams(new URLSearchParams({ id: n.id, step: "sources" })); },
        onError: (e) => fail(e, "保存できませんでした"),
      });
      return;
    }
    patch.mutate({ id, title, memo }, { onSuccess: () => go("sources"), onError: (e) => fail(e, "保存できませんでした") });
  }
  function saveSources() {
    patch.mutate({ id: id!, sourceIds }, { onSuccess: () => go("style"), onError: (e) => fail(e, "保存できませんでした") });
  }
  /** style の「目次を作る」: 保存 → 目次（質問が返れば question へ） */
  function makeOutline(body: { answer?: string; assume?: boolean } = {}) {
    if (!keyReady) { setSheet("aikey"); return; }
    const run = () => outline.mutate({ id: id!, ...body }, {
      onSuccess: (res) => {
        if (res.status === "question") { setAnswer(""); setAsked({ question: res.question, round: res.round }); go("question"); return; }
        setAsked(null);
        loadedFor.current = null; // 目次を読み直す
        if (res.notes?.length) toast.show(res.notes[0]!, "info");
        go("outline");
      },
      onError: (e) => fail(e, "目次を作れませんでした"),
    });
    if (step === "style") patch.mutate({ id: id!, style, volume, refNote }, { onSuccess: run, onError: (e) => fail(e, "保存できませんでした") });
    else run();
  }
  /** outline の変更は少し待ってから保存する（押すたびに送らない） */
  const saveTimer = useRef<number | null>(null);
  function queueSave(next: NoteOutline, pay: number | null, titleText?: string) {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      patch.mutate({ id: id!, outline: next, paywallAfter: pay, ...(titleText !== undefined ? { title: titleText } : {}) }, { onError: (e) => fail(e, "保存できませんでした") });
    }, 600);
  }
  function updateOutline(mut: (o: NoteOutline) => NoteOutline) {
    setDraftOutline((prev) => {
      if (!prev) return prev;
      const next = mut({ chapters: prev.chapters.map((c) => ({ ...c, sections: c.sections.map((s) => ({ ...s })) })) });
      const pay = paywall === null ? null : Math.min(paywall, Math.max(0, next.chapters.length - 2));
      setPaywall(pay);
      queueSave(next, pay);
      return next;
    });
  }
  function startWriting() {
    if (!keyReady) { setSheet("aikey"); return; }
    if (saveTimer.current) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    const n = note.data;
    patch.mutate({ id: id!, outline: draftOutline ?? undefined, paywallAfter: paywall, title: n?.titleOptions[titleIdx] ?? title }, {
      onSuccess: () => start.mutate({ id: id! }, { onSuccess: () => navigate(`/app/note/${id}`, { replace: true }), onError: (e) => fail(e, "書き始められませんでした") }),
      onError: (e) => fail(e, "保存できませんでした"),
    });
  }

  const busy = create.isPending || patch.isPending || outline.isPending || start.isPending;
  const n: NoteDetail | undefined = note.data;
  const pendingQuestion = asked?.question ?? (n?.qa.length ? n.qa[n.qa.length - 1]!.question : null);
  const qaRound = Math.max(asked?.round ?? 0, n?.qa.length ?? 0);
  const total = draftOutline?.chapters.reduce((a, c) => a + c.targetChars, 0) ?? 0;
  const freeChars = draftOutline && paywall !== null ? draftOutline.chapters.slice(0, paywall + 1).reduce((a, c) => a + c.targetChars, 0) : null;

  let heading = "新しい note";
  let body: ReactNode = null;
  let footer: ReactNode = null;

  if (outline.isPending) {
    body = (
      <div className="note-generating" role="status">
        <span className="note-spinner" aria-hidden="true" />
        <strong>{step === "question" ? "答えを目次に反映しています" : "目次を作っています"}</strong>
        <p className="hint">最大およそ1分。別の画面に移っても、処理は続きます。</p>
      </div>
    );
  } else if (step === "memo") {
    body = (
      <>
        <h1 className="wizard-title">何について書きますか？</h1>
        <p className="wizard-sub">箇条書きで大丈夫です。順番や言い回しは、あとで整えます。</p>
        <label className="field" htmlFor="note-title"><span>仮タイトル（任意）</span><input id="note-title" className="input" value={title} maxLength={120} placeholder="例：犬のごはん選び" onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="field" htmlFor="note-memo"><span>書きたいこと</span><GrowingText id="note-memo" value={memo} placeholder={MEMO_PLACEHOLDER} rows={7} maxLength={20000} onChange={setMemo} /></label>
      </>
    );
    footer = <button type="button" className="btn" aria-busy={busy} disabled={busy || memo.trim() === ""} onClick={saveMemo}>次へ</button>;
  } else if (step === "sources") {
    body = (
      <>
        <h1 className="wizard-title">参考にする資料はありますか？</h1>
        <p className="wizard-sub">本文の根拠に使います。なくても進めます。</p>
        {/* 作る画面のシートと同じ見せ方（箱の見出しは出さない） */}
        <div className="sources-sheet note-sources"><SourceAdder selected={sourceIds} onChange={setSourceIds} step={null} /></div>
        <p className="hint">資料は目次の後からも足せます。</p>
      </>
    );
    footer = <button type="button" className="btn" aria-busy={busy} disabled={busy} onClick={saveSources}>次へ</button>;
  } else if (step === "style") {
    body = (
      <>
        <h1 className="wizard-title">どんな書き方にしますか？</h1>
        <p className="wizard-sub">文体と分量を決めます。参考にしたい前の note があれば貼れます。</p>
        <div className="note-choices" role="radiogroup" aria-label="文体">
          {STYLES.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={style === s.id} className="note-choice" onClick={() => setStyle(s.id)}>
              <strong>{s.title}</strong><span>{s.note}</span>
            </button>
          ))}
        </div>
        <div className="field note-volume"><span>分量の目安</span>
          <div className="pick-source note-seg" role="tablist" aria-label="分量">
            {VOLUMES.map((v) => (
              <button key={v.id} type="button" role="tab" aria-selected={volume === v.id} disabled={v.id === "same" && refNote.trim() === ""} onClick={() => setVolume(v.id)}>{v.label}</button>
            ))}
          </div>
        </div>
        <details className="note-fold" open={refNote.trim() !== ""}>
          <summary>参考にする前の note（任意）</summary>
          <div className="note-fold-body">
            <GrowingText id="note-ref" value={refNote} rows={4} maxLength={60000} placeholder="note のエディタから本文をコピーして貼り付け" onChange={(v) => { setRefNote(v); if (v.trim() === "" && volume === "same") setVolume("standard"); }} />
            <p className="hint">貼ると、文体と1見出しあたりの文字数を読み取ります。</p>
          </div>
        </details>
      </>
    );
    footer = <button type="button" className="btn" aria-busy={busy} disabled={busy} onClick={() => makeOutline()}>目次を作る</button>;
  } else if (step === "question") {
    body = (
      <>
        <h1 className="wizard-title">書く前に、少しだけ確認します</h1>
        <p className="wizard-sub">答えると目次が正確になります。分からなければお任せで進めます。</p>
        <div className="note-question"><small>GEMINI の質問</small>{pendingQuestion ?? "（質問を読み込んでいます）"}</div>
        <label className="field" htmlFor="note-answer"><span className="visually-hidden">答え</span><GrowingText id="note-answer" value={answer} rows={3} maxLength={2000} placeholder="ここに答える" onChange={setAnswer} /></label>
      </>
    );
    footer = (
      <>
        <button type="button" className="btn-quiet" disabled={busy} onClick={() => makeOutline({ assume: true })}>お任せで進む</button>
        <button type="button" className="btn" aria-busy={busy} disabled={busy || answer.trim() === ""} onClick={() => makeOutline({ answer: answer.trim() })}>答える</button>
      </>
    );
  } else if (step === "outline") {
    heading = "目次";
    body = !draftOutline ? (
      <p className="muted">目次がまだありません。</p>
    ) : (
      <>
        <h1 className="wizard-title">目次を整える</h1>
        <p className="wizard-sub">見出しは押すと直せます。「ここから有料」の位置も選べます。</p>
        {n && n.titleOptions.length > 0 && (
          <div className="field"><span>タイトル案</span>
            <div className="note-choices note-titles" role="radiogroup" aria-label="タイトル案">
              {n.titleOptions.map((t, i) => (
                <button key={t} type="button" role="radio" aria-checked={titleIdx === i} className="note-choice" onClick={() => { setTitleIdx(i); setTitle(t); queueSave(draftOutline, paywall, t); }}>
                  <span className="note-choice-text">{t}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <p className="note-toc-meta">
          <span>{draftOutline.chapters.length}章 · 全体で約 {fmtN(total)} 字</span>
          {freeChars !== null && <span>· 無料パート 約 {fmtN(freeChars)} 字</span>}
        </p>
        <div className="note-toc">
          {draftOutline.chapters.map((c, i) => (
            <div key={i}>
              <div className="note-ch">
                <div className="note-ch-h">
                  {editing === `${i}` ? (
                    <input className="input note-ch-input" autoFocus defaultValue={c.heading} maxLength={120}
                      onBlur={(e) => { const v = e.target.value.trim(); setEditing(null); if (v) updateOutline((o) => { o.chapters[i]!.heading = v; return o; }); }}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur(); }} />
                  ) : (
                    <button type="button" className="note-ch-title" onClick={() => setEditing(`${i}`)}>{c.heading}</button>
                  )}
                  <span className="note-ch-len num">約 {fmtN(c.targetChars)} 字</span>
                </div>
                {c.sections.map((s, j) => (
                  <div key={j}>
                    <div className="note-sec">
                      {editing === `${i}-${j}` ? (
                        <input className="input note-sec-input" autoFocus defaultValue={s.title} maxLength={120}
                          onBlur={(e) => { const v = e.target.value.trim(); setEditing(null); if (v) updateOutline((o) => { o.chapters[i]!.sections[j]!.title = v; return o; }); }}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur(); }} />
                      ) : (
                        <button type="button" className="note-sec-title" onClick={() => setEditing(`${i}-${j}`)}>{s.title}</button>
                      )}
                      {s.caution && <button type="button" className="note-sec-warn" aria-label="注意を見る" aria-pressed={caution === `${i}-${j}`} onClick={() => setCaution(caution === `${i}-${j}` ? null : `${i}-${j}`)}>!</button>}
                      <button type="button" className="note-sec-x" aria-label="この節を消す" onClick={() => updateOutline((o) => { o.chapters[i]!.sections.splice(j, 1); return o; })}>×</button>
                    </div>
                    {caution === `${i}-${j}` && s.caution && <p className="note-sec-caution">{s.caution}</p>}
                  </div>
                ))}
                {(c.sections.length > 0 || (i > 0 && i < draftOutline.chapters.length - 1)) && (
                  <div className="note-sec note-sec-add">
                    <button type="button" className="btn-link" onClick={() => { const k = c.sections.length + 1; updateOutline((o) => { o.chapters[i]!.sections.push({ title: `${i}-${k} 新しい節` }); return o; }); setEditing(`${i}-${c.sections.length}`); }}>＋ 節を足す</button>
                  </div>
                )}
              </div>
              {i < draftOutline.chapters.length - 1 && (
                paywall === i ? (
                  <div className="note-gap note-gap-on"><span>ここから有料</span><button type="button" className="btn-link" onClick={() => { setPaywall(null); queueSave(draftOutline, null); }}>外す</button></div>
                ) : (
                  <div className="note-gap"><button type="button" onClick={() => { setPaywall(i); queueSave(draftOutline, i); }}>有料ラインをここに</button></div>
                )
              )}
            </div>
          ))}
        </div>
      </>
    );
    footer = <button type="button" className="btn" aria-busy={busy} disabled={busy || !draftOutline} onClick={() => { if (saveTimer.current) { window.clearTimeout(saveTimer.current); saveTimer.current = null; patch.mutate({ id: id!, outline: draftOutline!, paywallAfter: paywall }); } go("engine"); }}>この目次で書く</button>;
  } else if (step === "engine") {
    heading = "書く";
    const chapters = draftOutline?.chapters.length ?? 0;
    body = n?.status === "writing" ? (
      <p className="muted">書いています。<button type="button" className="btn-link" onClick={() => navigate(`/app/note/${id}`)}>原稿を見る</button></p>
    ) : (
      <>
        <h1 className="wizard-title">書き始めますか？</h1>
        <p className="wizard-sub">章ごとに順番に書きます。別の画面に移っても続きます。</p>
        <p className="note-est"><span>{chapters}章 · 約 <b className="num">{fmtN(total)}</b> 字</span>{paywall !== null && <span>有料ライン: {paywall + 1}章目の後</span>}</p>
        <div className="note-choices" role="radiogroup" aria-label="書くところ">
          <button type="button" role="radio" aria-checked="true" className="note-choice"><strong>アプリで書く（Gemini）</strong><span>約 {Math.max(1, Math.round(chapters * 1.4))} 分。1章ずつ届きます</span></button>
        </div>
      </>
    );
    footer = n?.status === "writing" ? null : <button type="button" className="btn" aria-busy={busy} disabled={busy || !draftOutline} onClick={startWriting}>書き始める</button>;
  }

  return (
    <div className="wizard">
      <StepHeader title={heading} onBack={back} progress={step === "question" ? `質問 ${qaRound}/${NOTE_MAX_QUESTIONS}` : PROGRESS[step]} />
      <motion.section
        key={outline.isPending ? "generating" : step}
        className={`wizard-body note-step-${step}`}
        aria-label={heading}
        initial={reduced ? { opacity: 0 } : { opacity: 0, x: 16 * dir }}
        animate={reduced ? { opacity: 1 } : { opacity: 1, x: 0 }}
        transition={reduced ? CROSSFADE : SPRING}
      >
        {body}
      </motion.section>
      {footer && !outline.isPending && <div className="wizard-footer">{footer}</div>}

      <Sheet open={sheet === "aikey"} onClose={() => setSheet(null)} title="AI キーが必要です">
        <p className="sheet-text">目次と本文は、設定に登録した AI キーで作ります。</p>
        <div className="sheet-row">
          <button type="button" className="btn btn-sub" onClick={() => setSheet(null)}>あとで</button>
          <button type="button" className="btn" onClick={() => navigate("/app/settings")}>設定を開く</button>
        </div>
      </Sheet>
    </div>
  );
}
