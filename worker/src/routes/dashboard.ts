/**
 * ダッシュボード（SPEC §7.2）。画面は M3 だが API はここで作る。
 *
 * `GET /accounts/:id/dashboard?period=7|14|21|30|90|all`
 * - `delta` = 期間末フォロワー − 期間初フォロワー（1点しかなければ 0）
 * - クリックは期間に関係なく**全期間で按分してから**期間で絞る（SPEC §8.5）
 */
import { Hono } from "hono";
import { allocateClicks, normalizeUrl, ok } from "@tap/shared";
import type { DashboardResponse, PostSummary } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { loadOwnedAccount } from "../lib/accounts";
import { loadUrlTotals } from "../jobs/clicks";
import { DAY_MS } from "../lib/time";
import { POST_SELECT, toPostSummary, type PostRow } from "./post-view";

const PERIODS = [7, 14, 21, 30, 90] as const;

function parsePeriod(raw: string | undefined): number | "all" {
  if (!raw || raw === "all") return raw === "all" ? "all" : 7;
  const n = Number.parseInt(raw, 10);
  return (PERIODS as readonly number[]).includes(n) ? n : 7;
}

export function dashboardRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/:id/dashboard", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const period = parsePeriod(c.req.query("period"));
    const now = new Date();
    const to = now.toISOString();
    const from =
      period === "all"
        ? "1970-01-01T00:00:00.000Z"
        : new Date(now.getTime() - period * DAY_MS).toISOString();
    const fromDate = from.slice(0, 10);
    const toDate = to.slice(0, 10);

    /* ── 投稿（期間内の root すべて。children 付き） ── */
    const allPosts = await db.all<PostRow>(
      `SELECT ${POST_SELECT} FROM posts WHERE account_id=? AND deleted=0 ORDER BY posted_at DESC`,
      account.id,
    );

    const childrenByRoot = new Map<string, PostRow[]>();
    for (const p of allPosts) {
      if (!p.is_reply) continue;
      const list = childrenByRoot.get(p.root_id) ?? [];
      list.push(p);
      childrenByRoot.set(p.root_id, list);
    }
    for (const list of childrenByRoot.values()) {
      list.sort((a, b) => Date.parse(a.posted_at) - Date.parse(b.posted_at));
    }

    /* ── リンク（ラベル付け用） ─────────────────── */
    const linkRows = await db.all<{ url: string; label: string; kind: string }>(
      "SELECT url, label, kind FROM links WHERE account_id=?",
      account.id,
    );
    const linkByUrl = new Map(linkRows.map((l) => [normalizeUrl(l.url), l]));

    const roots = allPosts.filter((p) => !p.is_reply && p.posted_at >= from && p.posted_at <= to);
    const posts: PostSummary[] = roots.map((p) =>
      toPostSummary(p, childrenByRoot.get(p.id) ?? [], linkByUrl),
    );

    /* ── クリック（全期間で按分 → 期間で絞る。SPEC §8.5） ── */
    const urlTotals = await loadUrlTotals({ db }, account.id);
    const alloc = allocateClicks(
      urlTotals,
      allPosts.map((p) => ({ id: p.id, rootId: p.root_id, text: p.text, views: p.views })),
    );
    for (const p of posts) p.clicks = alloc.byRoot.get(p.id) ?? 0;

    // 登録済みリンクと、クリックのあったURLの和集合を出す
    const linkUrls = new Set<string>([...linkByUrl.keys(), ...alloc.byUrl.keys()]);
    const links = [...linkUrls]
      .map((url) => {
        const known = linkByUrl.get(url);
        const v = alloc.byUrl.get(url);
        return {
          url,
          label: known?.label ?? url,
          kind: known?.kind ?? "other",
          clicks: v?.clicks ?? 0,
          posts: v?.posts ?? 0,
        };
      })
      .sort((a, b) => b.clicks - a.clicks || (a.url < b.url ? -1 : 1));

    /* ── フォロワー ─────────────────────────────── */
    const followerRows = await db.all<{ date: string; followers: number }>(
      period === "all"
        ? "SELECT date, followers FROM follower_snapshots WHERE account_id=? ORDER BY date ASC"
        : "SELECT date, followers FROM follower_snapshots WHERE account_id=? AND date>=? ORDER BY date ASC",
      ...(period === "all" ? [account.id] : [account.id, fromDate]),
    );
    const followerSeries = followerRows.map((f) => ({ date: f.date, n: f.followers }));
    const current = followerSeries.at(-1)?.n ?? 0;
    const delta =
      followerSeries.length > 1 ? current - (followerSeries[0]?.n ?? current) : 0;

    /* ── 日別表示回数 ───────────────────────────── */
    const viewRows = await db.all<{ date: string; views: number }>(
      period === "all"
        ? "SELECT date, views FROM daily_views WHERE account_id=? ORDER BY date ASC"
        : "SELECT date, views FROM daily_views WHERE account_id=? AND date>=? AND date<=? ORDER BY date ASC",
      ...(period === "all" ? [account.id] : [account.id, fromDate, toDate]),
    );
    const viewSeries = viewRows.map((v) => ({ date: v.date, v: v.views }));
    const viewTotal = viewSeries.reduce((s, x) => s + x.v, 0);

    const body: DashboardResponse = {
      period: period as DashboardResponse["period"],
      from,
      to,
      followers: { current, delta, series: followerSeries },
      views: { total: viewTotal, series: viewSeries },
      likes: posts.reduce((s, p) => s + p.likes, 0),
      clicks: posts.reduce((s, p) => s + p.clicks, 0),
      posts,
      links,
      unassignedClicks: alloc.unassigned,
    };
    return c.json(ok(body));
  });

  return r;
}
