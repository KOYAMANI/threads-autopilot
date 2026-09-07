/**
 * `insights_recent` / `insights_daily` / `insights_old`（SPEC §8.4）。
 *
 * 対象投稿を `metrics_fetched_at` の古い順に、予算内で `/{id}/insights` を叩く。
 * - `posts` の現在値（views/likes/...）は毎回更新する
 * - 取れなかったメトリクスは前回値を残す（0 で上書きしない）
 * - 履歴は**チェックポイント方式**。投稿からの経過が 48h/7d/30d を初めて超えた取得時に
 *   `post_metrics_history` へ1行だけ入れる（1投稿あたり最大3行）
 * - 30日を超えてから初めて取得した投稿は 48h と 7d を埋めない（後から作らない）
 *
 * 再開は `state_json.pending`（未処理の投稿）で行う。
 */
import { accountToken, type AccountRow } from "../lib/accounts";
import { ACCOUNT_COLUMNS } from "../lib/accounts";
import { BudgetExceeded } from "../lib/budget";
import type { JobContext, RunningJob } from "../lib/jobs";
import { getPostInsights, type CallOptions } from "../lib/threads";
import { DAY_MS } from "../lib/time";

export type InsightsWindow = "recent" | "daily" | "old";

/** SPEC §8.4 のチェックポイント（新しい順に見る）。 */
export const CHECKPOINTS: Array<{ name: "48h" | "7d" | "30d"; ms: number }> = [
  { name: "48h", ms: 48 * 3600_000 },
  { name: "7d", ms: 7 * DAY_MS },
  { name: "30d", ms: 30 * DAY_MS },
];

/** 1回の投入で拾う投稿数の上限（予算内で処理しきれない分は次回の日次で拾う）。 */
export const MAX_TARGETS = 200;

/** `[id, postedAt, metricsFetchedAt|null]` */
type Pending = [string, string, string | null];

type InsightsState = { pending?: Pending[]; initial?: boolean; startedAt?: string; fullBatch?: boolean };

/** 対象の期間（SPEC §8.2: recent=3日以内 / daily=3〜60日 / old=60日超）。 */
function windowSql(window: InsightsWindow): string {
  return {
    recent: "posted_at >= ?",
    daily: "posted_at < ? AND posted_at >= ?",
    old: "posted_at < ?",
  }[window];
}

function windowBounds(window: InsightsWindow, now: Date): string[] {
  const d3 = new Date(now.getTime() - 3 * DAY_MS).toISOString();
  const d60 = new Date(now.getTime() - 60 * DAY_MS).toISOString();
  if (window === "recent") return [d3];
  if (window === "daily") return [d3, d60];
  return [d60];
}

/**
 * この取得で新しく越えたチェックポイントを返す（SPEC §8.4）。
 * - 初回取得（`prevFetchedAt` が null）は、いま入っている帯の1つだけ（後から埋めない）
 * - 2回目以降は「前回の経過 < しきい値 <= 今回の経過」を満たすものすべて
 */
export function crossedCheckpoints(
  postedAt: number,
  nowMs: number,
  prevFetchedAtMs: number | null,
): Array<"48h" | "7d" | "30d"> {
  const age = nowMs - postedAt;
  const crossed = CHECKPOINTS.filter((c) => age >= c.ms);
  if (crossed.length === 0) return [];
  if (prevFetchedAtMs === null) {
    // いちばん大きい帯だけ入れる。48h と 7d は後から作らない
    return [crossed[crossed.length - 1]!.name];
  }
  const prevAge = prevFetchedAtMs - postedAt;
  return crossed.filter((c) => prevAge < c.ms).map((c) => c.name);
}

export function insightsJob(window: InsightsWindow) {
  return async function run(ctx: JobContext, job: RunningJob): Promise<void> {
    if (!job.accountId) return;
    const account = await ctx.db.first<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id=?`,
      job.accountId,
    );
    if (!account || account.status !== "ok") return;

    const state = job.state as InsightsState;
    state.startedAt ??= ctx.now.toISOString();
    if (!state.pending) {
      const rows = await ctx.db.all<{
        id: string;
        posted_at: string;
        metrics_fetched_at: string | null;
      }>(
        `SELECT id, posted_at, metrics_fetched_at FROM posts
          WHERE account_id=? AND deleted=0 AND ${windowSql(window)}
          ${state.initial ? "AND (metrics_fetched_at IS NULL OR metrics_fetched_at < ?) AND posted_at >= ?" : ""}
          ORDER BY metrics_fetched_at IS NULL DESC, metrics_fetched_at ASC
          LIMIT ${ctx.env.WORKERS_PLAN === "free" ? 50 : MAX_TARGETS}`,
        job.accountId,
        ...windowBounds(window, ctx.now),
        ...(state.initial ? [state.startedAt, new Date(Date.parse(state.startedAt) - 90 * DAY_MS).toISOString()] : []),
      );
      state.fullBatch = rows.length === (ctx.env.WORKERS_PLAN === "free" ? 50 : MAX_TARGETS);
      state.pending = rows.map((r) => [r.id, r.posted_at, r.metrics_fetched_at] as Pending);
    }

    if (state.pending.length === 0) return;

    const token = await accountToken(ctx.env, account);
    const options: CallOptions = { budget: ctx.budget, env: ctx.env, now: ctx.now.getTime() };
    const nowIso = ctx.now.toISOString();

    while (state.pending.length > 0) {
      ctx.budget.timeMs.check();
      const entry = state.pending[0]!;
      const [postId, postedAt, prevFetched] = entry;

      const m = await getPostInsights(token, postId, options);

      // 取れなかったメトリクスは前回値を残す（COALESCE で 0 上書きを防ぐ）
      await ctx.db.run(
        `UPDATE posts SET
            views=COALESCE(?, views), likes=COALESCE(?, likes), replies=COALESCE(?, replies),
            reposts=COALESCE(?, reposts), quotes=COALESCE(?, quotes), shares=COALESCE(?, shares),
            metrics_fetched_at=?
          WHERE account_id=? AND id=?`,
        m.views ?? null,
        m.likes ?? null,
        m.replies ?? null,
        m.reposts ?? null,
        m.quotes ?? null,
        m.shares ?? null,
        nowIso,
        job.accountId,
        postId,
      );

      const marks = crossedCheckpoints(
        Date.parse(postedAt),
        ctx.now.getTime(),
        prevFetched ? Date.parse(prevFetched) : null,
      );
      for (const cp of marks) {
        await ctx.db.run(
          `INSERT INTO post_metrics_history (account_id, post_id, checkpoint, at, views, likes, replies, reposts, quotes)
             VALUES (?,?,?,?,?,?,?,?,?)
             ON CONFLICT(account_id, post_id, checkpoint) DO NOTHING`,
          job.accountId,
          postId,
          cp,
          nowIso,
          m.views ?? null,
          m.likes ?? null,
          m.replies ?? null,
          m.reposts ?? null,
          m.quotes ?? null,
        );
      }

      // ここまで来て初めて未処理から外す（予算切れで途中終了しても取り直せる）
      state.pending.shift();
    }
    if (state.initial && state.fullBatch) {
      delete state.pending;
      throw new BudgetExceeded("subrequests", 1, 1);
    }
  };
}
