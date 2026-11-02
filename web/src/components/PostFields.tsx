/**
 * 本文＋コメント①②③の入力（SPEC §12.3 の Create / Queue の編集で共用）。
 *
 * 検査は `shared/src/validate.ts` の `validatePost()` をそのまま使う（SPEC §9.6
 * 「全経路で使う」）。サーバーと同じ関数なので、画面で通ったものはサーバーでも通る。
 * リンクの置き場は手動のキューでは本文でも許す（`link_placement` は M6 の設定）。
 */
import { useMemo, useRef, useState } from "react";
import { MAX_BODY_LENGTH, MAX_MEDIA_PER_POST, alignSegments, bodyLength, validatePost, type MediaItem } from "@tap/shared";
import MediaStrip, { useMediaUploads } from "./MediaStrip";
import { ImageIcon } from "./Icons";
import { ACCEPT_IMAGES } from "../api/media";

/** ツリーは本文＋コメント3本まで（SPEC §1「本文＋コメント①②③」）。 */
export const MAX_COMMENTS = 3;

/**
 * `media[0]` が本文、`media[i]` が `comments[i-1]` の画像。`comments` は空欄も含めた入力欄の並びのまま持ち、
 * 送るときに `draftPayload` で詰める（前の版の途中経過には `media` が無いので省略可）。
 */
export type PostDraft = { body: string; comments: string[]; media?: MediaItem[][] };

export function emptyDraft(): PostDraft {
  return { body: "", comments: ["", "", ""], media: [] };
}

/** サーバーに送る形。文字も画像も無いコメントを外し、画像の並びもそれに合わせて詰める。 */
export function draftPayload(draft: PostDraft): { body: string; comments: string[]; media: MediaItem[][] } {
  const { comments, media } = alignSegments(draft.comments.map((c) => c.trim()), draft.media ?? []);
  return { body: draft.body, comments, media };
}

/** i 番目のセグメント（0 が本文）の画像を差し替えた下書き。 */
export function withSegmentMedia(draft: PostDraft, i: number, next: MediaItem[]): PostDraft {
  const media = [...(draft.media ?? [])];
  while (media.length <= i) media.push([]);
  media[i] = next;
  return { ...draft, media };
}

/** 画像が1枚でも付いているか（本文が空でも出せる）。 */
export function hasMedia(draft: PostDraft, i = 0): boolean {
  return (draft.media?.[i]?.length ?? 0) > 0;
}

/** 空のコメントは落として詰める（サーバーに送る形）。 */
export function trimComments(comments: string[]): string[] {
  return comments.map((c) => c.trim()).filter((c) => c !== "");
}

/** 送る前の検査。通れば null、だめなら最初の問題の文言を返す。 */
export function draftIssue(draft: PostDraft): string | null {
  const { comments, media } = draftPayload(draft);
  const res = validatePost(draft.body, {
    comments,
    media,
    linkPlacement: "body",
  });
  return res.ok ? null : (res.issues[0]?.message ?? "入力に誤りがあります");
}

export function Counter({ text }: { text: string }) {
  const n = bodyLength(text);
  const over = n > MAX_BODY_LENGTH;
  return (
    <span className={`counter num${over ? " counter-over" : ""}`}>
      {n} / {MAX_BODY_LENGTH}
    </span>
  );
}

/** 入力欄の下に置く「画像を足す」とサムネイル（キューの編集シート用。作る画面は Composer が持つ）。 */
function FieldMedia({
  accountId,
  draft,
  index,
  label,
  onChange,
}: {
  accountId: string;
  draft: PostDraft;
  index: number;
  label: string;
  onChange: (next: PostDraft) => void;
}) {
  const latest = useRef(draft);
  latest.current = draft;
  const emit = (next: PostDraft) => {
    latest.current = next;
    onChange(next);
  };
  const items = draft.media?.[index] ?? [];
  const uploads = useMediaUploads(accountId, items, (fn) =>
    emit(withSegmentMedia(latest.current, index, fn(latest.current.media?.[index] ?? []))),
  );
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="field-media">
      <MediaStrip items={items} uploads={uploads} label={label} onChange={(next) => emit(withSegmentMedia(latest.current, index, next))} />
      <button type="button" className="media-add" disabled={uploads.count >= MAX_MEDIA_PER_POST} onClick={() => fileRef.current?.click()}>
        <ImageIcon size={18} />
        画像 <span className="muted num">{uploads.count}/{MAX_MEDIA_PER_POST}</span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT_IMAGES}
        multiple
        hidden
        disabled={uploads.count >= MAX_MEDIA_PER_POST}
        onChange={(e) => { uploads.add([...(e.target.files ?? [])]); e.target.value = ""; }}
      />
      {uploads.note && <p className="field-error" role="status">{uploads.note}</p>}
    </div>
  );
}

export default function PostFields({
  draft,
  onChange,
  autoFocus = false,
  idPrefix = "post",
  compact = false,
  accountId,
}: {
  draft: PostDraft;
  onChange: (next: PostDraft) => void;
  autoFocus?: boolean;
  idPrefix?: string;
  compact?: boolean;
  /** 渡すと、各欄に画像を付けられる */
  accountId?: string | null;
}) {
  const [extraComments, setExtraComments] = useState(0);
  const lastFilled = draft.comments.reduce((last, text, i) => text.trim() ? i + 1 : last, 0);
  const visibleComments = compact ? Math.max(lastFilled, extraComments) : MAX_COMMENTS;
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
          placeholder="ここに本文を書く"
          onChange={(e) => onChange({ ...draft, body: e.target.value })}
        />
      </label>
      {accountId && <FieldMedia accountId={accountId} draft={draft} index={0} label="本文" onChange={onChange} />}

      {comments.slice(0, visibleComments).map((c, i) => (
        <div key={i}>
          <label className="field" htmlFor={`${idPrefix}-c${i}`}>
            <span className="field-head">
              {compact ? `続きの投稿 ${i + 1}` : `コメント${"①②③"[i]}`}
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
          {accountId && <FieldMedia accountId={accountId} draft={draft} index={i + 1} label={`コメント${i + 1}`} onChange={onChange} />}
        </div>
      ))}

      {compact && visibleComments < MAX_COMMENTS && <button type="button" className="btn-quiet section" onClick={() => setExtraComments(visibleComments + 1)}>＋ 続きの投稿を追加</button>}

      {issue && (draft.body.trim() !== "" || hasMedia(draft)) && (
        <p className="msg msg-bad" role="status">
          {issue}
        </p>
      )}
    </>
  );
}
