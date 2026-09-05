/**
 * `posts` の行 → API の `PostSummary`（SPEC §7.2 / §7.3）。
 * ダッシュボードと投稿一覧・詳細で同じ形を返すためにここに1つだけ置く。
 */
import { classifyHook, extractUrls, normalizeUrl, type PostSummary } from "@tap/shared";

export type PostRow = {
  id: string;
  root_id: string;
  is_reply: number;
  text: string;
  permalink: string | null;
  media_type: string;
  media_url: string | null;
  link_attachment_url: string | null;
  posted_at: string;
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  shares: number;
  clicks: number;
  tags_json: string;
};

export const POST_SELECT =
  "id, root_id, is_reply, text, permalink, media_type, media_url, link_attachment_url, posted_at, views, likes, replies, reposts, quotes, shares, clicks, tags_json";

function hookOf(row: PostRow): string {
  try {
    const tags = JSON.parse(row.tags_json) as { hook?: string };
    if (tags?.hook) return tags.hook;
  } catch {
    // tags_json が壊れていても本文から出せる
  }
  return classifyHook(row.text);
}

/** ツリー（root と children）に出てくる最初のURLを代表リンクにする。 */
function pickLink(
  row: PostRow,
  children: PostRow[],
  links: Map<string, { label: string; kind: string }>,
): PostSummary["link"] {
  const candidates: string[] = [];
  if (row.link_attachment_url) candidates.push(row.link_attachment_url);
  for (const t of [row.text, ...children.map((c) => c.text)]) {
    for (const u of extractUrls(t)) candidates.push(u);
  }
  for (const raw of candidates) {
    const url = normalizeUrl(raw);
    if (url === "") continue;
    const known = links.get(url);
    return { url, label: known?.label ?? url, kind: known?.kind ?? "other" };
  }
  return null;
}

export function toPostSummary(
  row: PostRow,
  children: PostRow[],
  links: Map<string, { label: string; kind: string }>,
): PostSummary {
  return {
    id: row.id,
    text: row.text,
    permalink: row.permalink,
    postedAt: row.posted_at,
    mediaType: row.media_type,
    hasImage: row.media_type === "IMAGE" || row.media_type === "CAROUSEL_ALBUM",
    views: row.views,
    likes: row.likes,
    replies: row.replies,
    reposts: row.reposts,
    quotes: row.quotes,
    shares: row.shares,
    clicks: row.clicks,
    link: pickLink(row, children, links),
    hook: hookOf(row),
    children: children.map((ch) => ({ id: ch.id, text: ch.text, views: ch.views })),
  };
}
