/**
 * 投稿に付ける画像（DECISIONS 2026-10-30）。web と worker で共有する。
 *
 * 画像はセグメントごとに持つ。`media[0]` が1投稿目、`media[i]` が `comments[i-1]`。
 * 1枚なら IMAGE、2枚以上ならカルーセルとして Threads に出す。
 */
export type MediaItem = {
  /** Threads が取りに来る公開 URL（自前のアップロードは `/m/<id>`） */
  url: string;
  /** 代替テキスト。Threads の `alt_text`（1,000文字まで） */
  alt?: string;
};

/** 1投稿に付けられる枚数。Threads は20枚まで受け付けるが、Typefully と同じ10枚にする */
export const MAX_MEDIA_PER_POST = 10;
export const MAX_ALT_LENGTH = 1000;
/** アップロード1枚の上限（Threads の画像の上限と同じ） */
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
export const MEDIA_TYPES = ["image/jpeg", "image/png"] as const;

/** 何でも受け取り、形の正しい `MediaItem[][]` にする（DB の JSON を読むときにも使う）。 */
export function parseMedia(value: unknown): MediaItem[][] {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v.map((seg) =>
    Array.isArray(seg)
      ? seg.flatMap((m): MediaItem[] => {
          if (!m || typeof m !== "object" || typeof (m as MediaItem).url !== "string") return [];
          const alt = typeof (m as MediaItem).alt === "string" ? (m as MediaItem).alt!.trim() : "";
          return [{ url: (m as MediaItem).url, ...(alt ? { alt } : {}) }];
        })
      : [],
  );
}

/**
 * 本文・コメント・画像をそろえる。本文も画像も無いコメントは外し、画像の並びもそれに合わせて詰める。
 * 末尾の空の画像配列は落とす（画像が無ければ `[]`）。
 */
export function alignSegments(
  comments: string[],
  media: MediaItem[][],
): { comments: string[]; media: MediaItem[][] } {
  const keptComments: string[] = [];
  const keptMedia: MediaItem[][] = [media[0] ?? []];
  comments.forEach((text, i) => {
    const m = media[i + 1] ?? [];
    if (text.trim() === "" && m.length === 0) return;
    keptComments.push(text);
    keptMedia.push(m);
  });
  while (keptMedia.length > 0 && keptMedia[keptMedia.length - 1]!.length === 0) keptMedia.pop();
  return { comments: keptComments, media: keptMedia };
}

/** Threads 上の種類（posts.media_type と同じ値）。 */
export function segmentMediaType(media: MediaItem[] | undefined): "TEXT_POST" | "IMAGE" | "CAROUSEL_ALBUM" {
  const n = media?.length ?? 0;
  return n === 0 ? "TEXT_POST" : n === 1 ? "IMAGE" : "CAROUSEL_ALBUM";
}
