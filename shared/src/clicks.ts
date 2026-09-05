/**
 * クリックの按分（SPEC §8.5「投稿への割り当て」）。純関数。
 *
 * 1. 突合キーは正規化URL（呼び出し側が normalizeUrl() を通してから渡す）
 * 2. 投稿側のURLは extractUrls() で root と children の本文から集める
 * 3. そのURLを含む投稿（root でも child でもよい）の views の比で按分する
 * 4. 1つのツリー内で root と child の両方に同じURLがあるときは max(views) を1回だけ使う
 * 5. 按分した値は root に集約する
 * 6. どの投稿とも一致しないURLの合計が unassigned
 *
 * ジョブ（posts.clicks の更新）とダッシュボード（links / unassignedClicks）の
 * 両方から同じ関数を呼ぶ。AI は使わない決定的な計算（SPEC §10 冒頭）。
 */
import { extractUrls, normalizeUrl } from "./url";

export type ClickPost = {
  id: string;
  rootId: string;
  text: string;
  views: number;
};

export type ClickAllocation = {
  /** root の投稿ID → 按分後のクリック数 */
  byRoot: Map<string, number>;
  /** 正規化URL → {clicks: そのURLの総クリック, posts: 含むツリーの本数} */
  byUrl: Map<string, { clicks: number; posts: number }>;
  /** どの投稿とも一致しなかったクリックの合計 */
  unassigned: number;
  /** 投稿に割り当てられたクリックの合計 */
  assigned: number;
};

/**
 * ツリーごとの「そのURLに対する重み」を出す（SPEC §8.5 手順4）。
 * 同じツリー内に同じURLが複数あっても max(views) で1回だけ数える。
 */
function weightsByUrl(posts: ClickPost[]): Map<string, Map<string, number>> {
  // url → (rootId → weight)
  const out = new Map<string, Map<string, number>>();
  for (const p of posts) {
    const views = Number.isFinite(p.views) ? Math.max(0, p.views) : 0;
    for (const raw of extractUrls(p.text)) {
      const url = normalizeUrl(raw);
      if (url === "") continue;
      let trees = out.get(url);
      if (!trees) {
        trees = new Map<string, number>();
        out.set(url, trees);
      }
      const prev = trees.get(p.rootId);
      if (prev === undefined || views > prev) trees.set(p.rootId, views);
    }
  }
  return out;
}

/**
 * @param urlTotals 正規化済みURL → クリック合計（click_weeks の SUM）
 * @param posts     対象アカウントの投稿（root / child の両方。deleted は除いて渡す）
 */
export function allocateClicks(
  urlTotals: Map<string, number>,
  posts: ClickPost[],
): ClickAllocation {
  const trees = weightsByUrl(posts);
  const byRoot = new Map<string, number>();
  const byUrl = new Map<string, { clicks: number; posts: number }>();
  let unassigned = 0;
  let assigned = 0;

  for (const [url, total] of urlTotals) {
    const clicks = Number.isFinite(total) ? Math.max(0, total) : 0;
    const holders = trees.get(url);
    byUrl.set(url, { clicks, posts: holders ? holders.size : 0 });

    if (!holders || holders.size === 0) {
      unassigned += clicks;
      continue;
    }
    let sum = 0;
    for (const w of holders.values()) sum += w;

    for (const [rootId, w] of holders) {
      // views が全部 0 のときは頭割り（0除算を避ける）
      const share = sum > 0 ? (clicks * w) / sum : clicks / holders.size;
      byRoot.set(rootId, (byRoot.get(rootId) ?? 0) + share);
      assigned += share;
    }
  }

  return { byRoot, byUrl, unassigned, assigned };
}
