/**
 * 作る画面のエディタ（Typefully / Buffer に倣い、開いたらすぐ書ける場所を主役にする）。
 *
 * 見た目は全画面ビューと同じツリー（アイコンを縦線でつなぐ）。1投稿目と続き（最大3つ）を書く。
 * 作り方を選ぶのは作る画面の最初の手順、AI で直すのは下の帯のシートが受け持つ（DECISIONS 2026-10-19 4回目）。
 * 画像は各投稿に10枚まで。ボタン・貼り付け・ドロップで足す（Typefully に倣う。DECISIONS 2026-10-30）。
 * 「画像」のボタンは書いている投稿の下にだけ出す。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MAX_BODY_LENGTH, MAX_MEDIA_PER_POST, bodyLength, type AccountSummary } from "@tap/shared";
import AccountAvatar from "./AccountAvatar";
import { ImageIcon } from "./Icons";
import MediaStrip, { filesOf, useMediaUploads } from "./MediaStrip";
import { ACCEPT_IMAGES } from "../api/media";
import { Counter, MAX_COMMENTS, draftIssue, hasMedia, withSegmentMedia, type PostDraft } from "./PostFields";

/** 中身に合わせて高さが伸びる入力欄（動かすのは高さの即時変更だけで、アニメーションはしない）。 */
function GrowingText({
  id,
  value,
  placeholder,
  onChange,
  inputRef,
  label,
  onPaste,
}: {
  id: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
  label: string;
  onPaste?: React.ClipboardEventHandler<HTMLTextAreaElement>;
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
      onPaste={onPaste}
    />
  );
}

type Segment = { id: string; value: string; label: string; placeholder: string; set: (v: string) => void };

/** ツリーの1投稿（本文か続き）。文字と画像を持つ。 */
function ComposerSegment({
  account,
  index,
  segment,
  draft,
  onChange,
  inputRef,
}: {
  account: AccountSummary;
  index: number;
  segment: Segment;
  draft: React.MutableRefObject<PostDraft>;
  onChange: (next: PostDraft) => void;
  inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
}) {
  const items = draft.current.media?.[index] ?? [];
  const uploads = useMediaUploads(account.id, items, (fn) =>
    onChange(withSegmentMedia(draft.current, index, fn(draft.current.media?.[index] ?? []))),
  );
  const [dropping, setDropping] = useState(false);
  const full = uploads.count >= MAX_MEDIA_PER_POST;
  const fileRef = useRef<HTMLInputElement | null>(null);

  return (
    <li
      className={`viewer-post${dropping ? " is-dropping" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        const files = filesOf(e.dataTransfer);
        setDropping(false);
        if (files.length === 0) return;
        e.preventDefault();
        uploads.add(files);
      }}
    >
      <div className="viewer-rail" aria-hidden="true">
        <AccountAvatar account={account} />
      </div>
      <div className="viewer-body">
        <div className="viewer-head">
          <strong>@{account.username}</strong>
          {index > 0 && <span className="muted">続き {index}</span>}
          <span className="composer-count"><Counter text={segment.value} /></span>
        </div>
        <GrowingText
          id={segment.id}
          value={segment.value}
          label={segment.label}
          placeholder={segment.placeholder}
          onChange={segment.set}
          inputRef={inputRef}
          onPaste={(e) => {
            const files = filesOf(e.clipboardData);
            if (files.length === 0) return;
            e.preventDefault();
            uploads.add(files);
          }}
        />
        <MediaStrip
          items={items}
          uploads={uploads}
          label={segment.label}
          onChange={(next) => onChange(withSegmentMedia(draft.current, index, next))}
        />
        <div className="composer-tools">
          <button type="button" className="media-add" disabled={full} onClick={() => fileRef.current?.click()}>
            <ImageIcon size={18} />
            画像 <span className="muted num">{uploads.count}/{MAX_MEDIA_PER_POST}</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT_IMAGES}
            multiple
            hidden
            disabled={full}
            onChange={(e) => { uploads.add([...(e.target.files ?? [])]); e.target.value = ""; }}
          />
          {items.length > 1 && <span className="composer-hint">ドラッグで並べ替え。1枚目が最初に出ます</span>}
        </div>
        {uploads.note && <p className="field-error" role="status">{uploads.note}</p>}
      </div>
    </li>
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
  // 画像は送り終えるまで数秒かかる。その間に書き進めた本文を古い値で上書きしないよう、最新の下書きを持っておく
  const latest = useRef(draft);
  latest.current = draft;
  // 同じ描画の間に2枚続けて届いても取りこぼさないよう、渡した値をすぐ最新にする
  const emit = (next: PostDraft) => {
    latest.current = next;
    onChange(next);
  };
  const [extra, setExtra] = useState(0);
  const comments = [...draft.comments, "", "", ""].slice(0, MAX_COMMENTS);
  const lastFilled = comments.reduce((last, text, i) => (text.trim() || hasMedia(draft, i + 1) ? i + 1 : last), 0);
  const visible = Math.max(lastFilled, extra);
  const issue = useMemo(() => draftIssue(draft), [draft]);

  useEffect(() => {
    if (autoFocus) bodyRef.current?.focus();
  }, [autoFocus]);

  function setComment(i: number, value: string) {
    const next = [...comments];
    next[i] = value;
    emit({ ...latest.current, comments: next });
  }

  const segments: Segment[] = [
    { id: "composer-body", value: draft.body, label: "1投稿目", placeholder: "ここに本文を書く", set: (v: string) => emit({ ...latest.current, body: v }) },
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
          <ComposerSegment
            key={s.id}
            account={account}
            index={i}
            segment={s}
            draft={latest}
            onChange={emit}
            inputRef={i === 0 ? bodyRef : undefined}
          />
        ))}
      </ol>

      {visible < MAX_COMMENTS && (
        <button type="button" className="btn-link composer-add" onClick={() => setExtra(visible + 1)}>
          ＋ 続きの投稿を足す
        </button>
      )}

      {issue && (draft.body.trim() !== "" || hasMedia(draft)) && (
        <p className="field-error" id="composer-issue" role="status">{issue}</p>
      )}
    </div>
  );
}
