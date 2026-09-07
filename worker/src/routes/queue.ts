/**
 * キュー（SPEC §7.4）。アプリ内から操作するときの経路。
 * メールのリンクからの承認/取消は `GET|POST /a/:token`（§7.9、M6）。
 *
 * 作成・編集は必ず `validatePost()` を通す（SPEC §9.6「全経路で使う」）。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  MIN_SAMPLES_LEARNING,
  ok,
  suggestSlot,
  validatePost,
  type QueueItem,
  type SuggestSlotResponse,
} from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { audit } from "../lib/audit";
import { canPublishAccount, loadOwnedAccount } from "../lib/accounts";
import { recentAutoTags } from "../lib/autopilot";
import { jobContextFrom } from "../lib/jobs";
import { enqueuePublish } from "../jobs/publish";
import {
  attachMetrics,
  parseJsonArray,
  publishSettings,
  QUEUE_SELECT,
  toQueueItem,
  type QueueRow,
} from "../lib/queue";

const REPLY_CONTROLS = ["everyone", "accounts_you_follow", "mentioned_only"] as const;

const createSchema = z.object({
  status: z.enum(["draft", "scheduled", "now"]),
  scheduledAt: z.string().min(1).optional(),
  body: z.string().max(4000),
  comments: z.array(z.string().max(4000)).max(10).optional(),
  imageUrl: z.string().trim().url().max(2000).nullable().optional(),
  replyControl: z.enum(REPLY_CONTROLS).optional(),
  originPostId: z.string().max(64).nullable().optional(),
  sourceIds: z.array(z.string().max(64)).max(20).optional(),
});

const patchSchema = z.object({
  body: z.string().max(4000).optional(),
  comments: z.array(z.string().max(4000)).max(10).optional(),
  scheduledAt: z.string().min(1).nullable().optional(),
  imageUrl: z.string().trim().url().max(2000).nullable().optional(),
  replyControl: z.enum(REPLY_CONTROLS).optional(),
  status: z.enum(["draft", "scheduled"]).optional(),
});

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** ISO8601 として読めるか。読めたら UTC の ISO に揃えて返す。 */
function parseAt(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t).toISOString();
}

/**
 * 本文とコメントの検査（SPEC §9.6）。
 * `link_placement` は M6 のオートパイロット設定なので、手動のキューでは本文にリンクを
 * 置くこと自体は許す（`body`）。見るのは空・500文字・リンク5本・NGワード。
 */
function check(body: string, comments: string[]): { message: string } | null {
  const res = validatePost(body, { comments, linkPlacement: "body" });
  return res.ok ? null : { message: res.issues[0]!.message };
}

async function loadRow(
  db: AppEnv["Variables"]["db"],
  accountId: string,
  qid: string,
): Promise<QueueRow | null> {
  return db.first<QueueRow>(
    `SELECT ${QUEUE_SELECT} FROM queue WHERE id=? AND account_id=?`,
    qid,
    accountId,
  );
}

async function itemOf(
  db: AppEnv["Variables"]["db"],
  accountId: string,
  row: QueueRow,
): Promise<QueueItem> {
  const metrics = await attachMetrics(db, accountId, [row]);
  const rootId = parseJsonArray(row.result_ids_json)[0];
  return toQueueItem(row, rootId ? (metrics.get(rootId) ?? null) : null);
}

export function queueRoutes() {
  const r = new Hono<AppEnv>();

  /* ── 一覧（SPEC §7.4） ────────────────────────────── */
  r.get("/:id/queue", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const raw = (c.req.query("status") ?? "").trim();
    const wanted = raw === "" ? [] : raw.split(",").map((s) => s.trim()).filter(Boolean);
    const where = ["account_id=?"];
    const args: unknown[] = [account.id];
    if (wanted.length > 0) {
      where.push(`status IN (${wanted.map(() => "?").join(",")})`);
      args.push(...wanted);
    }
    const rows = await db.all<QueueRow>(
      `SELECT ${QUEUE_SELECT} FROM queue WHERE ${where.join(" AND ")}
         ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT 200`,
      ...args,
    );
    const metrics = await attachMetrics(db, account.id, rows);
    const items = rows.map((row) => {
      const rootId = parseJsonArray(row.result_ids_json)[0];
      return toQueueItem(row, rootId ? (metrics.get(rootId) ?? null) : null);
    });
    return c.json(ok({ items }));
  });

  /* ── おすすめ枠（SPEC §7.4 / §9.3） ──────────────────
   * `/:id/queue/:qid` より先に置く。Hono は先に登録した方が勝つ。
   */
  r.get("/:id/queue/suggest-slot", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const ap = await db.first<{ quiet_hours: number; slot_mode: string; fixed_hour: number | null; daily_limit: number }>(
      "SELECT quiet_hours, slot_mode, fixed_hour, daily_limit FROM autopilot WHERE account_id=?",
      account.id,
    );
    const taken = await db.all<{ scheduled_at: string }>(
      "SELECT scheduled_at FROM queue WHERE account_id=? AND status IN ('scheduled','pending_approval','publishing') AND scheduled_at IS NOT NULL",
      account.id,
    );
    // 実績（`learning` の `dim='slot'`）と直近の自動投稿を渡す。ここが AP の枠選択と
    // 同じ関数（`suggestSlot`）を通るので、画面のおすすめと自動投稿の枠が一致する（SPEC §9.3）
    const learned = await db.all<{ value: string; n: number; score_sum: number }>(
      "SELECT value, n, score_sum FROM learning WHERE account_id=? AND dim='slot' AND n>=?",
      account.id,
      MIN_SAMPLES_LEARNING,
    );
    const recent = await recentAutoTags(db, account.id, 3);
    const settings = publishSettings(account);
    const body: SuggestSlotResponse = suggestSlot({
      nowMs: Date.now(),
      tz: account.timezone,
      quietHours: (ap?.quiet_hours ?? 1) === 1,
      slotMode: (ap?.slot_mode as "auto" | "fixed") ?? "auto",
      fixedHour: ap?.fixed_hour ?? null,
      taken: taken.map((t) => t.scheduled_at),
      dailyLimit: ap?.daily_limit ?? 1,
      minGapMin: settings.minGapMin,
      history: learned.map((x) => ({
        value: x.value,
        n: x.n,
        avgScore: x.n > 0 ? x.score_sum / x.n : 0,
      })),
      recentValues: recent.map((r) => r.slot).filter((v): v is string => v !== null),
    });
    return c.json(ok(body));
  });

  /* ── 作成（SPEC §7.4） ────────────────────────────── */
  r.post("/:id/queue", async (c) => {
    const parsed = createSchema.safeParse(await readJson(c));
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const input = parsed.data;
    if (input.status !== "draft" && !canPublishAccount(account)) return fail("CONFLICT", "Threads APIを設定で連携してから予約してください", 409);
    const comments = (input.comments ?? []).filter((t) => t.trim() !== "");
    const bad = check(input.body, comments);
    if (bad) return fail("VALIDATION", bad.message, 400);

    const nowIso = new Date().toISOString();
    let status: string = input.status === "now" ? "scheduled" : input.status;
    let scheduledAt: string | null = null;
    if (input.status === "now") {
      scheduledAt = nowIso;
    } else if (input.status === "scheduled") {
      const at = parseAt(input.scheduledAt);
      if (!at) return fail("BAD_REQUEST", "投稿する日時を指定してください", 400);
      scheduledAt = at;
    } else {
      // draft でも日時だけ先に持っておける
      const at = parseAt(input.scheduledAt ?? null);
      scheduledAt = at ?? null;
      status = "draft";
    }

    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO queue (id, account_id, status, scheduled_at, body, comments_json, image_url, reply_control,
          source, approval_mode, approve_deadline, notified_at, action_token_used_at, step, next_step_at,
          container_id, container_polls, result_ids_json, error, error_raw, attempts, tags_json,
          origin_post_id, source_ids_json, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?, 'manual', NULL, NULL, NULL, NULL, 0, NULL, NULL, 0, '[]', NULL, NULL, 0, '{}', ?,?,?,?)`,
      id,
      account.id,
      status,
      scheduledAt,
      input.body,
      JSON.stringify(comments),
      input.imageUrl ?? null,
      input.replyControl ?? "everyone",
      input.originPostId ?? null,
      JSON.stringify(input.sourceIds ?? []),
      nowIso,
      nowIso,
    );

    if (status === "scheduled" && scheduledAt) {
      await schedulePublish(c, account.id, scheduledAt);
    }
    const row = (await loadRow(db, account.id, id))!;
    return c.json(ok({ item: await itemOf(db, account.id, row) }), 201);
  });

  /* ── 編集・日時変更（SPEC §7.4） ─────────────────── */
  r.patch("/:id/queue/:qid", async (c) => {
    const parsed = patchSchema.safeParse(await readJson(c));
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const row = await loadRow(db, account.id, c.req.param("qid"));
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);
    if (row.status === "publishing" || row.status === "done") {
      return fail("CONFLICT", "この投稿はもう編集できません", 409);
    }

    const input = parsed.data;
    const body = input.body ?? row.body;
    const comments = (input.comments ?? parseJsonArray(row.comments_json)).filter(
      (t) => t.trim() !== "",
    );
    const bad = check(body, comments);
    if (bad) return fail("VALIDATION", bad.message, 400);

    const at = parseAt(input.scheduledAt);
    if (input.scheduledAt !== undefined && at === undefined) {
      return fail("BAD_REQUEST", "日時の形式が正しくありません", 400);
    }
    const scheduledAt = at === undefined ? row.scheduled_at : at;
    const status = input.status ?? (row.status === "failed" ? "draft" : row.status);
    if ((status === "scheduled" || status === "pending_approval") && !canPublishAccount(account)) return fail("CONFLICT", "Threads APIを設定で連携し直してから予約してください", 409);
    if (status === "scheduled" && !scheduledAt) {
      return fail("BAD_REQUEST", "投稿する日時を指定してください", 400);
    }

    const nowIso = new Date().toISOString();
    // 本文を直したら、途中まで進んだ状態はリセットする（失敗からの作り直し）。
    // ただし **既に Threads へ出た投稿がある行（result_ids が空でない）は step を戻さない**。
    // 戻すと step 0 が root をもう1本作ってしまう（SPEC §8.3 の二重投稿防止）。
    // その場合は続きの step から再開する（publish-now と同じ扱い）。
    const published = parseJsonArray(row.result_ids_json).length > 0;
    const resetSteps = (row.status === "failed" || row.status === "draft") && !published;
    await db.run(
      `UPDATE queue SET body=?, comments_json=?, image_url=?, reply_control=?, scheduled_at=?, status=?,
         error=NULL, error_raw=NULL,
         step=CASE WHEN ? THEN 0 ELSE step END,
         next_step_at=NULL, container_id=NULL, container_polls=0,
         updated_at=? WHERE id=? AND account_id=?`,
      body,
      JSON.stringify(comments),
      input.imageUrl === undefined ? row.image_url : input.imageUrl,
      input.replyControl ?? row.reply_control,
      scheduledAt,
      status,
      resetSteps ? 1 : 0,
      nowIso,
      row.id,
      account.id,
    );

    if (status === "scheduled" && scheduledAt) {
      await schedulePublish(c, account.id, scheduledAt);
    }
    const next = (await loadRow(db, account.id, row.id))!;
    return c.json(ok({ item: await itemOf(db, account.id, next) }));
  });

  /* ── 承認（SPEC §7.4） ────────────────────────────── */
  r.post("/:id/queue/:qid/approve", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const row = await loadRow(db, account.id, c.req.param("qid"));
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);
    if (!canPublishAccount(account)) return fail("CONFLICT", "Threads APIを設定で連携し直してから予約してください", 409);
    if (row.status !== "pending_approval" && row.status !== "scheduled") {
      return fail("CONFLICT", "この下書きは承認できる状態ではありません", 409);
    }
    if (!row.scheduled_at) return fail("BAD_REQUEST", "投稿する日時がありません", 400);

    await db.run(
      "UPDATE queue SET status='scheduled', approve_deadline=NULL, updated_at=? WHERE id=? AND account_id=?",
      new Date().toISOString(),
      row.id,
      account.id,
    );
    await schedulePublish(c, account.id, row.scheduled_at);
    await audit(db, c.get("userId")!, "queue.approve", { accountId: account.id, queueId: row.id });
    const next = (await loadRow(db, account.id, row.id))!;
    return c.json(ok({ item: await itemOf(db, account.id, next) }));
  });

  /* ── 取消（SPEC §7.4） ────────────────────────────── */
  r.post("/:id/queue/:qid/cancel", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const row = await loadRow(db, account.id, c.req.param("qid"));
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);
    if (row.status === "done" || row.status === "publishing") {
      return fail("CONFLICT", "この投稿はもう取り消せません", 409);
    }

    const nowIso = new Date().toISOString();
    await db.run(
      "UPDATE queue SET status='cancelled', next_step_at=NULL, updated_at=? WHERE id=? AND account_id=?",
      nowIso,
      row.id,
      account.id,
    );
    await db.run(
      "INSERT INTO ap_log (id, account_id, at, kind, message, ref_id) VALUES (?,?,?,?,?,?)",
      crypto.randomUUID(),
      account.id,
      nowIso,
      "cancel",
      "予約を取り消しました",
      row.id,
    );
    await audit(db, c.get("userId")!, "queue.cancel", { accountId: account.id, queueId: row.id });
    const next = (await loadRow(db, account.id, row.id))!;
    return c.json(ok({ item: await itemOf(db, account.id, next) }));
  });

  /* ── 今すぐ投稿（SPEC §7.4） ──────────────────────── */
  r.post("/:id/queue/:qid/publish-now", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const row = await loadRow(db, account.id, c.req.param("qid"));
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);
    if (!canPublishAccount(account)) return fail("CONFLICT", "Threads APIを設定で連携し直してから予約してください", 409);
    if (row.status === "publishing" || row.status === "done") return fail("CONFLICT", "すでに投稿中または投稿済みです", 409);

    const bad = check(row.body, parseJsonArray(row.comments_json));
    if (bad) return fail("VALIDATION", bad.message, 400);

    const nowIso = new Date().toISOString();
    // step と result_ids は残す。失敗からの再開で1投稿目を出し直さないため（SPEC §8.3）
    await db.run(
      `UPDATE queue SET status='scheduled', scheduled_at=?, next_step_at=?, error=NULL, error_raw=NULL,
         updated_at=? WHERE id=? AND account_id=?`,
      nowIso,
      nowIso,
      nowIso,
      row.id,
      account.id,
    );
    await schedulePublish(c, account.id, nowIso);
    const next = (await loadRow(db, account.id, row.id))!;
    return c.json(ok({ item: await itemOf(db, account.id, next) }));
  });

  /* ── 複製（SPEC §7.4） ────────────────────────────── */
  r.post("/:id/queue/:qid/duplicate", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const row = await loadRow(db, account.id, c.req.param("qid"));
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    await db.run(
      `INSERT INTO queue (id, account_id, status, scheduled_at, body, comments_json, image_url, reply_control,
          source, approval_mode, approve_deadline, notified_at, action_token_used_at, step, next_step_at,
          container_id, container_polls, result_ids_json, error, error_raw, attempts, tags_json,
          origin_post_id, source_ids_json, created_at, updated_at)
        VALUES (?,?, 'draft', NULL, ?,?,?,?, 'manual', NULL, NULL, NULL, NULL, 0, NULL, NULL, 0, '[]', NULL, NULL, 0, '{}', ?,?,?,?)`,
      id,
      account.id,
      row.body,
      row.comments_json,
      row.image_url,
      row.reply_control,
      row.origin_post_id,
      row.source_ids_json,
      nowIso,
      nowIso,
    );
    const next = (await loadRow(db, account.id, id))!;
    return c.json(ok({ item: await itemOf(db, account.id, next) }), 201);
  });

  /* ── 削除（`done` 以外。SPEC §7.4） ───────────────── */
  r.delete("/:id/queue/:qid", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const res = await db.run(
      "DELETE FROM queue WHERE id=? AND account_id=? AND status<>'done'",
      c.req.param("qid"),
      account.id,
    );
    if (res.changes === 0) {
      const row = await loadRow(db, account.id, c.req.param("qid"));
      if (row) return fail("CONFLICT", "投稿済みのものは消せません", 409);
      return fail("NOT_FOUND", "見つかりませんでした", 404);
    }
    return c.json(ok({ deleted: true }));
  });

  return r;
}

/**
 * 予約が入った・早まったときに `publish` ジョブを積む（SPEC §8.3）。
 * 5分ごとの cron も同じジョブを積むので、これは「待たせない」ためだけの前倒し。
 */
async function schedulePublish(
  c: Context<AppEnv>,
  accountId: string,
  atIso: string,
): Promise<void> {
  const ctx = jobContextFrom(c.env, c.get("db"), c.get("budget"));
  const at = new Date(Math.max(Date.parse(atIso), ctx.now.getTime()));
  await enqueuePublish(ctx, accountId, at);
}
