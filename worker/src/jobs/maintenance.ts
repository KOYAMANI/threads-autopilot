/**
 * `token_refresh`（SPEC §8.6）と `cleanup`（SPEC §8.7）。
 */
import {
  ACCOUNT_COLUMNS,
  accountToken,
  LONG_LIVED_DAYS,
  tokenExpiresInDays,
  type AccountRow,
} from "../lib/accounts";
import { encrypt } from "../lib/crypto";
import { sendEmail } from "../lib/email";
import { notifyTargets } from "../lib/notify";
import type { JobContext, RunningJob } from "../lib/jobs";
import { refreshLongLivedToken, type CallOptions } from "../lib/threads";
import { DAY_MS } from "../lib/time";

/** 延長できるようになるまで（発行から）。 */
export const REFRESH_MIN_AGE_MS = 24 * 3600_000;
/** 前回の延長からの最小間隔（週1）。 */
export const REFRESH_INTERVAL_MS = 7 * DAY_MS;
/** 残りがこれを切ったら通知する（SPEC §8.6 / §10.5 `token_expiring`）。 */
export const EXPIRY_WARN_DAYS = 7;

export type TokenRefreshOutcome = "skipped" | "refreshed" | "not_long_lived" | "expiring";

export async function tokenRefreshJob(ctx: JobContext, job: RunningJob): Promise<void> {
  if (!job.accountId) return;
  const account = await ctx.db.first<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id=?`,
    job.accountId,
  );
  if (!account || account.status !== "ok") return;
  await refreshAccountToken(ctx, account);
}

/** 手動延長（`POST /accounts/:id/refresh-token`）とジョブで共用する。 */
export async function refreshAccountToken(
  ctx: JobContext,
  account: AccountRow,
  force = false,
): Promise<TokenRefreshOutcome> {
  const nowMs = ctx.now.getTime();
  if (!account.token_long_lived && !force) return "not_long_lived";

  const age = nowMs - Date.parse(account.token_obtained_at);
  const sinceRefresh = account.token_last_refresh_at
    ? nowMs - Date.parse(account.token_last_refresh_at)
    : Number.POSITIVE_INFINITY;

  if (!force && (age < REFRESH_MIN_AGE_MS || sinceRefresh < REFRESH_INTERVAL_MS)) {
    const days = remainingDays(account, nowMs);
    if (days > EXPIRY_WARN_DAYS) return "skipped";
    // 残り7日を切ったら通知（SPEC §8.6）。ジョブは週1なので、送るのも週1になる
    const target = await notifyTargets(ctx.db, account.id);
    if (target) {
      await sendEmail(ctx.env, target.email, "token_expiring", {
        username: account.username,
        days: String(Math.max(0, days)),
        appOrigin: ctx.env.APP_ORIGIN,
      });
    }
    return "expiring";
  }

  const token = await accountToken(ctx.env, account);
  const options: CallOptions = { budget: ctx.budget, env: ctx.env, now: nowMs };
  const res = await refreshLongLivedToken(token, options);
  const next = res.access_token || token;
  const nowIso = ctx.now.toISOString();

  await ctx.db.run(
    "UPDATE accounts SET token_enc=?, token_obtained_at=?, token_last_refresh_at=?, token_long_lived=1 WHERE id=?",
    await encrypt(next, ctx.env.ENC_KEY),
    nowIso,
    nowIso,
    account.id,
  );
  return "refreshed";
}

export function remainingDays(account: AccountRow, nowMs: number): number {
  return tokenExpiresInDays(account, nowMs) ?? 0;
}

export { LONG_LIVED_DAYS };

/* ── cleanup（SPEC §8.7） ──────────────────────────── */

export async function cleanupJob(ctx: JobContext, _job: RunningJob): Promise<void> {
  const now = ctx.now.getTime();
  const ago = (days: number) => new Date(now - days * DAY_MS).toISOString();
  const nowIso = ctx.now.toISOString();

  await ctx.db.batch([
    { sql: "DELETE FROM ap_log WHERE at < ?", params: [ago(90)] },
    { sql: "DELETE FROM jobs WHERE status='done' AND updated_at < ?", params: [ago(7)] },
    { sql: "DELETE FROM sessions WHERE expires_at < ?", params: [nowIso] },
    { sql: "DELETE FROM google_oauth_states WHERE expires_at < ?", params: [nowIso] },
    { sql: "DELETE FROM threads_oauth_states WHERE expires_at < ?", params: [nowIso] },
    { sql: "DELETE FROM google_api_budget WHERE bucket < ?", params: [ago(1)] },
    { sql: "DELETE FROM push_subscriptions WHERE session_id IS NOT NULL AND session_id NOT IN (SELECT id FROM sessions)", params: [] },
    { sql: "DELETE FROM password_resets WHERE expires_at < ?", params: [ago(7)] },
    { sql: "DELETE FROM rate_events WHERE at < ?", params: [ago(1)] },
  ]);

  // 削除された投稿（deleted=1）に紐づく履歴だけ掃除する。
  // 期間では消さない（1投稿あたり最大3行しかないため。SPEC §8.7）
  await ctx.db.run(
    `DELETE FROM post_metrics_history
       WHERE (account_id, post_id) IN (
         SELECT account_id, id FROM posts WHERE deleted=1 AND posted_at < ?
       )`,
    ago(90),
  );
}
