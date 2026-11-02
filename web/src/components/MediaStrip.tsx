/**
 * 投稿に付ける画像（Typefully に倣う。DECISIONS 2026-10-30）。
 *
 * - `useMediaUploads`: ボタン・貼り付け・ドロップで受けたファイルを縮めて送る。送っている間と
 *   失敗したものは手元だけに持ち、送り終えたら `MediaItem` として下書きに入れる
 * - `MediaStrip`: 1枚は全幅、2枚は2列、3枚以上は横に流す帯（Threads のカルーセルの見え方）。
 *   ×で外す・ドラッグで並べ替え・「+ALT」で説明を付ける
 */
import { useEffect, useRef, useState } from "react";
import { MAX_ALT_LENGTH, MAX_MEDIA_PER_POST, type MediaItem } from "@tap/shared";
import { ApiError } from "../api/client";
import { isAcceptedImage, uploadImage } from "../api/media";
import { CloseIcon } from "./Icons";
import Sheet from "./Sheet";

type Pending = { id: string; preview: string; file: File; failed: boolean };

export type MediaUploads = {
  pending: Pending[];
  /** 何枚付いているか（送っている途中も数える） */
  count: number;
  note: string | null;
  add: (files: File[]) => void;
  retry: (id: string) => void;
  discard: (id: string) => void;
};

/**
 * `update` は「いまの画像の並び」を受け取って次を返す関数を渡す形にする。送り終わるのは
 * 数秒あとなので、その間に書いた本文や外した画像を古い値で上書きしないため。
 */
export function useMediaUploads(
  accountId: string | null,
  items: MediaItem[],
  update: (fn: (prev: MediaItem[]) => MediaItem[]) => void,
): MediaUploads {
  const [pending, setPending] = useState<Pending[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => () => pending.forEach((p) => URL.revokeObjectURL(p.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  function send(p: Pending) {
    if (!accountId) return;
    uploadImage(accountId, p.file).then(
      (url) => {
        if (!live.current) return;
        update((prev) => [...prev, { url }].slice(0, MAX_MEDIA_PER_POST));
        setPending((list) => list.filter((x) => x.id !== p.id));
        URL.revokeObjectURL(p.preview);
      },
      (e: unknown) => {
        if (!live.current) return;
        setPending((list) => list.map((x) => (x.id === p.id ? { ...x, failed: true } : x)));
        if (e instanceof ApiError && e.code === "BAD_IMAGE") setNote(e.message);
      },
    );
  }

  function add(files: File[]) {
    const notes: string[] = [];
    const ok = files.filter(isAcceptedImage);
    if (ok.length < files.length) notes.push("JPEG・PNG・WebP・HEIC の画像だけ付けられます");
    const room = MAX_MEDIA_PER_POST - items.length - pending.length;
    if (ok.length > room) notes.push(`1投稿に付けられる画像は${MAX_MEDIA_PER_POST}枚までです`);
    setNote(notes.length ? notes.join("。") : null);
    const next = ok.slice(0, Math.max(0, room)).map((file) => ({
      id: crypto.randomUUID(),
      preview: URL.createObjectURL(file),
      file,
      failed: false,
    }));
    if (next.length === 0) return;
    setPending((list) => [...list, ...next]);
    next.forEach(send);
  }

  return {
    pending,
    count: items.length + pending.length,
    note,
    add,
    retry: (id) => {
      const p = pending.find((x) => x.id === id);
      if (!p) return;
      setNote(null);
      setPending((list) => list.map((x) => (x.id === id ? { ...x, failed: false } : x)));
      send(p);
    },
    discard: (id) => {
      const p = pending.find((x) => x.id === id);
      if (p) URL.revokeObjectURL(p.preview);
      setPending((list) => list.filter((x) => x.id !== id));
    },
  };
}

/** 貼り付け・ドロップされたものから画像ファイルだけを取り出す。 */
export function filesOf(data: DataTransfer | null): File[] {
  return data ? [...data.files].filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name)) : [];
}

export default function MediaStrip({
  items,
  uploads,
  onChange,
  label,
}: {
  items: MediaItem[];
  uploads: MediaUploads;
  onChange: (next: MediaItem[]) => void;
  /** 読み上げ用（「1投稿目」など） */
  label: string;
}) {
  const [altFor, setAltFor] = useState<number | null>(null);
  const [altText, setAltText] = useState("");
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const total = items.length + uploads.pending.length;
  if (total === 0) return null;
  const layout = total === 1 ? "one" : total === 2 ? "two" : "many";

  function move(from: number, to: number) {
    if (from === to) return;
    const next = [...items];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    onChange(next);
  }

  return (
    <>
      <ul className={`media-strip media-${layout}`} aria-label={`${label}の画像 ${total}枚`}>
        {items.map((m, i) => (
          <li
            key={m.url}
            className={`media-thumb${dragFrom === i ? " is-dragging" : ""}${dragOver === i && dragFrom !== null ? " is-over" : ""}`}
            draggable={items.length > 1}
            onDragStart={(e) => {
              setDragFrom(i);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/x-media-index", String(i));
            }}
            onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
            onDragOver={(e) => {
              if (dragFrom === null) return;
              e.preventDefault();
              e.stopPropagation();
              setDragOver(i);
            }}
            onDrop={(e) => {
              if (dragFrom === null) return;
              e.preventDefault();
              e.stopPropagation();
              move(dragFrom, i);
              setDragFrom(null);
              setDragOver(null);
            }}
          >
            <img src={m.url} alt={m.alt ?? ""} draggable={false} />
            {total > 1 && <span className="media-order num" aria-hidden="true">{i + 1}</span>}
            <button
              type="button"
              className={`media-alt${m.alt ? " is-set" : ""}`}
              onClick={() => { setAltFor(i); setAltText(m.alt ?? ""); }}
              aria-label={m.alt ? `${i + 1}枚目の説明を直す` : `${i + 1}枚目に説明を付ける`}
            >
              {m.alt ? "ALT ✓" : "+ALT"}
            </button>
            <button type="button" className="media-x" aria-label={`${i + 1}枚目を外す`} onClick={() => onChange(items.filter((_, k) => k !== i))}>
              <CloseIcon size={14} />
            </button>
          </li>
        ))}
        {uploads.pending.map((p) => (
          <li key={p.id} className="media-thumb is-pending">
            <img src={p.preview} alt="" />
            <div className="media-veil" role="status">
              {p.failed ? (
                <>
                  <span>送れませんでした</span>
                  <button type="button" className="media-retry" onClick={() => uploads.retry(p.id)}>再試行</button>
                </>
              ) : (
                <span className="media-spinner" aria-label="送っています" />
              )}
            </div>
            <button type="button" className="media-x" aria-label="この画像をやめる" onClick={() => uploads.discard(p.id)}>
              <CloseIcon size={14} />
            </button>
          </li>
        ))}
      </ul>

      <Sheet open={altFor !== null} onClose={() => setAltFor(null)} title="画像の説明（代替テキスト）">
        {altFor !== null && items[altFor] && (
          <div className="media-alt-sheet">
            <img src={items[altFor]!.url} alt="" />
            <label className="field" htmlFor="media-alt-text">
              <span className="field-head">
                見えない人にも伝わるように、写っているものを書く
                <span className="counter num">{[...altText].length} / {MAX_ALT_LENGTH}</span>
              </span>
              <textarea
                id="media-alt-text"
                className="input"
                rows={4}
                maxLength={MAX_ALT_LENGTH}
                value={altText}
                onChange={(e) => setAltText(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const alt = altText.trim();
                onChange(items.map((m, k) => (k === altFor ? { url: m.url, ...(alt ? { alt } : {}) } : m)));
                setAltFor(null);
              }}
            >
              保存する
            </button>
          </div>
        )}
      </Sheet>
    </>
  );
}
