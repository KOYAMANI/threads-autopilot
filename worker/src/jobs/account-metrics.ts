/**
 * アカウント単位の数字を取るジョブ（SPEC §8.4）。
 * - `daily_views`   … 直近63日を7日窓で取得し `daily_views` へ upsert
 * - `followers`     … `followers_count` を当日の `follower_snapshots` へ upsert（取れた回だけ）
 * - `demographics`  … 週1。フォロワー100人未満は失敗して良い
 */
import { ACCOUNT_COLUMNS, accountToken, type AccountRow } from "../lib/accounts";
import { isBudgetExceeded } from "../lib/budget";
import { buildUpsertChunks } from "../lib/db";
import type { JobContext, RunningJob } from "../lib/jobs";
import {
  getDailyViews,
  getDemographics,
  getFollowersCount,
  type CallOptions,
} from "../lib/threads";
import { DAY_MS, tzDate, unixSec } from "../lib/time";
import { isReauthError } from "../lib/accounts";

/** SPEC §8.4「直近63日を7日窓で」。 */
export const DAILY_VIEWS_DAYS = 63;
export const DAILY_VIEWS_WINDOW_DAYS = 7;

/** SPEC §6.3 が例示する breakdown。テーブルは複数持てるが M2 は age だけ取る。 */
export const DEMOGRAPHIC_BREAKDOWNS = ["age"] as const;

async function requireAccount(ctx: JobContext, job: RunningJob): Promise<AccountRow | null> {
  if (!job.accountId) return null;
  const a = await ctx.db.first<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id=?`,
    job.accountId,
  );
  return a && a.status === "ok" ? a : null;
}

/* ── daily_views ───────────────────────────────────── */

type DailyViewsState = { windows?: Array<[number, number]> };

/** 直近 63日を7日窓に割る（新しい側から）。境界は now を起点にした固定計算。 */
export function dailyViewWindows(nowMs: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let offset = 0; offset < DAILY_VIEWS_DAYS; offset += DAILY_VIEWS_WINDOW_DAYS) {
    const until = nowMs - offset * DAY_MS;
    const since = until - DAILY_VIEWS_WINDOW_DAYS * DAY_MS + 1000;
    out.push([unixSec(since), unixSec(until)]);
  }
  return out;
}

export async function dailyViewsJob(ctx: JobContext, job: RunningJob): Promise<void> {
  const account = await requireAccount(ctx, job);
  if (!account) return;
  const state = job.state as DailyViewsState;
  state.windows ??= dailyViewWindows(ctx.now.getTime());

  const token = await accountToken(ctx.env, account);
  const options: CallOptions = { budget: ctx.budget, env: ctx.env, now: ctx.now.getTime() };

  while (state.windows.length > 0) {
    ctx.budget.timeMs.check();
    const [sinceSec, untilSec] = state.windows[0]!;
    const values = await getDailyViews(token, { sinceSec, untilSec }, options);
    if (values.length > 0) {
      // 同じ日付が複数返っても1行にまとめる（PK 衝突を1文の中で起こさない）
      const byDate = new Map<string, number>();
      for (const v of values) byDate.set(v.date, v.views);
      const rows = [...byDate].map(([date, views]) => [account.id, date, views]);
      await ctx.db.batch(
        buildUpsertChunks(
          "daily_views",
          ["account_id", "date", "views"],
          rows,
          ["account_id", "date"],
          ["views"],
        ),
      );
    }
    state.windows.shift();
  }
}

/* ── followers ─────────────────────────────────────── */

export async function followersJob(ctx: JobContext, job: RunningJob): Promise<void> {
  const account = await requireAccount(ctx, job);
  if (!account) return;
  const token = await accountToken(ctx.env, account);
  const options: CallOptions = { budget: ctx.budget, env: ctx.env, now: ctx.now.getTime() };

  const n = await getFollowersCount(token, options);
  if (n === null) return; // 取れた回だけ記録する（SPEC §8.4）

  await ctx.db.run(
    `INSERT INTO follower_snapshots (account_id, date, followers) VALUES (?,?,?)
       ON CONFLICT(account_id, date) DO UPDATE SET followers=excluded.followers`,
    account.id,
    tzDate(ctx.now, account.timezone),
    n,
  );
}

/* ── demographics（週1） ───────────────────────────── */

export async function demographicsJob(ctx: JobContext, job: RunningJob): Promise<void> {
  const account = await requireAccount(ctx, job);
  if (!account) return;
  const token = await accountToken(ctx.env, account);
  const options: CallOptions = { budget: ctx.budget, env: ctx.env, now: ctx.now.getTime() };
  const nowIso = ctx.now.toISOString();

  for (const breakdown of DEMOGRAPHIC_BREAKDOWNS) {
    ctx.budget.timeMs.check();
    try {
      const data = await getDemographics(token, breakdown, options);
      if (data === null) continue;
      await ctx.db.run(
        `INSERT INTO demographics (account_id, breakdown, json, fetched_at) VALUES (?,?,?,?)
           ON CONFLICT(account_id, breakdown) DO UPDATE SET json=excluded.json, fetched_at=excluded.fetched_at`,
        account.id,
        breakdown,
        JSON.stringify(data),
        nowIso,
      );
    } catch (e) {
      // フォロワー100人未満は失敗して良い（SPEC §6.3）。
      // 予算切れ（再開が必要）とトークン失効（needs_reauth）だけは上へ投げる
      if (isBudgetExceeded(e) || isReauthError(e)) throw e;
    }
  }
}
