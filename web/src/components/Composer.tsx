/**
 * 作る画面のエディタ（Typefully / Buffer に倣い、開いたらすぐ書ける場所を主役にする）。
 *
 * 見た目は全画面ビューと同じツリー（アイコンを縦線でつなぐ）。1投稿目と続き（最大3つ）を書く。
 * 作り方を選ぶのは作る画面の最初の手順、AI で直すのは下の帯のシートが受け持つ（DECISIONS 2026-10-19 4回目）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MAX_BODY_LENGTH, bodyLength, type AccountSummary } from "@tap/shared";
import AccountAvatar from "./AccountAvatar";
import { Counter, MAX_COMMENTS, draftIssue, type PostDraft } from "./PostFields";

/** 中身に合わせて高さが伸びる入力欄（動かすのは高さの即時変更だけで、アニメーションはしない）。 */
function GrowingText({
  id,
  value,
  placeholder,
  onChange,
  inputRef,
  label,
}: {
  id: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
  label: string;
}) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const ref = inputRef ?? own;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, ref]);
  return (
    <textarea
      id={id}
      ref={ref}
      className="composer-input"
      rows={2}
      aria-label={label}
      aria-invalid={bodyLength(value) > MAX_BODY_LENGTH || undefined}
      aria-describedby={bodyLength(value) > MAX_BODY_LENGTH ? "composer-issue" : undefined}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export default function Composer({
  account,
  draft,
  onChange,
  autoFocus = false,
}: {
  account: AccountSummary;
  draft: PostDraft;
  onChange: (next: PostDraft) => void;
  /** 白紙から書くときは、開いたらすぐ本文に書けるようにする */
  autoFocus?: boolean;
}) {
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [extra, setExtra] = useState(0);
  const comments = [...draft.comments, "", "", ""].slice(0, MAX_COMMENTS);
  const lastFilled = comments.reduce((last, text, i) => (text.trim() ? i + 1 : last), 0);
  const visible = Math.max(lastFilled, extra);
  const issue = useMemo(() => draftIssue(draft), [draft]);

  useEffect(() => {
    if (autoFocus) bodyRef.current?.focus();
  }, [autoFocus]);

  function setComment(i: number, value: string) {
    const next = [...comments];
    next[i] = value;
    onChange({ ...draft, comments: next });
  }

  const segments = [
    { id: "composer-body", value: draft.body, label: "1投稿目", placeholder: "ここに本文を書く", set: (v: string) => onChange({ ...draft, body: v }) },
    ...comments.slice(0, visible).map((c, i) => ({
      id: `composer-c${i}`,
      value: c,
      label: `続きの投稿 ${i + 1}`,
      placeholder: "ここにコメントを書く",
      set: (v: string) => setComment(i, v),
    })),
  ];

  return (
    <div className="composer">
      <ol className="viewer-thread composer-thread">
        {segments.map((s, i) => (
          <li key={s.id} className="viewer-post">
            <div className="viewer-rail" aria-hidden="true">
              <AccountAvatar account={account} />
            </div>
            <div className="viewer-body">
              <div className="viewer-head">
                <strong>@{account.username}</strong>
                {i > 0 && <span className="muted">続き {i}</span>}
                <span className="composer-count"><Counter text={s.value} /></span>
              </div>
              <GrowingText
                id={s.id}
                value={s.value}
                label={s.label}
                placeholder={s.placeholder}
                onChange={s.set}
                inputRef={i === 0 ? bodyRef : undefined}
              />
            </div>
          </li>
        ))}
      </ol>

      {visible < MAX_COMMENTS && (
        <button type="button" className="btn-link composer-add" onClick={() => setExtra(visible + 1)}>
          ＋ 続きの投稿を足す
        </button>
      )}

      {issue && draft.body.trim() !== "" && (
        <p className="field-error" id="composer-issue" role="status">{issue}</p>
      )}
    </div>
  );
}
