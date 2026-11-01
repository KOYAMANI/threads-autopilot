/**
 * ダッシュボード（SPEC §7.2）。画面は M3 だが API はここで作る。集計は `lib/dashboard.ts`。
 *
 * `GET /accounts/:id/dashboard?period=7|14|21|30|90|all`
 * - `delta` = 期間末フォロワー − 期間初フォロワー（1点しかなければ 0）
 * - クリックは期間に関係なく**全期間で按分してから**期間で絞る（SPEC §8.5）
 */
import { Hono } from "hono";
import { ok } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { loadOwnedAccount } from "../lib/accounts";
import { computeDashboard, DASHBOARD_PERIODS, type DashboardPeriodInput } from "../lib/dashboard";

function parsePeriod(raw: string | undefined): DashboardPeriodInput {
  if (!raw || raw === "all") return raw === "all" ? "all" : 7;
  const n = Number.parseInt(raw, 10);
  return (DASHBOARD_PERIODS as readonly number[]).includes(n) ? (n as DashboardPeriodInput) : 7;
}

export function dashboardRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/:id/dashboard", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const body = await computeDashboard(db, account, parsePeriod(c.req.query("period")));
    return c.json(ok(body));
  });

  return r;
}
