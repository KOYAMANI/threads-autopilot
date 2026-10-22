/**
 * note 一覧（SPEC §12.3 note）。カードを押すと、その note のいまの段階へ入る。
 * 画面の動作は「新しい note を書く」の1つ（DECISIONS 2026-10-21 note）。
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { NoteSummary } from "@tap/shared";
import { useDeleteNote, useNotes } from "../api/notes";
import { ApiError } from "../api/client";
import { useShell } from "../components/Shell";
import Sheet from "../components/Sheet";
import Skeleton from "../components/Skeleton";
import StepHeader from "../components/StepHeader";
import { useToast } from "../components/Toast";
import { fmtN, md } from "../lib/format";

function statusOf(n: NoteSummary): { label: string; kind: "done" | "writing" | "draft" } {
  if (n.status === "done") return { label: "完成", kind: "done" };
  if (n.status === "writing") return { label: "執筆中", kind: "writing" };
  if (n.status === "outlined") return { label: n.chaptersDone > 0 ? "途中" : "目次まで", kind: "draft" };
  return { label: "下書き", kind: "draft" };
}

export default function NoteList() {
  const navigate = useNavigate();
  const toast = useToast();
  const { account } = useShell();
  const notes = useNotes(account?.id ?? null);
  const remove = useDeleteNote(account?.id ?? null);
  const [target, setTarget] = useState<NoteSummary | null>(null);

  if (!account) return <p className="muted">アカウントがありません。</p>;
  const tz = account.timezone ?? "Asia/Tokyo";

  function open(n: NoteSummary) {
    if (n.status === "draft") navigate(`/app/note/new?id=${n.id}&step=memo`);
    else if (n.status === "outlined" && n.chaptersTotal === 0) navigate(`/app/note/new?id=${n.id}&step=outline`);
    else navigate(`/app/note/${n.id}`);
  }

  return (
    <div className="wizard">
      <StepHeader title="note" />
      <section className="wizard-body">
        <h1 className="wizard-title">note</h1>
        <p className="wizard-sub">長い記事を、目次から本文まで。書き上がったら note に貼り付けます。</p>
        {notes.isPending ? (
          <Skeleton lines={3} label="読み込んでいます" />
        ) : notes.data && notes.data.length > 0 ? (
          <ul className="note-list">
            {notes.data.map((n) => {
              const st = statusOf(n);
              return (
                <li key={n.id} className="note-row">
                  <button type="button" className="note-row-main" onClick={() => open(n)}>
                    <span className="note-row-title">{n.title || "（タイトル未定）"}</span>
                    <span className="note-row-meta">
                      <span className={`note-pill note-pill-${st.kind}`}>{st.label}</span>
                      {n.chaptersTotal > 0 && <span className="num">{n.status === "done" ? `${fmtN(n.chars)}字` : `${n.chaptersDone}/${n.chaptersTotal}章`}</span>}
                      <span>{md(n.updatedAt, tz)}</span>
                    </span>
                  </button>
                  <button type="button" className="icon-btn note-row-more" aria-label="その他の操作" onClick={() => setTarget(n)}>…</button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted note-empty">まだ note はありません。</p>
        )}
      </section>
      <div className="wizard-footer">
        <button type="button" className="btn" onClick={() => navigate("/app/note/new")}>新しい note を書く</button>
      </div>

      <Sheet open={target !== null} onClose={() => setTarget(null)} title={target?.title || "この note"}>
        <p className="sheet-text">消すと原稿も戻せません。</p>
        <div className="sheet-row">
          <button type="button" className="btn btn-sub" onClick={() => setTarget(null)}>やめる</button>
          <button
            type="button"
            className="btn"
            aria-busy={remove.isPending}
            disabled={remove.isPending}
            onClick={() => {
              if (!target) return;
              remove.mutate(target.id, {
                onSuccess: () => { setTarget(null); toast.show("消しました", "ok"); },
                onError: (e) => toast.show(e instanceof ApiError ? e.message : "消せませんでした", "bad"),
              });
            }}
          >
            この note を消す
          </button>
        </div>
      </Sheet>
    </div>
  );
}
