/**
 * Hono アプリ（SPEC §7）。全ルートは /api 配下。
 * - 認証: Cookie `sid` → sessions。除外は /auth/register, /auth/login, /auth/forgot, /auth/reset, /health, /admin/*
 * - CSRF: 変更系は `X-Requested-With: fetch` 必須（SPEC §5.1）
 * - 応答は必ず {ok:true,data} / {ok:false,error:{code,message}}（SPEC §2.4）
 */
import { Hono } from "hono";
import type { ApiErr } from "@tap/shared";
import { APP_VERSION, type Env } from "./env";
import { budgetFromEnv } from "./lib/budget";
import { BudgetExceeded } from "./lib/budget";
import { createDb, type Db } from "./lib/db";
import { getSession, hasRequestedWith, readCookie, SESSION_COOKIE } from "./lib/session";
import { redact } from "./lib/redact";
import { authRoutes } from "./routes/auth";
import { adminRoutes } from "./routes/admin";
import { healthRoutes } from "./routes/health";

export type Vars = {
  db: Db;
  userId: string | null;
  sessionId: string | null;
};

export type AppEnv = { Bindings: Env; Variables: Vars };

/** 認証を要求しないパス（/api を除いた相対パス）。 */
const PUBLIC_PATHS = new Set([
  "/health",
  "/auth/register",
  "/auth/login",
  "/auth/forgot",
  "/auth/reset",
]);

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.has(path) || path.startsWith("/admin/");
}

export function fail(code: string, message: string, status = 400): Response {
  const body: ApiErr = { ok: false, error: { code, message } };
  return Response.json(body, { status });
}

export function createApp() {
  const app = new Hono<AppEnv>().basePath("/api");

  // 1リクエスト＝1予算。D1 クエリ数は lib/db.ts が自動で数える（SPEC §8.1）
  app.use("*", async (c, next) => {
    const budget = budgetFromEnv(c.env);
    c.set("db", createDb(c.env.DB, budget));
    c.set("userId", null);
    c.set("sessionId", null);
    await next();
  });

  // CSRF（SPEC §5.1）
  app.use("*", async (c, next) => {
    if (!hasRequestedWith(c.req.raw)) {
      return fail("CSRF", "リクエストの形式が正しくありません。画面を再読み込みしてください", 403);
    }
    await next();
  });

  // セッション
  app.use("*", async (c, next) => {
    const path = c.req.path.replace(/^\/api/, "") || "/";
    const sid = readCookie(c.req.raw, SESSION_COOKIE);
    if (sid) {
      const session = await getSession(c.get("db"), sid);
      if (session) {
        c.set("userId", session.user_id);
        c.set("sessionId", session.id);
      }
    }
    if (!isPublic(path) && !c.get("userId")) {
      return fail("UNAUTHORIZED", "ログインしてください", 401);
    }
    await next();
  });

  app.route("/health", healthRoutes());
  app.route("/auth", authRoutes());
  app.route("/admin", adminRoutes());

  app.notFound(() => fail("NOT_FOUND", "見つかりませんでした", 404));

  app.onError((err) => {
    if (err instanceof BudgetExceeded) {
      console.error(`[api] budget exceeded: ${err.kind} ${err.used}/${err.limit}`);
      return fail("BUDGET_EXCEEDED", "処理が混み合っています。少し待ってからもう一度お試しください", 503);
    }
    console.error(`[api] unhandled: ${redact(String(err instanceof Error ? err.stack ?? err.message : err))}`);
    return fail("INTERNAL", "処理に失敗しました。しばらくしてからもう一度お試しください", 500);
  });

  return app;
}

export { APP_VERSION };
