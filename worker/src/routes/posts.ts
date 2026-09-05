/**
 * 投稿（SPEC §7.3）。
 * - `GET /accounts/:id/posts?q=&sort=views|likes|clicks|new&limit=30&cursor=`
 * - `GET /accounts/:id/posts/:postId`（詳細＋48h/7d/30d の履歴）
 * - `POST /accounts/:id/posts/:postId/repost`
 *
 * 投稿は必ず `(account_id, id)` の組で引く（SPEC §2.4 / §4）。
 */
import { Hono } from "hono";
import { normalizeUrl, ok } from "@tap/shared";
import type { PostDetailResponse, PostHistoryPoint, PostSummary } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { accountToken, loadOwnedAccount } from "../lib/accounts";
import { repost, type CallOptions } from "../lib/threads";
import { POST_SELECT, toPostSummary, type PostRow } from "./post-view";

const SORTS = {
  views: "views DESC",
  likes: "likes DESC",
  clicks: "clicks DESC",
  new: "posted_at DESC",
} as const;

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

async function linkMap(
  db: AppEnv["Variables"]["db"],
  accountId: string,
): Promise<Map<string, { label: string; kind: string }>> {
  const rows = await db.all<{ url: string; label: string; kind: string }>(
    "SELECT url, label, kind FROM links WHERE account_id=?",
    accountId,
  );
  return new Map(rows.map((l) => [normalizeUrl(l.url), { label: l.label, kind: l.kind }]));
}

/** root に紐づく children をまとめて引く。 */
async function childrenOf(
  db: AppEnv["Variables"]["db"],
  accountId: string,
  rootIds: string[],
): Promise<Map<string, PostRow[]>> {
  const out = new Map<string, PostRow[]>();
  for (let i = 0; i < rootIds.length; i += 80) {
    const chunk = rootIds.slice(i, i + 80);
    if (chunk.length === 0) continue;
    const rows = await db.all<PostRow>(
      `SELECT ${POST_SELECT} FROM posts
         WHERE account_id=? AND deleted=0 AND is_reply=1 AND root_id IN (${chunk.map(() => "?").join(",")})
         ORDER BY posted_at ASC`,
      accountId,
      ...chunk,
    );
    for (const r of rows) {
      const list = out.get(r.root_id) ?? [];
      list.push(r);
      out.set(r.root_id, list);
    }
  }
  return out;
}

export function postRoutes() {
  const r = new Hono<AppEnv>();

  /* ── 一覧（投稿選択用） ────────────────────────── */
  r.get("/:id/posts", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const q = (c.req.query("q") ?? "").trim();
    const sortKey = (c.req.query("sort") ?? "new") as keyof typeof SORTS;
    const order = SORTS[sortKey] ?? SORTS.new;
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number.parseInt(c.req.query("limit") ?? "", 10) || DEFAULT_LIMIT),
    );
    const offset = Math.max(0, Number.parseInt(c.req.query("cursor") ?? "", 10) || 0);

    const where = ["account_id=?", "deleted=0", "is_reply=0"];
    const args: unknown[] = [account.id];
    if (q !== "") {
      where.push("text LIKE ?");
      args.push(`%${q}%`);
    }

    const rows = await db.all<PostRow>(
      `SELECT ${POST_SELECT} FROM posts WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...args,
      limit + 1,
      offset,
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const links = await linkMap(db, account.id);
    const children = await childrenOf(
      db,
      account.id,
      page.map((p) => p.id),
    );
    const posts: PostSummary[] = page.map((p) =>
      toPostSummary(p, children.get(p.id) ?? [], links),
    );
    return c.json(ok({ posts, cursor: hasMore ? String(offset + limit) : null }));
  });

  /* ── 詳細＋履歴（48h / 7d / 30d の3点） ──────────── */
  r.get("/:id/posts/:postId", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const row = await db.first<PostRow>(
      `SELECT ${POST_SELECT} FROM posts WHERE account_id=? AND id=?`,
      account.id,
      c.req.param("postId"),
    );
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const links = await linkMap(db, account.id);
    const children = await childrenOf(db, account.id, [row.id]);
    const historyRows = await db.all<{
      checkpoint: string;
      at: string;
      views: number | null;
      likes: number | null;
      replies: number | null;
      reposts: number | null;
      quotes: number | null;
    }>(
      "SELECT checkpoint, at, views, likes, replies, reposts, quotes FROM post_metrics_history WHERE account_id=? AND post_id=?",
      account.id,
      row.id,
    );
    const order = { "48h": 0, "7d": 1, "30d": 2 } as Record<string, number>;
    const history: PostHistoryPoint[] = historyRows
      .map((h) => ({ ...h, checkpoint: h.checkpoint as PostHistoryPoint["checkpoint"] }))
      .sort((a, b) => (order[a.checkpoint] ?? 9) - (order[b.checkpoint] ?? 9));

    const body: PostDetailResponse = {
      post: toPostSummary(row, children.get(row.id) ?? [], links),
      history,
    };
    return c.json(ok(body));
  });

  /* ── リポスト（SPEC §7.3） ────────────────────────── */
  r.post("/:id/posts/:postId/repost", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    if (account.status !== "ok") {
      return fail("ACCOUNT_NOT_READY", "アカウントをつなぎ直してください", 400);
    }

    const postId = c.req.param("postId");
    const exists = await db.first<{ id: string }>(
      "SELECT id FROM posts WHERE account_id=? AND id=?",
      account.id,
      postId,
    );
    if (!exists) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const options: CallOptions = { budget: c.get("budget"), env: c.env };
    const token = await accountToken(c.env, account);
    const res = await repost(token, postId, options);
    return c.json(ok({ id: res.id }));
  });

  return r;
}
