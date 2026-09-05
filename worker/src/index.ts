/**
 * Worker の入口（SPEC §2.1）。
 * - fetch:     /api/* を Hono、それ以外は Workers Static Assets（SPA）
 * - scheduled: Cron Triggers（SPEC §8.2）。中身は M2
 */
import type { Env } from "./env";
import { createApp } from "./app";
import { createJobContext, enqueueForCron, runJobs } from "./lib/jobs";
import { redact } from "./lib/redact";

const app = createApp();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }

    // GET|POST /a/:token（メールからの承認/取消、SPEC §7.9）は M6 で実装する。
    // それまでは SPA 側に落とさず、Worker がそのまま日本語のHTMLを返す。
    if (url.pathname.startsWith("/a/")) {
      return new Response(
        "<!doctype html><html lang=\"ja\"><meta charset=\"utf-8\"><title>準備中</title>" +
          "<body style=\"font-family:system-ui;padding:2rem\"><p>この機能はまだ使えません。</p></body></html>",
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
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
