/**
 * Worker の入口（SPEC §2.1）。
 * - fetch:     /api/* を Hono、それ以外は Workers Static Assets（SPA）
 * - /a/*:     メールからの承認/取消（SPEC §7.9。Cookie 非依存）
 * - scheduled: Cron Triggers（SPEC §8.2）
 */
import type { Env } from "./env";
import { createApp } from "./app";
import { createJobContext, enqueueForCron, runJobs } from "./lib/jobs";
import { redact } from "./lib/redact";
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
      return handleAction(request, env);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const jobCtx = createJobContext(env);
          await enqueueForCron(jobCtx, event.cron);
          await runJobs(jobCtx);
        } catch (e) {
          console.error(`[cron] ${event.cron} failed: ${redact(String(e))}`);
        }
      })(),
    );
  },
};
