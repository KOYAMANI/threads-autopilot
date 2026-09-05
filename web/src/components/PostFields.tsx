/**
 * 本文＋コメント①②③の入力（SPEC §12.3 の Create / Queue の編集で共用）。
 *
 * 検査は `shared/src/validate.ts` の `validatePost()` をそのまま使う（SPEC §9.6
 * 「全経路で使う」）。サーバーと同じ関数なので、画面で通ったものはサーバーでも通る。
 * リンクの置き場は手動のキューでは本文でも許す（`link_placement` は M6 の設定）。
 */
import { useMemo } from "react";
import { MAX_BODY_LENGTH, bodyLength, validatePost } from "@tap/shared";

/** ツリーは本文＋コメント3本まで（SPEC §1「本文＋コメント①②③」）。 */
export const MAX_COMMENTS = 3;

export type PostDraft = { body: string; comments: string[] };

export function emptyDraft(): PostDraft {
  return { body: "", comments: ["", "", ""] };
}

/** 空のコメントは落として詰める（サーバーに送る形）。 */
export function trimComments(comments: string[]): string[] {
  return comments.map((c) => c.trim()).filter((c) => c !== "");
}

/** 送る前の検査。通れば null、だめなら最初の問題の文言を返す。 */
export function draftIssue(draft: PostDraft): string | null {
  const res = validatePost(draft.body, {
    comments: trimComments(draft.comments),
    linkPlacement: "body",
  });
  return res.ok ? null : (res.issues[0]?.message ?? "入力に誤りがあります");
}

function Counter({ text }: { text: string }) {
  const n = bodyLength(text);
  const over = n > MAX_BODY_LENGTH;
  return (
    <span className={`counter num${over ? " counter-over" : ""}`}>
      {n} / {MAX_BODY_LENGTH}
    </span>
  );
}

export default function PostFields({
  draft,
  onChange,
  autoFocus = false,
  idPrefix = "post",
}: {
  draft: PostDraft;
  onChange: (next: PostDraft) => void;
  autoFocus?: boolean;
  idPrefix?: string;
}) {
  const issue = useMemo(() => draftIssue(draft), [draft]);
  const comments = draft.comments.length >= MAX_COMMENTS
    ? draft.comments.slice(0, MAX_COMMENTS)
    : [...draft.comments, ...Array<string>(MAX_COMMENTS - draft.comments.length).fill("")];

  function setComment(i: number, value: string) {
    const next = [...comments];
    next[i] = value;
    onChange({ ...draft, comments: next });
  }

  return (
    <>
      <label className="field" htmlFor={`${idPrefix}-body`}>
        <span className="field-head">
          本文
          <Counter text={draft.body} />
        </span>
        <textarea
          id={`${idPrefix}-body`}
          className="input"
          rows={6}
          autoFocus={autoFocus}
          value={draft.body}
          placeholder="1行目で止まらせる。ここに本文を書きます。"
          onChange={(e) => onChange({ ...draft, body: e.target.value })}
        />
      </label>

      {comments.map((c, i) => (
        <label className="field" key={i} htmlFor={`${idPrefix}-c${i}`}>
          <span className="field-head">
            コメント{"①②③"[i]}
            <Counter text={c} />
          </span>
          <textarea
            id={`${idPrefix}-c${i}`}
            className="input"
            rows={3}
            value={c}
            placeholder={i === 0 ? "リンクはここに置くのが既定です。" : "空のままなら投稿しません。"}
            onChange={(e) => setComment(i, e.target.value)}
          />
        </label>
      ))}

      {issue && draft.body.trim() !== "" && (
        <p className="msg msg-bad" role="status">
          {issue}
        </p>
      )}
    </>
  );
}
