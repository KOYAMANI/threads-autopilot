import type { JobContext } from "./jobs";
import { enqueuePublish } from "../jobs/publish";
import { reviewPublishingActive } from "./staging-review-policy";
import { betaPublishingActive, allStagingUsers } from "./staging-beta-policy";

/** Dispatch only manual work for the reviewer or explicitly granted student profiles. */
export async function dispatchReviewPublishing(ctx: JobContext): Promise<void> {
  const reviewer = reviewPublishingActive(ctx.env, ctx.now.getTime());
  const beta = betaPublishingActive(ctx.env, ctx.now.getTime());
  if ((!reviewer && !beta) || !ctx.env.JOB_QUEUE) return;
  const now = ctx.now.toISOString();
  const accounts = await ctx.sys.all<{id:string}>(`SELECT a.id FROM accounts a
    JOIN users u ON u.id=a.user_id JOIN licenses l ON l.id=u.license_id
    WHERE a.status='ok' AND l.status='active' AND (?=1 OR (
      (?=1 AND a.user_id=? AND a.threads_user_id=?) OR
      (?=1 AND EXISTS (SELECT 1 FROM staging_beta_licenses b WHERE b.license_id=l.id)
       AND EXISTS (SELECT 1 FROM staging_beta_profiles p WHERE p.user_id=a.user_id
        AND p.threads_user_id=a.threads_user_id AND p.enabled=1))))
    AND EXISTS (SELECT 1 FROM queue q WHERE q.account_id=a.id AND q.source<>'autopilot'
      AND q.status IN ('scheduled','publishing') AND q.scheduled_at<=?
      AND (q.next_step_at IS NULL OR q.next_step_at<=?))
    ORDER BY (SELECT MIN(COALESCE(q.next_step_at,q.scheduled_at)) FROM queue q
      WHERE q.account_id=a.id AND q.source<>'autopilot' AND q.status IN ('scheduled','publishing'))
    LIMIT 3`, allStagingUsers(ctx.env) ? 1 : 0, reviewer ? 1 : 0, ctx.env.STAGING_REVIEW_USER_ID ?? '',
    ctx.env.STAGING_THREADS_USER_ID ?? '', beta ? 1 : 0, now, now);
  for (const account of accounts) {
    await ctx.sys.run(`UPDATE jobs SET status='pending',dispatched_until=NULL
      WHERE type='publish' AND account_id=? AND status='running' AND updated_at<?`,
      account.id, new Date(ctx.now.getTime()-600_000).toISOString());
    await enqueuePublish(ctx, account.id, ctx.now);
    const lease = new Date(ctx.now.getTime()+300_000).toISOString();
    const claims = await ctx.sys.all<{id:string}>(`UPDATE jobs SET dispatched_until=?
      WHERE type='publish' AND account_id=? AND status='pending' AND next_run_at<=?
      AND (dispatched_until IS NULL OR dispatched_until<=?) RETURNING id`, lease, account.id, now, now);
    if (!claims.length) continue;
    try { await ctx.env.JOB_QUEUE.sendBatch(claims.map(row=>({body:{jobId:row.id}}))); }
    catch {
      await ctx.sys.run(`UPDATE jobs SET dispatched_until=NULL WHERE type='publish' AND account_id=? AND status='pending' AND dispatched_until=?`, account.id, lease);
      throw new Error("Staging publishing dispatch failed");
    }
  }
}
