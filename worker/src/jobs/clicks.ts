/**
 * `clicks` ジョブ（SPEC §8.5）。URL別クリックの週グリッドと、投稿への按分。
 *
 * - 起点 `CLICK_FLOOR = 1712991600`（2024-04-13）から7日刻みの**固定**グリッド。
 *   実行時刻に依存しないので、何度回しても同じ週になり二重計上しない
 * - 遡る下限は「いちばん古い投稿の1週間前」
 * - 直近2週は毎回数え直し。それ以前は `click_weeks_done` に無い週だけ、1回の実行で最大26週
 * - 同じ週×URLで前回より小さい値が来たら前回を残す
 * - 按分は `shared/src/clicks.ts` の `allocateClicks()`（ダッシュボードと同じ関数）
 */
import { allocateClicks, normalizeUrl } from "@tap/shared";
import { ACCOUNT_COLUMNS, accountToken, type AccountRow } from "../lib/accounts";
import type { JobContext, RunningJob } from "../lib/jobs";
import { getLinkClicks, type CallOptions } from "../lib/threads";
import { clickWeeks, type ClickWeek } from "../lib/time";

/** 直近この本数の週は毎回数え直す（確定させない）。 */
export const HOT_WEEKS = 2;
/** 1回の実行で新しく取りにいく「確定済みでない過去週」の上限。 */
export const MAX_OLD_WEEKS_PER_RUN = 26;

type ClicksState = {
  /** 未取得の週。[index, sinceSec, untilSec, weekEnd, hot] */
  weeks?: Array<[number, number, number, string, 0 | 1]>;
  /** 週の取得が終わって按分だけ残っているか */
  allocate?: boolean;
};

export type ClickPostRow = { id: string; root_id: string; text: string; views: number };

/** 取りにいく週を決める（新しい順）。 */
export async function pickWeeks(
  ctx: JobContext,
  accountId: string,
): Promise<Array<{ week: ClickWeek; hot: boolean }>> {
  const oldest = await ctx.db.first<{ p: string | null }>(
    "SELECT MIN(posted_at) AS p FROM posts WHERE account_id=?",
    accountId,
  );
  const oldestMs = oldest?.p ? Date.parse(oldest.p) : null;
  const all = clickWeeks(ctx.now.getTime(), Number.isFinite(oldestMs as number) ? oldestMs : null);

  const doneRows = await ctx.db.all<{ week_end: string }>(
    "SELECT week_end FROM click_weeks_done WHERE account_id=?",
    accountId,
  );
  const done = new Set(doneRows.map((r) => r.week_end));

  const out: Array<{ week: ClickWeek; hot: boolean }> = [];
  let oldPicked = 0;
  for (let i = 0; i < all.length; i++) {
    const week = all[i]!;
    const hot = i < HOT_WEEKS;
    if (hot) {
      out.push({ week, hot });
      continue;
    }
    if (done.has(week.weekEnd)) continue;
    if (oldPicked >= MAX_OLD_WEEKS_PER_RUN) break;
    oldPicked++;
    out.push({ week, hot });
  }
  return out;
}

export async function clicksJob(ctx: JobContext, job: RunningJob): Promise<void> {
  if (!job.accountId) return;
  const accountId = job.accountId;
  const account = await ctx.db.first<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id=?`,
    accountId,
  );
  if (!account || account.status !== "ok") return;

  const state = job.state as ClicksState;
  if (!state.weeks && !state.allocate) {
    const picked = await pickWeeks(ctx, accountId);
    state.weeks = picked.map(
      ({ week, hot }) =>
        [week.index, week.sinceSec, week.untilSec, week.weekEnd, hot ? 1 : 0] as [
          number,
          number,
          number,
          string,
          0 | 1,
        ],
    );
  }

  const token = await accountToken(ctx.env, account);
  const options: CallOptions = { budget: ctx.budget, env: ctx.env, now: ctx.now.getTime() };
  const nowIso = ctx.now.toISOString();

  while (state.weeks && state.weeks.length > 0) {
    ctx.budget.timeMs.check();
    const [, sinceSec, untilSec, weekEnd, hot] = state.weeks[0]!;
    const values = await getLinkClicks(token, { sinceSec, untilSec }, options);

    // 正規化してから週内で合算する。同じ正規化URLが1文の中で2回出ると
    // SQLite の ON CONFLICT DO UPDATE が同じ行を二度触れずエラーになるため
    const byUrl = new Map<string, number>();
    for (const v of values) {
      const url = normalizeUrl(v.url);
      if (url === "") continue;
      byUrl.set(url, (byUrl.get(url) ?? 0) + Math.max(0, v.clicks));
    }

    if (byUrl.size > 0) {
      await ctx.db.run(
        `INSERT INTO click_weeks(account_id,week_end,url,clicks,fetched_at)
         SELECT ?,?,key,value,? FROM json_each(?) WHERE 1
         ON CONFLICT(account_id,week_end,url) DO UPDATE SET
           clicks=MAX(excluded.clicks,click_weeks.clicks), fetched_at=excluded.fetched_at`,
        accountId, weekEnd, nowIso, JSON.stringify(Object.fromEntries(byUrl)),
      );
    }

    if (!hot) {
      await ctx.db.run(
        "INSERT INTO click_weeks_done (account_id, week_end) VALUES (?,?) ON CONFLICT(account_id, week_end) DO NOTHING",
        accountId,
        weekEnd,
      );
    }
    state.weeks.shift();
  }

  state.allocate = true;
  await allocateToPosts(ctx, accountId);
  state.allocate = false;
}

/** 期間に関係なく全期間で按分してから `posts.clicks`（root のみ）に書く（SPEC §7.2 / §8.5）。 */
export async function allocateToPosts(ctx: JobContext, accountId: string): Promise<void> {
  const totals = await loadUrlTotals(ctx, accountId);
  const posts = await ctx.db.all<ClickPostRow>(
    "SELECT id, root_id, text, views FROM posts WHERE account_id=? AND deleted=0",
    accountId,
  );
  const alloc = allocateClicks(
    totals,
    posts.map((p) => ({ id: p.id, rootId: p.root_id, text: p.text, views: p.views })),
  );

  const values = Object.fromEntries([...alloc.byRoot].filter(([, v]) => v > 0));
  await ctx.db.batch([
    { sql: "UPDATE posts SET clicks=0 WHERE account_id=? AND clicks<>0", params: [accountId] },
    { sql: `UPDATE posts SET clicks=j.value FROM json_each(?) AS j
            WHERE posts.account_id=? AND posts.id=j.key`, params: [JSON.stringify(values), accountId] },
  ]);
}

/** `click_weeks` の合計（正規化URLごと）。ダッシュボードからも使う。 */
export async function loadUrlTotals(
  ctx: { db: JobContext["db"] },
  accountId: string,
): Promise<Map<string, number>> {
  const rows = await ctx.db.all<{ url: string; c: number }>(
    "SELECT url, SUM(clicks) AS c FROM click_weeks WHERE account_id=? GROUP BY url",
    accountId,
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    const url = normalizeUrl(r.url);
    if (url === "") continue;
    out.set(url, (out.get(url) ?? 0) + (Number(r.c) || 0));
  }
  return out;
}
