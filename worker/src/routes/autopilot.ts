/**
 * オートパイロット（SPEC §7.7）。
 *
 * | メソッド/パス | 内容 |
 * |---|---|
 * | `GET/PUT /accounts/:id/autopilot` | 設定。`enabled=true` の条件は §7.7 の4つ |
 * | `GET /accounts/:id/autopilot/learning` | 集計。`n < 10` の行は数値を null で返す |
 * | `GET /accounts/:id/autopilot/log?limit=50` | `ap_log` |
 * | `GET /accounts/:id/autopilot/next` | 次の自動投稿（ApBar が読む） |
 *
 * 返す数字は集計そのもの。倍率・おすすめ・予測は出さない（SPEC §9.2 末尾）。
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  DEFAULT_HOOK_ORDER,
  ok,
  slotLabel,
  toLearningAggregate,
  type ApLogEntry,
  type AutopilotBlocker,
  type AutopilotResponse,
  type LearningRow,
} from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { loadOwnedAccount } from "../lib/accounts";
import { audit } from "../lib/audit";
import {
  AUTOPILOT_SELECT,
  BLOCKER_MESSAGE,
  apLog,
  autopilotBlockers,
  loadAutopilot,
  toAutopilotSettings,
  type AutopilotRow,
} from "../lib/autopilot";
import { attachMetrics, parseJsonArray, QUEUE_SELECT, toQueueItem, type QueueRow } from "../lib/queue";
import { formatSlot } from "../jobs/plan";

const HOOKS = DEFAULT_HOOK_ORDER as unknown as [string, ...string[]];

const putSchema = z.object({
  enabled: z.boolean().optional(),
  perWeek: z.number().int().min(1).max(21).optional(),
  slotMode: z.enum(["auto", "fixed"]).optional(),
  fixedHour: z.number().int().min(0).max(23).nullable().optional(),
  approvalMode: z.enum(["manual", "cancel", "auto"]).optional(),
  approvalWindowH: z.number().int().min(1).max(48).optional(),
  dailyLimit: z.number().int().min(1).max(5).optional(),
  quietHours: z.boolean().optional(),
  ngWords: z.string().max(2000).optional(),
  linkPlacement: z.enum(["comment", "body", "none"]).optional(),
  hookMode: z.enum(["auto", "fixed"]).optional(),
  fixedHook: z.enum(HOOKS).nullable().optional(),
  scoreWeights: z.enum(["balanced", "followers", "clicks"]).optional(),
});

function toResponse(row: AutopilotRow, blockers: AutopilotBlocker[]): AutopilotResponse {
  return {
    settings: toAutopilotSettings(row),
    canEnable: blockers.length === 0,
    blockers,
    blockerMessages: blockers.map((b) => BLOCKER_MESSAGE[b]),
  };
}

export function autopilotRoutes() {
  const r = new Hono<AppEnv>();

  /* ── 学習（SPEC §7.7）。`/:id/autopilot` より先に登録する ── */
  r.get("/:id/autopilot/learning", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const rows = await db.all<{
      dim: string;
      value: string;
      n: number;
      score_sum: number;
      views_sum: number;
      like_rate_sum: number;
    }>(
      "SELECT dim, value, n, score_sum, views_sum, like_rate_sum FROM learning WHERE account_id=?",
      account.id,
    );

    // dim='source' の value は sources.id。消えている行もあるのでタイトルは引けた分だけ
    const sourceIds = rows.filter((x) => x.dim === "source" && x.value !== "external").map((x) => x.value);
    const titles = new Map<string, string>();
    if (sourceIds.length > 0) {
      const found = await db.all<{ id: string; title: string }>(
        `SELECT id, title FROM sources WHERE user_id=? AND id IN (${sourceIds.map(() => "?").join(",")})`,
        c.get("userId")!,
        ...sourceIds,
      );
      for (const s of found) titles.set(s.id, s.title);
    }

    const out: LearningRow[] = rows.map((row) => {
      const agg = toLearningAggregate({
        dim: row.dim,
        value: row.value,
        n: row.n,
        scoreSum: row.score_sum,
        viewsSum: row.views_sum,
        likeRateSum: row.like_rate_sum,
      });
      const label =
        row.dim === "slot"
          ? slotLabel(row.value)
          : row.dim === "source"
            ? (row.value === "external" ? "取り込んだ投稿" : (titles.get(row.value) ?? null))
            : null;
      return { ...agg, label };
    });
    // 平均表示回数の降順（数値なしの行は後ろ。SPEC §12.3）
    out.sort((a, b) => (b.avgViews ?? -1) - (a.avgViews ?? -1) || b.n - a.n);
    return c.json(ok({ rows: out }));
  });

  /* ── ログ（SPEC §7.7） ───────────────────────────── */
  r.get("/:id/autopilot/log", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const limit = Math.min(200, Math.max(1, Number.parseInt(c.req.query("limit") ?? "50", 10) || 50));
    const rows = await db.all<{
      id: string;
      at: string;
      kind: string;
      message: string;
      ref_id: string | null;
    }>(
      "SELECT id, at, kind, message, ref_id FROM ap_log WHERE account_id=? ORDER BY at DESC LIMIT ?",
      account.id,
      limit,
    );
    const entries: ApLogEntry[] = rows.map((x) => ({
      id: x.id,
      at: x.at,
      kind: x.kind,
      message: x.message,
      refId: x.ref_id,
    }));
    return c.json(ok({ entries }));
  });

  /* ── 次の自動投稿（SPEC §7.7。ApBar が読む） ─────── */
  r.get("/:id/autopilot/next", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const ap = await loadAutopilot(db, account.id);
    const row = await db.first<QueueRow>(
      `SELECT ${QUEUE_SELECT} FROM queue
         WHERE account_id=? AND source='autopilot' AND status IN ('pending_approval','scheduled')
         ORDER BY scheduled_at ASC LIMIT 1`,
      account.id,
    );

    let summary: string;
    if (!ap.enabled) {
      summary = "オートパイロットはオフです";
    } else if (!row) {
      summary = "次の下書きを準備しています";
    } else {
      const when = row.scheduled_at ? formatSlot(row.scheduled_at, account.timezone) : "未定";
      summary =
        row.status === "pending_approval"
          ? `次は ${when}。承認するまで出しません`
          : row.approve_deadline
            ? `次は ${when}。${formatSlot(row.approve_deadline, account.timezone)} まで取り消せます`
            : `次は ${when} に自動で出します`;
    }

    const metrics = row ? await attachMetrics(db, account.id, [row]) : null;
    const rootId = row ? parseJsonArray(row.result_ids_json)[0] : undefined;
    return c.json(
      ok({
        enabled: Boolean(ap.enabled),
        item: row ? toQueueItem(row, rootId ? (metrics?.get(rootId) ?? null) : null) : null,
        summary,
      }),
    );
  });

  /* ── 設定（SPEC §7.7） ───────────────────────────── */
  r.get("/:id/autopilot", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const row = await loadAutopilot(db, account.id);
    const blockers = await autopilotBlockers(db, {
      accountId: account.id,
      userId: c.get("userId")!,
      accountStatus: account.status,
    });
    return c.json(ok(toResponse(row, blockers)));
  });

  r.put("/:id/autopilot", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const input = parsed.data;

    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const prev = await loadAutopilot(db, account.id);
    const blockers = await autopilotBlockers(db, {
      accountId: account.id,
      userId: c.get("userId")!,
      accountStatus: account.status,
    });

    // ON にできない理由があるときは、理由を添えて断る（画面はトーストに出す。SPEC §12.3）
    if (input.enabled === true && blockers.length > 0) {
      return fail("AP_BLOCKED", BLOCKER_MESSAGE[blockers[0]!], 409);
    }

    const next: AutopilotRow = {
      ...prev,
      enabled: input.enabled === undefined ? prev.enabled : input.enabled ? 1 : 0,
      per_week: input.perWeek ?? prev.per_week,
      slot_mode: input.slotMode ?? prev.slot_mode,
      fixed_hour: input.fixedHour === undefined ? prev.fixed_hour : input.fixedHour,
      approval_mode: input.approvalMode ?? prev.approval_mode,
      approval_window_h: input.approvalWindowH ?? prev.approval_window_h,
      daily_limit: input.dailyLimit ?? prev.daily_limit,
      quiet_hours: input.quietHours === undefined ? prev.quiet_hours : input.quietHours ? 1 : 0,
      ng_words: input.ngWords ?? prev.ng_words,
      link_placement: input.linkPlacement ?? prev.link_placement,
      hook_mode: input.hookMode ?? prev.hook_mode,
      fixed_hook: input.fixedHook === undefined ? prev.fixed_hook : input.fixedHook,
      score_weights: input.scoreWeights ?? prev.score_weights,
      // オンに戻したら失敗の数え直し（SPEC §9.4-4 の3連続は「続けて」の意味）
      consecutive_failures:
        input.enabled === true && !prev.enabled ? 0 : prev.consecutive_failures,
      updated_at: new Date().toISOString(),
    };

    await db.run(
      `INSERT INTO autopilot (account_id, enabled, per_week, slot_mode, fixed_hour, approval_mode,
          approval_window_h, daily_limit, quiet_hours, ng_words, link_placement, hook_mode, fixed_hook,
          score_weights, consecutive_failures, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(account_id) DO UPDATE SET
           enabled=excluded.enabled, per_week=excluded.per_week, slot_mode=excluded.slot_mode,
           fixed_hour=excluded.fixed_hour, approval_mode=excluded.approval_mode,
           approval_window_h=excluded.approval_window_h, daily_limit=excluded.daily_limit,
           quiet_hours=excluded.quiet_hours, ng_words=excluded.ng_words,
           link_placement=excluded.link_placement, hook_mode=excluded.hook_mode,
           fixed_hook=excluded.fixed_hook, score_weights=excluded.score_weights,
           consecutive_failures=excluded.consecutive_failures, updated_at=excluded.updated_at`,
      next.account_id,
      next.enabled,
      next.per_week,
      next.slot_mode,
      next.fixed_hour,
      next.approval_mode,
      next.approval_window_h,
      next.daily_limit,
      next.quiet_hours,
      next.ng_words,
      next.link_placement,
      next.hook_mode,
      next.fixed_hook,
      next.score_weights,
      next.consecutive_failures,
      next.updated_at,
    );

    if (input.enabled !== undefined && Boolean(input.enabled) !== Boolean(prev.enabled)) {
      await apLog(
        db,
        account.id,
        input.enabled ? "plan" : "stopped",
        input.enabled ? "オートパイロットをオンにしました" : "オートパイロットをオフにしました",
      );
      // SPEC §13 M7「AP ON/OFF」を監査に残す
      await audit(db, c.get("userId")!, input.enabled ? "autopilot.on" : "autopilot.off", {
        accountId: account.id,
      });
    }

    return c.json(ok(toResponse(next, blockers)));
  });

  return r;
}
