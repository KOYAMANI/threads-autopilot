/**
 * Worker の入口（SPEC §2.1）。
 * - fetch:     /api/* を Hono、それ以外は Workers Static Assets（SPA）
 * - /a/*:     メールからの承認/取消（SPEC §7.9。Cookie 非依存）
 * - scheduled: Cron Triggers（SPEC §8.2）
 */
import type { Env } from "./env";
import { createApp } from "./app";
import { createJobContext, createSchedulerContext, enqueueForCron, runJobs, dispatchJobs } from "./lib/jobs";
import { createSchedulerHealthDb, recordSchedulerStart, recordSchedulerFinish } from "./lib/scheduler-health";
import { enqueueSheetSyncs } from "./jobs/sheets";
import { dispatchReviewPublishing } from "./lib/review-scheduler";
import { handleAction } from "./routes/action";

const app = createApp();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }

    // GET|POST /a/:token（メールからの承認/取消、SPEC §7.9）。
    // Cookie を読まない専用経路なので Hono（/api の CSRF・セッション）には載せない。
    if (url.pathname.startsWith("/a/")) {
      if (env.MAINTENANCE_MODE === "1") return new Response("メンテナンス中です", {status:503,headers:{"Cache-Control":"no-store"}});
      return handleAction(request, env);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },

  async queue(batch: MessageBatch<{jobId:string}>, env: Env): Promise<void> {
    if (env.MAINTENANCE_MODE === "1") { for (const message of batch.messages) message.ack(); return; }
    // Small configured batches keep total CPU/DB budget bounded per invocation.
    let handled = false;
    for (const message of batch.messages) {
      if (env.WORKERS_PLAN === "free" && handled) { message.retry({delaySeconds:60}); continue; }
      handled = true;
      if (typeof message.body?.jobId !== "string") { message.ack(); continue; }
      try {
        const result = await runJobs(createJobContext(env), undefined, message.body.jobId);
        // Budget checkpoints are successful slices, not retries of failed work.
        // Send a fresh message so long imports do not hit the queue retry limit.
        if (result.deferred && env.JOB_QUEUE) await env.JOB_QUEUE.send(message.body, {delaySeconds: 1});
        message.ack();
      }
      catch { message.retry({delaySeconds:60}); }
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const healthDb = createSchedulerHealthDb(env);
        const runId = crypto.randomUUID();
        try {
          await recordSchedulerStart(healthDb, event.cron, runId, new Date(event.scheduledTime));
          if (env.MAINTENANCE_MODE === "1") {
            await recordSchedulerFinish(healthDb, event.cron, runId, "paused");
            return;
          }
          // Staging dispatches only the explicitly enabled reviewer's manual posts.
          if (env.APP_ENV === "staging") {
            await dispatchReviewPublishing(createSchedulerContext(env));
          } else {
            const jobCtx = createSchedulerContext(env);
            await enqueueForCron(jobCtx, event.cron);
            await enqueueSheetSyncs(jobCtx);
            if (env.JOB_QUEUE) await dispatchJobs(jobCtx);
            else if (env.WORKERS_PLAN !== "free") await runJobs(jobCtx);
          }
          await recordSchedulerFinish(healthDb, event.cron, runId, "success");
        } catch {
          try { await recordSchedulerFinish(healthDb, event.cron, runId, "error"); }
          catch { /* The platform still records failure even if D1 is unavailable. */ }
          // Surface failure to Cloudflare instead of reporting a successful Cron.
          // Provider/DB exception bodies may contain data, so keep telemetry generic.
          throw new Error("Scheduled task failed; inspect scheduler status and job outcomes");
        }
      })(),
    );
  },
};
