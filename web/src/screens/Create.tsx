/**
 * 作る（SPEC §12.3）。M4 では **AI 生成の手前まで**を作る。
 *
 * ここで出せるのは「本文＋コメント①②③ を書いて、下書きに保存するか、キューに入れる」まで。
 * 箱1（自分の投稿の picker）・箱2（参考情報）・3案の生成と修正は M5（`POST /ai/generate`）。
 *
 * ホームやキューの「リライト / これを型にして作る」は `location.state.preset` で受ける
 * （SPEC §12.3）。`rewrite` は本文を下敷きとして流し込み、`template` は文体の見本として
 * 見せるだけにする（本文には入れない。M5 で AI に渡す）。
 */
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useCreateQueue } from "../api/queue";
import { ApiError } from "../api/client";
import PostFields, {
  draftIssue,
  emptyDraft,
  trimComments,
  type PostDraft,
} from "../components/PostFields";
import ScheduleSheet, { type SchedulePick } from "../components/ScheduleSheet";
import { useShell } from "../components/Shell";
import { useToast } from "../components/Toast";
import type { CreatePreset } from "./Home";

export default function Create() {
  const { account } = useShell();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const preset = (location.state as { preset?: CreatePreset } | null)?.preset ?? null;

  const [draft, setDraft] = useState<PostDraft>(emptyDraft);
  const [sheet, setSheet] = useState(false);
  const create = useCreateQueue(account?.id ?? null);

  // リライトは下敷きを本文に入れる。型は見せるだけ（M5 で AI に渡す）
  useEffect(() => {
    if (preset?.mode === "rewrite") {
      setDraft((d) => (d.body === "" ? { ...d, body: preset.text } : d));
    }
  }, [preset]);

  if (!account) return <p className="muted">アカウントがありません。</p>;

  const tz = account.timezone ?? "Asia/Tokyo";

  function fail(e: unknown, fallback: string) {
    toast.show(e instanceof ApiError ? e.message : fallback, "bad");
  }

  function guard(): boolean {
    const issue = draftIssue(draft);
    if (issue) {
      toast.show(issue, "bad");
      return false;
    }
    return true;
  }

  function saveDraft() {
    if (!guard()) return;
    create.mutate(
      { status: "draft", body: draft.body, comments: trimComments(draft.comments) },
      {
        onSuccess: () => {
          toast.show("下書きに保存しました", "ok");
          navigate("/app/queue");
        },
        onError: (e) => fail(e, "保存できませんでした"),
      },
    );
  }

  function enqueue(pick: SchedulePick) {
    if (!guard()) return;
    create.mutate(
      pick.kind === "now"
        ? { status: "now", body: draft.body, comments: trimComments(draft.comments) }
        : {
            status: "scheduled",
            scheduledAt: pick.at ?? undefined,
            body: draft.body,
            comments: trimComments(draft.comments),
          },
      {
        onSuccess: () => {
          setSheet(false);
          toast.show(pick.kind === "now" ? "次の実行で出します" : "予約しました", "ok");
          navigate("/app/queue");
        },
        onError: (e) => fail(e, "キューに入れられませんでした"),
      },
    );
  }

  return (
    <>
      <h1>作る</h1>
      <p className="muted" style={{ marginTop: "0.125rem" }}>
        本文とコメントを書いて、下書きか予約にします
      </p>

      {preset && (
        <div className="card section">
          <h2>{preset.mode === "rewrite" ? "リライト元" : "文体の見本"}</h2>
          <p className="muted" style={{ marginTop: "0.25rem" }}>
            {preset.mode === "rewrite"
              ? "本文に入れました。書き直してください。"
              : "この投稿の型で書きます（AIに渡すのは M5）。"}
          </p>
          <p style={{ marginTop: "var(--sp)", fontSize: "0.8125rem", whiteSpace: "pre-wrap" }}>
            {preset.text}
          </p>
        </div>
      )}

      <div className="card section">
        <PostFields draft={draft} onChange={setDraft} idPrefix="create" />
      </div>

      <div className="section" style={{ display: "grid", gap: "calc(var(--sp) * 1.5)" }}>
        <button type="button" className="btn" disabled={create.isPending} onClick={() => setSheet(true)}>
          キューに入れる
        </button>
        <button
          type="button"
          className="btn btn-sub"
          disabled={create.isPending}
          onClick={saveDraft}
        >
          {create.isPending ? "保存しています…" : "下書きに保存"}
        </button>
      </div>

      <div className="card section">
        <p className="muted">
          自分の過去投稿からの選択・参考情報（テキスト / YouTube / ファイル / 記事URL）・AIでの3案生成と修正は
          M5 で足します。
        </p>
      </div>

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
