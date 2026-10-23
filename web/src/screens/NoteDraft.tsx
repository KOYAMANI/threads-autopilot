/**
 * note の原稿（SPEC §12.3 note）。章ごとに届く本文を読み、直し、コピーする。
 *
 * - 書いている間は3秒ごとに読み直す（`useNote`）。進捗は章の数と字数
 * - PC は左に章の一覧、右に本文。スマホは章を押すと全画面で読む
 * - 「コピー」は Markdown / HTML を選んで clipboard へ（`shared/src/note-export.ts`）
 */
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { NoteDetail, NoteSection } from "@tap/shared";
import { noteToHtml, noteToMarkdown, notePlaceholders, splitParagraphs } from "@tap/shared";
import { ApiError } from "../api/client";
import { useCancelNote, useNote, useReviseSection, useRewriteSection, useStartNote } from "../api/notes";
import FullScreen from "../components/FullScreen";
import ReviseSheet from "../components/ReviseSheet";
import Sheet from "../components/Sheet";
import Skeleton from "../components/Skeleton";
import StepHeader from "../components/StepHeader";
import { useToast } from "../components/Toast";
import { useMediaQuery } from "../lib/motion";
import { fmtN } from "../lib/format";

type SheetKind = "copy" | "fills" | "revise" | null;

/** 本文を段落に分けて描く。`## ` は節の見出し、`【 】` は自分で埋める箇所、`- ` は箇条書き。 */
function renderBody(body: string): ReactNode[] {
  const mark = (text: string, key: number): ReactNode => {
    const parts = text.split(/(【[^】]+】)/g);
    return (
      <span key={key}>
        {parts.map((p, i) => (p.startsWith("【") ? <mark key={i}>{p}</mark> : p))}
      </span>
    );
  };
  return splitParagraphs(body).map((p, i) => {
    if (p.startsWith("## ")) return <h3 key={i}>{p.slice(3).trim()}</h3>;
    const lines = p.split("\n");
    if (lines.every((l) => /^[-・] /.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{mark(l.replace(/^[-・] /, ""), j)}</li>)}</ul>;
    if (lines.every((l) => /^\d+[.．] /.test(l))) return <ol key={i}>{lines.map((l, j) => <li key={j}>{mark(l.replace(/^\d+[.．] /, ""), j)}</li>)}</ol>;
    return <p key={i}>{lines.map((l, j) => <span key={j}>{j > 0 && <br />}{mark(l.replace(/\*\*/g, ""), j)}</span>)}</p>;
  });
}

function statusLabel(s: NoteSection): string {
  if (s.status === "done") return `${fmtN(s.charCount)}字`;
  if (s.status === "writing") return "執筆中";
  if (s.status === "failed") return "書けませんでした";
  return "まだ";
}

export default function NoteDraft() {
  const navigate = useNavigate();
  const toast = useToast();
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const desktop = useMediaQuery("(min-width: 1024px)");
  const note = useNote(id);
  const cancel = useCancelNote();
  const resume = useStartNote();
  const revise = useReviseSection(id);
  const rewrite = useRewriteSection(id);

  const [sheet, setSheet] = useState<SheetKind>(null);
  const [fmt, setFmt] = useState<"md" | "html">("md");
  const [range, setRange] = useState<"all" | "chapter">("all");
  const [reviseText, setReviseText] = useState("");
  const [readerOpen, setReaderOpen] = useState(false);

  const n: NoteDetail | undefined = note.data;
  const sections = useMemo(() => (n ? [...n.sections].sort((a, b) => a.ord - b.ord) : []), [n]);
  const chParam = params.get("ch");
  const current = sections.find((s) => s.id === chParam) ?? null;
  const total = sections.reduce((a, s) => a + s.targetChars, 0);
  const written = sections.filter((s) => s.status === "done").reduce((a, s) => a + s.charCount, 0);
  const lastDone = [...sections].reverse().find((s) => s.status === "done") ?? null;
  const placeholders = useMemo(() => (n ? notePlaceholders(n) : []), [n]);
  const writing = n?.status === "writing";

  // スマホは章を選んだら全画面で読む
  useEffect(() => { if (!desktop) setReaderOpen(current !== null); }, [desktop, current]);

  function fail(e: unknown, fallback: string) {
    toast.show(e instanceof ApiError ? e.message : fallback, "bad");
  }
  function openChapter(s: NoteSection | null) {
    const p = new URLSearchParams(params);
    if (s) p.set("ch", s.id); else p.delete("ch");
    setParams(p, { replace: current !== null });
  }
  function copyNow() {
    if (!n) return;
    const r = range === "chapter" && current ? { kind: "chapter" as const, sectionId: current.id } : { kind: "all" as const };
    const text = fmt === "md" ? noteToMarkdown(n, r) : noteToHtml(n, r);
    navigator.clipboard?.writeText(text).then(
      () => { setSheet(null); toast.show("コピーしました。note のエディタに貼り付けてください", "ok"); },
      () => toast.show("コピーできませんでした", "bad"),
    );
  }

  if (note.isPending) return <div className="wizard"><StepHeader title="note" onBack={() => navigate("/app/note")} /><Skeleton lines={4} label="読み込んでいます" /></div>;
  if (!n) return <div className="wizard"><StepHeader title="note" onBack={() => navigate("/app/note")} /><p className="muted">見つかりませんでした。</p></div>;

  const copyButton = <button type="button" className="btn btn-sub btn-fit note-copy-btn" disabled={written === 0} onClick={() => { setRange(current ? "chapter" : "all"); setSheet("copy"); }}>コピー</button>;

  const progress = (
    <div className="note-progress">
      <div className="note-progress-l">
        <span>{n.status === "done" ? "すべて書けました" : writing ? (lastDone ? `${lastDone.heading.split(/[ ：]/)[0]}まで書けました` : "書き始めています") : "途中で止まっています"}</span>
        <span className="num">{fmtN(written)} / 約 {fmtN(total)} 字</span>
      </div>
      <div className="note-progress-b"><span style={{ width: `${total ? Math.min(100, Math.round((written / total) * 100)) : 0}%` }} /></div>
    </div>
  );

  const chapterList = (
    <>
      {progress}
      {placeholders.length > 0 && (
        <div className="chips note-chips"><button type="button" className="chip note-chip-mark" onClick={() => setSheet("fills")}>自分で埋める箇所 {placeholders.length}か所</button></div>
      )}
      <ol className="note-chapters">
        {sections.map((s) => (
          <li key={s.id}>
            <button type="button" className="note-chapter" aria-current={current?.id === s.id ? "true" : undefined} disabled={s.status !== "done" && s.status !== "failed"} onClick={() => openChapter(s)}>
              <span className={`note-st note-st-${s.status}`} aria-hidden="true">{s.status === "done" ? "✓" : ""}</span>
              <span className="note-chapter-t">{s.heading}<small>{statusLabel(s)}</small></span>
            </button>
            {n.paywallAfter !== null && s.ord === n.paywallAfter && <div className="note-pay">ここから有料</div>}
          </li>
        ))}
      </ol>
    </>
  );

  const reader = current ? (
    <article className="note-doc">
      <h2>{current.heading}</h2>
      {n.paywallAfter !== null && current.ord === n.paywallAfter + 1 && <div className="note-pay">ここから有料</div>}
      {current.status === "failed" ? (
        <p className="notice">この章は書けませんでした。{current.error ? `（${current.error}）` : ""}</p>
      ) : (
        renderBody(current.body)
      )}
      {current.error && current.status === "done" && <p className="hint">注記: {current.error}</p>}
      {!writing && (
        <div className="note-doc-actions">
          {current.status === "done" && <button type="button" className="btn" onClick={() => { setReviseText(""); setSheet("revise"); }}>指示で直す</button>}
          <button type="button" className="btn-link" aria-busy={rewrite.isPending} disabled={rewrite.isPending} onClick={() => rewrite.mutate(current.id, { onError: (e) => fail(e, "書き直せませんでした") })}>この章を書き直す</button>
        </div>
      )}
    </article>
  ) : (
    <p className="muted note-doc-empty">章を選ぶと、ここに本文が出ます。</p>
  );

  const footer = writing ? (
    <div className="wizard-footer"><button type="button" className="btn-quiet" aria-busy={cancel.isPending} disabled={cancel.isPending} onClick={() => cancel.mutate(id, { onError: (e) => fail(e, "止められませんでした") })}>やめる</button></div>
  ) : n.status === "outlined" && sections.length > 0 ? (
    <div className="wizard-footer"><button type="button" className="btn" aria-busy={resume.isPending} disabled={resume.isPending} onClick={() => resume.mutate({ id, resume: true }, { onError: (e) => fail(e, "再開できませんでした") })}>続きを書く</button></div>
  ) : null;

  return (
    <div className={desktop ? "wizard note-wide" : "wizard"}>
      <StepHeader title={n.title || "note"} onBack={() => navigate("/app/note")} actions={copyButton} />
      <section className="wizard-body">
        {desktop ? (
          <div className="note-two"><div>{chapterList}</div><div className="note-right">{reader}</div></div>
        ) : (
          <>
            <h1 className="wizard-title note-doc-title">{n.title || "（タイトル未定）"}</h1>
            {chapterList}
          </>
        )}
      </section>
      {footer}

      {!desktop && (
        <FullScreen open={readerOpen} onClose={() => openChapter(null)} title={current?.heading ?? ""} headerActions={copyButton} escapeDisabled={sheet !== null}>
          <div className="note-reader">{reader}</div>
        </FullScreen>
      )}

      <Sheet open={sheet === "copy"} onClose={() => setSheet(null)} title="コピーして note に貼る">
        <div className="field"><span>形式</span>
          <div className="pick-source note-seg" role="tablist" aria-label="形式">
            <button type="button" role="tab" aria-selected={fmt === "md"} onClick={() => setFmt("md")}>Markdown</button>
            <button type="button" role="tab" aria-selected={fmt === "html"} onClick={() => setFmt("html")}>HTML</button>
          </div>
        </div>
        {current && (
          <div className="field"><span>範囲</span>
            <div className="pick-source note-seg" role="tablist" aria-label="範囲">
              <button type="button" role="tab" aria-selected={range === "all"} onClick={() => setRange("all")}>全文</button>
              <button type="button" role="tab" aria-selected={range === "chapter"} onClick={() => setRange("chapter")}>この章だけ</button>
            </div>
          </div>
        )}
        <div className="sheet-row"><button type="button" className="btn" onClick={copyNow}>コピーする</button></div>
        <p className="btn-hint sheet-hint">note のエディタに貼ると見出しが反映されます。有料ラインは貼った後に note 側で設定します。</p>
      </Sheet>

      <Sheet open={sheet === "fills"} onClose={() => setSheet(null)} title={`自分で埋める箇所 ${placeholders.length}か所`}>
        <ul className="note-fills">
          {placeholders.map((p, i) => {
            const s = sections.find((x) => x.id === p.sectionId);
            return (
              <li key={i}>
                <button type="button" onClick={() => { setSheet(null); if (s) openChapter(s); }}>
                  <strong>【{p.text}】</strong><small>{s?.heading}</small>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="btn-hint sheet-hint">商品名・写真・出典など、本人しか分からないところです。</p>
      </Sheet>

      <ReviseSheet
        open={sheet === "revise"}
        onClose={() => setSheet(null)}
        quick={[["短くする", "この章を2〜3割短くしてください。具体例は残してください。"], ["やわらかく", "言い切りを弱め、語りかける口調にしてください。"]]}
        value={reviseText}
        onValue={setReviseText}
        busy={revise.isPending}
        onRun={(instruction) => {
          if (!current) return;
          revise.mutate({ sectionId: current.id, instruction }, {
            onSuccess: () => { setSheet(null); toast.show("直しました", "ok"); },
            onError: (e) => fail(e, "直せませんでした"),
          });
        }}
      />
    </div>
  );
}
