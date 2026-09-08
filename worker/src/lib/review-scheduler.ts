import type { JobContext } from "./jobs";
import { enqueuePublish } from "../jobs/publish";
import { reviewPublishingActive } from "./staging-review-policy";

/** Only manual posts belonging to the dedicated reviewer are dispatched. */
export async function dispatchReviewPublishing(ctx: JobContext): Promise<void> {
  if (!reviewPublishingActive(ctx.env, ctx.now.getTime()) || !ctx.env.JOB_QUEUE) return;
  const now = ctx.now.toISOString();
  const account = await ctx.sys.first<{id:string}>(`SELECT a.id FROM accounts a
    WHERE a.user_id=? AND a.threads_user_id=? AND a.status='ok'
    AND EXISTS (SELECT 1 FROM queue q WHERE q.account_id=a.id AND q.source<>'autopilot'
      AND q.status IN ('scheduled','publishing') AND q.scheduled_at<=?
      AND (q.next_step_at IS NULL OR q.next_step_at<=?)) LIMIT 1`,
    ctx.env.STAGING_REVIEW_USER_ID!, ctx.env.STAGING_THREADS_USER_ID!, now, now);
  if (!account) return;
  await ctx.sys.run(`UPDATE jobs SET status='pending',dispatched_until=NULL
    WHERE type='publish' AND account_id=? AND status='running' AND updated_at<?`,
    account.id, new Date(ctx.now.getTime()-600_000).toISOString());
  await enqueuePublish(ctx, account.id, ctx.now);
  const lease = new Date(ctx.now.getTime()+300_000).toISOString();
  const claims = await ctx.sys.all<{id:string}>(`UPDATE jobs SET dispatched_until=?
    WHERE type='publish' AND account_id=? AND status='pending' AND next_run_at<=?
    AND (dispatched_until IS NULL OR dispatched_until<=?) RETURNING id`, lease, account.id, now, now);
  if (!claims.length) return;
  try { await ctx.env.JOB_QUEUE.sendBatch(claims.map(row=>({body:{jobId:row.id}}))); }
  catch {
    await ctx.sys.run(`UPDATE jobs SET dispatched_until=NULL WHERE type='publish' AND account_id=? AND status='pending' AND dispatched_until=?`, account.id, lease);
    throw new Error("Reviewer publishing dispatch failed");
  }
}
